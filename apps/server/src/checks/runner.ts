import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CheckRun, CheckName, CheckResult, CheckRunStatus, CheckOutcome } from '@spatial/shared';
import { writeAtomic } from '../assets/atomic-file.ts';
import { WorkError } from '../work/repo.ts';
import { computeSnapshot, type SnapshotResult, copyAudited, cleanupSnapshot } from './snapshot.ts';
import { writeArtifact, removeArtifacts, type ArtifactRef } from './artifacts.ts';

export { SnapshotError } from './snapshot.ts';
export { ArtifactError, ARTIFACT_NAMES } from './artifacts.ts';
export type { ArtifactRef, ArtifactName } from './artifacts.ts';
export type { CheckResult } from '@spatial/shared';

/** Default budget: build 120s, smoke/occlusion 30s each, whole run 180s. */
export const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
export const POLICY_VERSION = 'm3b-v1';

/** The four checks in execution order. */
export const CHECK_ORDER: CheckName[] = ['schema', 'build', 'smoke', 'occlusion'];

/** Interface for a check phase executor. Tests inject controlled doubles. */
export interface CheckExecutor {
  schema(ctx: CheckContext): Promise<CheckResult>;
  build(ctx: CheckContext): Promise<CheckResult>;
  smoke(ctx: CheckContext): Promise<CheckResult>;
  occlusion(ctx: CheckContext): Promise<CheckResult>;
}

/** Context passed to each check phase. */
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

/** Options for creating a CheckRunner. */
export interface CheckRunnerOptions {
  dataDirectory: string;
  candidatePath: string;       // path to the candidate worktree
  candidateCommit: string;     // git commit of the candidate
  baseVersion: string;         // main version when candidate was created
  contentDigest: string;       // digest from pendingDiff
  mainVersion: string;         // current main HEAD (must match baseVersion for pending)
  executor?: CheckExecutor;    // inject for tests; production uses real executor
  buildTimeoutMs?: number;
  browserTimeoutMs?: number;
  runTimeoutMs?: number;
}

interface PersistedRuns { runs: CheckRun[] }

/**
 * Manages persistent CheckRuns: same identity (candidateCommit + contentDigest)
 * gets only one concurrent run; completed same-identity returns existing result.
 * Rerun requires explicit { rerun: true }.
 */
export class CheckRunner {
  private file: string;
  private artifactsBase: string;
  private runs: CheckRun[] = [];
  private active: Map<string, { run: CheckRun; controller: AbortController; promise: Promise<CheckRun> }> = new Map();
  private options: CheckRunnerOptions;
  private writes: Promise<void> = Promise.resolve();

  constructor(options: CheckRunnerOptions) {
    this.options = options;
    this.file = path.join(options.dataDirectory, 'check-runs.json');
    this.artifactsBase = options.dataDirectory;
  }

