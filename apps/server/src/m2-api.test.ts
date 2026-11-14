import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createApp } from './app.ts';
import { createCodingAgentMock } from './agent/mock-server.ts';
import { listenForFetch } from './test-support/fetch-listener.ts';
import { createMockCheckOptions } from './test-support/check-executor.ts';

it('exposes the M2 task/candidate/version flow and durable event replay without exposing the agent key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m2-api-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'App.tsx'), '<button>立即购买</button>\n');
  const { mock, baseUrl: codingAgentBaseUrl } = await listenForFetch(() => createCodingAgentMock({ key: 'mock-agent-secret' }));
  const { app, work } = await createApp({
    checks: createMockCheckOptions(),
    workRoot, dataDirectory: path.join(directory, 'assets'), workDataDirectory: path.join(directory, 'm2'), historyDirectory: path.join(directory, 'history'),
    base: 'http://127.0.0.1:1', key: 'mock-only', codingAgentBaseUrl, codingAgentApiKey: 'mock-agent-secret', codingAgentModel: 'mock-coder',
  });
  work.previews.start = async id => `/preview/c/${id}/`;
  work.previews.stop = async () => {};
  work.previews.stopAll = async () => {};
  try {
    const initial = await app.inject('/version');
    expect(initial.statusCode).toBe(200);
    const baseVersion = initial.json().version;
    const created = await app.inject({ method: 'POST', url: '/tasks', payload: {
      instruction: '改按钮',
      selection: { src: 'src/App.tsx:1:10', baseVersion, cid: 'App', bbox: [0, 0, 1, 1], styles: {}, instances: 1, ancestors: [] },
    } });
    expect(created.statusCode).toBe(202);
    const id = created.json().id;
    await work.idle();
    expect((await app.inject(`/tasks/${id}`)).json().status).toBe('done');
    const candidate = (await app.inject(`/candidates/${id}`)).json();
    expect(candidate.checks.every((check: { status: string }) => check.status === 'not_run')).toBe(true);
    expect(candidate.outOfScope).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/candidates/${id}/adopt` })).statusCode).toBe(409);
    const checking = await app.inject({ method: 'POST', url: `/candidates/${id}/checks` });
    expect(checking.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await app.inject(`/checks/${checking.json().id}`)).json().outcome).toBe('passed'), { timeout: 8000 });
    expect((await app.inject({ method: 'POST', url: `/candidates/${id}/adopt` })).statusCode).toBe(200);
    expect(await readFile(path.join(workRoot, 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    expect((await app.inject({ method: 'POST', url: '/version/revert' })).statusCode).toBe(200);
    expect(await readFile(path.join(workRoot, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
    const history = await app.inject('/events/history?since=0');
    expect(history.statusCode).toBe(200);
    expect(history.json().events.some((event: { type: string }) => event.type === 'candidate.ready')).toBe(true);
    expect(history.json().events.map((event: { seq: number }) => event.seq)).toEqual(history.json().events.map((_: unknown, index: number) => index + 1));
    expect(JSON.stringify(history.json())).not.toContain('mock-agent-secret');
    expect((await app.inject('/events/history?since=-1')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/preview/c/${id}/`, payload: {} })).statusCode).toBe(404);
  } finally { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }); }
}, 15_000); // Includes the explicit check/gate workflow added by M3-B.
