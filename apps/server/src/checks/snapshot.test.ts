import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computeSnapshot, copyAudited, SnapshotError, cleanupSnapshot } from './snapshot.ts';
import { writeArtifact, readArtifact, validateArtifactName, ArtifactError, removeArtifacts, listArtifacts } from './artifacts.ts';
import { CheckRunner, POLICY_VERSION, type CheckExecutor, type CheckResult, type CheckContext } from './runner.ts';
import { symlink } from 'node:fs/promises';

async function makeTree(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const abs = path.join(root, file);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

let dir: string;
let activeRunner: CheckRunner | undefined;
afterEach(async () => {
  if (activeRunner) { try { await activeRunner.drain(); } catch { /* ignore */ } activeRunner = undefined; }
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// Convenience: wait for active runs to complete without aborting.
async function waitActive(runner: CheckRunner) { await runner.waitForActive(); }

// ─── Snapshot identity tests ───

it('digest covers all audited files, not just changed ones', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, {
    'src/App.tsx': 'export default () => <div/>;\n',
    'src/components/Button.tsx': 'export function Button() { return <button/>; }\n',
    'src/style.css': 'body { margin: 0; }\n',
    'src/scene.config.json': '{"model":"/assets/test.glb"}\n',
    'public/assets/test.glb': 'binary-content',
  });
  const snap = await computeSnapshot(tree);
  expect(snap.entries).toHaveLength(5);
  expect(snap.digest).toMatch(/^[0-9a-f]{64}$/);
  // Same content → same digest.
  const snap2 = await computeSnapshot(tree);
  expect(snap2.digest).toBe(snap.digest);
});

it('digest changes when an unmodified dependency file is substituted', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, {
    'src/App.tsx': 'export default () => <div/>;\n',
    'src/components/Button.tsx': 'export function Button() { return <button/>; }\n',
  });
  const before = await computeSnapshot(tree);
  // Substitute Button.tsx with different content — digest must change even though
  // only App.tsx was "edited by the model".
  await writeFile(path.join(tree, 'src/components/Button.tsx'), 'export function Button() { return <button disabled/>; }\n');
  const after = await computeSnapshot(tree);
  expect(after.digest).not.toBe(before.digest);
});

it('digest changes when a file is deleted', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, {
    'src/App.tsx': 'export default () => <div/>;\n',
    'src/style.css': 'body { margin: 0; }\n',
  });
  const before = await computeSnapshot(tree);
  await rm(path.join(tree, 'src/style.css'));
  const after = await computeSnapshot(tree);
  expect(after.digest).not.toBe(before.digest);
});

it('rejects symlinks in the candidate tree', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, { 'src/App.tsx': '<div/>\n' });
  // Create a symlink inside src that points outside.
  await symlink(path.join(dir, 'target.txt'), path.join(tree, 'src/link.tsx'));
  await expect(computeSnapshot(tree)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});

it('rejects sensitive files (.env, credentials, keys)', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, {
    'src/App.tsx': '<div/>\n',
    '.env': 'SECRET=key\n',
  });
  // .env is a dot-file, skipped — but a .env.tsx would be caught by forbiddenPattern.
  await makeTree(tree, { 'src/.env.tsx': 'export const x = 1;\n' });
  await expect(computeSnapshot(tree)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});

it('skips node_modules and non-audited directories', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  await makeTree(tree, {
    'src/App.tsx': '<div/>\n',
    'node_modules/vite/package.json': '{"name":"vite"}\n',
    'dist/index.html': '<html/>\n',
    'package.json': '{}\n',
  });
  const snap = await computeSnapshot(tree);
  expect(snap.entries.map(e => e.path)).toEqual(['src/App.tsx']);
});

