import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.ts';
import { createPreviewOrigin } from './work/preview-origin.ts';
import { EventLog } from './events.ts';

it('rejects preview-origin mutations before any task or paid upstream work, and exposes no API on preview listener', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'isolation-'));
  await mkdir(path.join(root, 'work/src'), { recursive: true });
  await writeFile(path.join(root, 'work/src/App.tsx'), '<div/>');
  const { app, work, service } = await createApp({ workRoot: path.join(root, 'work'), dataDirectory: path.join(root, 'assets'), base: 'http://127.0.0.1:1', key: 'fake-only' });
  const server = createPreviewOrigin(work.previews);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    for (const [method, url] of [['PUT', '/scene'], ['POST', '/assets/lux3d'], ['POST', '/tasks'], ['POST', '/candidates/example/adopt'], ['POST', '/version/revert']] as const) {
      const result = await app.inject({ method, url, headers: { origin: 'http://127.0.0.1:5175' }, payload: {} });
      expect(result.statusCode).toBe(403);
      expect(result.json().error.code).toBe('ORIGIN_DENIED');
      expect((await fetch(`http://127.0.0.1:${address.port}${url}`, { method })).status).toBe(404);
    }
    expect(service.list()).toEqual([]);
    expect(work.listTasks()).toEqual([]);
    expect(work.listCandidates()).toEqual([]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await app.close(); await rm(root, { recursive: true, force: true }); }
});

it('repairs torn event tails before appending and never broadcasts on disk failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'events-repair-'));
  try {
    const filename = path.join(root, 'events.jsonl');
    await writeFile(filename, '{"type":"a","seq":1,"ts":"now"}\n{"seq":2');
    const log = new EventLog(root); await log.init();
    log.publish({ type: 'b' });
    const reopened = new EventLog(root); await reopened.init();
    expect(reopened.last).toBe(2);
    expect(reopened.publish({ type: 'c' }).seq).toBe(3);
    expect((await readFile(filename, 'utf8')).trim().split('\n')).toHaveLength(3);
    await rm(filename); await mkdir(filename);
    let deliveries = 0;
    reopened.subscribe(() => { deliveries++; });
    expect(() => reopened.publish({ type: 'error' })).toThrow();
    expect(deliveries).toBe(0);
    expect(reopened.last).toBe(3);
    expect(() => reopened.publish({ type: 'retry' })).toThrow('restart required');
  } finally { await rm(root, { recursive: true, force: true }); }
});
