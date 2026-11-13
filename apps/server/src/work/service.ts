import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { acquireInstanceLock } from '../assets/instance-lock.ts';
import path from 'node:path';
import type { Candidate, Check, Selection, Task } from '@spatial/shared';
import { writeAtomic } from '../assets/atomic-file.ts';
import { CodingAgent, CodingAgentError, type CodingAgentOptions } from '../agent/client.ts';
import { Sandbox, ToolError } from '../agent/tools.ts';
import type { StudioEvent } from '../events.ts';
import { PreviewManager, previewBase } from './preview.ts';
import { WorkRepo, WorkError } from './repo.ts';

interface StoredTask extends Task {
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}
interface StoredCandidate extends Candidate { taskId: string; createdAt: string }
interface Adoption { mergeCommit: string; candidateId: string; at: string }
interface State { tasks: StoredTask[]; candidates: StoredCandidate[]; adoptions: Adoption[]; intent?: { kind: 'adopt' | 'revert' | 'discard'; id: string; before: string; target?: string } }

export interface WorkServiceOptions {
  /** The caller already holds the instance lock of `directory` (createApp does, so the event log is covered too). */
  lockHeld?: boolean;
  workRoot: string;
  directory: string;
  agent: CodingAgentOptions;
  emit: (event: { type: string } & Record<string, unknown>) => StudioEvent;
  previewStartTimeoutMs?: number;
}

const checks = (): Check[] => ['build', 'smoke', 'occlusion', 'schema'].map(name => ({ name: name as Check['name'], status: 'not_run' }));
const clone = <T>(value: T): T => structuredClone(value);

/** Single-worker task scheduler plus the durable candidate/version lifecycle. */
export class WorkService {
  readonly repo: WorkRepo;
  readonly previews: PreviewManager;
  private readonly options: WorkServiceOptions;
  private readonly file: string;
  private state: State = { tasks: [], candidates: [], adoptions: [] };
  private writes: Promise<void> = Promise.resolve();
  private taskQueue: Promise<void> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private closing = false;
  private inFlight = new Set<Promise<unknown>>();
  private releaseLock?: () => Promise<void>;

  constructor(options: WorkServiceOptions) {
    this.options = options;
    this.file = path.join(options.directory, 'tasks.json');
    this.repo = new WorkRepo({ workRoot: options.workRoot, dataDirectory: options.directory });
    this.previews = new PreviewManager({ workRoot: options.workRoot, cacheDirectory: path.join(options.directory, 'preview-cache'), startTimeoutMs: options.previewStartTimeoutMs });
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    // These mutations can await work outside the repo queue. Register admission
    // synchronously so close cannot miss a submit that has not enqueued its task yet.
    for (const name of ['submit', 'cancel']) {
      const operation = methods[name].bind(this);
      methods[name] = (...args) => {
        if (this.closing) return Promise.reject(new WorkError('SERVICE_CLOSING', '后端正在关闭，未接受任务操作', 503));
        const pending = operation(...args);
        this.inFlight.add(pending);
        void pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
        return pending;
      };
    }
    for (const name of ['version', 'validateSelection', 'adopt', 'discard', 'revert', 'trimCandidates']) {
      const operation = methods[name].bind(this);
      methods[name] = (...args) => this.repo.exclusive(async () => { await this.recoverIntent(); return operation(...args); });
    }
  }