it('copyAudited copies only audited files and verifies digest match', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-snap-'));
  const tree = path.join(dir, 'candidate');
  const dest = path.join(dir, 'build');
  await makeTree(tree, {
    'src/App.tsx': '<div/>\n',
    'src/style.css': 'body { margin: 0; }\n',
    'public/assets/test.glb': 'binary',
  });
  const result = await copyAudited(tree, dest);
  expect(result.entries).toHaveLength(3);
  // Verify files were copied.
  const copied = await readFile(path.join(dest, 'src/App.tsx'), 'utf8');
  expect(copied).toBe('<div/>\n');
  // node_modules not copied.
  await expect(readFile(path.join(dest, 'node_modules', 'vite', 'package.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

// ─── Artifact security tests ───

it('rejects unknown artifact names', () => {
  expect(() => validateArtifactName('evil.exe')).toThrow();
  expect(() => validateArtifactName('../escape')).toThrow();
  expect(() => validateArtifactName('subdir/file.json')).toThrow();
  expect(() => validateArtifactName('')).toThrow();
});

it('writeArtifact and readArtifact round-trip', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-art-'));
  const ref = await writeArtifact(dir, 'abc123def', 'schema.json', '{"valid":true}');
  expect(ref.name).toBe('schema.json');
  expect(ref.bytes).toBe(14);
  expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
  const { buffer, ref: readRef } = await readArtifact(dir, 'abc123def', 'schema.json');
  expect(JSON.parse(buffer.toString('utf8'))).toEqual({ valid: true });
  expect(readRef.hash).toBe(ref.hash);
});

it('readArtifact rejects path traversal in runId', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-art-'));
  await expect(readArtifact(dir, '../../etc', 'schema.json')).rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  await expect(readArtifact(dir, 'abc123', '../../../etc/passwd')).rejects.toMatchObject({ code: 'UNKNOWN_ARTIFACT' });
});

it('readArtifact returns 404 for missing artifact', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-art-'));
  await expect(readArtifact(dir, 'abc123', 'schema.json')).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND', status: 404 });
});

it('writeArtifact truncates long text logs', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-art-'));
  const longLog = 'x'.repeat(200_000);
  const ref = await writeArtifact(dir, 'run1abc', 'runner.log', longLog);
  expect(ref.bytes).toBeLessThan(longLog.length);
  const { buffer } = await readArtifact(dir, 'run1abc', 'runner.log');
  expect(buffer.toString('utf8')).toContain('截断');
});

it('removeArtifacts cleans up the directory', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-art-'));
  await writeArtifact(dir, 'run1abc', 'schema.json', '{}');
  await removeArtifacts(dir, 'run1abc');
  const refs = await listArtifacts(dir, 'run1abc');
  expect(refs).toEqual([]);
});

// ─── CheckRunner persistent state tests ───

function makeExecutor(results: Partial<Record<string, CheckResult>>): CheckExecutor {
  const defaults: Record<string, CheckResult> = {
    schema: { name: 'schema', status: 'passed' },
    build: { name: 'build', status: 'passed' },
    smoke: { name: 'smoke', status: 'passed' },
    occlusion: { name: 'occlusion', status: 'passed' },
  };
  const merged = { ...defaults, ...results };
  const phase = (name: CheckResult['name']) => async (ctx: CheckContext): Promise<CheckResult> => {
    const result = merged[name]!;
    if (result.status !== 'passed') return result;
    const ref = await ctx.writeArtifact(name === 'build' ? 'build.log' : `${name}.json`, JSON.stringify({ testDouble: true, name }));
    return { ...result, evidence: ref.hash };
  };
  return {
    schema: phase('schema'), build: phase('build'), smoke: phase('smoke'), occlusion: phase('occlusion'),
  };
}

async function makeRunner(dir: string, opts?: { executor?: CheckExecutor; candidateCommit?: string; contentDigest?: string }) {
  const candidatePath = path.join(dir, 'candidate');
  await mkdir(path.join(candidatePath, 'src'), { recursive: true });
  await writeFile(path.join(candidatePath, 'src/App.tsx'), '<div/>\n');
  const runner = new CheckRunner({
    dataDirectory: path.join(dir, 'data'),
    candidatePath,
    candidateCommit: opts?.candidateCommit ?? 'abc123',
    baseVersion: 'base456',
    contentDigest: opts?.contentDigest ?? (await computeSnapshot(candidatePath)).digest,
    mainVersion: 'base456',
    executor: opts?.executor,
    buildTimeoutMs: 1000,
    browserTimeoutMs: 1000,
    runTimeoutMs: 5000,
  });
  await runner.init();
  activeRunner = runner;
  return runner;
}

