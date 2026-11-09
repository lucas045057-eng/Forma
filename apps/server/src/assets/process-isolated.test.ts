import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { afterEach, expect, it } from 'vitest';
import { processModelIsolated } from './process-isolated.ts';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const data = resolve(import.meta.dirname, '../../../../../.data');
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(join(data, 'isolated-model-'));
  directories.push(directory);
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor().setBuffer(buffer).setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]));
  const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', positions));
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const input = join(directory, 'input.glb');
  await new NodeIO().write(input, document);
  return { directory, input, output: join(directory, 'model.glb') };
}

it('publishes model and parts only after successful worker exit', async () => {
  const { directory, input, output } = await fixture();
  const result = await processModelIsolated(input, output);
  expect(result.webReady).toBe(true);
  expect((await readFile(output)).byteLength).toBe(result.after.bytes);
  expect(JSON.parse(await readFile(join(directory, 'parts.json'), 'utf8'))).toEqual(result.parts);
  expect((await readdir(directory)).some((name) => name.startsWith('.model-stage-'))).toBe(false);
}, 30_000);

it('kills and waits for a timed-out worker, removes its staging and preserves outer files', async () => {
  const { directory, input, output } = await fixture();
  const previous = Buffer.from('previous output');
  await writeFile(output, previous);
  await writeFile(join(directory, 'old.tmp'), 'owned by service');
  await expect(processModelIsolated(input, output, { timeoutMs: 1 })).rejects.toThrow('timed out');
  expect(await readFile(output)).toEqual(previous);
  expect((await readdir(directory)).sort()).toEqual(['input.glb', 'model.glb', 'old.tmp']);
});

it('cancels a running worker without publishing partial artifacts', async () => {
  const { directory, input, output } = await fixture();
  const controller = new AbortController();
  const processing = processModelIsolated(input, output, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await expect(processing).rejects.toThrow(/abort/i);
  } finally {
    clearTimeout(timer);
  }
  await expect(access(output)).rejects.toThrow();
  expect(await readdir(directory)).toEqual(['input.glb']);
});

it('rejects invalid input in the worker and cleans staging', async () => {
  const { directory, input, output } = await fixture();
  await writeFile(input, 'invalid GLB');
  await expect(processModelIsolated(input, output)).rejects.toThrow('Invalid GLB');
  expect(await readdir(directory)).toEqual(['input.glb']);
});
