import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as atomic from '../assets/atomic-file.ts';
import { computeSnapshot, type SnapshotResult } from './snapshot.ts';
import { CheckRunner, type CheckContext, type CheckExecutor, type CheckResult } from './runner.ts';

type Fixture = { directory: string; runner: CheckRunner; persistenceFailureExpected: boolean };
const fixtures: Fixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    try { await f.runner.drain(); }
    catch (error) {
      if (!f.persistenceFailureExpected || (error as { code?: string }).code !== 'PERSISTENCE_FAILED') throw error;
    }
    await rm(f.directory, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function evidencePhase(name: CheckResult['name']) {
  return async (ctx: CheckContext): Promise<CheckResult> => {
    const filename = name === 'build' ? 'build.log' : `${name}.json`;
    const ref = await ctx.writeArtifact(filename, JSON.stringify({ testDouble: true, name }));
    return { name, status: 'passed', evidence: ref.hash };
  };
}

async function fixture(input: {
  phases?: Partial<CheckExecutor>;
  contentDigest?: string;
  mainVersion?: string;
  runTimeoutMs?: number;
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'm3b-reliability-'));
  const candidatePath = path.join(directory, 'candidate');
  await mkdir(path.join(candidatePath, 'src'), { recursive: true });
  await writeFile(path.join(candidatePath, 'src/App.tsx'), 'export default () => <main/>;\n');
  const snapshot = await computeSnapshot(candidatePath);
  const executor: CheckExecutor = {
    schema: evidencePhase('schema'), build: evidencePhase('build'),
    smoke: evidencePhase('smoke'), occlusion: evidencePhase('occlusion'), ...input.phases,
  };
  const dataDirectory = path.join(directory, 'data');
  const runner = new CheckRunner({
    dataDirectory, candidatePath, candidateCommit: 'a'.repeat(40),
    baseVersion: 'b'.repeat(40), mainVersion: input.mainVersion ?? 'b'.repeat(40),
    contentDigest: input.contentDigest ?? snapshot.digest, executor,
    buildTimeoutMs: 1000, browserTimeoutMs: 1000, runTimeoutMs: input.runTimeoutMs ?? 3000,
  });
  const f = { directory, candidatePath, dataDirectory, runner, snapshot, persistenceFailureExpected: false };
  fixtures.push(f);
  await runner.init();
  return f;
}

it('rejects a caller digest which does not describe the full input bytes before executing checks', async () => {
  const schema = vi.fn(evidencePhase('schema'));
  const f = await fixture({ contentDigest: 'pending-diff-only', phases: { schema } });
  await expect(f.runner.startChecks('candidate1')).rejects.toMatchObject({ code: 'SNAPSHOT_MISMATCH' });
  expect(schema).not.toHaveBeenCalled();
  expect(f.runner.runsFor('candidate1')).toEqual([]);
});

it('includes the trusted tool identity in the snapshot identity', async () => {
  const f = await fixture();
  const fingerprint: (root: string, options: { toolIdentity: string }) => Promise<SnapshotResult> = computeSnapshot;
  const first = await fingerprint(f.candidatePath, { toolIdentity: 'trusted-entry-and-tools-v1' });
  const second = await fingerprint(f.candidatePath, { toolIdentity: 'trusted-entry-and-tools-v2' });
  expect(first.entries).toEqual(second.entries);
  expect(first.digest).not.toBe(second.digest);
});

it('refuses a stale main version before creating or executing a check run', async () => {
  const schema = vi.fn(evidencePhase('schema'));
  const f = await fixture({ mainVersion: 'c'.repeat(40), phases: { schema } });
  await expect(f.runner.startChecks('candidate1')).rejects.toMatchObject({ code: 'STALE_CANDIDATE' });
  expect(schema).not.toHaveBeenCalled();
  expect(f.runner.runsFor('candidate1')).toEqual([]);
});

