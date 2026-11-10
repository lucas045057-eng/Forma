import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import type { SceneChanged } from '@spatial/shared/scene-edit';
import { SceneService, safeWorkPath } from './service.ts';
import { createApp } from '../app.ts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'scene-test-')); roots.push(root);
  const workRoot = path.join(root, 'work'), historyDirectory = path.join(root, 'history');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  const file = path.join(workRoot, 'src/scene.config.json');
  await writeFile(file, JSON.stringify(defaultSceneConfig));
  const events: SceneChanged[] = [];
  const options = { workRoot, historyDirectory, emit: (event: SceneChanged) => events.push(event) };
  return { root, file, options, events, service: new SceneService(options) };
}
const changed = (ambient: number) => { const result = structuredClone(defaultSceneConfig); result.hero.lights.ambient = ambient; return result; };

it('serializes concurrent writes, persists history and pops undo without toggling', async () => {
  const f = await fixture();
  await Promise.all([f.service.put(changed(2)), f.service.put(changed(3)), f.service.put(changed(4))]);
  expect((await f.service.get()).hero.lights.ambient).toBe(4);
  expect(f.events.map(e => e.sequence)).toEqual([1, 2, 3]);
  const resumed = new SceneService(f.options);
  expect((await resumed.undo()).config.hero.lights.ambient).toBe(3);
  expect((await resumed.undo()).config.hero.lights.ambient).toBe(2);
  expect((await resumed.undo()).config).toEqual(defaultSceneConfig);
  await expect(resumed.undo()).rejects.toMatchObject({ status: 409 });
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual(defaultSceneConfig);
  const journal = JSON.parse(await readFile(path.join(f.options.historyDirectory, (await readdir(f.options.historyDirectory))[0]), 'utf8'));
  expect(journal.entries).toHaveLength(6); expect(journal.stack).toEqual([]);
  expect(journal.entries[0]).toMatchObject({ sequence: 1, previous: defaultSceneConfig, next: changed(2) });
});
it('rejects schema, extra fields and unordered frames without changing file/history', async () => {
  const f = await fixture();
  await expect(f.service.put({ ...changed(2), extra: true })).rejects.toMatchObject({ code: 'INVALID_SCENE', status: 400 });
  await expect(f.service.put({ ...changed(2), scroll: [{ at: 0.6 }, { at: 0.4 }] })).rejects.toMatchObject({ fields: [{ path: '/scroll' }] });
  await expect(f.service.put({ ...changed(2), model: '/assets/../secret' })).rejects.toMatchObject({ status: 400 });
  expect(await f.service.get()).toEqual(defaultSceneConfig);
  await expect(f.service.undo()).rejects.toMatchObject({ status: 409 });
});
it('rejects traversal and junctions before touching outside content', async () => {
  const f = await fixture();
  await expect(safeWorkPath(f.options.workRoot, '../outside.json')).rejects.toMatchObject({ code: 'PATH_DENIED' });
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'scene.config.json'), 'untouched');
  await rm(path.join(f.options.workRoot, 'src'), { recursive: true });
  await symlink(outside, path.join(f.options.workRoot, 'src'), 'junction');
  await expect(f.service.put(changed(2))).rejects.toMatchObject({ code: 'PATH_DENIED' });
  expect(await readFile(path.join(outside, 'scene.config.json'), 'utf8')).toBe('untouched');
});
it('replays a durable interrupted intent and retains correct undo stack', async () => {
  const f = await fixture(); await f.service.put(changed(2));
  const file = path.join(f.options.historyDirectory, (await readdir(f.options.historyDirectory))[0]);
  const journal = JSON.parse(await readFile(file, 'utf8'));
  journal.pending = { entry: { sequence: 2, ts: new Date().toISOString(), previous: changed(2), next: changed(3), kind: 'write' }, stack: [...journal.stack, changed(2)] };
  await writeFile(file, JSON.stringify(journal));
  const resumed = new SceneService(f.options);
  expect(await resumed.get()).toEqual(changed(3));
  expect((await resumed.undo()).config).toEqual(changed(2));
});
it('HTTP returns field errors, accepts config without coercion, and enforces origins', async () => {
  const f = await fixture();
  const { app } = await createApp({ ...f.options, dataDirectory: path.join(f.root, 'assets'), base: 'http://127.0.0.1:4010', key: 'mock-only' });
  try {
    const invalid = await app.inject({ method: 'PUT', url: '/scene', payload: { ...changed(2), hero: {} } });
    expect(invalid.statusCode).toBe(400); expect(invalid.json().error.fields[0].path).toBe('/hero');
    expect((await app.inject({ method: 'POST', url: '/scene/undo' })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/scene', payload: changed(2), headers: { origin: 'https://foreign.invalid' } })).statusCode).toBe(403);
    const valid = await app.inject({ method: 'PUT', url: '/scene', payload: changed(2) });
    expect(valid.json()).toMatchObject({ type: 'scene.changed', diff: [{ path: '/hero/lights/ambient', oldValue: 1.2, newValue: 2 }] });
    expect((await app.inject('/scene')).json()).toEqual(changed(2));
  } finally { await app.close(); }
});
it('adopts only ready assets, requires force and copies metadata with undo', async () => {
  const f = await fixture(); const assets = path.join(f.root, 'assets');
  await mkdir(path.join(assets, 'asset1'), { recursive: true });
  const model = Buffer.from('test-processed-model');
  await writeFile(path.join(assets, 'asset1/model.glb'), model);
  await writeFile(path.join(assets, 'index.json'), JSON.stringify([{ id: 'asset1', status: 'ready', createdAt: '', updatedAt: '', metrics: { webReady: false, parts: { recognized: true, lid: 'lid', nodes: [] } } }]));
  const { app } = await createApp({ ...f.options, dataDirectory: assets, base: 'http://127.0.0.1:4010', key: 'mock-only' });
  try {
    expect((await app.inject({ method: 'POST', url: '/assets/asset1/adopt', payload: {} })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/assets/asset1/adopt', payload: { force: 'true' } })).statusCode).toBe(400);
    const adopted = await app.inject({ method: 'POST', url: '/assets/asset1/adopt', payload: { force: true } });
    expect(adopted.statusCode).toBe(200); expect(adopted.json().config.model).toBe('/assets/asset1.glb');
    expect(await readFile(path.join(f.options.workRoot, 'public/assets/asset1.glb'))).toEqual(model);
    expect(JSON.parse(await readFile(path.join(f.options.workRoot, 'public/assets/asset1.parts.json'), 'utf8')).lid).toBe('lid');
    expect((await app.inject({ method: 'POST', url: '/scene/undo' })).json().config).toEqual(defaultSceneConfig);
    expect((await app.inject({ method: 'POST', url: '/assets/absent/adopt', payload: {} })).statusCode).toBe(409);
    await writeFile(path.join(assets, 'asset1/model.glb'), 'different-model');
    expect((await app.inject({ method: 'POST', url: '/assets/asset1/adopt', payload: { force: true } })).statusCode).toBe(409);
    await writeFile(path.join(assets, 'asset1/model.glb'), model);
    await rm(path.join(f.options.workRoot, 'public/assets'), { recursive: true });
    const outside = path.join(f.root, 'outside-adoption'); await mkdir(outside);
    await symlink(outside, path.join(f.options.workRoot, 'public/assets'), 'junction');
    expect((await app.inject({ method: 'POST', url: '/assets/asset1/adopt', payload: { force: true } })).statusCode).toBe(403);
    expect(await readdir(outside)).toEqual([]);
  } finally { await app.close(); }
});

it('bounds the persisted journal and undo stack', async () => {
  const f = await fixture();
  for (let i = 1; i <= 55; i++) await f.service.put(changed(i / 10));
  const journal = JSON.parse(await readFile(path.join(f.options.historyDirectory, (await readdir(f.options.historyDirectory))[0]), 'utf8'));
  expect(journal.entries).toHaveLength(50);
  expect(journal.stack).toHaveLength(50);
  expect(journal.sequence).toBe(55);
  expect((await f.service.undo()).config.hero.lights.ambient).toBe(5.4);
});

it('refuses requests addressed to a non-loopback host name unless explicitly allowed', async () => {
  const f = await fixture();
  const base = { ...f.options, dataDirectory: path.join(f.root, 'assets'), base: 'http://127.0.0.1:4010', key: 'mock-only' };
  const { app } = await createApp(base);
  try {
    for (const host of ['localhost:3001', '127.0.0.1:5173', '[::1]:3001']) {
      expect((await app.inject({ url: '/scene', headers: { host } })).statusCode).toBe(200);
    }
    for (const host of ['evil.example:3001', 'evil.example', '127.0.0.1.evil.example:3001']) {
      // Same-origin from the browser's point of view after DNS rebinding, still refused.
      const response = await app.inject({ method: 'PUT', url: '/scene', headers: { host, origin: `http://${host}` }, payload: changed(9) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('HOST_DENIED');
    }
    expect((await f.service.get()).hero.lights.ambient).toBe(defaultSceneConfig.hero.lights.ambient);
  } finally { await app.close(); }
  const { app: allowed } = await createApp({ ...base, allowedHosts: ['studio.lan'] });
  try { expect((await allowed.inject({ url: '/scene', headers: { host: 'studio.lan:3001' } })).statusCode).toBe(200); }
  finally { await allowed.close(); }
});
