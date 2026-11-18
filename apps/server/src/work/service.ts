import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { acquireInstanceLock } from '../assets/instance-lock.ts';
import path from 'node:path';
import type { ApprovalCard, Candidate, Check, CheckRun, Selection, Task, AssetPlacementTarget, ModelProvenance } from '@spatial/shared';
import type { SceneModuleConfig } from '@spatial/shared/scene-module';
import { packageAssetModule, removeModulePackage } from './asset-module.ts';
import { readLedger, verifyCandidateLedger, writeLedger, type AssetLedger, type ManagedBaselineListing } from './asset-ledger.ts';
import { writeAtomic } from '../assets/atomic-file.ts';
import { CodingAgent, CodingAgentError, type CodingAgentOptions } from '../agent/client.ts';
import { Sandbox, ToolError } from '../agent/tools.ts';
import type { StudioEvent } from '../events.ts';
import { PreviewManager, previewBase } from './preview.ts';
import { WorkRepo, WorkError } from './repo.ts';
import { evaluateApproval } from '../approvals/policy.ts';
import { CheckRunner, CheckCompletionInvalidated, CHECK_ORDER, POLICY_VERSION, type CheckCandidateInput, type CheckExecutor } from '../checks/runner.ts';
import { assertSnapshotBudget, computeSnapshot, SnapshotBudgetError } from '../checks/snapshot.ts';
import { createRealExecutor } from '../checks/worker.ts';
import { getCheckToolsIdentity } from '../checks/tools.ts';
import { readArtifact, validateArtifactName } from '../checks/artifacts.ts';

interface StoredTask extends Task {
  /** Candidate id whose server-side attachment ledger proves managed files. */
  ledgerId?: string;
  /** Startup could not prove the candidate baseline; keep the draft for an operator. */
  recoveryHold?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: { code: string; message: string };
}
interface StoredCandidate extends Candidate { taskId: string; createdAt: string }
interface StoredApproval extends ApprovalCard { summary: string }
interface ApprovalIntent { kind: 'approve' | 'reject' | 'cancel' | 'preview_failed' | 'stale'; id: string; taskId: string; before: string; contentDigest: string }
interface Adoption { mergeCommit: string; candidateId: string; at: string }
interface State {
  tasks: StoredTask[];
  candidates: StoredCandidate[];
  adoptions: Adoption[];
  approvals: StoredApproval[];
  checkRuns: CheckRun[];
  intent?: { kind: 'adopt' | 'revert' | 'discard'; id: string; before: string; target?: string };
  approvalIntent?: ApprovalIntent;
}

export interface WorkServiceOptions {
  /** The caller already holds the instance lock of `directory` (createApp does, so the event log is covered too). */
  lockHeld?: boolean;
  workRoot: string;
  directory: string;
  agent: CodingAgentOptions;
  emit: (event: { type: string } & Record<string, unknown>) => StudioEvent;
  previewStartTimeoutMs?: number;
  /** Internal construction seam only; HTTP requests cannot override tools/executors. */
  checks?: { executor?: CheckExecutor; toolIdentity?: string | (() => Promise<string>); buildTimeoutMs?: number; browserTimeoutMs?: number; runTimeoutMs?: number };
}

const checks = (): Check[] => ['build', 'smoke', 'occlusion', 'schema'].map(name => ({ name: name as Check['name'], status: 'not_run' }));
const clone = <T>(value: T): T => structuredClone(value);

