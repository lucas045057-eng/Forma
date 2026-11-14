import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { get, request } from 'node:http';
import { CodingAgent } from './agent/client.ts';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
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
  const startedAt = performance.now();
  const stage = (name: string) => console.info(`[n4-http] ${Math.round(performance.now() - startedAt)}ms ${name}`);
  stage('init-start');
  const instance = await createApp(options);
  stage('init');
  const closeEvents = instance.events.close.bind(instance.events);
  vi.spyOn(instance.events, 'close').mockImplementation(async () => {
    await readFile(path.join(root, 'data', '.instance.lock'));
    const log = await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim().split('\n').at(-1)!).type).toBe('version.changed');
    expect(await readFile(path.join(workRoot, 'src', 'app.ts'), 'utf8')).toBe('export const value = 2;');
    stage('file-and-event-before-unlock');
    await closeEvents();
  });
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
    stage('listen');
    await writeFile(path.join(workRoot, 'src', 'app.ts'), 'export const value = 2;');
    const response = new Promise<number>((resolve, reject) => {
      get(`${base}/version`, { agent: false, headers: { connection: 'close' } }, result => {
        result.resume();
        result.once('end', () => resolve(result.statusCode!));
      }).on('error', reject);
    });
    await accepted;
    stage('accepted');
    let closed = false;
    closing = instance.app.close().then(() => { closed = true; stage('closing-resolved'); });
    await preClose;
    stage('preClose');
    expect(closed).toBe(false);
    await expect(createApp(options)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    stage('second-instance-rejected');
    await expect(instance.app.inject('/version')).rejects.toMatchObject({ code: 'FST_ERR_REOPENED_CLOSE_SERVER' });
    stage('new-request-rejected');
    release();
    stage('gate-released');
    expect(await response).toBe(200);
    stage('old-response');
    await closing;
    stage('closing-awaited');
    const log = await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
    expect(JSON.parse(log.trim().split('\n').at(-1)!).type).toBe('version.changed');
    await expect(instance.work.repo.snapshot()).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    expect(() => instance.events.publish({ type: 'late' })).toThrow();
    stage('restart-start');
    const restarted = await createApp(options);
    stage('restart-ready');
    try {
      expect(restarted.events.last).toBe(instance.events.last);
      expect(restarted.events.publish({ type: 'restart' }).seq).toBe(instance.events.last + 1);
    } finally { await restarted.app.close(); stage('restart-closed'); }
  } catch (error) {
    console.error('[n4-http] failure before finally', error);
    throw error;
  } finally {
    stage('finally-enter');
    release();
    stage('finally-gate-released');
    await (closing ?? instance.app.close());
    stage('finally-closed');
    await rm(root, { recursive: true, force: true });
    stage('finally-cleaned');
  }
});