  async init() {
    await mkdir(this.options.directory, { recursive: true });
    if (!this.options.lockHeld) this.releaseLock = await acquireInstanceLock(this.options.directory);
    await this.repo.init();
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as State;
      if (!Array.isArray(saved.tasks) || !Array.isArray(saved.candidates) || !Array.isArray(saved.adoptions)) throw new Error('invalid state');
      this.state = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 M2 任务状态 tasks.json'); }
    await this.recoverIntent();
    for (const entry of await readdir(this.repo.candidatesDir, { withFileTypes: true })) {
      if (/^[a-z0-9]{6,32}$/.test(entry.name) && !this.state.candidates.some(c => c.id === entry.name && c.decision === 'pending')) await this.repo.removeCandidate(entry.name);
    }
    let recovered = false;
    for (const task of this.state.tasks) {
      if (task.status === 'running' || task.status === 'queued') {
        task.status = 'failed';
        task.updatedAt = new Date().toISOString();
        task.error = { code: 'SERVICE_RESTARTED', message: '服务重启中断了任务；请确认选中对象后重新提交' };
        task.events.push({ type: 'task.updated', ts: task.updatedAt, sequence: task.events.length + 1, message: task.error.message });
        this.options.emit({ type: 'task.updated', task: clone(task) });
        recovered = true;
      }
    }
    if (recovered) await this.save();
  }

  private async recoverIntent() {
    const intent = this.state.intent;
    if (!intent) return;
    const head = await this.repo.head();
    const candidate = this.state.candidates.find(c => c.id === intent.id);
    if (intent.kind === 'discard') {
      await this.previews.stop(intent.id);
      await this.repo.removeCandidate(intent.id);
      if (candidate) candidate.decision = 'discarded';
    } else if (head !== intent.before) {
      const target = intent.target;
      if (!await this.repo.transitionMatches(intent.before, intent.kind, intent.id, target)) throw new WorkError('RECOVERY_CONFLICT', '作品历史与未完成意图不一致，请保留数据并人工检查', 409);
      if (intent.kind === 'adopt') {
        if (candidate) candidate.decision = 'adopted';
        if (!this.state.adoptions.some(a => a.mergeCommit === head)) this.state.adoptions.push({ mergeCommit: head, candidateId: intent.id, at: new Date().toISOString() });
      } else if (this.state.adoptions.at(-1)?.candidateId === intent.id) this.state.adoptions.pop();
    }
    this.state.intent = undefined;
    try { await this.save(); } catch (error) { this.state.intent = intent; throw error; }
  }

  private save() {
    const json = JSON.stringify(this.state, null, 2);
    const operation = this.writes.then(() => writeAtomic(this.file, json));
    this.writes = operation.catch(() => {});
    return operation;
  }

  private task(id: string) {
    const task = this.state.tasks.find(item => item.id === id);
    if (!task) throw new WorkError('NOT_FOUND', '任务不存在', 404);
    return task;
  }
  private candidate(id: string) {
    const candidate = this.state.candidates.find(item => item.id === id);
    if (!candidate) throw new WorkError('NOT_FOUND', '候选版本不存在', 404);
    return candidate;
  }
  private async append(task: StoredTask, message: string) {
    task.updatedAt = new Date().toISOString();
    task.events.push({ type: 'task.updated', ts: task.updatedAt, sequence: task.events.length + 1, message });
    await this.save();
    this.options.emit({ type: 'task.updated', task: clone(task) });
  }
  private async snapshot() {
    const previous = await this.repo.head();
    const version = await this.repo.snapshot();
    if (version !== previous) this.options.emit({ type: 'version.changed', version, previous, reason: 'snapshot' });
    return version;
  }

  async version() { return { version: await this.snapshot() }; }

  async submit(instruction: string, selection?: Selection) {
    await this.validateSelection(selection);
    const now = new Date().toISOString();
    const task: StoredTask = { id: randomUUID().replaceAll('-', ''), instruction, selection, status: 'queued', events: [], createdAt: now, updatedAt: now };
    this.state.tasks.push(task);
    await this.append(task, '任务已排队');
    this.taskQueue = this.taskQueue.then(() => this.execute(task.id)).catch(() => {});
    return clone(task);
  }

