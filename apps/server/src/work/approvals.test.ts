import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Selection } from '@spatial/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CodingAgent } from '../agent/client.ts';
import type { StudioEvent } from '../events.ts';
import { WorkService } from './service.ts';
import { WorkRepo } from './repo.ts';

function agentSpy() { return vi.spyOn(CodingAgent.prototype, 'run'); }
function saveSpy(work: WorkService) { return vi.spyOn(work as unknown as { save: () => Promise<void> }, 'save'); }
const agentOptions = { baseUrl: 'http://127.0.0.1:1', apiKey: 'mock-only', model: 'mock-coder' };
let agent: ReturnType<typeof agentSpy>;
let modelCalls = 0;
beforeEach(() => {
  modelCalls = 0;
  agent = vi.spyOn(CodingAgent.prototype, 'run').mockImplementation(async ({ root, instruction }) => {
    modelCalls += 1;
    if (instruction.includes('multi')) {
      await writeFile(path.join(root, 'src/components/Button.tsx'), 'export function Button() { return <button>共享</button>; }\n');
      await writeFile(path.join(root, 'src/style.css'), 'button { border-radius: 8px; }\n');
    } else if (instruction.includes('shared')) await writeFile(path.join(root, 'src/components/Button.tsx'), 'export function Button() { return <button style={{ borderRadius: 8 }}>购买</button>; }\n');
    else if (instruction.includes('local')) await writeFile(path.join(root, 'src/App.tsx'), "import { Button } from './components/Button';\nexport default () => <><p>局部文案</p><Button/><Button/><Button/></>;\n");
    else if (instruction.includes('package')) await writeFile(path.join(root, 'package.json'), '{"changed":true}\n');
    return { summary: `完成 ${instruction}`, written: [] };
  });
});
afterEach(() => { agent.mockRestore(); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-m3-approvals-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src/components'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), "import { Button } from './components/Button';\nexport default () => <><Button/><Button/><Button/></>;\n");
  await writeFile(path.join(workRoot, 'src/components/Button.tsx'), 'export function Button() { return <button>购买</button>; }\n');
  await writeFile(path.join(workRoot, 'src/style.css'), 'button { color: black; }\n');
  const published: StudioEvent[] = [];
  const work = new WorkService({ workRoot, directory: path.join(directory, 'data'), agent: agentOptions, emit: event => {
    const stamped = { ...event, seq: published.length + 1, ts: new Date().toISOString() } as StudioEvent;
    published.push(stamped); return stamped;
  } });
  await work.init();
  const previewStarts: string[] = [];
  work.previews.start = async id => { previewStarts.push(id); return `/preview/c/${id}/`; };
  work.previews.stop = async () => {};
  work.previews.stopAll = async () => {};
  const baseVersion = await work.repo.head();
  return { directory, workRoot, work, published, previewStarts, baseVersion };
}

function selection(baseVersion: string, src = 'src/components/Button.tsx:1:1'): Selection {
  const styles: Selection['styles'] = { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px',
    padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' };
  return { src, baseVersion, cid: 'Button', bbox: [0, 0, 10, 10], styles, instances: 1, ancestors: [] };
}

async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  await f.work.close(); await rm(f.directory, { recursive: true, force: true });
}

function expectStatus(work: WorkService, id: string, status: string) {
  const task = work.getTask(id);
  expect(task.status, `任务 ${id}：${JSON.stringify(task.error ?? { code: 'NONE', message: '无错误记录' })}`).toBe(status);
}

it('holds a shared edit in private staging, then approves exactly that draft without another model call', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared radius', selection(f.baseVersion));
    await f.work.idle();
    expectStatus(f.work, task.id, 'awaiting_approval');
    expect(f.work.listCandidates()).toEqual([]);
    expect(() => f.work.getCandidate(task.id)).toThrow('候选版本不存在');
    await expect(f.work.adopt(task.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.previewStarts).toEqual([]);
    expect(f.work.listApprovals()).toHaveLength(1);
    const card = f.work.listApprovals()[0];
    expect(card).toMatchObject({ taskId: task.id, status: 'pending', baseVersion: f.baseVersion, ruleCodes: ['shared_component'] });
    expect(card.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await f.work.repo.candidateExists(task.id)).toBe(true);
    expect(await readFile(path.join(f.workRoot, 'src/components/Button.tsx'), 'utf8')).not.toContain('borderRadius');
    expect(f.published.filter(event => event.type === 'approval.requested')).toHaveLength(1);
    expect(f.published.some(event => event.type === 'candidate.ready')).toBe(false);

    const approved = await f.work.answerApproval(card.id, 0);
    expect(approved.task.status).toBe('done');
    expect(approved.approval.status).toBe('approved');
    expect(f.work.listCandidates()).toHaveLength(1);
    expect(f.previewStarts).toEqual([task.id]);
    expect(modelCalls).toBe(1);
    expect(f.published.filter(event => event.type === 'candidate.ready')).toHaveLength(1);
    expect(f.published.filter(event => event.type === 'approval.resolved')).toHaveLength(1);
    const repeated = await f.work.answerApproval(card.id, 0);
    expect(repeated).toEqual(approved);
    expect(modelCalls).toBe(1);
    expect(f.previewStarts).toEqual([task.id]);
    await expect(f.work.answerApproval(card.id, 1)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_ANSWERED', status: 409 });
  } finally { await cleanup(f); }
});

it('rejects and cancels awaiting tasks with staging cleanup and no public candidate', async () => {
  const f = await fixture();
  try {
    const rejected = await f.work.submit('shared reject', selection(f.baseVersion));
    await f.work.idle();
    const rejectedCard = f.work.listApprovals()[0];
    const response = await f.work.answerApproval(rejectedCard.id, 1);
    expect(response.task.status).toBe('cancelled');
    expect(response.approval.status).toBe('rejected');
    expect(await f.work.repo.candidateExists(rejected.id)).toBe(false);
    expect(f.work.listCandidates()).toEqual([]);
    expect((await f.work.answerApproval(rejectedCard.id, 1)).approval.status).toBe('rejected');
    await expect(f.work.answerApproval(rejectedCard.id, 0)).rejects.toMatchObject({ code: 'APPROVAL_ALREADY_ANSWERED' });

    const cancelled = await f.work.submit('shared cancel', selection(f.baseVersion));
    await f.work.idle();
    await f.work.cancel(cancelled.id);
    expectStatus(f.work, cancelled.id, 'cancelled');
    expect(f.work.getApproval(f.work.listApprovals()[1].id).status).toBe('cancelled');
    expect(await f.work.repo.candidateExists(cancelled.id)).toBe(false);
    expect(f.work.listCandidates()).toEqual([]);
  } finally { await cleanup(f); }
});

it('releases the task queue while awaiting and allows a later local task', async () => {
  const f = await fixture();
  try {
    const waiting = await f.work.submit('shared waiting', selection(f.baseVersion));
    await f.work.idle();
    const local = await f.work.submit('local copy', selection(f.baseVersion, 'src/App.tsx:2:1'));
    await f.work.idle();
    expectStatus(f.work, waiting.id, 'awaiting_approval');
    expectStatus(f.work, local.id, 'done');
    expect(f.work.listCandidates().map(candidate => candidate.id)).toEqual([local.id]);
    expect(modelCalls).toBe(2);
  } finally { await cleanup(f); }
});

it('combines rules into one card and enforces the three-pending-card limit', async () => {
  const f = await fixture();
  try {
    const multi = await f.work.submit('multi shared', selection(f.baseVersion));
    await f.work.idle();
    expect(f.work.listApprovals()).toHaveLength(1);
    expect(f.work.getApproval(f.work.listApprovals()[0].id).ruleCodes).toEqual(expect.arrayContaining(['shared_component', 'global_style']));
    for (const name of ['second', 'third']) {
      await f.work.submit(`shared ${name}`, selection(f.baseVersion));
      await f.work.idle();
    }
    expect(f.work.listApprovals().filter(card => card.status === 'pending')).toHaveLength(3);
    const overflow = await f.work.submit('shared overflow', selection(f.baseVersion));
    await f.work.idle();
    expectStatus(f.work, overflow.id, 'failed');
    expect(f.work.getTask(overflow.id)).toMatchObject({ error: { code: 'APPROVAL_LIMIT' } });
    expect(f.work.listApprovals()).toHaveLength(3);
    expect(await f.work.repo.candidateExists(overflow.id)).toBe(false);
  } finally { await cleanup(f); }
});

it('binds answers to the exact draft digest and current main version', async () => {
  const f = await fixture();
  try {
    const changed = await f.work.submit('shared digest', selection(f.baseVersion));
    await f.work.idle();
    await writeFile(path.join(f.work.repo.candidatePath(changed.id), 'src/components/Button.tsx'), 'export function Button() { return <button>篡改</button>; }\n');
    await expect(f.work.answerApproval(f.work.listApprovals()[0].id, 0)).rejects.toMatchObject({ code: 'STALE_APPROVAL', status: 409 });
    expect(f.work.listCandidates()).toEqual([]);

    const moved = await f.work.submit('shared version', selection(f.baseVersion));
    await f.work.idle();
    await writeFile(path.join(f.workRoot, 'src/App.tsx'), 'export default () => <p>主作品已变化</p>;\n');
    await f.work.version();
    await expect(f.work.answerApproval(f.work.listApprovals()[1].id, 0)).rejects.toMatchObject({ code: 'STALE_APPROVAL', status: 409 });
    expect(f.work.listCandidates()).toEqual([]);
  } finally { await cleanup(f); }
});

it('hard-fails package changes instead of offering an approval card', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('package change', selection(f.baseVersion, 'src/App.tsx:2:1'));
    await f.work.idle();
    expectStatus(f.work, task.id, 'failed');
    expect(f.work.getTask(task.id)).toMatchObject({ error: { code: 'UNSAFE_CANDIDATE_DIFF' } });
    expect(f.work.listApprovals()).toEqual([]);
    expect(f.work.listCandidates()).toEqual([]);
    expect(await f.work.repo.candidateExists(task.id)).toBe(false);
  } finally { await cleanup(f); }
});