it.each(['submit', 'selection', 'cancel'])('drains admitted HTTP %s before task files, journal and lock close', async mode => {
  const root = await mkdtemp(path.join(tmpdir(), 'n4-task-http-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'app.ts'), 'export const value = 1;');
  const options = { workRoot, workDataDirectory: path.join(root, 'data'), historyDirectory: path.join(root, 'history'),
    dataDirectory: path.join(root, 'assets'), base: 'http://127.0.0.1:9', key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9', codingAgentApiKey: 'mock-only', codingAgentModel: 'mock' };
  const instance = await createApp(options);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  let agentEntered!: () => void;
  const agentStarted = new Promise<void>(resolve => { agentEntered = resolve; });
  const agent = vi.spyOn(CodingAgent.prototype, 'run').mockImplementation(async ({ signal }) => {
    agentEntered();
    if (mode === 'cancel') await new Promise<void>(resolve => {
      if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new Error('mock agent stopped');
  });
  let preClosed!: () => void;
  const preClose = new Promise<void>(resolve => { preClosed = resolve; });
  instance.app.addHook('preClose', async () => { preClosed(); });
  let closing: Promise<void> | undefined;
  let taskAtBoundary = '', logAtBoundary = '';
  const closeEvents = instance.events.close.bind(instance.events);
  vi.spyOn(instance.events, 'close').mockImplementation(async () => {
    await readFile(path.join(root, 'data', '.instance.lock'));
    taskAtBoundary = await readFile(path.join(root, 'data', 'tasks.json'), 'utf8');
    logAtBoundary = await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
    // Shutdown can mark an aborted Agent failed; either terminal outcome must be
    // fully persisted before the journal closes, never queued or running.
    expect(['failed', 'cancelled']).toContain(JSON.parse(taskAtBoundary).tasks[0].status);
    expect(JSON.parse(taskAtBoundary).tasks).toEqual(instance.work.listTasks());
    expect(logAtBoundary).toContain('task.updated');
    await closeEvents();
  });
  try {
    const base = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    let endpoint = '/tasks';
    const body: Record<string, unknown> = { instruction: 'change value' };
    if (mode === 'selection') body.selection = { src: 'src/app.ts:1:1', baseVersion: (await instance.work.version()).version };
    if (mode === 'cancel') {
      const task = await instance.work.submit('change value');
      await agentStarted;
      endpoint = `/tasks/${task.id}/cancel`;
      const cancel = instance.work.cancel.bind(instance.work);
      vi.spyOn(instance.work, 'cancel').mockImplementation(async id => { entered(); await gate; return cancel(id); });
    } else {
      void instance.work.repo.exclusive(() => gate);
      const submit = instance.work.submit.bind(instance.work);
      vi.spyOn(instance.work, 'submit').mockImplementation((...args) => {
        const result = submit(...args); entered(); return result;
      });
    }
    const response = new Promise<number>((resolve, reject) => {
      const req = request(`${base}${endpoint}`, { method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', connection: 'close' } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject); req.end(JSON.stringify(mode === 'cancel' ? {} : body));
    });
    await accepted;
    let closed = false;
    closing = instance.app.close().then(() => { closed = true; });
    await preClose;
    await expect(createApp(options)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(closed).toBe(false);
    release();
    expect(await response).toBe(mode === 'cancel' ? 200 : 202);
    await closing;
    await instance.work.idle();
    expect(await readFile(path.join(root, 'data', 'tasks.json'), 'utf8')).toBe(taskAtBoundary);
    expect(await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).toBe(logAtBoundary);
    await expect(instance.work.submit('late')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    await expect(instance.work.cancel('late')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    const restarted = await createApp(options);
    try { expect(restarted.events.last).toBe(instance.events.last); }
    finally { await restarted.app.close(); }
  } finally {
    release();
    await (closing ?? instance.app.close());
    agent.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('drains an admitted real HTTP approval before closing the journal and releasing the lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'n4-approval-http-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src/components'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), "import { Button } from './components/Button';\nexport default () => <><Button/><Button/><Button/></>;\n");
  await writeFile(path.join(workRoot, 'src/components/Button.tsx'), 'export function Button() { return <button>购买</button>; }\n');
  const options = { workRoot, workDataDirectory: path.join(root, 'data'), historyDirectory: path.join(root, 'history'),
    dataDirectory: path.join(root, 'assets'), base: 'http://127.0.0.1:9', key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9', codingAgentApiKey: 'mock-only', codingAgentModel: 'mock' };
  const agent = vi.spyOn(CodingAgent.prototype, 'run').mockImplementation(async ({ root: candidate }) => {
    await writeFile(path.join(candidate, 'src/components/Button.tsx'), 'export function Button() { return <button>批准</button>; }\n');
    return { summary: 'mock approval edit', written: ['src/components/Button.tsx'] };
  });
  const instance = await createApp(options);
  instance.work.previews.start = async id => `/preview/c/${id}/`;
  instance.work.previews.stop = async () => {};
  instance.work.previews.stopAll = async () => {};
  const lock = path.join(root, 'data', '.instance.lock');
  let release!: () => void, entered!: () => void, preClosed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  const preClose = new Promise<void>(resolve => { preClosed = resolve; });
  instance.app.addHook('preClose', async () => { preClosed(); });
  let closing: Promise<void> | undefined;
  try {
    const baseVersion = await instance.work.repo.head();
    const task = await instance.work.submit('shared HTTP close', { src: 'src/components/Button.tsx:1:1', baseVersion,
      cid: 'Button', bbox: [0, 0, 1, 1], styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px',
        padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' }, instances: 1, ancestors: [] });
    await instance.work.idle();
    expect(instance.work.getTask(task.id).status).toBe('awaiting_approval');
    const card = instance.work.listApprovals()[0];
    const pendingDiff = instance.work.repo.pendingDiff.bind(instance.work.repo);
    vi.spyOn(instance.work.repo, 'pendingDiff').mockImplementationOnce(async (...args) => { entered(); await gate; return pendingDiff(...args); });
    let taskAtBoundary = '', logAtBoundary = '';
    const closeEvents = instance.events.close.bind(instance.events);
    vi.spyOn(instance.events, 'close').mockImplementation(async () => {
      await readFile(lock, 'utf8');
      taskAtBoundary = await readFile(path.join(root, 'data', 'tasks.json'), 'utf8');
      logAtBoundary = await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
      const saved = JSON.parse(taskAtBoundary);
      expect(saved.tasks[0].status).toBe('done');
      expect(saved.approvals[0].status).toBe('approved');
      expect(saved.candidates).toHaveLength(1);
      expect(JSON.parse(logAtBoundary.trim().split('\n').at(-1)!).type).toBe('approval.resolved');
      await closeEvents();
    });
    const origin = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    let responded = false;
    const response = new Promise<number>((resolve, reject) => {
      const req = request(`${origin}/approvals/${card.id}`, { method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', connection: 'close' } }, res => {
        res.resume(); res.once('end', () => { responded = true; resolve(res.statusCode!); });
      });
      req.on('error', reject); req.end(JSON.stringify({ option: 0 }));
    });
    await accepted;
    let closed = false;
    closing = instance.app.close().then(() => { closed = true; });
    await preClose;
    expect(responded).toBe(false);
    expect(closed).toBe(false);
    expect(existsSync(lock)).toBe(true);
    await expect(createApp(options)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    release();
    expect(await response).toBe(200);
    await closing;
    expect(existsSync(lock)).toBe(false);
    await instance.work.idle();
    expect(await readFile(path.join(root, 'data', 'tasks.json'), 'utf8')).toBe(taskAtBoundary);
    expect(await readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).toBe(logAtBoundary);
    const restarted = await createApp(options);
    try {
      expect(restarted.events.last).toBe(instance.events.last);
      expect(restarted.events.publish({ type: 'approval.restart.check' }).seq).toBe(instance.events.last + 1);
      expect(restarted.work.getTask(task.id).status).toBe('done');
    } finally { await restarted.app.close(); }
  } finally {
    release();
    await (closing ?? instance.app.close());
    agent.mockRestore();
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