  private async validateSelection(selection?: Selection) {
    if (!selection) return;
    const match = /^(src\/[A-Za-z0-9_./-]+):([1-9]\d*):([1-9]\d*)$/.exec(selection.src);
    if (!match || match[1].split('/').includes('..') || selection.src.includes('\\')) throw new WorkError('INVALID_SELECTION', '选中对象的 src 必须是 src/…:行:列');
    await this.snapshot();
    if (!await this.repo.isCommit(selection.baseVersion)) throw new WorkError('INVALID_SELECTION', 'baseVersion 不是作品版本库中的提交');
    const file = match[1];
    if (await this.repo.fileChangedSince(selection.baseVersion, file)) throw new WorkError('STALE_SELECTION', '选中文件在点选后已变化，请重新点选', 409);
    let source: string;
    try { source = await new Sandbox(this.options.workRoot).read(file); }
    catch (error) { throw new WorkError('INVALID_SELECTION', error instanceof ToolError ? '选中文件不存在或不可读取' : '选中文件校验失败'); }
    if (Number(match[2]) > source.split('\n').length) throw new WorkError('INVALID_SELECTION', '选中对象的源码行号超出文件范围');
  }

  private async execute(id: string) {
    const task = this.task(id);
    if (task.status !== 'queued') return;
    if (this.closing) {
      task.status = 'failed';
      task.error = { code: 'SERVICE_STOPPED', message: '服务已停止，请重新提交任务' };
      await this.append(task, task.error.message);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let created = false;
    try {
      task.status = 'running';
      task.error = undefined;
      await this.append(task, '开始校验选中对象并创建候选版本');
      await this.validateSelection(task.selection);
      const base = await this.snapshot();
      await this.repo.createCandidate(id, base);
      created = true;
      await this.append(task, '候选目录已创建，编码 Agent 开始工作');
      const agent = new CodingAgent({
        ...this.options.agent,
        onStep: async message => { await this.append(task, message); },
      });
      const result = await agent.run({ taskId: id, instruction: task.instruction, selection: task.selection, root: this.repo.candidatePath(id), signal: controller.signal });
      controller.signal.throwIfAborted();
      const changed = await this.repo.commitCandidate(id, result.summary);
      if (!changed.length) throw new WorkError('NO_CHANGES', '编码 Agent 没有产生任何文件改动', 409);
      const allowed = new Set(task.selection ? [task.selection.src, ...(Array.isArray(task.selection.ancestors) ? task.selection.ancestors : [])].map(src => src.replace(/:\d+:\d+$/, '')) : []);
      const candidate: StoredCandidate = {
        id, taskId: id, baseVersion: base, branch: this.repo.branch(id), previewUrl: '', createdAt: new Date().toISOString(),
        diff: await this.repo.diff(id, base), outOfScope: changed.filter(file => !allowed.has(file)), checks: checks(), decision: 'pending',
      };
      await this.append(task, `候选已提交，改动 ${changed.length} 个文件；正在启动预览`);
      candidate.previewUrl = await this.previews.start(id, this.repo.candidatePath(id), controller.signal);
      controller.signal.throwIfAborted();
      this.state.candidates.push(candidate);
      task.status = 'done';
      task.candidateId = id;
      await this.append(task, result.summary);
      this.options.emit({ type: 'candidate.ready', candidate: clone(candidate) });
      await this.trimCandidates();
    } catch (error) {
      if (created) {
        await this.previews.stop(id).catch(() => {});
        await this.repo.removeCandidate(id).catch(() => {});
      }
      const cancelled = (task.status as Task['status']) === 'cancelled';
      if (this.closing) {
        task.status = 'failed';
        task.error = { code: 'SERVICE_STOPPED', message: '服务已停止，请重新提交任务' };
      } else if (!cancelled) {
        task.status = 'failed';
        task.error = this.failure(error);
      }
      await this.append(task, cancelled ? '任务已取消' : `任务失败：${task.error?.message ?? '未知错误'}`);
    } finally { this.controllers.delete(id); }
  }

  private failure(error: unknown) {
    if (error instanceof CodingAgentError || error instanceof WorkError) return { code: error.code, message: error.message };
    if (error instanceof Error && error.name === 'AbortError') return { code: 'TASK_CANCELLED', message: '任务已取消' };
    return { code: 'TASK_FAILED', message: '任务执行失败，请检查候选目录、预览服务与模型配置' };
  }

  listTasks() { return clone(this.state.tasks); }
  getTask(id: string) { return clone(this.task(id)); }
  listCandidates() { return clone(this.state.candidates); }
  getCandidate(id: string) { return clone(this.candidate(id)); }

  async cancel(id: string) {
    const task = this.task(id);
    if (task.status !== 'queued' && task.status !== 'running') throw new WorkError('INVALID_STATE', '任务已经结束，不能取消', 409);
    task.status = 'cancelled';
    task.error = { code: 'TASK_CANCELLED', message: '用户取消任务' };
    this.controllers.get(id)?.abort();
    await this.append(task, '用户取消任务');
    return clone(task);
  }

  private async trimCandidates() {
    const pending = this.state.candidates.filter(candidate => candidate.decision === 'pending');
    while (pending.length > 3) {
      const oldest = pending.shift()!;
      await this.closeCandidate(oldest, '超过最多 3 个待定候选，自动撤回最早版本');
    }
  }
  private async closeCandidate(candidate: StoredCandidate, reason: string) {
    this.state.intent = { kind: 'discard', id: candidate.id, before: await this.repo.head() };
    await this.save();
    await this.recoverIntent();
    this.options.emit({ type: 'candidate.closed', candidate: clone(candidate), reason });
  }

  async adopt(id: string) {
    const candidate = this.candidate(id);
    if (candidate.decision !== 'pending') throw new WorkError('INVALID_STATE', '只有待定候选可以采用', 409);
    await this.snapshot();
    this.state.intent = { kind: 'adopt', id, before: await this.repo.head() };
    await this.save();
    const mergeCommit = await this.repo.adopt(id);
    candidate.decision = 'adopted';
    this.state.adoptions.push({ mergeCommit, candidateId: id, at: new Date().toISOString() });
    await this.recoverIntent();
    await this.previews.stop(id).catch(() => {});
    await this.repo.removeCandidate(id).catch(() => {});
    const version = await this.repo.head();
    this.options.emit({ type: 'version.changed', version, mergeCommit, candidateId: id, reason: 'adopt' });
    this.options.emit({ type: 'candidate.closed', candidate: clone(candidate), reason: '已采用' });
    return { version, candidate: clone(candidate) };
  }

  async discard(id: string) {
    const candidate = this.candidate(id);
    if (candidate.decision !== 'pending') throw new WorkError('INVALID_STATE', '只有待定候选可以撤回', 409);
    await this.closeCandidate(candidate, '用户撤回候选版本');
    return clone(candidate);
  }

  async revert() {
    const adoption = this.state.adoptions.at(-1);
    if (!adoption) throw new WorkError('NO_ADOPTION', '没有可以回退的采用记录', 409);
    await this.snapshot();
    this.state.intent = { kind: 'revert', id: adoption.candidateId, before: await this.repo.head(), target: adoption.mergeCommit };
    await this.save();
    const version = await this.repo.revert(adoption.mergeCommit);
    await this.recoverIntent();
    this.options.emit({ type: 'version.changed', version, reverted: adoption.mergeCommit, candidateId: adoption.candidateId, reason: 'revert' });
    return { version, reverted: adoption.mergeCommit };
  }

  previewUrl(id: string) { return previewBase(id); }
  async idle() { await this.taskQueue; await this.writes; }
  async close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.inFlight]);
    await this.taskQueue;
    // Review N4: queued work-tree operations (adopt, revert, 3D write-back) finish before the
    // event log closes and the lock is released; new ones are refused from here on.
    await this.repo.drain();
    await this.previews.stopAll();
    await this.writes;
    await this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