it('preserves a pending card and its staging across restart without approving it', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared restart', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    const before = await readFile(path.join(f.work.repo.candidatePath(task.id), 'src/components/Button.tsx'), 'utf8');
    await f.work.close();
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: f.work['options'].emit });
    restarted.previews.start = async id => `/preview/c/${id}/`;
    restarted.previews.stop = async () => {};
    restarted.previews.stopAll = async () => {};
    try {
      await restarted.init();
      expectStatus(restarted, task.id, 'awaiting_approval');
      expect(restarted.getApproval(card.id).status).toBe('pending');
      expect(await readFile(path.join(restarted.repo.candidatePath(task.id), 'src/components/Button.tsx'), 'utf8')).toBe(before);
      expect(restarted.listCandidates()).toEqual([]);
      expect(modelCalls).toBe(1);
    } finally { await restarted.close(); }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('recovers a persisted approval after the commit without creating a second commit or public event', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared recover', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    await f.work.close();
    const file = path.join(f.directory, 'data', 'tasks.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.approvals[0] = { ...saved.approvals[0], status: 'approved', answer: { option: 0, at: new Date().toISOString() } };
    saved.approvalIntent = { kind: 'approve', id: card.id, taskId: task.id, before: f.baseVersion, contentDigest: card.contentDigest };
    await writeFile(file, JSON.stringify(saved));
    const repo = new WorkRepo({ workRoot: f.workRoot, dataDirectory: path.join(f.directory, 'data') });
    await repo.commitCandidate(task.id, saved.approvals[0].summary);
    const committed = await repo.candidateCommit(task.id);
    const events: StudioEvent[] = [];
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: event => {
      const stamped = { ...event, seq: events.length + 1, ts: new Date().toISOString() } as StudioEvent; events.push(stamped); return stamped;
    } });
    restarted.previews.start = async id => `/preview/c/${id}/`;
    restarted.previews.stop = async () => {};
    restarted.previews.stopAll = async () => {};
    try {
      await restarted.init();
      expect(await restarted.repo.candidateCommit(task.id)).toBe(committed);
      expectStatus(restarted, task.id, 'done');
      expect(restarted.listCandidates()).toHaveLength(1);
      expect(events.filter(event => event.type === 'candidate.ready')).toHaveLength(1);
      const snapshot = JSON.stringify(events);
      await restarted.finalizeApprovedTask(task.id);
      expect(JSON.stringify(events)).toBe(snapshot);
      expect(modelCalls).toBe(1);
    } finally { await restarted.close(); }
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