it('finishes cancellation even if a phase ignores its abort signal, without accepting late success', async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture({ phases: { schema: async () => {
    entered.resolve(); await release.promise;
    return { name: 'schema', status: 'passed' };
  } } });
  const run = await f.runner.startChecks('candidate1');
  await entered.promise;
  const cancelling = f.runner.cancelChecks(run.id);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: string;
  try {
    result = await Promise.race([
      cancelling.then(() => 'cancelled'),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 150); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
    await cancelling;
    await f.runner.waitForActive();
  }
  expect(result!).toBe('cancelled');
  const finished = f.runner.getRun(run.id);
  expect(finished.status).toBe('cancelled');
  expect(finished.finishedAt).toBeTruthy();
  expect(finished.checks.every(check => check.status !== 'passed')).toBe(true);
});

it('records an overall deadline as failure, never as a user cancellation or late passed phase', async () => {
  const f = await fixture({ runTimeoutMs: 20, phases: { schema: async () => {
    await new Promise(resolve => setTimeout(resolve, 80));
    return { name: 'schema', status: 'passed' };
  } } });
  const run = await f.runner.startChecks('candidate1');
  await f.runner.waitForActive();
  const finished = f.runner.getRun(run.id);
  expect(finished.status).toBe('completed');
  expect(finished.error?.code).toBe('TIMEOUT');
  expect(finished.checks[0].status).toBe('failed');
  expect(finished.checks.slice(1).every(check => check.status === 'not_run')).toBe(true);
  expect(finished.finishedAt).toBeTruthy();
});

it('refuses evidence writes from a cancelled execution context', async () => {
  const entered = deferred<CheckContext>();
  const release = deferred();
  const f = await fixture({ phases: { schema: async ctx => {
    entered.resolve(ctx); await release.promise;
    return { name: 'schema', status: 'passed' };
  } } });
  const run = await f.runner.startChecks('candidate1');
  const context = await entered.promise;
  const cancelling = f.runner.cancelChecks(run.id);
  release.resolve();
  await cancelling;
  await expect(context.writeArtifact('schema.json', '{"late":true}')).rejects.toThrow(/取消|cancel|aborted/i);
});

it('does not expose an all-passed result when its terminal durable save keeps failing', async () => {
  const f = await fixture();
  f.persistenceFailureExpected = true;
  const realWrite = atomic.writeAtomic;
  vi.spyOn(atomic, 'writeAtomic').mockImplementation(async (file, content) => {
    if (file === path.join(f.dataDirectory, 'check-runs.json')) {
      const state = JSON.parse(content.toString()) as { runs: Array<{ status: string }> };
      if (state.runs.some(run => run.status === 'completed')) throw new Error('injected terminal state save failure');
    }
    return realWrite(file, content);
  });
  const run = await f.runner.startChecks('candidate1');
  await Promise.allSettled([f.runner.waitForActive()]);
  const result = f.runner.getRun(run.id);
  expect(result.checks.every(check => check.status === 'passed')).toBe(false);
  expect(result.error?.code).toBe('PERSISTENCE_FAILED');
  await expect(f.runner.waitForActive()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
});

it('requires actual registered evidence before accepting a passed phase result', async () => {
  const f = await fixture({ phases: { schema: async () => ({ name: 'schema', status: 'passed' }) } });
  const run = await f.runner.startChecks('candidate1');
  await f.runner.waitForActive();
  const result = f.runner.getRun(run.id);
  expect(result.checks[0].status).toBe('failed');
  expect(result.error?.code).toBe('CHECK_PROTOCOL');
  expect(result.checks.slice(1).every(check => check.status === 'not_run')).toBe(true);
});

it('rejects a result attributed to the wrong phase even when it has a real evidence file', async () => {
  const f = await fixture({ phases: { schema: async ctx => {
    const ref = await ctx.writeArtifact('schema.json', '{}');
    return { name: 'build', status: 'passed', evidence: ref.hash };
  } } });
  const run = await f.runner.startChecks('candidate1');
  await f.runner.waitForActive();
  const result = f.runner.getRun(run.id);
  expect(result.checks[0]).toMatchObject({ name: 'schema', status: 'failed' });
  expect(result.error?.code).toBe('CHECK_PROTOCOL');
});
