import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckRun, CheckName, CheckResult } from '@spatial/shared';
import { writeAtomic } from '../assets/atomic-file.ts';
import { WorkError } from '../work/repo.ts';
import { computeSnapshot, type SnapshotResult, copyAudited, cleanupSnapshot } from './snapshot.ts';
import { writeArtifact, readArtifact, ARTIFACT_NAMES, type ArtifactRef } from './artifacts.ts';

export { SnapshotError } from './snapshot.ts';
export { ArtifactError, ARTIFACT_NAMES } from './artifacts.ts';
export type { ArtifactRef, ArtifactName } from './artifacts.ts';
export type { CheckResult } from '@spatial/shared';

export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
export const POLICY_VERSION = 'm3b-v2';
export const CHECK_ORDER: CheckName[] = ['schema', 'build', 'smoke', 'occlusion'];

export interface CheckExecutor {
  schema(ctx: CheckContext): Promise<CheckResult>;
  build(ctx: CheckContext): Promise<CheckResult>;
  smoke(ctx: CheckContext): Promise<CheckResult>;
  occlusion(ctx: CheckContext): Promise<CheckResult>;
  /** Production executor must stop and confirm exit of its owned worker/browser here. */
  stop?(runId: string): Promise<void>;
}
export interface CheckContext {
  runId: string;
  candidateRoot: string;
  buildRoot: string;
  snapshot: SnapshotResult;
  signal: AbortSignal;
  buildTimeoutMs: number;
  browserTimeoutMs: number;
  artifactsDir: string;
  writeArtifact: (name: string, content: Buffer | string) => Promise<ArtifactRef>;
}
export interface CheckRunnerOptions {
  dataDirectory: string;
  candidatePath: string;
  candidateCommit: string;
  baseVersion: string;
  /** Full input snapshot digest, never WorkRepo.pendingDiff's changed-file digest. */
  contentDigest: string;
  mainVersion: string;
  toolIdentity?: string;
  executor?: CheckExecutor;
  buildTimeoutMs?: number;
  browserTimeoutMs?: number;
  runTimeoutMs?: number;
}
interface ActiveRun { run: CheckRun; controller: AbortController; promise: Promise<CheckRun> }
const copy = <T>(value: T): T => structuredClone(value);
const cancelled = () => new WorkError('CANCELLED', '检查被取消', 409);
const timeout = () => new WorkError('TIMEOUT', '检查超过时间预算', 408);

/** Bound orchestration waits; production resource termination belongs to executor.stop. */
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? cancelled());
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', aborted);
    }).catch(() => {});
  });
}

export class CheckRunner {
  private readonly file: string;
  private runs: CheckRun[] = [];
  private durable: CheckRun[] = [];
  private active = new Map<string, ActiveRun>();
  private writes: Promise<void> = Promise.resolve();
  private admissions: Promise<void> = Promise.resolve();
  private closing = false;
  private fault?: WorkError;
  private resourceFault?: WorkError;
  private readonly options: CheckRunnerOptions;