it('rolls back a new card when its first durable save fails before cleanup', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let save: ReturnType<typeof saveSpy> | undefined;
  try {
    agent.mockImplementationOnce(async ({ root }) => {
      entered(); await gate;
      await writeFile(path.join(root, 'src/components/Button.tsx'), 'export function Button() { return <button>保存失败</button>; }\n');
      return { summary: 'shared save failure', written: ['src/components/Button.tsx'] };
    });
    const task = await f.work.submit('shared save failure', selection(f.baseVersion));
    await started;
    save = saveSpy(f.work).mockRejectedValueOnce(new Error('injected first card save failure'));
    release();
    await f.work.idle();
    expectStatus(f.work, task.id, 'failed');
    expect(f.work.listApprovals()).toEqual([]);
    expect(f.work.listCandidates()).toEqual([]);
    expect(await f.work.repo.candidateExists(task.id)).toBe(false);
    expect(f.published.some(event => event.type === 'approval.requested' || event.type === 'candidate.ready')).toBe(false);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'data', 'tasks.json'), 'utf8'));
    expect(saved.approvals).toEqual([]);
    expect(saved.tasks[0].status).toBe('failed');
  } finally { release(); save?.mockRestore(); await cleanup(f); }
});

it('does not broadcast or publish when persisting an approval answer fails', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared write failure', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    const save = vi.spyOn(f.work as unknown as { save: () => Promise<void> }, 'save').mockRejectedValueOnce(new Error('injected disk failure'));
    await expect(f.work.answerApproval(card.id, 0)).rejects.toThrow('injected disk failure');
    save.mockRestore();
    expectStatus(f.work, task.id, 'awaiting_approval');
    expect(f.work.getApproval(card.id).status).toBe('pending');
    expect(f.work.listCandidates()).toEqual([]);
    expect(f.previewStarts).toEqual([]);
    expect(f.published.some(event => event.type === 'approval.resolved' || event.type === 'candidate.ready')).toBe(false);
  } finally { await cleanup(f); }
});