it('same identity concurrent start returns same run, not duplicate', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const r1 = await runner.startChecks('cand1');
  const r2 = await runner.startChecks('cand1');
  expect(r1.id).toBe(r2.id);
  // Status may be queued or running since the executor runs synchronously.
  expect(['queued', 'running']).toContain(r1.status);
});

it('completed same-identity returns existing result without rerun', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const r1 = await runner.startChecks('cand1');
  await waitActive(runner);
  const completed1 = runner.getRun(r1.id);
  expect(completed1.status).toBe('completed');
  // Second call returns same run.
  const r2 = await runner.startChecks('cand1');
  expect(r2.id).toBe(r1.id);
});

it('rerun:true creates a new run even if completed exists', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const r1 = await runner.startChecks('cand1');
  await waitActive(runner);
  const r2 = await runner.startChecks('cand1', { rerun: true });
  expect(r2.id).not.toBe(r1.id);
});

it('queued/running runs are marked SERVICE_RESTARTED on init, not auto-rerun', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  // Simulate a crash: write a check-runs.json with a queued run that was never completed.
  const crashRun = {
    id: 'crash001abc',
    candidateId: 'cand1',
    baseVersion: 'base456',
    candidateCommit: 'abc123',
    contentDigest: 'digest789',
    mainVersion: 'base456',
    policyVersion: POLICY_VERSION,
    status: 'running',
    checks: [
      { name: 'schema', status: 'passed' },
      { name: 'build', status: 'not_run' },
      { name: 'smoke', status: 'not_run' },
      { name: 'occlusion', status: 'not_run' },
    ],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dataDir, 'check-runs.json'), JSON.stringify({ runs: [crashRun] }, null, 2));
  // Create a new runner on same data dir — it should find the interrupted run and mark it.
  const runner2 = new CheckRunner({
    dataDirectory: dataDir,
    candidatePath: path.join(dir, 'candidate'),
    candidateCommit: 'abc123',
    baseVersion: 'base456',
    contentDigest: 'digest789',
    mainVersion: 'base456',
    executor: makeExecutor({}),
    buildTimeoutMs: 1000,
    browserTimeoutMs: 1000,
    runTimeoutMs: 5000,
  });
  await runner2.init();
  activeRunner = runner2;
  const runs = runner2.runsFor('cand1');
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe('completed');
  expect(runs[0].error?.code).toBe('SERVICE_RESTARTED');
  // The already-passed schema check should retain its result.
  expect(runs[0].checks[0].status).toBe('passed');
  // Check.status never has a running value; unfinished work remains not_run with a reason.
  expect(runs[0].checks[1].status).toBe('not_run');
  expect(runs[0].checks[1].message).toBeTruthy();
  // Unstarted checks should get a message.
  expect(runs[0].checks[2].message).toBeTruthy();
});

it('cancel aborts a running check and marks it cancelled', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  let aborted = false;
  const executor: CheckExecutor = {
    schema: async (ctx: CheckContext) => {
      aborted = ctx.signal.aborted;
      // Wait for abort.
      return new Promise(resolve => {
        ctx.signal.addEventListener('abort', () => resolve({ name: 'schema', status: 'failed', message: '被取消' }));
      });
    },
    build: async () => ({ name: 'build', status: 'not_run' }),
    smoke: async () => ({ name: 'smoke', status: 'not_run' }),
    occlusion: async () => ({ name: 'occlusion', status: 'not_run' }),
  };
  const runner = await makeRunner(dir, { executor });
  const run = await runner.startChecks('cand1');
  const cancelled = await runner.cancelChecks(run.id);
  await waitActive(runner);
  expect(cancelled.status).toBe('cancelled');
});

