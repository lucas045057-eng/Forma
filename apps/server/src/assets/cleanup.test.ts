import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cleanupAssetTemporaries } from './cleanup.ts';

it('cleans only owned temporary files before startup, retaining assets and unrelated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-cleanup-'));
  try {
    await mkdir(join(root, '123'));
    await mkdir(join(root, '123', 'nested'));
    const uuid = '12345678-1234-1234-1234-123456789abc';
    for (const name of ['index.json', 'index.json.tmp', `index.json.${uuid}.tmp`, 'notes.tmp']) {
      await writeFile(join(root, name), 'keep or clean');
    }
    for (const name of ['model.glb', 'parts.json', 'raw.glb', 'raw.glb.tmp', 'model.glb.tmp', `parts.json.${uuid}.tmp`, 'notes.tmp']) {
      await writeFile(join(root, '123', name), 'keep or clean');
    }
    await writeFile(join(root, '123', 'nested', 'model.glb.tmp'), 'keep');
    await cleanupAssetTemporaries(root);
    expect((await readdir(root)).sort()).toEqual(['123', 'index.json', 'notes.tmp']);
    expect((await readdir(join(root, '123'))).sort()).toEqual(['model.glb', 'nested', 'notes.tmp', 'parts.json', 'raw.glb']);
    expect(await readdir(join(root, '123', 'nested'))).toEqual(['model.glb.tmp']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