it('drains an admitted direct answer before close and refuses later answers', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const accepted = new Promise<void>(resolve => { entered = resolve; });
  let closing: Promise<void> | undefined;
  try {
    const task = await f.work.submit('shared direct close', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    const pendingDiff = f.work.repo.pendingDiff.bind(f.work.repo);
    vi.spyOn(f.work.repo, 'pendingDiff').mockImplementationOnce(async (...args) => { entered(); await gate; return pendingDiff(...args); });
    const answer = f.work.answerApproval(card.id, 0);
    await accepted;
    let closed = false;
    closing = f.work.close().then(() => { closed = true; });
    await expect(f.work.answerApproval(card.id, 0)).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
    expect(closed).toBe(false);
    release();
    expect((await answer).task.status).toBe('done');
    await closing;
    expectStatus(f.work, task.id, 'done');
    const saved = await readFile(path.join(f.directory, 'data', 'tasks.json'), 'utf8');
    const events = JSON.stringify(f.published);
    await f.work.idle();
    expect(await readFile(path.join(f.directory, 'data', 'tasks.json'), 'utf8')).toBe(saved);
    expect(JSON.stringify(f.published)).toBe(events);
  } finally { release(); await closing; await cleanup(f); }
});

it.each(['Error', 'AbortError'])('isolates preview %s to its approval and permits another card and restart', async name => {
  const f = await fixture();
  try {
    const first = await f.work.submit('shared A', selection(f.baseVersion));
    await f.work.idle();
    const second = await f.work.submit('shared B', selection(f.baseVersion));
    await f.work.idle();
    const [a, b] = f.work.listApprovals();
    const start = vi.spyOn(f.work.previews, 'start').mockRejectedValueOnce(Object.assign(new Error('private preview diagnostic'), { name }));
    const response = await f.work.answerApproval(a.id, 0);
    expect(response.approval.status).toBe('failed');
    expect(response.task).toMatchObject({ status: 'failed', error: { code: 'PREVIEW_FAILED' } });
    expect(JSON.stringify(response)).not.toContain('private preview diagnostic');
    expect(f.work.listCandidates()).toEqual([]);
    expect(await f.work.repo.candidateExists(first.id)).toBe(false);
    expect(f.published.filter(event => event.type === 'candidate.ready')).toEqual([]);
    expect(await f.work.answerApproval(a.id, 0)).toEqual(response);
    expect(start).toHaveBeenCalledTimes(1);
    expect((await f.work.answerApproval(b.id, 1)).task.status).toBe('cancelled');
    expectStatus(f.work, second.id, 'cancelled');
    expect(modelCalls).toBe(2);
    await f.work.close();
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: f.work['options'].emit });
    const restartStart = vi.spyOn(restarted.previews, 'start').mockRejectedValue(new Error('must not replay failed preview'));
    try {
      await restarted.init();
      expect(restarted.getApproval(a.id).status).toBe('failed');
      expectStatus(restarted, first.id, 'failed');
      expect(restarted.getApproval(b.id).status).toBe('rejected');
      expect(restartStart).not.toHaveBeenCalled();
      expect(modelCalls).toBe(2);
    } finally { await restarted.close(); }
  } finally { await cleanup(f); }
});

