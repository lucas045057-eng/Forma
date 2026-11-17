import { it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultSceneModuleConfig } from '@spatial/shared/scene-module';
import { ModuleSceneService } from './modules.ts';
import type { WorkRepo } from '../work/repo.ts';

class FakeRepo {
  version = 'v1';
  private count = 1;
  head() { return Promise.resolve(this.version); }
  snapshot() { this.version = `v${++this.count}`; return Promise.resolve(this.version); }
  exclusive<T>(work: () => Promise<T>) { return work(); }
  external() { this.version = `external-${++this.count}`; }
}

const instanceId = 'a'.repeat(32);

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'module-history-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src', 'scene-modules'), { recursive: true });
  const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
  await writeFile(path.join(workRoot, 'src', 'scene-modules', `${instanceId}.json`), JSON.stringify(config, null, 2) + '\n');
  const repo = new FakeRepo();
  const service = new ModuleSceneService({ workRoot, directory: path.join(directory, 'data'), repo: repo as unknown as WorkRepo });
  return { directory, workRoot, service, repo };
}

it('writes only the selected instance, snapshots a version and undoes exactly that step', async () => {
  const f = await fixture();
  try {
    const before = JSON.parse(await readFile(path.join(f.workRoot, 'src', 'scene-modules', `${instanceId}.json`), 'utf8'));
    const first = await f.service.adjust(instanceId, { layout: { widthPercent: 60 }, scale: 1.4 }, 'v1');
    expect(first.config.layout.widthPercent).toBe(60);
    expect(first.version).toBe('v2');
    const after = JSON.parse(await readFile(path.join(f.workRoot, 'src', 'scene-modules', `${instanceId}.json`), 'utf8'));
    expect(after.layout.widthPercent).toBe(60);
    expect(after.assetId).toBe(before.assetId);
    const detail = await f.service.get(instanceId);
    expect(detail.canUndo).toBe(true);
    const undone = await f.service.undo(instanceId, 'v2');
    expect(undone.version).toBe('v3');
    expect(undone.config.layout.widthPercent).toBe(before.layout.widthPercent);
    expect((await f.service.get(instanceId)).canUndo).toBe(false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('invalidates a stale cursor instead of replaying an old snapshot over newer work', async () => {
  const f = await fixture();
  try {
    await f.service.adjust(instanceId, { scale: 1.2 }, 'v1');
    f.repo.external();
    const external = f.repo.version;
    await expect(f.service.undo(instanceId, external)).rejects.toMatchObject({ code: 'MODULE_HISTORY_STALE' });
    const fresh = await f.service.adjust(instanceId, { scale: 1.3 }, external);
    expect(fresh.config.scale).toBe(1.3);
    const detail = await f.service.get(instanceId);
    expect(detail.canUndo).toBe(true);
    expect(detail.history.length).toBeGreaterThan(0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('rejects an adjustment prepared for a different work version without touching the file', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.workRoot, 'src', 'scene-modules', `${instanceId}.json`);
    const before = await readFile(file, 'utf8');
    await expect(f.service.adjust(instanceId, { scale: 2 }, 'not-current')).rejects.toMatchObject({ code: 'MODULE_HISTORY_STALE' });
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('invalidates the module cursor when the main scene changes without a new module snapshot (N4)', async () => {
  const f = await fixture();
  try {
    await f.service.adjust(instanceId, { scale: 1.2 }, 'v1');
    await writeFile(path.join(f.workRoot, 'src', 'scene.config.json'), JSON.stringify({ changed: true }), 'utf8');
    expect((await f.service.get(instanceId)).stale).toBe(true);
    await expect(f.service.undo(instanceId, f.repo.version)).rejects.toMatchObject({ code: 'MODULE_HISTORY_STALE' });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