  async init() {
    await mkdir(this.options.dataDirectory, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as PersistedRuns;
      if (!Array.isArray(saved.runs)) throw new Error('invalid check-runs.json');
      this.runs = saved.runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取检查运行状态 check-runs.json');
      this.runs = [];
    }
    // Mark any queued/running runs as failed on restart — never auto-rerun.
    let changed = false;
    for (const run of this.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'completed';
        run.error = { code: 'SERVICE_RESTARTED', message: '服务重启中断了检查运行；请显式重新检查' };
        run.finishedAt = new Date().toISOString();
        // Mark unstarted checks as not_run.
        for (const check of run.checks) {
          if (check.status === 'not_run' && !check.message) {
            check.message = '服务重启中断';
          }
        }
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  private async save() {
    const json = JSON.stringify({ runs: this.runs } satisfies PersistedRuns, null, 2);
    const op = this.writes.then(() => writeAtomic(this.file, json));
    this.writes = op.catch(() => {});
    return op;
  }

  private identityOf(run: CheckRun): string {
    return `${run.candidateCommit}:${run.contentDigest}`;
  }

  private findActive(candidateId: string, candidateCommit: string, contentDigest: string): CheckRun | undefined {
    const identity = `${candidateCommit}:${contentDigest}`;
    for (const [id, entry] of this.active) {
      if (entry.run.candidateId === candidateId && this.identityOf(entry.run) === identity) {
        return entry.run;
      }
    }
    return undefined;
  }

  private findCompleted(candidateId: string, candidateCommit: string, contentDigest: string): CheckRun | undefined {
    const identity = `${candidateCommit}:${contentDigest}`;
    return this.runs.find(r =>
      r.candidateId === candidateId &&
      this.identityOf(r) === identity &&
      (r.status === 'completed' || r.status === 'cancelled'),
    );
  }

  /**
   * Start or return an existing check run for a candidate.
   * Same identity queued/running returns the same run.
   * Same identity completed returns existing result unless { rerun: true }.
   */
  async startChecks(candidateId: string, opts?: { rerun?: boolean }): Promise<CheckRun> {
    const existing = this.findActive(candidateId, this.options.candidateCommit, this.options.contentDigest);
    if (existing) return structuredClone(existing);

    if (!opts?.rerun) {
      const completed = this.findCompleted(candidateId, this.options.candidateCommit, this.options.contentDigest);
      if (completed) return structuredClone(completed);
    }

    // Create a new run.
    const runId = randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    const run: CheckRun = {
      id: runId,
      candidateId,
      baseVersion: this.options.baseVersion,
      candidateCommit: this.options.candidateCommit,
      contentDigest: this.options.contentDigest,
      mainVersion: this.options.mainVersion,
      policyVersion: POLICY_VERSION,
      status: 'queued',
      checks: CHECK_ORDER.map(name => ({ name, status: 'not_run' as const })),
      createdAt: now,
    };

    this.runs.push(run);
    await this.save();

    const controller = new AbortController();
    const promise = this.execute(run, controller);
    this.active.set(runId, { run, controller, promise });

    return structuredClone(run);
  }

  /** Cancel a queued/running check run. Idempotent for already-cancelled. */
  async cancelChecks(runId: string): Promise<CheckRun> {
    const entry = this.active.get(runId);
    if (entry) {
      entry.controller.abort();
      await entry.promise.catch(() => {});
    }
    const run = this.runs.find(r => r.id === runId);
    if (!run) throw new WorkError('NOT_FOUND', '检查运行不存在', 404);
    return structuredClone(run);
  }

  /** Get a check run by id. */
  getRun(runId: string): CheckRun {
    const run = this.runs.find(r => r.id === runId);
    if (!run) throw new WorkError('NOT_FOUND', '检查运行不存在', 404);
    return structuredClone(run);
  }

  /** List all runs for a candidate. */
  runsFor(candidateId: string): CheckRun[] {
    return structuredClone(this.runs.filter(r => r.candidateId === candidateId));
  }

  /** Get the latest completed run for a candidate. */
  latestCompleted(candidateId: string): CheckRun | undefined {
    const runs = this.runs
      .filter(r => r.candidateId === candidateId && r.status === 'completed')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    return runs[0] ? structuredClone(runs[0]) : undefined;
  }

  private async execute(run: CheckRun, controller: AbortController): Promise<CheckRun> {
    const executor = this.options.executor;
    if (!executor) {
      // No executor configured — mark as failed (production wires real executor in B2/B3).
      run.status = 'completed';
      run.error = { code: 'NO_EXECUTOR', message: '检查运行器未配置' };
      run.finishedAt = new Date().toISOString();
      run.startedAt = new Date().toISOString();
      await this.save();
      this.active.delete(run.id);
      return run;
    }

    const runTimeoutMs = this.options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    const buildTimeoutMs = this.options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const browserTimeoutMs = this.options.browserTimeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
    const artifactsDir = this.artifactsBase;
    const writeArtifactFn = (name: string, content: Buffer | string) => writeArtifact(artifactsDir, run.id, name, content);

    // Overall run timer.
    const runTimer = setTimeout(() => controller.abort(), runTimeoutMs);

    try {
      controller.signal.throwIfAborted();
      run.status = 'running';
      run.startedAt = new Date().toISOString();
      await this.save();

      // Compute snapshot of the candidate tree.
      let snapshot: SnapshotResult;
      try {
        snapshot = await computeSnapshot(this.options.candidatePath);
      } catch (error) {
        return await this.failRun(run, 'SNAPSHOT_ERROR', `内容快照失败：${error instanceof Error ? error.message : '未知错误'}`, controller.signal.aborted);
      }

      // Copy audited files to a trusted build root.
      const buildRoot = path.join(this.artifactsBase, 'check-builds', run.id);
      try {
        await copyAudited(this.options.candidatePath, buildRoot);
      } catch (error) {
        await cleanupSnapshot(buildRoot);
        return await this.failRun(run, 'COPY_ERROR', `安全复制失败：${error instanceof Error ? error.message : '未知错误'}`, controller.signal.aborted);
      }

      const ctx: CheckContext = {
        runId: run.id,
        candidateRoot: this.options.candidatePath,
        buildRoot,
        snapshot,
        signal: controller.signal,
        buildTimeoutMs,
        browserTimeoutMs,
        artifactsDir,
        writeArtifact: writeArtifactFn,
      };

      // Execute checks in order: schema → build → smoke → occlusion.
      let allPassed = true;
      let blockedBy: string | undefined;
      for (let i = 0; i < CHECK_ORDER.length; i++) {
        const name = CHECK_ORDER[i];
        if (controller.signal.aborted) {
          // Mark remaining as cancelled.
          for (let j = i; j < CHECK_ORDER.length; j++) {
            run.checks[j] = { ...run.checks[j], status: 'not_run', message: '检查被取消' };
          }
          run.status = 'cancelled';
          break;
        }
        if (blockedBy) {
          run.checks[i] = { name, status: 'not_run', message: `前序检查 ${blockedBy} 未通过` };
          continue;
        }
        const phase = executor[name] as (ctx: CheckContext) => Promise<CheckResult>;
        let result: CheckResult;
        try {
          result = await phase(ctx);
        } catch (error) {
          result = { name, status: 'failed', message: error instanceof Error ? error.message : '检查执行异常' };
        }
        run.checks[i] = result;
        await this.save();
        if (result.status !== 'passed') {
          allPassed = false;
          blockedBy = name;
        }
      }

      if (run.status !== 'cancelled') {
        run.status = 'completed';
        run.finishedAt = new Date().toISOString();
        if (!allPassed && !run.error) {
          const failed = run.checks.find(c => c.status === 'failed');
          if (failed) run.error = { code: 'CHECK_FAILED', message: `${failed.name} 检查未通过` };
        }
      }
      await this.save();
      await cleanupSnapshot(buildRoot);
      this.active.delete(run.id);
      return run;
    } catch (error) {
      return await this.failRun(run, 'RUN_ERROR', error instanceof Error ? error.message : '检查运行异常', controller.signal.aborted);
    } finally {
      clearTimeout(runTimer);
    }
  }

  private async failRun(run: CheckRun, code: string, message: string, aborted: boolean): Promise<CheckRun> {
    run.status = aborted ? 'cancelled' : 'completed';
    run.error = { code: aborted ? 'CANCELLED' : code, message };
    run.finishedAt = new Date().toISOString();
    // Mark unstarted checks as not_run.
    for (const check of run.checks) {
      if (check.status === 'not_run' && !check.message) {
        check.message = aborted ? '检查被取消' : '因前序错误未启动';
      }
    }
    await this.save();
    const buildRoot = path.join(this.artifactsBase, 'check-builds', run.id);
    await cleanupSnapshot(buildRoot);
    this.active.delete(run.id);
    return run;
  }

  /** Wait for all active runs to finish without aborting them. For tests. */
  async waitForActive(): Promise<void> {
    const active = [...this.active.values()];
    await Promise.allSettled(active.map(e => e.promise));
    await this.writes;
  }

  /** Drain: abort all active runs and wait for them to finish. Called during shutdown. */
  async drain(): Promise<void> {
    const active = [...this.active.values()];
    for (const entry of active) entry.controller.abort();
    await Promise.allSettled(active.map(e => e.promise));
    await this.writes;
  }
}