/** Single-worker task scheduler plus the durable candidate/version lifecycle. */
export class WorkService {
  readonly repo: WorkRepo;
  readonly previews: PreviewManager;
  private readonly options: WorkServiceOptions;
  private readonly file: string;
  private state: State = { tasks: [], candidates: [], adoptions: [], approvals: [], checkRuns: [] };
  private readonly checkRunner: CheckRunner;
  private checkViews = new Map<string, { checks: Check[]; latestCheckRunId?: string }>();
  private durableCheckRuns: CheckRun[] = [];
  private checkFault?: WorkError;
  private retiring = new Set<string>();
  private retirements = new Map<string, Promise<void>>();
  private trims: Promise<void> = Promise.resolve();
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
    this.checkRunner = new CheckRunner({
      dataDirectory: options.directory, executor: options.checks?.executor ?? createRealExecutor(),
      buildTimeoutMs: options.checks?.buildTimeoutMs, browserTimeoutMs: options.checks?.browserTimeoutMs, runTimeoutMs: options.checks?.runTimeoutMs,
      resolveCandidate: (id, signal) => this.resolveCheckCandidate(id, signal),
      store: { load: async () => clone(this.state.checkRuns), save: runs => this.saveCheckRuns(runs) },
    });
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    // These mutations can await work outside the repo queue. Register admission
    // synchronously so close cannot miss a submit that has not enqueued its task yet.
    for (const name of ['submit', 'cancel', 'answerApproval', 'startChecks', 'cancelCheckRun', 'discard', 'createAssetCandidate', 'removeModuleCandidate']) {
      const operation = methods[name].bind(this);
      methods[name] = (...args) => {
        if (this.closing) return Promise.reject(new WorkError('SERVICE_CLOSING', '后端正在关闭，未接受任务操作', 503));
        const pending = operation(...args).then(async result => {
          if (name === 'answerApproval' || name === 'cancel' || name === 'createAssetCandidate' || name === 'removeModuleCandidate') await this.trimCandidates();
          return result;
        });
        this.inFlight.add(pending);
        void pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
        return pending;
      };
    }
    for (const name of ['version', 'validateSelection', 'adopt', 'revert']) {
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
      if (!Array.isArray(saved.tasks) || !Array.isArray(saved.candidates) || !Array.isArray(saved.adoptions) ||
        (saved.approvals !== undefined && !Array.isArray(saved.approvals)) ||
        (saved.checkRuns !== undefined && !Array.isArray(saved.checkRuns))) throw new Error('invalid state');
      this.state = { ...saved, approvals: saved.approvals ?? [], checkRuns: saved.checkRuns ?? [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 M2/M3 任务状态 tasks.json'); }
    for (const task of this.state.tasks) {
      if (task.status === 'awaiting_approval' && !this.state.approvals.some(card => card.taskId === task.id)) throw new Error('等待请示的任务缺少对应卡片，拒绝自动清理或发布');
    }
    await this.recoverIntent();
    try { await this.recoverApprovalIntent(); }
    catch (error) {
      if (!(error instanceof WorkError) || !['CANDIDATE_BASE_UNKNOWN', 'CANDIDATE_BASE_CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error;
      const intent = this.state.approvalIntent;
      const card = intent ? this.state.approvals.find(item => item.id === intent.id) : undefined;
      const task = intent ? this.state.tasks.find(item => item.id === intent.taskId) : undefined;
      if (card) { card.status = 'failed'; card.updatedAt = new Date().toISOString(); }
      if (task) {
        task.status = 'failed';
        task.recoveryHold = true;
        task.updatedAt = new Date().toISOString();
        task.error = { code: 'RECOVERY_FAILED', message: '恢复时无法证明候选基线；草稿已保留，请由操作者核对后处理' };
        task.events.push({ type: 'task.updated', ts: task.updatedAt, sequence: task.events.length + 1, message: task.error.message });
      }
      this.state.approvalIntent = undefined;
      await this.save();
    }
    for (const entry of await readdir(this.repo.candidatesDir, { withFileTypes: true })) {
      if (!/^[a-z0-9]{6,32}$/.test(entry.name)) continue;
      const publicPending = this.state.candidates.some(c => c.id === entry.name && c.decision === 'pending');
      const privateStaging = this.state.tasks.some(task => task.id === entry.name &&
        (task.recoveryHold || (task.status === 'awaiting_approval' && this.state.approvals.some(card => card.taskId === task.id))));
      if (!publicPending && !privateStaging) await this.repo.removeCandidate(entry.name);
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
    await this.checkRunner.init();
    this.syncCandidateChecks(this.state.checkRuns);
    this.captureCheckViews();
    this.durableCheckRuns = clone(this.state.checkRuns);
    await this.save();
    await this.trimCandidates();
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

  private async recoverApprovalIntent(listing?: ManagedBaselineListing) {
    const intent = this.state.approvalIntent;
    if (!intent) return;
    const card = this.approval(intent.id), task = this.task(intent.taskId);
    if (intent.kind === 'approve') { await this.finalizeApprovedTask(task.id, listing); return; }
    if (intent.kind === 'preview_failed' || intent.kind === 'stale') await this.save();
    await this.previews.stop(task.id);
    await this.repo.removeCandidate(task.id);
    const previousCard = clone(card), previousTask = clone(task);
    const failed = intent.kind === 'preview_failed' || intent.kind === 'stale';
    card.status = intent.kind === 'preview_failed' ? 'failed' : intent.kind === 'stale' ? 'stale' : intent.kind === 'reject' ? 'rejected' : 'cancelled';
    card.updatedAt = new Date().toISOString();
    task.status = failed ? 'failed' : 'cancelled';
    task.error = intent.kind === 'preview_failed' ? { code: 'PREVIEW_FAILED', message: '候选预览启动失败，本次草稿已丢弃，请重新提交任务' }
      : intent.kind === 'stale' ? { code: 'STALE_APPROVAL', message: '草稿或主作品版本已变化，不能继续批准' }
      : { code: intent.kind === 'reject' ? 'APPROVAL_REJECTED' : 'TASK_CANCELLED', message: intent.kind === 'reject' ? '用户拒绝并丢弃本次修改' : '用户取消任务' };
    task.updatedAt = card.updatedAt;
    task.events.push({ type: 'task.updated', ts: card.updatedAt, sequence: task.events.length + 1, message: task.error.message });
    this.state.approvalIntent = undefined;
    try { await this.save(); } catch (error) {
      Object.assign(card, previousCard); Object.assign(task, previousTask);
      this.state.approvalIntent = intent; throw error;
    }
    this.options.emit({ type: 'approval.resolved', approval: this.publicApproval(card) });
    this.options.emit({ type: 'task.updated', task: clone(task) });
  }

  private async failApproval(card: StoredApproval, kind: 'preview_failed' | 'stale') {
    // Persist the cleanup decision before removing the only draft. A failed terminal save
    // can then resume cleanup without retrying the preview or requiring the removed files.
    this.state.approvalIntent = { kind, id: card.id, taskId: card.taskId, before: card.baseVersion, contentDigest: card.contentDigest };
    await this.recoverApprovalIntent();
  }

  /** Publish only the already-generated draft named by a durable approval intent. */
  async finalizeApprovedTask(taskId: string, listing?: ManagedBaselineListing) {
    const card = this.state.approvals.find(item => item.taskId === taskId);
    const task = this.task(taskId);
    if (!card) throw new WorkError('NOT_FOUND', '任务没有请示卡片', 404);
    const intent = this.state.approvalIntent;
    if (!intent) {
      if (card.status === 'approved' && task.status === 'done' && this.state.candidates.some(candidate => candidate.id === taskId)) {
        return { approval: this.publicApproval(card), task: clone(task) };
      }
      return { approval: this.publicApproval(card), task: clone(task) };
    }
    if (intent.kind !== 'approve' || intent.id !== card.id || intent.taskId !== taskId) throw new WorkError('RECOVERY_CONFLICT', '请示恢复意图不一致', 409);
    const head = await this.repo.head();
    const pending = await this.repo.pendingDiff(taskId, intent.before, await this.taskLedger(task), listing);
    if (head !== intent.before || pending.contentDigest !== intent.contentDigest || card.contentDigest !== intent.contentDigest || card.baseVersion !== intent.before) {
      await this.failApproval(card, 'stale');
      return { approval: this.publicApproval(card), task: clone(task) };
    }
    const controller = new AbortController();
    this.controllers.set(taskId, controller);
    try {
      await this.repo.commitCandidate(taskId, card.summary, await this.taskLedger(task), intent.before, pending.baseline);
      let previewUrl: string;
      try {
        previewUrl = await this.previews.start(taskId, this.repo.candidatePath(taskId), controller.signal);
        controller.signal.throwIfAborted();
      } catch {
        await this.failApproval(card, 'preview_failed');
        return { approval: this.publicApproval(card), task: clone(task) };
      }
      const previousTask = clone(task), previousCard = clone(card), previousCandidates = clone(this.state.candidates);
      let candidate = this.state.candidates.find(item => item.id === taskId);
      if (!candidate) {
        const allowed = new Set(task.selection ? [task.selection.src, ...(Array.isArray(task.selection.ancestors) ? task.selection.ancestors : [])].map(src => src.replace(/:\d+:\d+$/, '')) : []);
        candidate = { id: taskId, taskId, candidateCommit: await this.repo.candidateCommit(taskId), baseVersion: intent.before, branch: this.repo.branch(taskId), previewUrl,
          createdAt: new Date().toISOString(), diff: pending.diff, outOfScope: pending.changedFiles.filter(file => !allowed.has(file)), checks: checks(), decision: 'pending' };
        this.state.candidates.push(candidate);
      } else { candidate.previewUrl = previewUrl; candidate.candidateCommit ??= await this.repo.candidateCommit(taskId); }
      if (task.status !== 'done') {
        task.status = 'done'; task.candidateId = taskId; task.error = undefined; task.updatedAt = new Date().toISOString();
        task.events.push({ type: 'task.updated', ts: task.updatedAt, sequence: task.events.length + 1, message: card.summary });
      }
      card.status = 'approved'; card.updatedAt = new Date().toISOString();
      this.state.approvalIntent = undefined;
      try { await this.save(); } catch (error) {
        Object.assign(task, previousTask); Object.assign(card, previousCard);
        this.state.candidates = previousCandidates; this.state.approvalIntent = intent;
        await this.previews.stop(taskId);
        throw error;
      }
      this.options.emit({ type: 'task.updated', task: clone(task) });
      this.options.emit({ type: 'candidate.ready', candidate: clone(candidate) });
      this.options.emit({ type: 'approval.resolved', approval: this.publicApproval(card) });
      return { approval: this.publicApproval(card), task: clone(task) };
    } finally { this.controllers.delete(taskId); }
  }

  private async toolsIdentity() {
    const configured = this.options.checks?.toolIdentity;
    return typeof configured === 'function' ? configured() : configured ?? getCheckToolsIdentity();
  }

  private async resolveCheckCandidate(id: string, signal?: AbortSignal): Promise<CheckCandidateInput> {
    return this.repo.exclusive(async () => {
      signal?.throwIfAborted();
      await this.recoverIntent();
      const candidate = this.candidate(id);
      if (candidate.decision !== 'pending' || this.retiring.has(id)) throw new WorkError('INVALID_STATE', '候选已关闭或正在撤回', 409);
      if (!candidate.candidateCommit) throw new WorkError('LEGACY_CANDIDATE', '旧候选缺少生成提交记录，请重新生成候选', 409);
      const mainVersion = await this.snapshot();
      if (mainVersion !== candidate.baseVersion) throw new WorkError('STALE_CANDIDATE', '主作品版本已变化，请重新生成候选', 409);
      const candidateCommit = await this.repo.candidateCommit(id, { clean: true, expectedCommit: candidate.candidateCommit });
      const task = this.state.tasks.find(item => item.id === candidate.taskId);
      await verifyCandidateLedger(this.repo, id, candidate.baseVersion, task ? await this.taskLedger(task) : undefined);
      const toolIdentity = await this.toolsIdentity();
      const snapshot = await computeSnapshot(this.repo.candidatePath(id), { toolIdentity, signal });
      return { candidateId: id, candidatePath: this.repo.candidatePath(id), candidateCommit, baseVersion: candidate.baseVersion,
        mainVersion, toolIdentity, contentDigest: snapshot.digest };
    });
  }

  private syncCandidateChecks(runs: CheckRun[]) {
    for (const candidate of this.state.candidates) {
      const run = runs.filter(item => item.candidateId === candidate.id).at(-1);
      candidate.latestCheckRunId = run?.id;
      candidate.checks = run && run.policyVersion === POLICY_VERSION && run.toolIdentity ?
        run.checks.map(check => ({ ...clone(check), runId: run.id })) : checks();
    }
  }
  private captureCheckViews() {
    this.checkViews = new Map(this.state.candidates.map(candidate => [candidate.id, {
      checks: clone(candidate.checks), latestCheckRunId: candidate.latestCheckRunId,
    }]));
  }
  private publicCandidate(candidate: StoredCandidate): Candidate {
    const result = clone(candidate), view = this.checkViews.get(candidate.id);
    result.checks = view ? clone(view.checks) : checks();
    result.latestCheckRunId = view?.latestCheckRunId;
    try { this.checkRunner.assertHealthy(); }
    catch { result.checks = checks().map(check => ({ ...check, message: '检查状态或资源未能可靠完成' })); }
    return result;
  }

  private async validatePassedRun(run: CheckRun) {
    if (this.checkFault || run.status !== 'completed' || run.outcome !== 'passed' || run.error ||
        run.policyVersion !== POLICY_VERSION || run.checks.length !== 4 ||
        !run.checks.every((check, index) => check.name === CHECK_ORDER[index] && check.status === 'passed')) throw new WorkError('INVALID_CHECK_PROOF', '检查证明不完整', 409);
    const input = await this.resolveCheckCandidate(run.candidateId);
    if (input.candidateCommit !== run.candidateCommit || input.baseVersion !== run.baseVersion ||
        input.mainVersion !== run.mainVersion || input.contentDigest !== run.contentDigest || input.toolIdentity !== run.toolIdentity) {
      throw new WorkError('STALE_CANDIDATE', '检查证明不对应当前完整输入', 409);
    }
    const refs = run.artifacts ?? [];
    if (new Set(refs.map(ref => ref.name)).size !== refs.length) throw new WorkError('INVALID_CHECK_PROOF', '证据引用重复', 409);
    for (const name of ['schema.json', 'build.log', 'smoke.json', 'smoke.png', 'occlusion.json', 'occlusion.png']) {
      const ref = refs.find(item => item.name === name);
      if (!ref) throw new WorkError('INVALID_CHECK_PROOF', '缺少实际检查证据', 409);
      await readArtifact(this.options.directory, run.id, name, ref);
    }
    for (const check of run.checks) {
      const ref = refs.find(item => item.name === (check.name === 'build' ? 'build.log' : check.name + '.json'));
      if (!check.evidence || check.evidence !== ref?.hash) throw new WorkError('INVALID_CHECK_PROOF', '检查结果摘要与证据不符', 409);
    }
  }

  private async saveCheckRuns(runs: CheckRun[]) {
    return this.repo.exclusive(async () => {
      const previousRuns = this.state.checkRuns;
      // Validate terminal publication in the same repo critical section as the save.
      for (const run of runs) {
        const previous = previousRuns.find(item => item.id === run.id);
        if (run.status === 'completed' && run.outcome === 'passed' && !(previous?.status === 'completed' && previous.outcome === 'passed')) {
          try { await this.validatePassedRun(run); }
          catch (error) { throw new CheckCompletionInvalidated(run.id, error instanceof WorkError ? error.code : 'CHECK_EVIDENCE_INVALID'); }
        }
      }
      const previousViews = this.state.candidates.map(candidate => ({ candidate, checks: candidate.checks, latestCheckRunId: candidate.latestCheckRunId }));
      this.state.checkRuns = clone(runs);
      this.syncCandidateChecks(runs);
      try { await this.save(); }
      catch (error) {
        this.state.checkRuns = previousRuns;
        for (const previous of previousViews) { previous.candidate.checks = previous.checks; previous.candidate.latestCheckRunId = previous.latestCheckRunId; }
        this.checkFault = new WorkError('PERSISTENCE_FAILED', '检查状态未能可靠落盘，拒绝采用与新检查', 503);
        throw error;
      }
      this.captureCheckViews();
      this.durableCheckRuns = clone(runs);
      for (const run of runs) {
        const previous = previousRuns.find(item => item.id === run.id);
        if (JSON.stringify(previous) === JSON.stringify(run)) continue;
        const terminal = run.status === 'completed' || run.status === 'cancelled';
        const previousTerminal = previous?.status === 'completed' || previous?.status === 'cancelled';
        const type = terminal && !previousTerminal ? 'check.finished' : !previous ? 'check.started' : 'check.updated';
        this.options.emit({ type, run: clone(run), candidate: this.state.candidates.some(candidate => candidate.id === run.candidateId) ? this.getCandidate(run.candidateId) : undefined });
      }
    });
  }

  async startChecks(id: string, options?: { rerun?: boolean }) {
    if (this.checkFault) throw this.checkFault;
    return this.checkRunner.startChecks(id, options);
  }
  getCheckRun(id: string) {
    try { this.checkRunner.assertHealthy(); }
    catch { return this.checkRunner.getRun(id); }
    const run = this.durableCheckRuns.find(item => item.id === id);
    if (!run) throw new WorkError('NOT_FOUND', '检查运行不存在', 404);
    return clone(run);
  }
  async cancelCheckRun(id: string) { return this.checkRunner.cancelChecks(id); }
  async readCheckArtifact(id: string, name: string) {
    validateArtifactName(name);
    const run = this.getCheckRun(id), ref = run.artifacts?.find(item => item.name === name);
    if (!ref) throw new WorkError('NOT_FOUND', '运行没有该证据', 404);
    return readArtifact(this.options.directory, id, name, ref);
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
  private async taskLedger(task: StoredTask): Promise<AssetLedger | undefined> {
    return task.ledgerId ? readLedger(this.options.directory, task.ledgerId) : undefined;
  }
  private candidate(id: string) {
    const candidate = this.state.candidates.find(item => item.id === id);
    if (!candidate) throw new WorkError('NOT_FOUND', '候选版本不存在', 404);
    return candidate;
  }
  private approval(id: string) {
    const approval = this.state.approvals.find(item => item.id === id);
    if (!approval) throw new WorkError('NOT_FOUND', '请示卡片不存在', 404);
    return approval;
  }
  private publicApproval(card: StoredApproval): ApprovalCard {
    const { summary: _summary, ...approval } = clone(card);
    return approval;
  }
  private async append(task: StoredTask, message: string) {
    task.updatedAt = new Date().toISOString();
    task.events.push({ type: 'task.updated', ts: task.updatedAt, sequence: task.events.length + 1, message });
    await this.save();
    this.options.emit({ type: 'task.updated', task: clone(task) });
  }
  private async snapshotWithListing() {
    const previous = await this.repo.head();
    const result = await this.repo.snapshotWithListing();
    if (result.version !== previous) this.options.emit({ type: 'version.changed', version: result.version, previous, reason: 'snapshot' });
    return result;
  }
  private async snapshot() { return (await this.snapshotWithListing()).version; }

  async version() { return { version: await this.snapshot() }; }

  async submit(instruction: string, selection?: Selection, options?: { bootstrap?: boolean }) {
    if (options?.bootstrap && selection) throw new WorkError('INVALID_INPUT', '首版整页生成不能同时绑定局部选中元素', 400);
    await this.validateSelection(selection);
    const now = new Date().toISOString();
    const task: StoredTask = {
      id: randomUUID().replaceAll('-', ''),
      instruction,
      selection,
      ...(options?.bootstrap ? { bootstrap: true } : {}),
      status: 'queued',
      events: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.push(task);
    await this.append(task, options?.bootstrap ? '首版 3D 网页生成任务已排队' : '任务已排队');
    this.taskQueue = this.taskQueue.then(() => this.execute(task.id)).catch(() => {});
    return clone(task);
  }

  async createAssetCandidate(input:{baseVersion:string;assetId:string;binary:Buffer;provenance:ModelProvenance;parts?:unknown;target:AssetPlacementTarget;config:SceneModuleConfig;force?:boolean}):Promise<Task>{
    const instanceId=randomUUID().replaceAll('-','');
    return this.createModuleTask({
      baseVersion:input.baseVersion,instruction:input.force?'放入独立3D模块（明确强制采用超网页门槛模型）':'放入独立3D模块',
      prepare:async(root,candidateId,base)=>{
        const result=await packageAssetModule({root,candidateId,baseVersion:base,instanceId,assetId:input.assetId,binary:input.binary,provenance:input.provenance,parts:input.parts,target:input.target,config:input.config});
        return result.ledger;
      },
    });
  }

  async removeModuleCandidate(input:{baseVersion:string;instanceId:string}):Promise<Task>{
    if(!/^[a-f0-9]{32}$/.test(input.instanceId))throw new WorkError('INVALID_MODULE','实例编号无效');
    return this.createModuleTask({
      baseVersion:input.baseVersion,instruction:'移除独立3D模块',
      prepare:async(root,candidateId,base)=>(await removeModulePackage({root,candidateId,baseVersion:base,instanceId:input.instanceId})).ledger,
    });
  }

  private async createModuleTask(input:{baseVersion:string;instruction:string;prepare:(root:string,candidateId:string,base:string)=>Promise<AssetLedger>}):Promise<Task>{
    return this.repo.exclusive(async()=>{
      const { version: base, listing: baselineListing } = await this.snapshotWithListing();
      if(base!==input.baseVersion)throw new WorkError('STALE_PLACEMENT','作品版本已变化，请重新放置',409);
      const id=randomUUID().replaceAll('-',''),now=new Date().toISOString();
      const task:StoredTask={id,kind:'module',instruction:input.instruction,status:'running',events:[],createdAt:now,updatedAt:now};
      this.state.tasks.push(task);await this.save();
      try{
        const prepared = await this.repo.createCandidate(id,base,baselineListing);
        const root=this.repo.candidatePath(id);
        const ledger=await input.prepare(root,id,base);
        if(ledger.intent==='insert') await assertSnapshotBudget(root);
        await writeLedger(this.options.directory,ledger);
        task.ledgerId=id;await this.save();
        const pending=await this.repo.pendingDiff(id,base,ledger,prepared.listing);
        if(!pending.changedFiles.length)throw new WorkError('NO_CHANGES','模块文件没有产生任何改动',409);
        const evaluation=await evaluateApproval({root,baseVersion:base,changedFiles:pending.changedFiles});
        if(evaluation.ruleCodes.includes('shared_component'))throw new WorkError('SHARED_PLACEMENT_TARGET','插入会复制到共享组件的多个实例，请选择唯一外层容器',409);
        if(evaluation.required){
          const card:StoredApproval={id:randomUUID().replaceAll('-',''),taskId:id,question:'是否发布这个独立3D模块候选？',reason:evaluation.evidence.join('\n'),options:[{label:'批准候选',impact:'仅发布草稿，检查后才可采用'},{label:'拒绝并丢弃',impact:'主作品和资产不变'}],affected:evaluation.affected,evidence:evaluation.evidence,status:'pending',ruleCodes:evaluation.ruleCodes,ruleVersion:'m3a-v1',baseVersion:base,contentDigest:pending.contentDigest,createdAt:now,updatedAt:now,summary:task.instruction};
          this.state.approvals.push(card);task.status='awaiting_approval';await this.append(task,'独立3D模块草稿已准备，等待明确批准');this.options.emit({type:'approval.requested',approval:this.publicApproval(card)});return clone(task);
        }
        await this.repo.commitCandidate(id,task.instruction,ledger,base,pending.baseline);
        const candidate:StoredCandidate={id,taskId:id,candidateCommit:await this.repo.candidateCommit(id),baseVersion:base,branch:this.repo.branch(id),previewUrl:await this.previews.start(id,root),diff:pending.diff,outOfScope:pending.changedFiles,checks:checks(),decision:'pending',createdAt:now};
        this.state.candidates.push(candidate);task.status='done';task.candidateId=id;await this.append(task,task.instruction);this.options.emit({type:'candidate.ready',candidate:clone(candidate)});return clone(task);
      }catch(error){await this.previews.stop(id);await this.repo.removeCandidate(id);task.status='failed';task.error=error instanceof SnapshotBudgetError?{code:error.code,message:error.message}:this.failure(error);await this.append(task,task.error.message);throw error;}
    });
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
      const { version: base, listing: baselineListing } = await this.snapshotWithListing();
      const prepared = await this.repo.createCandidate(id, base, baselineListing);
      created = true;
      await this.append(task, '候选目录已创建，编码 Agent 开始工作');
      const agent = new CodingAgent({
        ...this.options.agent,
        onStep: async message => { await this.append(task, message); },
      });
      const result = await agent.run({ taskId: id, instruction: task.instruction, selection: task.selection, bootstrap: task.bootstrap, root: this.repo.candidatePath(id), signal: controller.signal });
      controller.signal.throwIfAborted();
      const pending = await this.repo.pendingDiff(id, base, undefined, prepared.listing);
      if (!pending.changedFiles.length) throw new WorkError('NO_CHANGES', '编码 Agent 没有产生任何文件改动', 409);
      const evaluation = await evaluateApproval({ root: this.repo.candidatePath(id), baseVersion: base, changedFiles: pending.changedFiles, selection: task.selection });
      const skipBootstrapApproval = task.bootstrap === true && !task.selection && this.state.adoptions.length === 0;
      if (evaluation.required && !skipBootstrapApproval) {
        await this.repo.exclusive(async () => {
          controller.signal.throwIfAborted();
          if (task.status !== 'running') throw new WorkError('TASK_CANCELLED', '任务已取消', 409);
          if (this.state.approvals.filter(card => card.status === 'pending').length >= 3) throw new WorkError('APPROVAL_LIMIT', '最多保留 3 张等待请示卡片，请先处理现有卡片', 409);
          const now = new Date().toISOString();
          const card: StoredApproval = {
            id: randomUUID().replaceAll('-', ''), taskId: id, question: '本次修改涉及共享或范围外内容，是否发布为候选版本？',
            reason: evaluation.evidence.join('\n'), options: [{ label: '批准本次修改', impact: '仅发布绑定当前摘要的私有草稿' }, { label: '拒绝并丢弃', impact: '删除本任务私有草稿，不改变主作品' }],
            affected: evaluation.affected, evidence: evaluation.evidence, status: 'pending', ruleCodes: evaluation.ruleCodes,
            ruleVersion: 'm3a-v1', baseVersion: base, contentDigest: pending.contentDigest, createdAt: now, updatedAt: now, summary: result.summary,
          };
          const previousEvents = [...task.events], previousUpdatedAt = task.updatedAt;
          this.state.approvals.push(card);
          task.status = 'awaiting_approval';
          task.error = undefined;
          try {
            await this.append(task, `模型已生成私有草稿，需批准后才能发布；规则：${evaluation.ruleCodes.join('、')}`);
          } catch (error) {
            // The first durable card save failed: do not leave a pending card pointing at the
            // staging that the outer task failure path is about to remove.
            this.state.approvals = this.state.approvals.filter(item => item.id !== card.id);
            task.status = 'running'; task.events = previousEvents; task.updatedAt = previousUpdatedAt;
            throw error;
          }
          this.options.emit({ type: 'approval.requested', approval: this.publicApproval(card) });
        });
        return;
      }
      const changed = await this.repo.commitCandidate(id, result.summary, undefined, base, pending.baseline);
      const allowed = new Set(task.selection ? [task.selection.src, ...(Array.isArray(task.selection.ancestors) ? task.selection.ancestors : [])].map(src => src.replace(/:\d+:\d+$/, '')) : []);
      const candidate: StoredCandidate = {
        id, taskId: id, candidateCommit: await this.repo.candidateCommit(id), baseVersion: base, branch: this.repo.branch(id), previewUrl: '', createdAt: new Date().toISOString(),
        diff: pending.diff, outOfScope: skipBootstrapApproval ? [] : changed.filter(file => !allowed.has(file)), checks: checks(), decision: 'pending',
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
  listCandidates() { return this.state.candidates.map(candidate => this.publicCandidate(candidate)); }
  getCandidate(id: string) { return this.publicCandidate(this.candidate(id)); }
  listApprovals(): ApprovalCard[] { return this.state.approvals.map(card => this.publicApproval(card)); }
  getApproval(id: string): ApprovalCard { return this.publicApproval(this.approval(id)); }

  async answerApproval(id: string, option: 0 | 1) {
    if (!Number.isInteger(option) || (option !== 0 && option !== 1)) throw new WorkError('INVALID_OPTION', 'option 必须是原始 JSON 数字 0 或 1', 400);
    return this.repo.exclusive(async () => {
      await this.recoverApprovalIntent();
      const card = this.approval(id), task = this.task(card.taskId);
      if (card.status === 'stale') throw new WorkError('STALE_APPROVAL', '请示已过期，请重新生成任务', 409);
      if (card.answer) {
        if (card.answer.option === option) return { approval: this.publicApproval(card), task: clone(task) };
        throw new WorkError('APPROVAL_ALREADY_ANSWERED', '请示已经以另一选项回答，不能重放或覆盖', 409);
      }
      if (card.status !== 'pending' || task.status !== 'awaiting_approval') throw new WorkError('APPROVAL_NOT_PENDING', '请示已失效，不能继续回答', 409);
      let approvalListing: ManagedBaselineListing | undefined;
      if (option === 0) {
        const { version: head, listing } = await this.snapshotWithListing();
        const pending = await this.repo.pendingDiff(task.id, card.baseVersion, await this.taskLedger(task), listing);
        if (head !== card.baseVersion || pending.contentDigest !== card.contentDigest) {
          await this.failApproval(card, 'stale');
          throw new WorkError('STALE_APPROVAL', '草稿摘要或主作品版本已变化，请重新生成任务', 409);
        }
        approvalListing = pending.baseline;
      }
      const index = this.state.approvals.findIndex(item => item.id === id);
      const previous = clone(card);
      const now = new Date().toISOString();
      card.answer = { option, at: now }; card.updatedAt = now; card.status = option === 0 ? 'approving' : 'rejected';
      this.state.approvalIntent = { kind: option === 0 ? 'approve' : 'reject', id, taskId: task.id, before: card.baseVersion, contentDigest: card.contentDigest };
      try { await this.save(); }
      catch (error) { this.state.approvals[index] = previous; this.state.approvalIntent = undefined; throw error; }
      await this.recoverApprovalIntent(approvalListing);
      return { approval: this.publicApproval(card), task: clone(this.task(task.id)) };
    });
  }

  async cancel(id: string) {
    return this.repo.exclusive(async () => {
      await this.recoverApprovalIntent();
      const task = this.task(id);
      if (task.status === 'awaiting_approval') {
        const card = this.state.approvals.find(item => item.taskId === id);
        if (!card) throw new WorkError('RECOVERY_CONFLICT', '等待任务缺少请示卡片', 409);
        const previous = clone(card), previousIntent = this.state.approvalIntent;
        card.status = 'cancelled'; card.updatedAt = new Date().toISOString();
        this.state.approvalIntent = { kind: 'cancel', id: card.id, taskId: id, before: card.baseVersion, contentDigest: card.contentDigest };
        try { await this.save(); }
        catch (error) {
          const index = this.state.approvals.findIndex(item => item.id === card.id);
          this.state.approvals[index] = previous; this.state.approvalIntent = previousIntent; throw error;
        }
        await this.recoverApprovalIntent();
        return clone(this.task(id));
      }
      if (task.status !== 'queued' && task.status !== 'running') throw new WorkError('INVALID_STATE', '任务已经结束，不能取消', 409);
      task.status = 'cancelled';
      task.error = { code: 'TASK_CANCELLED', message: '用户取消任务' };
      this.controllers.get(id)?.abort();
      await this.append(task, '用户取消任务');
      return clone(task);
    });
  }

  private trimCandidates() {
    const operation = this.trims.then(async () => {
      for (;;) {
        const oldest = await this.repo.exclusive(async () => {
          const pending = this.state.candidates.filter(candidate => candidate.decision === 'pending');
          return pending.length > 3 ? pending[0] : undefined;
        });
        if (!oldest) return;
        await this.closeCandidate(oldest, '超过最多 3 个待定候选，自动撤回最早版本');
      }
    });
    this.trims = operation.catch(() => {});
    return operation;
  }
  private closeCandidate(candidate: StoredCandidate, reason: string): Promise<void> {
    const existing = this.retirements.get(candidate.id);
    if (existing) return existing;
    const operation = (async () => {
      await this.repo.exclusive(async () => { await this.recoverIntent(); this.retiring.add(candidate.id); });
      // Never wait for checker final saves while holding the mutex they need.
      for (const run of this.checkRunner.runsFor(candidate.id)) {
        if (run.status === 'running' || run.status === 'queued') await this.checkRunner.cancelChecks(run.id);
      }
      await this.repo.exclusive(async () => {
        await this.recoverIntent();
        if (candidate.decision !== 'pending') return;
        this.state.intent = { kind: 'discard', id: candidate.id, before: await this.repo.head() };
        await this.save();
        await this.recoverIntent();
        this.options.emit({ type: 'candidate.closed', candidate: this.publicCandidate(candidate), reason });
        this.retiring.delete(candidate.id);
      });
    })();
    this.retirements.set(candidate.id, operation);
    void operation.finally(() => this.retirements.delete(candidate.id)).catch(() => {});
    return operation;
  }

  async adopt(id: string) {
    const candidate = this.candidate(id);
    if (candidate.decision !== 'pending') throw new WorkError('INVALID_STATE', '只有待定候选可以采用', 409);
    await this.snapshot();
    try {
      this.checkRunner.assertHealthy();
      if (this.checkFault || this.retiring.has(id)) throw new Error('check unavailable');
      const latest = this.state.checkRuns.filter(run => run.candidateId === id).at(-1);
      if (!latest || candidate.latestCheckRunId !== latest.id) throw new Error('missing check run');
      await this.validatePassedRun(latest);
    } catch { throw new WorkError('CHECKS_NOT_PASSED', '当前候选没有完整有效的四项检查证明，请重新检查或生成候选', 409); }
    const task = this.state.tasks.find(item => item.id === candidate.taskId);
    await verifyCandidateLedger(this.repo, id, candidate.baseVersion, task ? await this.taskLedger(task) : undefined);
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
    const candidate = await this.repo.exclusive(async () => {
      await this.recoverIntent();
      const candidate = this.candidate(id);
      if (candidate.decision !== 'pending') throw new WorkError('INVALID_STATE', '只有待定候选可以撤回', 409);
      return candidate;
    });
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
    const checksStopped = this.checkRunner.drain();
    void checksStopped.catch(() => {});
    await Promise.allSettled([...this.inFlight]);
    await this.taskQueue;
    await this.trims;
    await checksStopped;
    // Review N4: queued work-tree operations (adopt, revert, 3D write-back) finish before the
    // event log closes and the lock is released; new ones are refused from here on.
    await this.repo.drain();
    await this.previews.stopAll();
    await this.writes;
    await this.releaseLock?.();
    this.releaseLock = undefined;
  }
}