it('recovers a committed approval with a failing preview without preventing startup', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared recovery preview failure', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    await f.work.close();
    const file = path.join(f.directory, 'data', 'tasks.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    saved.approvals[0].answer = { option: 0, at: new Date().toISOString() };
    saved.approvals[0].status = 'approved';
    saved.approvalIntent = { kind: 'approve', id: card.id, taskId: task.id, before: f.baseVersion, contentDigest: card.contentDigest };
    await writeFile(file, JSON.stringify(saved));
    const repo = new WorkRepo({ workRoot: f.workRoot, dataDirectory: path.join(f.directory, 'data') });
    await repo.commitCandidate(task.id, saved.approvals[0].summary);
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: f.work['options'].emit });
    vi.spyOn(restarted.previews, 'start').mockRejectedValue(new Error('recovery preview failure'));
    try {
      await restarted.init();
      expect(restarted.getApproval(card.id).status).toBe('failed');
      expect(restarted.getTask(task.id)).toMatchObject({ status: 'failed', error: { code: 'PREVIEW_FAILED' } });
      expect(restarted.listCandidates()).toEqual([]);
      expect(JSON.parse(await readFile(file, 'utf8')).approvalIntent).toBeUndefined();
      expect(f.published.filter(event => event.type === 'candidate.ready')).toEqual([]);
      expect(modelCalls).toBe(1);
    } finally { await restarted.close(); }
  } finally { await cleanup(f); }
});

it('resumes failed-preview cleanup after terminal save failure without restarting preview', async () => {
  const f = await fixture();
  let save: ReturnType<typeof saveSpy> | undefined;
  try {
    const task = await f.work.submit('shared terminal failure', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    const originalSave = f.work['save'].bind(f.work);
    vi.spyOn(f.work.previews, 'start').mockImplementationOnce(async () => {
      save = saveSpy(f.work).mockImplementationOnce(originalSave).mockRejectedValueOnce(new Error('terminal disk failure'));
      throw new Error('preview fault');
    });
    await expect(f.work.answerApproval(card.id, 0)).rejects.toThrow('terminal disk failure');
    save?.mockRestore();
    expect(f.work.listCandidates()).toEqual([]);
    expect(f.published.some(event => event.type === 'approval.resolved' || event.type === 'candidate.ready')).toBe(false);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'data/tasks.json'), 'utf8'));
    expect(saved.approvalIntent.kind).toBe('preview_failed');
    await f.work.close();
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: f.work['options'].emit });
    const preview = vi.spyOn(restarted.previews, 'start').mockRejectedValue(new Error('must not start'));
    try {
      await restarted.init();
      expect(restarted.getApproval(card.id).status).toBe('failed');
      expectStatus(restarted, task.id, 'failed');
      expect(preview).not.toHaveBeenCalled();
      expect(modelCalls).toBe(1);
    } finally { await restarted.close(); }
  } finally { save?.mockRestore(); await cleanup(f); }
});

