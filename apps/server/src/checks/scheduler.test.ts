import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckRun } from '@spatial/shared';
import { WorkRepo } from '../work/repo.ts';
import { computeSnapshot } from './snapshot.ts';
import { CheckRunner, type CheckContext, type CheckExecutor, type CheckResult } from './runner.ts';

interface Input {
  candidateId: string; candidatePath: string; candidateCommit: string;
  baseVersion: string; mainVersion: string; contentDigest: string; toolIdentity: string;
}
interface Store { load(): Promise<CheckRun[]>; save(runs: CheckRun[]): Promise<void> }
interface Owned { directory: string; repo: WorkRepo; runners: CheckRunner[]; release: Array<() => void> }
const owned: Owned[] = [];
afterEach(async () => {
  for (const f of owned.splice(0)) {
    for (const release of f.release) release();
    for (const runner of f.runners) {
      try { await runner.drain(); }
      catch (error) { if ((error as { code?: string }).code !== 'PERSISTENCE_FAILED') throw error; }
    }
    await f.repo.drain();
    await rm(f.directory, { recursive: true, force: true });
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
async function passed(name: CheckResult['name'], ctx: CheckContext): Promise<CheckResult> {
  const ref = await ctx.writeArtifact(name === 'build' ? 'build.log' : `${name}.json`, JSON.stringify({ testDouble: true, name }));
  return { name, status: 'passed', evidence: ref.hash };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'm3b-scheduler-'));
  const workRoot = path.join(directory, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await mkdir(path.join(workRoot, 'public/assets'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), 'export default () => <main>base</main>;\n');
  await writeFile(path.join(workRoot, 'public/assets/product.png'), 'fixture asset bytes');
  const repo = new WorkRepo({ workRoot, dataDirectory: path.join(directory, 'repo-data') });
  const f: Owned = { directory, repo, runners: [], release: [] };
  owned.push(f);
  await repo.init();
  const base = await repo.head();
  const inputs = new Map<string, Input>();
  for (const id of ['candidate1', 'candidate2']) {
    const candidatePath = await repo.createCandidate(id, base);
    await writeFile(path.join(candidatePath, 'src/App.tsx'), `export default () => <main>${id}</main>;\n`);
    await repo.commitCandidate(id, 'fixture ' + id);
    const candidateCommit = await repo.candidateCommit(id);
    const toolIdentity = 'fixture-tools-v1';
    const snapshot = await computeSnapshot(candidatePath, { toolIdentity });
    inputs.set(id, { candidateId: id, candidatePath, candidateCommit, baseVersion: base, mainVersion: base, contentDigest: snapshot.digest, toolIdentity });
  }
  // The existing API can accept an extra JS argument; the strict mode is introduced by this task.
  const audit: (id: string, options: { clean: true; expectedCommit: string }) => Promise<string> = repo.candidateCommit.bind(repo);
  async function resolveCandidate(id: string): Promise<Input> {
    const input = inputs.get(id);
    if (!input) throw new Error('unknown fixture candidate');
    await audit(id, { clean: true, expectedCommit: input.candidateCommit });
    return { ...input };
  }
  async function runner(settings: {
    schema?: CheckExecutor['schema']; stop?: CheckExecutor['stop'];
    resolveCandidate?: (id: string) => Promise<Input>; store?: Store;
  } = {}) {
    const executor: CheckExecutor = {
      schema: settings.schema ?? (ctx => passed('schema', ctx)),
      build: ctx => passed('build', ctx), smoke: ctx => passed('smoke', ctx),
      occlusion: ctx => passed('occlusion', ctx), stop: settings.stop,
    };
    const options = {
      ...inputs.get('candidate1')!, dataDirectory: path.join(directory, 'checks'), executor,
      resolveCandidate: settings.resolveCandidate ?? resolveCandidate, store: settings.store,
      runTimeoutMs: 5000,
    };
    const result = new CheckRunner(options);
    f.runners.push(result);
    await result.init();
    return result;
  }
  return { ...f, base, workRoot, inputs, audit, resolveCandidate, runner };
}

it('accepts a clean candidate whose worktree and expected commit match', async () => {
  const f = await fixture();
  const input = f.inputs.get('candidate1')!;
  await expect(f.audit(input.candidateId, { clean: true, expectedCommit: input.candidateCommit })).resolves.toBe(input.candidateCommit);
});

it('rejects tracked source edits which were never committed to the checked candidate', async () => {
  const f = await fixture(); const input = f.inputs.get('candidate1')!;
  await writeFile(path.join(input.candidatePath, 'src/App.tsx'), 'export default () => <main>tampered</main>;');
  await expect(f.audit(input.candidateId, { clean: true, expectedCommit: input.candidateCommit })).rejects.toMatchObject({ code: 'STALE_CANDIDATE' });
});

it('rejects a tracked public asset changed outside the candidate commit', async () => {
  const f = await fixture(); const input = f.inputs.get('candidate1')!;
  await writeFile(path.join(input.candidatePath, 'public/assets/product.png'), 'different fixture bytes');
  await expect(f.audit(input.candidateId, { clean: true, expectedCommit: input.candidateCommit })).rejects.toMatchObject({ code: 'STALE_CANDIDATE' });
});

it('rejects an unexpected new branch commit instead of relabelling it as the expected commit', async () => {
  const f = await fixture(); const input = f.inputs.get('candidate1')!;
  await writeFile(path.join(input.candidatePath, 'src/App.tsx'), 'export default () => <main>new commit</main>;');
  await f.repo.commitCandidate(input.candidateId, 'unexpected fixture commit');
  await expect(f.audit(input.candidateId, { clean: true, expectedCommit: input.candidateCommit })).rejects.toMatchObject({ code: 'STALE_CANDIDATE' });
});

it('rejects a clean detached HEAD which differs from the candidate branch', async () => {
  const f = await fixture(); const input = f.inputs.get('candidate1')!;
  await new Promise<void>((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', f.base], {
    cwd: input.candidatePath, windowsHide: true,
    env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }, error => error ? reject(error) : resolve()));
  await expect(f.audit(input.candidateId, { clean: true, expectedCommit: input.candidateCommit })).rejects.toMatchObject({ code: 'STALE_CANDIDATE' });
});

it('resolves each candidate separately rather than checking the first root under a second id', async () => {
  const f = await fixture(); const runner = await f.runner();
  const first = await runner.startChecks('candidate1'); const second = await runner.startChecks('candidate2');
  await runner.waitForActive();
  for (const [id, run] of [['candidate1', first], ['candidate2', second]] as const) {
    const input = f.inputs.get(id)!;
    expect(runner.getRun(run.id)).toMatchObject({ candidateId: id, candidateCommit: input.candidateCommit, contentDigest: input.contentDigest, outcome: 'passed' });
  }
});

it('rejects a resolver which returns another candidate identity', async () => {
  const f = await fixture();
  const runner = await f.runner({ resolveCandidate: () => f.resolveCandidate('candidate1') });
  await expect(runner.startChecks('candidate2')).rejects.toMatchObject({ code: 'CANDIDATE_ID_MISMATCH' });
});

it('serializes execution and resource ownership across two different candidates', async () => {
  const f = await fixture(); const firstEntered = gate(); const secondEntered = gate(); const releaseFirst = gate();
  f.release.push(releaseFirst.release);
  const owners = new Set<string>(); let maximumOwners = 0; let calls = 0;
  const runner = await f.runner({ schema: async ctx => {
    calls++; owners.add(ctx.runId); maximumOwners = Math.max(maximumOwners, owners.size);
    if (calls === 1) { firstEntered.release(); await releaseFirst.promise; } else secondEntered.release();
    return passed('schema', ctx);
  }, stop: async id => { owners.delete(id); } });
  let timer: ReturnType<typeof setTimeout> | undefined; let observed: string;
  try {
    await runner.startChecks('candidate1'); await firstEntered.promise;
    await runner.startChecks('candidate2');
    observed = await Promise.race([secondEntered.promise.then(() => 'overlap'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('queued'), 500); })]);
  } finally { if (timer) clearTimeout(timer); releaseFirst.release(); await runner.waitForActive(); }
  expect(observed!).toBe('queued'); expect(maximumOwners).toBe(1); expect(calls).toBe(2); expect(owners.size).toBe(0);
});

