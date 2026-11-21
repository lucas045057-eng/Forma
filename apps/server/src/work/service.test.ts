import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Selection } from '@spatial/shared';
import { createCodingAgentMock, type CodingAgentMock, type MockScenario } from '../agent/mock-server.ts';
import type { StudioEvent } from '../events.ts';
import { WorkService } from './service.ts';
import { listenForFetch } from '../test-support/fetch-listener.ts';
import { createMockCheckOptions } from '../test-support/check-executor.ts';

async function fixture(scenario: MockScenario = 'success', delayMs?: number) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m2-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src', 'components'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'App.tsx'), '<button>立即购买</button>\n');
  await writeFile(path.join(workRoot, 'src', 'components', 'Button.tsx'), 'export const Button = () => <button>立即购买</button>;\n');
  const { mock, baseUrl } = await listenForFetch(() => createCodingAgentMock({ scenario, delayMs }));
  const published: StudioEvent[] = [];
  const work = new WorkService({
    checks: createMockCheckOptions(),
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
    await expect(f.work.adopt(task.id)).rejects.toMatchObject({ code: 'CHECKS_NOT_PASSED' });
    const checked = await f.work.startChecks(task.id);
    await vi.waitFor(() => expect(f.work.getCheckRun(checked.id).outcome).toBe('passed'), { timeout: 8000 });
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
}, 15_000); // Task + explicit check proof + adoption + revert are real Git workflows.

it('holds changes outside the selected file and its ancestors for approval', async () => {
  const f = await fixture();
  try {
    const base = (await f.work.version()).version;
    const task = await f.work.submit('修改共享按钮', selection(base, 'src/components/Button.tsx:1:38'));
    await f.work.idle();
    expect(f.work.getTask(task.id).status).toBe('awaiting_approval');
    expect(f.work.listCandidates()).toEqual([]);
    expect(f.work.listApprovals()[0].ruleCodes).toContain('out_of_scope');
    expect(f.work.listApprovals()[0].affected).toContain('src/App.tsx');
  } finally { await cleanup(f); }
});

it('keeps at most three pending candidates and cleans up the oldest', async () => {
  const f = await fixture();
  try {
    const ids: string[] = [];
    const base = (await f.work.version()).version;
    for (let index = 0; index < 4; index += 1) {
      const task = await f.work.submit(`修改 ${index}`, selection(base));
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
}, 15_000); // Four complete real-Git workflows, including eviction and cleanup.

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

it('submits a batch of 3 differentiated variants in parallel, produces 3 independent candidates, and supports single-variant cancel', async () => {
  const f = await fixture('success');
  try {
    const base = (await f.work.version()).version;
    await expect(f.work.submitBatch('   ', selection(base), { count: 2 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.work.submitBatch('数量错误', selection(base), { count: 4 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.work.submitBatch('非法选区', selection(base, '../App.tsx:1:1'), { count: 2 })).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    expect(f.work.listTasks()).toEqual([]);

    const batch = await f.work.submitBatch('把购买按钮做成三种风格对比', selection(base), { count: 3 });
    expect(batch.batchId).toMatch(/^[a-f0-9]{32}$/);
    expect(batch.tasks).toHaveLength(3);
    expect(batch.tasks.map(t => t.variantLabel)).toEqual([
      '方案 A · 稳健精致',
      '方案 B · 对比张力',
      '方案 C · 编排重构',
    ]);
    expect(batch.tasks.map(t => [t.variantIndex, t.variantTotal, t.batchId])).toEqual([
      [1, 3, batch.batchId],
      [2, 3, batch.batchId],
      [3, 3, batch.batchId],
    ]);

    await f.work.idle();
    const candidates = f.work.listCandidates().filter(c => c.decision === 'pending');
    expect(candidates).toHaveLength(3);
    for (const task of batch.tasks) {
      expect(f.work.getTask(task.id)).toMatchObject({
        status: 'done',
        candidateId: task.id,
        batchId: batch.batchId,
      });
    }
  } finally { await cleanup(f); }
}, 20_000);

it('allows cancelling one variant in a running batch while sibling variants complete', async () => {
  const f = await fixture('success', 120);
  // Override agent timeout so 3 rounds * 120ms easily succeed for uncanceled siblings
  f.work['options'].agent.timeoutMs = 5000;
  try {
    const base = (await f.work.version()).version;
    const batch = await f.work.submitBatch('并行取消单个变体测试', selection(base), { count: 2 });
    await vi.waitFor(() => {
      expect(f.work.getTask(batch.tasks[0].id).status).toBe('running');
      expect(f.work.getTask(batch.tasks[1].id).status).toBe('running');
    });
    await f.work.cancel(batch.tasks[0].id);
    await f.work.idle();
    expect(f.work.getTask(batch.tasks[0].id).status).toBe('cancelled');
    expect(f.work.getTask(batch.tasks[1].id).status).toBe('done');
    expect(f.work.listCandidates().filter(c => c.decision === 'pending').map(c => c.id)).toEqual([batch.tasks[1].id]);
  } finally { await cleanup(f); }
}, 15_000);
