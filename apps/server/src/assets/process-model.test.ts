import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Document, NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { processModel } from './process-model.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('normalizes world-space geometry and preserves textured material through meshopt decoding', async () => {
  const data = resolve(import.meta.dirname, '../../../../../.data');
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(join(data, 'process-model-'));
  directories.push(directory);
  const input = join(directory, 'raw.glb');
  const output = join(directory, 'nested', 'model.glb');
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4]));
  const indices = document.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]));
  const uv = document.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
  const image = await sharp({ create: { width: 2048, height: 1024, channels: 4, background: '#a07040' } })
    .png().toBuffer();
  const texture = document.createTexture().setImage(image).setMimeType('image/png');
  const material = document.createMaterial('wood').setBaseColorTexture(texture).setRoughnessFactor(0.7);
  const mesh = document.createMesh('bottle').addPrimitive(document.createPrimitive()
    .setAttribute('POSITION', positions).setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material));
  const child = document.createNode('bottle').setMesh(mesh).setTranslation([3, -7, 2]);
  const root = document.createNode('transformed-root').setScale([2, 3, 4])
    .setRotation([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)])
    .setTranslation([8, 9, -5]).addChild(child);
  const scene = document.createScene('main').addChild(root);
  document.getRoot().setDefaultScene(scene);
  // A root shared between scenes must remain visible in both after reparenting.
  document.createScene('alternate').addChild(root);
  await new NodeIO().write(input, document);

  const result = await processModel(input, output);
  expect(result.before.vertices).toBe(4);
  expect(result.after.vertices).toBe(4);
  expect(result.after.bytes).toBeLessThan(3_000_000);
  expect(result.webReady).toBe(true);
  expect(result.parts.recognized).toBe(false);
  expect(result.parts.reason).toBeTruthy();
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const decoded = await io.read(output);
  expect(decoded.getRoot().listExtensionsRequired().map((extension) => extension.extensionName))
    .toContain('EXT_meshopt_compression');
  for (const decodedScene of decoded.getRoot().listScenes()) {
    const { min, max } = getBounds(decodedScene);
    expect(min[1]).toBeCloseTo(0, 5);
    expect(min[0] + max[0]).toBeCloseTo(0, 5);
    expect(min[2] + max[2]).toBeCloseTo(0, 5);
    expect(Math.max(...max.map((value, axis) => value - min[axis]!))).toBeCloseTo(1, 5);
  }
  const decodedMaterial = decoded.getRoot().listMaterials()[0]!;
  expect(decodedMaterial.getName()).toBe('wood');
  expect(decodedMaterial.getRoughnessFactor()).toBe(0.7);
  const decodedTexture = decodedMaterial.getBaseColorTexture()!;
  expect(decodedTexture.getMimeType()).toBe('image/webp');
  expect(decodedTexture.getSize()).toEqual([1024, 512]);
  expect(decoded.getRoot().listNodes().some((node) => node.getName() === 'bottle')).toBe(true);
});

it('rejects models without scene geometry', async () => {
  const data = resolve(import.meta.dirname, '../../../../../.data');
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(join(data, 'process-model-'));
  directories.push(directory);
  const input = join(directory, 'empty.glb');
  const document = new Document();
  document.createScene();
  await new NodeIO().write(input, document);
  await expect(processModel(input, join(directory, 'model.glb'))).rejects.toThrow('no scene geometry');
});

it.each(['buffers', 'images'])('rejects external %s URIs before resolving resources', async (kind) => {
  const data = resolve(import.meta.dirname, '../../../../../.data');
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(join(data, 'process-model-'));
  directories.push(directory);
  const input = join(directory, 'external.glb');
  const output = join(directory, 'model.glb');
  const text = JSON.stringify({ asset: { version: '2.0' }, [kind]: [{ uri: '../private-resource.bin' }] });
  const json = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, ' '));
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + json.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  await writeFile(input, Buffer.concat([header, json]));
  await expect(processModel(input, output)).rejects.toThrow('External resource URI');
  await expect(access(output)).rejects.toThrow();
});