  constructor(options: CheckRunnerOptions) {
    this.options = { ...options };
    this.file = path.join(options.dataDirectory, 'check-runs.json');
    for (const [value, maximum] of [
      [options.buildTimeoutMs, DEFAULT_BUILD_TIMEOUT_MS],
      [options.browserTimeoutMs, DEFAULT_BROWSER_TIMEOUT_MS],
      [options.runTimeoutMs, DEFAULT_RUN_TIMEOUT_MS],
    ] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > maximum)) throw new Error('Invalid check budget');
    }
  }

  async init() {
    await mkdir(this.options.dataDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as { runs?: unknown };
      if (!Array.isArray(saved.runs) || !saved.runs.every(validStoredRun) ||
        new Set(saved.runs.map(run => run.id)).size !== saved.runs.length) throw new Error('Invalid check runs');
      this.runs = saved.runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取检查运行状态 check-runs.json');
    }
    this.durable = copy(this.runs);
    let changed = false;
    for (const run of this.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'completed';
        run.outcome = 'failed';
        run.error = { code: 'SERVICE_RESTARTED', message: '服务重启中断检查；不会自动重新运行' };
        run.finishedAt = new Date().toISOString();
        for (const check of run.checks) if (check.status === 'not_run') check.message = '服务重启中断';
        if (run.checks.every(check => check.status === 'passed')) {
          run.checks[3] = { name: 'occlusion', status: 'not_run', message: '完成状态尚未持久化即重启' };
        }
        changed = true;
      } else if (run.outcome === undefined) {
        run.outcome = 'failed';
        run.error = { code: 'LEGACY_CHECK_RECORD', message: '旧记录缺少完整检查证明，请显式重新检查' };
        run.checks = CHECK_ORDER.map(name => ({ name, status: 'not_run', message: '旧检查记录不可用' }));
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private poison() {
    this.fault ??= new WorkError('PERSISTENCE_FAILED', '检查状态保存失败，拒绝继续运行或使用未落盘的通过结果', 503);
    for (const run of this.runs) {
      const durable = this.durable.find(previous => previous.id === run.id);
      if (JSON.stringify(durable) === JSON.stringify(run) && !this.active.has(run.id) && run.status !== 'queued' && run.status !== 'running') continue;
      run.status = 'completed';
      run.outcome = 'failed';
      run.error = { code: this.fault.code, message: this.fault.message };
      run.finishedAt = new Date().toISOString();
      run.checks = CHECK_ORDER.map(name => ({ name, status: 'not_run', message: this.fault!.message }));
    }
    for (const entry of this.active.values()) entry.controller.abort(this.fault);
  }

  private async save() {
    if (this.fault) throw this.fault;
    const snapshot = copy(this.runs);
    const operation = this.writes.then(async () => {
      if (this.fault) throw this.fault;
      await writeAtomic(this.file, JSON.stringify({ runs: snapshot }, null, 2));
      this.durable = snapshot;
    });
    this.writes = operation.then(() => {}, () => {});
    try { await operation; }
    catch { this.poison(); throw this.fault; }
  }

  private identity(run: Pick<CheckRun, 'candidateId' | 'candidateCommit' | 'baseVersion' | 'mainVersion' | 'policyVersion' | 'contentDigest' | 'toolIdentity'>) {
    return JSON.stringify([run.candidateId, run.candidateCommit, run.baseVersion, run.mainVersion, run.policyVersion, run.contentDigest, run.toolIdentity ?? '']);
  }

  startChecks(candidateId: string, opts?: { rerun?: boolean }): Promise<CheckRun> {
    if (this.fault) return Promise.reject(this.fault);
    if (this.resourceFault) return Promise.reject(this.resourceFault);
    if (this.closing) return Promise.reject(new WorkError('SERVICE_CLOSING', '检查服务正在关闭', 503));
    const operation = this.admissions.then(() => this.startAdmitted(candidateId, opts));
    this.admissions = operation.then(() => {}, () => {});
    return operation;
  }

  private async startAdmitted(candidateId: string, opts?: { rerun?: boolean }): Promise<CheckRun> {
    if (this.fault) throw this.fault;
    if (this.options.mainVersion !== this.options.baseVersion) throw new WorkError('STALE_CANDIDATE', '主作品版本已变化，请重新生成候选', 409);
    const controller = new AbortController();
    const deadline = Date.now() + (this.options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(timeout()), Math.max(0, deadline - Date.now()));
    let snapshot: SnapshotResult;
    try {
      snapshot = await computeSnapshot(this.options.candidatePath, { toolIdentity: this.options.toolIdentity, signal: controller.signal });
      controller.signal.throwIfAborted();
    } finally { clearTimeout(timer); }
    if (snapshot.digest !== this.options.contentDigest) throw new WorkError('SNAPSHOT_MISMATCH', '候选字节与完整检查摘要不一致', 409);
    const run: CheckRun = {
      id: randomUUID().replaceAll('-', ''), candidateId,
      candidateCommit: this.options.candidateCommit, baseVersion: this.options.baseVersion,
      mainVersion: this.options.mainVersion, contentDigest: snapshot.digest,
      toolIdentity: this.options.toolIdentity ?? '', policyVersion: POLICY_VERSION,
      status: 'queued', outcome: 'not_run', artifacts: [],
      checks: CHECK_ORDER.map(name => ({ name, status: 'not_run' })),
      createdAt: new Date().toISOString(),
    };
    const identity = this.identity(run);
    const existing = [...this.active.values()].find(entry => this.identity(entry.run) === identity)?.run;
    if (existing) return copy(existing);
    if (!opts?.rerun) {
      const completed = [...this.runs].reverse().find(item => this.identity(item) === identity && ['completed', 'cancelled'].includes(item.status));
      if (completed) return copy(completed);
    }
    this.runs.push(run);
    try { await this.save(); }
    catch (error) { this.runs = this.runs.filter(item => item.id !== run.id); throw error; }
    const promise = Promise.resolve().then(() => this.execute(run, controller, snapshot, deadline));
    this.active.set(run.id, { run, controller, promise });
    void promise.finally(() => this.active.delete(run.id)).catch(() => {});
    return copy(run);
  }

  async cancelChecks(runId: string): Promise<CheckRun> {
    const entry = this.active.get(runId);
    if (entry) {
      if (entry.run.status !== 'completed' && entry.run.status !== 'cancelled') entry.controller.abort(cancelled());
      await entry.promise;
    }
    return this.getRun(runId);
  }
  getRun(id: string): CheckRun {
    const run = (this.fault ? this.runs : this.durable).find(item => item.id === id);
    if (!run) throw new WorkError('NOT_FOUND', '检查运行不存在', 404);
    return copy(run);
  }
  runsFor(candidateId: string): CheckRun[] { return copy((this.fault ? this.runs : this.durable).filter(run => run.candidateId === candidateId)); }
  latestCompleted(candidateId: string): CheckRun | undefined {
    const run = [...(this.fault ? this.runs : this.durable)].reverse().find(item => item.candidateId === candidateId && item.status === 'completed' && item.outcome === 'passed' && !item.error);
    return run ? copy(run) : undefined;
  }

  private async execute(run: CheckRun, controller: AbortController, snapshot: SnapshotResult, deadline: number): Promise<CheckRun> {
    const signal = controller.signal;
    const timer = setTimeout(() => controller.abort(timeout()), Math.max(0, deadline - Date.now()));
    const buildRoot = path.join(this.options.dataDirectory, 'check-builds', run.id);
    const executor = this.options.executor;
    let phaseIndex = 0;
    const writes = new Set<Promise<ArtifactRef>>();
    try {
      signal.throwIfAborted();
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      await this.save();
      if (!executor) throw new WorkError('NO_EXECUTOR', '检查运行器未配置', 503);
      const copied = await copyAudited(this.options.candidatePath, buildRoot, snapshot.digest, { toolIdentity: this.options.toolIdentity, signal });
      for (phaseIndex = 0; phaseIndex < CHECK_ORDER.length; phaseIndex++) {
        signal.throwIfAborted();
        const name = CHECK_ORDER[phaseIndex];
        const phaseController = new AbortController();
        const phaseSignal = AbortSignal.any([signal, phaseController.signal]);
        const budget = name === 'build' ? (this.options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS) :
          name === 'schema' ? undefined : (this.options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS);
        const phaseTimer = budget === undefined ? undefined : setTimeout(() => phaseController.abort(timeout()), budget);
        const refs = new Map<string, ArtifactRef>();
        let open = true;
        const assertActive = () => {
          if (!open || phaseSignal.aborted || this.fault) throw phaseSignal.reason ?? this.fault ?? cancelled();
        };
        const context: CheckContext = {
          runId: run.id, candidateRoot: this.options.candidatePath, buildRoot,
          snapshot: copied, signal: phaseSignal,
          buildTimeoutMs: this.options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
          browserTimeoutMs: this.options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS,
          artifactsDir: this.options.dataDirectory,
          writeArtifact: async (filename, content) => {
            assertActive();
            const expected = name === 'build' ? ['build.log'] : [name + '.json', name + '.png'];
            if (!expected.includes(filename)) throw new WorkError('CHECK_PROTOCOL', '证据不属于当前检查项', 409);
            const writing = writeArtifact(this.options.dataDirectory, run.id, filename, content);
            writes.add(writing);
            let ref: ArtifactRef;
            try { ref = await writing; } finally { writes.delete(writing); }
            assertActive();
            refs.set(ref.name, ref);
            return ref;
          },
        };
        try {
          const result = await bounded(() => executor[name](context), phaseSignal);
          phaseSignal.throwIfAborted();
          if (!result || result.name !== name || !['passed', 'failed', 'not_run'].includes(result.status) ||
            (result.message !== undefined && typeof result.message !== 'string') ||
            (result.durationMs !== undefined && (!Number.isFinite(result.durationMs) || result.durationMs < 0))) {
            throw new WorkError('CHECK_PROTOCOL', '检查返回了错误的阶段或结果结构', 409);
          }
          if (result.status === 'passed' && (!result.evidence || ![...refs.values()].some(ref => ref.hash === result.evidence))) {
            throw new WorkError('CHECK_PROTOCOL', '通过结果没有本阶段真实登记的证据', 409);
          }
          for (const ref of refs.values()) await readArtifact(this.options.dataDirectory, run.id, ref.name, ref);
          phaseSignal.throwIfAborted();
          run.artifacts = [...(run.artifacts ?? []).filter(ref => !refs.has(ref.name)), ...refs.values()];
          run.checks[phaseIndex] = { name, status: result.status, message: result.message, evidence: result.evidence, durationMs: result.durationMs };
          await this.save();
          if (result.status !== 'passed') throw new WorkError('CHECK_FAILED', name + ' 检查未通过', 409);
        } finally {
          open = false;
          if (phaseTimer) clearTimeout(phaseTimer);
        }
      }
      signal.throwIfAborted();
      run.outcome = 'passed';
    } catch (error) {
      if (!this.fault) {
        const failure = error instanceof WorkError ? error : new WorkError('RUN_ERROR', error instanceof Error ? error.message : '检查运行异常', 500);
        const index = Math.min(phaseIndex, CHECK_ORDER.length - 1);
        run.status = failure.code === 'CANCELLED' ? 'cancelled' : 'completed';
        run.outcome = failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
        run.error = { code: failure.code, message: failure.message };
        if (failure.code !== 'CHECK_FAILED') {
          run.checks[index] = { name: CHECK_ORDER[index], status: failure.code === 'CANCELLED' ? 'not_run' : 'failed', message: failure.message };
        }
        for (let i = index + 1; i < CHECK_ORDER.length; i++) run.checks[i] = { name: CHECK_ORDER[i], status: 'not_run', message: '前序检查 ' + CHECK_ORDER[index] + ' 未完成：' + failure.code };
      }
    } finally {
      clearTimeout(timer);
      await Promise.allSettled([...writes]);
      try {
        await executor?.stop?.(run.id);
        await cleanupSnapshot(buildRoot);
      } catch {
        this.resourceFault = new WorkError('CLEANUP_FAILED', '检查资源未确认清理，拒绝关闭或继续检查', 503);
        run.outcome = 'failed';
        run.error = { code: this.resourceFault.code, message: this.resourceFault.message };
        run.checks[3] = { name: 'occlusion', status: 'failed', message: this.resourceFault.message };
      }
    }
    if (this.fault) throw this.fault;
    if (!run.error && signal.aborted) {
      const failure = signal.reason instanceof WorkError ? signal.reason : cancelled();
      run.outcome = failure.code === 'CANCELLED' ? 'cancelled' : 'failed';
      run.status = failure.code === 'CANCELLED' ? 'cancelled' : 'completed';
      run.error = { code: failure.code, message: failure.message };
      run.checks[3] = { name: 'occlusion', status: failure.code === 'CANCELLED' ? 'not_run' : 'failed', message: failure.message };
    }
    if (run.status !== 'cancelled') run.status = 'completed';
    run.finishedAt = new Date().toISOString();
    await this.save();
    if (this.resourceFault) throw this.resourceFault;
    return run;
  }

  async waitForActive(): Promise<void> {
    await Promise.all([...this.active.values()].map(entry => entry.promise));
    await this.writes;
    if (this.fault) throw this.fault;
    if (this.resourceFault) throw this.resourceFault;
  }
  async drain(): Promise<void> {
    this.closing = true;
    await this.admissions;
    for (const entry of this.active.values()) entry.controller.abort(cancelled());
    await this.waitForActive();
  }
}

function validStoredRun(value: unknown): value is CheckRun {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  for (const field of ['id', 'candidateId', 'baseVersion', 'candidateCommit', 'contentDigest', 'mainVersion', 'policyVersion', 'createdAt']) {
    if (typeof run[field] !== 'string' || !(run[field] as string).length) return false;
  }
  if (!/^[a-z0-9]{6,32}$/.test(run.id as string) || !['queued', 'running', 'completed', 'cancelled'].includes(run.status as string) ||
    !Number.isFinite(Date.parse(run.createdAt as string))) return false;
  if (!Array.isArray(run.checks) || run.checks.length !== CHECK_ORDER.length ||
    !run.checks.every((item: unknown, index: number) => {
      if (!item || typeof item !== 'object') return false;
      const check = item as Record<string, unknown>;
      return check.name === CHECK_ORDER[index] && ['passed', 'failed', 'not_run'].includes(check.status as string);
    })) return false;
  if (run.outcome !== undefined && !['passed', 'failed', 'not_run', 'blocked', 'cancelled'].includes(run.outcome as string)) return false;
  if (run.toolIdentity !== undefined && typeof run.toolIdentity !== 'string') return false;
  if (run.artifacts !== undefined && (!Array.isArray(run.artifacts) || !run.artifacts.every((item: unknown) => {
    if (!item || typeof item !== 'object') return false;
    const ref = item as Record<string, unknown>;
    return ARTIFACT_NAMES.includes(ref.name as typeof ARTIFACT_NAMES[number]) && typeof ref.mime === 'string' &&
      Number.isSafeInteger(ref.bytes) && (ref.bytes as number) >= 0 && typeof ref.hash === 'string' && /^[a-f0-9]{64}$/.test(ref.hash);
  }))) return false;
  return true;
}
