import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { get } from 'node:http';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.ts';

it('keeps the event log inside the work-data lock and continues seq after a graceful restart (review F4)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'events-lock-'));
  const shared = { workRoot: path.resolve(import.meta.dirname, '../../../templates/product-page'), workDataDirectory: path.join(root, 'm2'),
    historyDirectory: path.join(root, 'history'), base: 'http://127.0.0.1:9', key: 'mock-only' };
  const log = path.join(root, 'm2', 'events.jsonl');
  try {
    const first = await createApp({ ...shared, dataDirectory: path.join(root, 'assets-1') });
    first.events.publish({ type: 'test.marker', n: 1 });
    first.events.publish({ type: 'test.marker', n: 2 });
    await first.events.idle();
    const before = await readFile(log, 'utf8');
    const last = first.events.last;
    // A second backend on the same work data must fail before reading or repairing the log.
    await expect(createApp({ ...shared, dataDirectory: path.join(root, 'assets-2') })).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(await readFile(log, 'utf8')).toBe(before);
    await first.app.close();
    const second = await createApp({ ...shared, dataDirectory: path.join(root, 'assets-3') });
    try {
      expect(second.events.last).toBe(last);
      expect(second.events.publish({ type: 'test.marker', n: 3 }).seq).toBe(last + 1);
    } finally { await second.app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('releases the work-data lock when a constructor throws after it was taken (review N3)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'events-lock-'));
  const shared = { workRoot: path.resolve(import.meta.dirname, '../../../templates/product-page'), workDataDirectory: path.join(root, 'm2'),
    historyDirectory: path.join(root, 'history'), key: 'mock-only' };
  try {
    // A plain-http non-loopback Lux3D base makes the client constructor throw after the lock is held.
    await expect(createApp({ ...shared, dataDirectory: path.join(root, 'a'), base: 'http://192.0.2.10:4010' })).rejects.toThrow();
    const ok = await createApp({ ...shared, dataDirectory: path.join(root, 'b'), base: 'http://127.0.0.1:9' });
    await ok.app.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('drains queued work-tree operations before the log closes and the lock is released (review N4)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'events-lock-'));
  const shared = { workRoot: path.resolve(import.meta.dirname, '../../../templates/product-page'), workDataDirectory: path.join(root, 'm2'),
    historyDirectory: path.join(root, 'history'), base: 'http://127.0.0.1:9', key: 'mock-only', dataDirectory: path.join(root, 'assets') };
  const { existsSync } = await import('node:fs');
  const lock = path.join(root, 'm2', '.instance.lock');
  try {
    const { app, work, events } = await createApp(shared);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    // An operation already queued when shutdown starts: it must complete and its event must land.
    const queued = work.repo.exclusive(async () => { await gate; events.publish({ type: 'test.late' }); order.push('operation'); });
    let draining!: () => void;
    const startedDrain = new Promise<void>(resolve => { draining = resolve; });
    const drain = work.repo.drain.bind(work.repo);
    vi.spyOn(work.repo, 'drain').mockImplementation(() => { const result = drain(); draining(); return result; });
    const closing = app.close().then(() => order.push('closed'));
    await startedDrain;
    expect(existsSync(lock)).toBe(true);
    // New work is refused once shutdown has begun.
    await expect(work.repo.exclusive(async () => 'late')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    release();
    await queued; await closing;
    expect(order).toEqual(['operation', 'closed']);
    expect(existsSync(lock)).toBe(false);
    expect(() => events.publish({ type: 'after.close' })).toThrow();
    const lines = (await readFile(path.join(root, 'm2', 'events.jsonl'), 'utf8')).trim().split('\n');
    expect(JSON.parse(lines.at(-1)!).type).toBe('test.late');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('drains an admitted real HTTP snapshot before unlock and preserves nested repo calls', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'n4-http-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'app.ts'), 'export const value = 1;');
  const options = { workRoot, workDataDirectory: path.join(root, 'data'), historyDirectory: path.join(root, 'history'),
    dataDirectory: path.join(root, 'assets'), base: 'http://127.0.0.1:9', key: 'mock-only' };
  const instance = await createApp(options);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  let preClosed!: () => void;
  const preClose = new Promise<void>(resolve => { preClosed = resolve; });
  instance.app.addHook('preClose', async () => { preClosed(); });
  const snapshot = instance.work.repo.snapshot.bind(instance.work.repo);
  vi.spyOn(instance.work.repo, 'snapshot').mockImplementation(async (...args) => {
    entered(); await gate; return snapshot(...args);
  });
  let closing: Promise<void> | undefined;
  try {
    const base = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    await writeFile(path.join(workRoot, 'src', 'app.ts'), 'export const value = 2;');
    const response = new Promise<number>((resolve, reject) => {
      get(`${base}/version`, result => {
        result.resume();
        result.once('end', () => resolve(result.statusCode!));
      }).on('error', reject);
    });
    await accepted;
    let closed = false;
    closing = instance.app.close().then(() => { closed = true; });
    await preClose;
    expect(closed).toBe(false);
    await expect(createApp(options)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect((await instance.app.inject('/version')).statusCode).toBe(503);
    release();
    expect(await response).toBe(200);
    await closing;
    const log = await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim().split('\n').at(-1)!).type).toBe('version.changed');
    await expect(instance.work.repo.snapshot()).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    expect(() => instance.events.publish({ type: 'late' })).toThrow();
    const restarted = await createApp(options);
    try {
      expect(restarted.events.last).toBe(instance.events.last);
      expect(restarted.events.publish({ type: 'restart' }).seq).toBe(instance.events.last + 1);
    } finally { await restarted.app.close(); }
  } finally {
    release();
    await (closing ?? instance.app.close());
    await rm(root, { recursive: true, force: true });
  }
});

it('retains ownership and journal if a producer fails to stop, while stopping other producers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'n4-failure-'));
  const workRoot = path.join(root, 'work');
  await mkdir(workRoot);
  const options = { workRoot, workDataDirectory: path.join(root, 'data'), historyDirectory: path.join(root, 'history'),
    dataDirectory: path.join(root, 'assets'), base: 'http://127.0.0.1:9', key: 'mock-only' };
  const instance = await createApp(options);
  const stop = vi.spyOn(instance.work, 'close').mockRejectedValue(new Error('injected stop failure'));
  const assets = vi.spyOn(instance.service, 'close');
  try {
    await expect(instance.app.close()).rejects.toThrow('injected stop failure');
    expect(assets).toHaveBeenCalled();
    await expect(createApp(options)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(() => instance.events.publish({ type: 'producer.still.owned' })).not.toThrow();
  } finally {
    stop.mockRestore();
    await instance.work.close();
    await instance.service.close();
    await instance.scene.idle();
    await instance.events.close();
    // The failed app deliberately retains its lock. All fixture producers are now stopped.
    await rm(root, { recursive: true, force: true });
  }
});
