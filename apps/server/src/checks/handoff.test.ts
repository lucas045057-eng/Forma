import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { computeSnapshot, copyAudited } from './snapshot.ts';
import { writeArtifact } from './artifacts.ts';
import { CheckRunner, type CheckExecutor, type CheckContext, type CheckResult } from './runner.ts';

const directories: string[] = [];
const runners: CheckRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.drain();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'm3b-handoff-'));
  directories.push(directory);
  const candidate = path.join(directory, 'candidate');
  await mkdir(path.join(candidate, 'src'), { recursive: true });
  await writeFile(path.join(candidate, 'src/App.tsx'), 'export default () => <main/>;\n');
  return { directory, candidate };
}

async function runnerFixture() {
  const f = await fixture();
  const snapshot = await computeSnapshot(f.candidate);
  let schemaCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const passed = async (name: CheckResult['name'], ctx: CheckContext): Promise<CheckResult> => {
    const ref = await ctx.writeArtifact(name === 'build' ? 'build.log' : `${name}.json`, JSON.stringify({ testDouble: true, name }));
    return { name, status: 'passed', evidence: ref.hash };
  };
  const executor: CheckExecutor = {
    schema: async ctx => { schemaCalls++; await gate; return passed('schema', ctx); },
    build: async ctx => passed('build', ctx),
    smoke: async ctx => passed('smoke', ctx),
    occlusion: async ctx => passed('occlusion', ctx),
  };
  const options = {
    dataDirectory: path.join(f.directory, 'data'), candidatePath: f.candidate,
    candidateCommit: 'a'.repeat(40), baseVersion: 'b'.repeat(40), mainVersion: 'b'.repeat(40),
    contentDigest: snapshot.digest, executor, runTimeoutMs: 1000,
  };
  const runner = new CheckRunner(options);
  await runner.init();
  runners.push(runner);
  return { ...f, runner, options, release, schemaCalls: () => schemaCalls };
}

it('rejects a junction used as the candidate root itself', async () => {
  const f = await fixture();
  const alias = path.join(f.directory, 'root-junction');
  await symlink(f.candidate, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(computeSnapshot(alias)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
});

it('accepts an 11 MiB GLB consistent with the already delivered product assets', async () => {
  const f = await fixture();
  await mkdir(path.join(f.candidate, 'public/assets'), { recursive: true });
  await writeFile(path.join(f.candidate, 'public/assets/product.glb'), Buffer.alloc(11 * 1024 * 1024, 1));
  const snapshot = await computeSnapshot(f.candidate);
  expect(snapshot.entries.find(entry => entry.path === 'public/assets/product.glb')?.bytes).toBe(11 * 1024 * 1024);
});

it('refuses a snapshot destination junction and leaves its target untouched', async () => {
  const f = await fixture();
  const target = path.join(f.directory, 'other-owned-data');
  await mkdir(target);
  await writeFile(path.join(target, 'sentinel'), 'preserve');
  const destination = path.join(f.directory, 'destination');
  await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(copyAudited(f.candidate, destination)).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  expect(await readFile(path.join(target, 'sentinel'), 'utf8')).toBe('preserve');
  await expect(readFile(path.join(target, 'src/App.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('deduplicates genuinely concurrent starts across the first persistence await', async () => {
  const f = await runnerFixture();
  try {
    const [first, second] = await Promise.all([f.runner.startChecks('candidate1'), f.runner.startChecks('candidate1')]);
    expect(first.id).toBe(second.id);
  } finally {
    f.release();
    await f.runner.waitForActive();
  }
  expect(f.schemaCalls()).toBe(1);
  expect(f.runner.runsFor('candidate1')).toHaveLength(1);
});

it('refuses new check admission after drain begins', async () => {
  const f = await runnerFixture();
  f.release();
  await f.runner.drain();
  await expect(f.runner.startChecks('candidate1')).rejects.toMatchObject({ code: 'SERVICE_CLOSING' });
});

it('rejects path traversal on artifact writes as well as reads', async () => {
  const f = await fixture();
  await expect(writeArtifact(f.directory, '../escaped', 'build.log', 'not permitted'))
    .rejects.toMatchObject({ code: 'UNKNOWN_RUN' });
  await expect(readFile(path.join(f.directory, 'escaped/build.log'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects an artifact root junction before writing into another directory', async () => {
  const f = await fixture();
  const target = path.join(f.directory, 'unrelated');
  await mkdir(target);
  await symlink(target, path.join(f.directory, 'check-artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(writeArtifact(f.directory, 'abcdef123456', 'build.log', 'not permitted'))
    .rejects.toMatchObject({ code: 'PATH_DENIED' });
  await expect(readFile(path.join(target, 'abcdef123456/build.log'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses structurally corrupt persisted records instead of silently accepting an array', async () => {
  const f = await runnerFixture();
  await writeFile(path.join(f.options.dataDirectory, 'check-runs.json'), JSON.stringify({ runs: [{}] }));
  const restarted = new CheckRunner(f.options);
  await expect(restarted.init()).rejects.toThrow();
});