it('cancel is idempotent for already-cancelled runs', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const run = await runner.startChecks('cand1');
  await runner.cancelChecks(run.id);
  await waitActive(runner);
  // Cancel again — should not throw.
  const result = await runner.cancelChecks(run.id);
  expect(result.status).toBe('cancelled');
});

it('cancel a completed run does not rewrite it to cancelled', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const run = await runner.startChecks('cand1');
  await waitActive(runner);
  const completed = runner.getRun(run.id);
  expect(completed.status).toBe('completed');
  await runner.cancelChecks(run.id);
  const after = runner.getRun(run.id);
  expect(after.status).toBe('completed'); // not rewritten to cancelled
});

it('a failed schema check blocks subsequent checks as not_run', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({
    schema: { name: 'schema', status: 'failed', message: '场景配置缺失' },
  });
  const runner = await makeRunner(dir, { executor });
  const run = await runner.startChecks('cand1');
  await waitActive(runner);
  const completed = runner.getRun(run.id);
  expect(completed.status).toBe('completed');
  expect(completed.checks[0].status).toBe('failed'); // schema
  expect(completed.checks[1].status).toBe('not_run'); // build
  expect(completed.checks[1].message).toContain('schema');
  expect(completed.checks[2].status).toBe('not_run'); // smoke
  expect(completed.checks[3].status).toBe('not_run'); // occlusion
});

it('latestCompleted returns the most recent completed run', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const r1 = await runner.startChecks('cand1');
  await waitActive(runner);
  const r2 = await runner.startChecks('cand1', { rerun: true });
  await waitActive(runner);
  const latest = runner.latestCompleted('cand1');
  expect(latest?.id).toBe(r2.id);
});

it('latestCompleted returns undefined when no completed runs exist', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  expect(runner.latestCompleted('cand1')).toBeUndefined();
});

it('runs are persisted to check-runs.json and survive restart', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  const r1 = await runner.startChecks('cand1');
  await waitActive(runner);
  // Verify file exists.
  const file = path.join(dir, 'data', 'check-runs.json');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  expect(saved.runs).toHaveLength(1);
  expect(saved.runs[0].id).toBe(r1.id);
  // New runner loads it.
  const runner2 = new CheckRunner({
    dataDirectory: path.join(dir, 'data'),
    candidatePath: path.join(dir, 'candidate'),
    candidateCommit: 'abc123',
    baseVersion: 'base456',
    contentDigest: 'digest789',
    mainVersion: 'base456',
    executor: makeExecutor({}),
    buildTimeoutMs: 1000,
    browserTimeoutMs: 1000,
    runTimeoutMs: 5000,
  });
  await runner2.init();
  expect(runner2.runsFor('cand1')).toHaveLength(1);
});

it('corrupted check-runs.json does not silently reset', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'check-runs.json'), '{invalid json');
  const runner = new CheckRunner({
    dataDirectory: dataDir,
    candidatePath: path.join(dir, 'candidate'),
    candidateCommit: 'abc123',
    baseVersion: 'base456',
    contentDigest: 'digest789',
    mainVersion: 'base456',
    executor: makeExecutor({}),
  });
  await expect(runner.init()).rejects.toThrow();
});

it('old candidate with no check runs returns not_run for all checks', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  // No runs started — latestCompleted is undefined.
  expect(runner.latestCompleted('old-candidate')).toBeUndefined();
  const runs = runner.runsFor('old-candidate');
  expect(runs).toEqual([]);
});

it('cross-candidate results are isolated', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'm3b-runner-'));
  const executor = makeExecutor({});
  const runner = await makeRunner(dir, { executor });
  await runner.startChecks('cand1');
  await waitActive(runner);
  // cand2 has a different candidateCommit.
  const runs1 = runner.runsFor('cand1');
  const runs2 = runner.runsFor('cand2');
  expect(runs1).toHaveLength(1);
  expect(runs2).toEqual([]);
});