it('cancels a queued candidate without waiting for another candidate or starting its executor', async () => {
  const f = await fixture(); const entered = gate(); const release = gate(); f.release.push(release.release);
  let calls = 0;
  const runner = await f.runner({ schema: async ctx => { calls++; entered.release(); await release.promise; return passed('schema', ctx); } });
  let timer: ReturnType<typeof setTimeout> | undefined; let observed: string;
  try {
    await runner.startChecks('candidate1'); await entered.promise;
    const second = await runner.startChecks('candidate2');
    const cancel = runner.cancelChecks(second.id);
    observed = await Promise.race([cancel.then(() => 'cancelled'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('blocked'), 500); })]);
    expect(observed).toBe('cancelled'); expect(calls).toBe(1);
    expect(runner.getRun(second.id).status).toBe('cancelled');
  } finally { if (timer) clearTimeout(timer); release.release(); await runner.waitForActive(); }
});

it('persists through the owning state store without creating a competing check-runs.json', async () => {
  const f = await fixture(); let saved: CheckRun[] = [];
  const store: Store = { load: async () => structuredClone(saved), save: vi.fn(async runs => { saved = structuredClone(runs); }) };
  const runner = await f.runner({ store }); const run = await runner.startChecks('candidate1'); await runner.waitForActive();
  expect(store.save).toHaveBeenCalled(); expect(saved.find(item => item.id === run.id)?.outcome).toBe('passed');
  await expect(readFile(path.join(f.directory, 'checks/check-runs.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects start when the owning state store cannot durably accept the queued run', async () => {
  const f = await fixture(); const schema = vi.fn((ctx: CheckContext) => passed('schema', ctx));
  const store: Store = { load: async () => [], save: async () => { throw new Error('injected owning-store failure'); } };
  const runner = await f.runner({ store, schema });
  await expect(runner.startChecks('candidate1')).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
  expect(schema).not.toHaveBeenCalled(); expect(runner.runsFor('candidate1')).toEqual([]);
});
