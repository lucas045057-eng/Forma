import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Selection } from '@spatial/shared';
import { createCodingAgentMock, type CodingAgentMock, type MockScenario } from '../agent/mock-server.ts';
import type { StudioEvent } from '../events.ts';
import { WorkService } from './service.ts';

async function fixture(scenario: MockScenario = 'success', delayMs?: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m2-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src', 'components'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'App.tsx'), '<button>立即购买</button>\n');
  await writeFile(path.join(workRoot, 'src', 'components', 'Button.tsx'), 'export const Button = () => <button>立即购买</button>;\n');
  const mock = await createCodingAgentMock({ scenario, delayMs });
  const baseUrl = await mock.listen({ host: '127.0.0.1', port: 0 });
  const published: StudioEvent[] = [];
  const work = new WorkService({
    workRoot, directory: path.join(directory, 'data'), emit: event => { const stamped = { ...event, seq: published.length + 1, ts: new Date().toISOString() } as StudioEvent; published.push(stamped); return stamped; },
    agent: { baseUrl, apiKey: 'mock-only', model: 'mock-coder', timeoutMs: delayMs ? 80 : 2000 },
  });
  await work.init();
  const stopped: string[] = [];
  work.previews.start = async id => `/preview/c/${id}/`;
  work.previews.stop = async id => { stopped.push(id); };
  work.previews.stopAll = async () => {};
  return { directory, workRoot, work, mock, published, stopped };
}
async function cleanup(f: { directory: string; work: WorkService; mock: CodingAgentMock }) {
  await f.work.close(); await f.mock.close(); await rm(f.directory, { recursive: true, force: true });
}
function selection(baseVersion: string, src = 'src/App.tsx:1:10'): Selection {
  return { src, baseVersion, cid: 'App', bbox: [0, 0, 10, 10], styles: {} as Selection['styles'], instances: 1, ancestors: [] };
}

