import { mkdir, readFile } from 'node:fs/promises';
import { writeAtomic } from './atomic-file.ts';
import { dirname } from 'node:path';
import { Document, NodeIO, getBounds, type Scene } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

function vertexCount(document: Document): number {
  const positions = new Set(document.getRoot().listMeshes().flatMap((mesh) =>
    mesh.listPrimitives().map((primitive) => primitive.getAttribute('POSITION')),
  ));
  return [...positions].reduce((count, accessor) => count + (accessor?.getCount() ?? 0), 0);
}

function boundsOf(scenes: Scene[]): { min: number[]; max: number[] } {
  const bounds = scenes.map((scene) => getBounds(scene));
  return {
    min: [0, 1, 2].map((axis) => Math.min(...bounds.map((box) => box.min[axis]!))),
    max: [0, 1, 2].map((axis) => Math.max(...bounds.map((box) => box.max[axis]!))),
  };
}

export async function processModel(inputPath: string, outputPath: string) {
  const started = performance.now();
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  const input = await readFile(inputPath);
  if (input.length < 20 || input.readUInt32LE(0) !== 0x46546c67
    || input.readUInt32LE(4) !== 2 || input.readUInt32LE(8) !== input.length
    || input.readUInt32LE(16) !== 0x4e4f534a || input.readUInt32LE(12) > input.length - 20) {
    throw new Error('Invalid GLB header or JSON chunk');
  }
  const json = JSON.parse(input.toString('utf8', 20, 20 + input.readUInt32LE(12))) as {
    buffers?: { uri?: unknown }[];
    images?: { uri?: unknown }[];
  };
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource.uri !== undefined && (typeof resource.uri !== 'string' || !resource.uri.startsWith('data:'))) {
      throw new Error('External resource URI is not allowed in GLB');
    }
  }
  // Decode the same validated bytes, without resolving filesystem or network resources.
  const document = await io.readBinary(input);
  const before = { bytes: input.byteLength, vertices: vertexCount(document) };
  if (!before.vertices || !document.getRoot().listScenes().length) {
    throw new Error('Model has no scene geometry');
  }

  await document.transform(weld());
  // Leave headroom for UV seams, which can prevent the target ratio being reached.
  for (const error of [0.001, 0.005, 0.02]) {
    const vertices = vertexCount(document);
    if (vertices < 100_000) break;
    await document.transform(simplify({
      simplifier: MeshoptSimplifier,
      ratio: Math.min(0.9, 80_000 / vertices),
      error,
    }));
  }
  if (vertexCount(document) >= 100_000) {
    throw new Error('Model cannot be simplified below 100,000 vertices within the error limit');
  }
  await document.transform(
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );

  // Normalize after quantization: use world bounds, preserving existing transforms and materials.
  const scenes = document.getRoot().listScenes();
  const bounds = boundsOf(scenes);
  const largestSide = Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis]!));
  if (!Number.isFinite(largestSide) || largestSide <= 0) {
    throw new Error('Model has invalid or zero-sized bounds');
  }
  const scale = 1 / largestSide;
  const roots = new Set(scenes.flatMap((scene) => scene.listChildren()));
  for (const root of roots) {
    const parents = scenes.filter((scene) => scene.listChildren().includes(root));
    const parent = document.createNode('asset-normalization')
      .setScale([scale, scale, scale])
      .setTranslation([
        -(bounds.min[0]! + bounds.max[0]!) * 0.5 * scale,
        -bounds.min[1]! * scale,
        -(bounds.min[2]! + bounds.max[2]!) * 0.5 * scale,
      ])
      .addChild(root);
    for (const scene of parents) scene.addChild(parent);
  }
  const binary = await io.writeBinary(document);
  // Measure decoded output before publishing it, including compression encoder changes.
  const output = await io.readBinary(binary);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeAtomic(outputPath, binary);
  return {
    before,
    after: { bytes: binary.byteLength, vertices: vertexCount(output) },
    durationMs: Math.round(performance.now() - started),
    bounds: boundsOf(output.getRoot().listScenes()),
  };
}