it.each(['save', 'cleanup'])('retains stale cleanup intent across %s failure and restart', async failure => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared stale failure', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    await writeFile(path.join(f.work.repo.candidatePath(task.id), 'src/components/Button.tsx'), 'export const changed = 1;');
    const fault = failure === 'save' ? saveSpy(f.work).mockRejectedValueOnce(new Error('stale save failure'))
      : vi.spyOn(f.work.repo, 'removeCandidate').mockRejectedValueOnce(new Error('stale cleanup failure'));
    await expect(f.work.answerApproval(card.id, 0)).rejects.toThrow(`stale ${failure} failure`);
    fault.mockRestore();
    expect(await f.work.repo.candidateExists(task.id)).toBe(true);
    expect(f.work.getApproval(card.id).status).toBe('pending');
    expect(f.published.some(event => event.type === 'approval.resolved')).toBe(false);
    if (failure === 'save') {
      await expect(f.work.answerApproval(card.id, 0)).rejects.toMatchObject({ code: 'STALE_APPROVAL' });
    }
    await f.work.close();
    const restarted = new WorkService({ workRoot: f.workRoot, directory: path.join(f.directory, 'data'), agent: agentOptions, emit: f.work['options'].emit });
    try {
      await restarted.init();
      expect(restarted.getApproval(card.id).status).toBe('stale');
      expect(await restarted.repo.candidateExists(task.id)).toBe(false);
      expectStatus(restarted, task.id, 'failed');
      expect(modelCalls).toBe(1);
    } finally { await restarted.close(); }
  } finally { await cleanup(f); }
});

it.each(['draft', 'main'])('persists stale %s approvals, releases capacity and rejects repeated answers consistently', async changed => {
  const f = await fixture();
  try {
    for (let index = 0; index < 3; index++) {
      await f.work.submit(`shared ${index}`, selection(f.baseVersion));
      await f.work.idle();
    }
    const card = f.work.listApprovals()[0];
    if (changed === 'draft') {
      await writeFile(path.join(f.work.repo.candidatePath(card.taskId), 'src/components/Button.tsx'), 'export function Button() { return <button>changed</button>; }\n');
    } else {
      await writeFile(path.join(f.workRoot, 'src/style.css'), 'button { color: red; }\n');
    }
    await expect(f.work.answerApproval(card.id, 0)).rejects.toMatchObject({ code: 'STALE_APPROVAL', status: 409 });
    expect(f.work.getApproval(card.id).status).toBe('stale');
    expect(f.work.getTask(card.taskId)).toMatchObject({ status: 'failed', error: { code: 'STALE_APPROVAL' } });
    expect(await f.work.repo.candidateExists(card.taskId)).toBe(false);
    expect(f.work.listCandidates()).toEqual([]);
    expect(f.work.listApprovals().filter(item => item.status === 'pending')).toHaveLength(2);
    for (const option of [0, 1] as const) await expect(f.work.answerApproval(card.id, option)).rejects.toMatchObject({ code: 'STALE_APPROVAL', status: 409 });
    const next = await f.work.submit('shared replacement', selection((await f.work.version()).version));
    await f.work.idle();
    expectStatus(f.work, next.id, 'awaiting_approval');
    expect(f.work.listApprovals().filter(item => item.status === 'pending')).toHaveLength(3);
    const saved = JSON.parse(await readFile(path.join(f.directory, 'data', 'tasks.json'), 'utf8'));
    expect(saved.approvals.find((item: { id: string }) => item.id === card.id).status).toBe('stale');
    expect(f.published.filter(event => event.type === 'approval.resolved')).toHaveLength(1);
  } finally { await cleanup(f); }
});

it('serializes approve, reject and cancel so only one terminal transition wins', async () => {
  const f = await fixture();
  try {
    const task = await f.work.submit('shared race', selection(f.baseVersion));
    await f.work.idle();
    const card = f.work.listApprovals()[0];
    const results = await Promise.allSettled([f.work.answerApproval(card.id, 0), f.work.answerApproval(card.id, 1), f.work.cancel(task.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(['done', 'cancelled']).toContain(f.work.getTask(task.id).status);
    expect(f.work.listCandidates().length <= 1).toBe(true);
    expect(modelCalls).toBe(1);
  } finally { await cleanup(f); }
});