it.each([false, true])('drains an admitted direct submit before close returns (selection=%s)', async withSelection => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closing: Promise<void> | undefined;
  try {
    const selected = withSelection ? selection((await f.work.version()).version) : undefined;
    const blocked = f.work.repo.exclusive(() => gate);
    const submitted = f.work.submit('修改购买按钮', selected);
    let closed = false;
    closing = f.work.close().then(() => { closed = true; });
    await expect(f.work.submit('late')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    await expect(f.work.cancel('late')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    expect(closed).toBe(false);
    release(); await blocked;
    const task = await submitted;
    await closing;
    expect(f.work.getTask(task.id)).toMatchObject({ status: 'failed', error: { code: 'SERVICE_STOPPED' } });
    const file = path.join(f.directory, 'data', 'tasks.json');
    const saved = await readFile(file, 'utf8');
    expect(JSON.parse(saved).tasks[0].status).toBe('failed');
    const events = JSON.stringify(f.published);
    await f.work.idle();
    expect(await readFile(file, 'utf8')).toBe(saved);
    expect(JSON.stringify(f.published)).toBe(events);
  } finally { release(); await closing; await cleanup(f); }
});

it('validates source paths, commits, line ranges and stale selections before enqueueing', async () => {
  const f = await fixture();
  try {
    const version = (await f.work.version()).version;
    await expect(f.work.submit('bad', selection(version, '../App.tsx:1:1'))).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await expect(f.work.submit('bad', selection('0'.repeat(40)))).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await expect(f.work.submit('bad', selection(version, 'src/App.tsx:99:1'))).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await writeFile(path.join(f.workRoot, 'src', 'App.tsx'), '<button>已改变</button>\n');
    await expect(f.work.submit('stale', selection(version))).rejects.toMatchObject({ code: 'STALE_SELECTION', status: 409 });
    expect(f.work.listTasks()).toEqual([]);
  } finally { await cleanup(f); }
});

it('runs one task, records checks and scope, then adopts and reverts the work version', async () => {
  const f = await fixture();
  try {
    const base = (await f.work.version()).version;
    const task = await f.work.submit('修改购买按钮', selection(base));
    await f.work.idle();
    const done = f.work.getTask(task.id);
    expect(done.status).toBe('done');
    expect(done.events.map(event => event.sequence)).toEqual(done.events.map((_, index) => index + 1));
    const candidate = f.work.getCandidate(task.id);
    expect(candidate.previewUrl).toBe(`/preview/c/${task.id}/`);
    expect(candidate.outOfScope).toEqual([]);
    expect(candidate.checks.map(check => check.status)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
    expect(await readFile(path.join(f.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
    expect(await readFile(path.join(f.work.repo.candidatePath(task.id), 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    const adopted = await f.work.adopt(task.id);
    expect(adopted.version).not.toBe(base);
    expect(await readFile(path.join(f.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    await f.work.revert();
    expect(await readFile(path.join(f.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
    await expect(f.work.revert()).rejects.toMatchObject({ code: 'NO_ADOPTION' });
    expect(f.mock.sessions).toEqual([task.id, task.id, task.id]);
    expect(f.published.some(event => event.type === 'candidate.ready')).toBe(true);
    expect(f.published.some(event => event.type === 'version.changed')).toBe(true);
  } finally { await cleanup(f); }
});

it('records changes outside the selected file and its ancestors', async () => {
  const f = await fixture();
  try {
    const base = (await f.work.version()).version;
    const task = await f.work.submit('修改共享按钮', selection(base, 'src/components/Button.tsx:1:38'));
    await f.work.idle();
    expect(f.work.getTask(task.id).status).toBe('done');
    expect(f.work.getCandidate(task.id).outOfScope).toEqual(['src/App.tsx']);
  } finally { await cleanup(f); }
});

it('keeps at most three pending candidates and cleans up the oldest', async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const task = await f.work.submit(`修改 ${index}`);
      ids.push(task.id);
      await f.work.idle();
      expect(f.work.getTask(task.id).status).toBe('done');
    }
    const candidates = f.work.listCandidates();
    expect(candidates.filter(candidate => candidate.decision === 'pending')).toHaveLength(3);
    expect(candidates[0]).toMatchObject({ id: ids[0], decision: 'discarded' });
    expect(f.stopped).toContain(ids[0]);
    expect(await f.work.repo.candidateExists(ids[0])).toBe(false);
    await f.work.discard(ids[1]);
    expect(f.work.getCandidate(ids[1]).decision).toBe('discarded');
  } finally { await cleanup(f); }
});

it('cancels a running task and removes its candidate directory', async () => {
  const f = await fixture('success', 250);
  try {
    const task = await f.work.submit('慢任务');
    await vi.waitFor(() => expect(f.work.getTask(task.id).status).toBe('running'));
    await f.work.cancel(task.id);
    await f.work.idle();
    expect(f.work.getTask(task.id).status).toBe('cancelled');
    expect(f.work.listCandidates()).toEqual([]);
    expect(await f.work.repo.candidateExists(task.id)).toBe(false);
  } finally { await cleanup(f); }
});

it('marks an interrupted running task as failed and retryable after restart', async () => {
  const f = await fixture();
  try {
    await f.work.close();
    const file = path.join(f.directory, 'data', 'tasks.json');
    await writeFile(file, JSON.stringify({ tasks: [{ id: 'interrupted', instruction: 'test', status: 'running', events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], candidates: [], adoptions: [] }));
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), emit: f.work['options'].emit, agent: { baseUrl: 'http://127.0.0.1:1', apiKey: 'mock-only', model: 'mock' } });
    await restarted.init();
    expect(restarted.getTask('interrupted')).toMatchObject({ status: 'failed', error: { code: 'SERVICE_RESTARTED' } });
    await restarted.close();
  } finally { await f.mock.close(); await rm(f.directory, { recursive: true, force: true }); }
});
