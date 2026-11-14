import childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { computeSnapshot, copyAudited } from './snapshot.ts';
import { readArtifact, writeArtifact, type ArtifactRef } from './artifacts.ts';
import type { CheckContext, CheckExecutor } from './runner.ts';
import { createRealExecutor } from './worker.ts';

const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const templateRoot = path.join(projectRoot, 'templates/product-page');
interface Owned { directory: string; executor: CheckExecutor; controller: AbortController; ctx: CheckContext }
const owned: Owned[] = [];
afterEach(async () => {
  try {
    for (const f of owned.splice(0)) {
      f.controller.abort();
      await f.executor.stop?.(f.ctx.runId);
      await rm(f.directory, { recursive: true, force: true });
    }
  } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); }
});

async function fixture(realTemplate = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'm3b-worker-'));
  const candidateRoot = path.join(directory, 'candidate');
  await mkdir(path.join(candidateRoot, 'src'), { recursive: true });
  if (realTemplate) await cp(path.join(templateRoot, 'src'), path.join(candidateRoot, 'src'), { recursive: true });
  else {
    await writeFile(path.join(candidateRoot, 'src/main.tsx'), "import { createRoot } from 'react-dom/client'; import App from './App'; createRoot(document.getElementById('root')!).render(<App/>);\n");
    await writeFile(path.join(candidateRoot, 'src/App.tsx'), 'export default () => <main>worker fixture</main>;\n');
    await cp(path.join(templateRoot, 'src/scene.config.json'), path.join(candidateRoot, 'src/scene.config.json'));
  }
  const buildRoot = path.join(directory, 'snapshot');
  const snapshot = await copyAudited(candidateRoot, buildRoot);
  const artifactsDir = path.join(directory, 'evidence');
  const controller = new AbortController();
  const refs = new Map<string, ArtifactRef>();
  const ctx: CheckContext = {
    runId: randomUUID().replaceAll('-', ''), candidateRoot, buildRoot, snapshot,
    signal: controller.signal, buildTimeoutMs: 120_000, browserTimeoutMs: 30_000, artifactsDir,
    writeArtifact: async (name, content) => {
      const ref = await writeArtifact(artifactsDir, ctx.runId, name, content);
      refs.set(name, ref); return ref;
    },
  };
  const executor = createRealExecutor();
  owned.push({ directory, executor, controller, ctx });
  return { directory, candidateRoot, buildRoot, controller, ctx, executor, refs };
}

async function build(f: Awaited<ReturnType<typeof fixture>>) {
  // Fault fixtures deliberately replace snapshot inputs before the check begins.
  f.ctx.snapshot = await computeSnapshot(f.buildRoot);
  expect((await f.executor.schema(f.ctx)).status).toBe('passed');
  return f.executor.build(f.ctx);
}
async function bundleText(buildRoot: string) {
  const assets = path.join(buildRoot, 'dist/assets');
  const files = await readdir(assets);
  const scripts = files.filter(file => file.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  return (await Promise.all(scripts.map(file => readFile(path.join(assets, file), 'utf8')))).join('\n');
}
function observeSpawns() {
  const spy = vi.spyOn(childProcess, 'spawn');
  syncBuiltinESMExports();
  return spy;
}
function workerSpawn(spy: ReturnType<typeof observeSpawns>) {
  const index = spy.mock.calls.findIndex(call => call[0] === process.execPath && Array.isArray(call[1]) &&
    call[1].some(arg => /[/\\]checks[/\\]worker-entry\.(?:ts|js)$/.test(String(arg))));
  expect(index, 'a fixed trusted Node worker must own the checks').toBeGreaterThanOrEqual(0);
  const child: ChildProcess = spy.mock.results[index]!.value;
  expect(child.pid).toBeTypeOf('number');
  return { child, call: spy.mock.calls[index]! };
}

it('runs schema in a fixed worker with a minimal environment and real artifact identity', async () => {
  vi.stubEnv('CODING_AGENT_API_KEY', 'test-only-coding-canary');
  vi.stubEnv('LUX3D_API_KEY', 'test-only-asset-canary');
  vi.stubEnv('TEST_CHECK_CANARY', 'test-only-extra-environment');
  vi.stubEnv('NODE_OPTIONS', '--invalid-test-only-parent-option');
  const spy = observeSpawns();
  const f = await fixture(); const result = await f.executor.schema(f.ctx);
  expect(result.status, result.message).toBe('passed');
  const { call } = workerSpawn(spy);
  const options = call[2];
  expect(options?.env).toBeDefined(); expect(options?.shell ?? false).toBe(false);
  for (const key of ['CODING_AGENT_API_KEY', 'LUX3D_API_KEY', 'TEST_CHECK_CANARY', 'NODE_OPTIONS']) expect(options?.env?.[key]).toBeUndefined();
  expect(result.evidence).toBe(f.refs.get('schema.json')?.hash);
});

it('validates the immutable snapshot even when the live candidate changes afterwards', async () => {
  const f = await fixture();
  await writeFile(path.join(f.candidateRoot, 'src/scene.config.json'), '{broken live candidate');
  expect((await f.executor.schema(f.ctx)).status).toBe('passed');
});

it('reports malformed JSON from the actual snapshot even when the live candidate remains valid', async () => {
  const f = await fixture();
  await writeFile(path.join(f.buildRoot, 'src/scene.config.json'), '{broken snapshot');
  f.ctx.snapshot = await computeSnapshot(f.buildRoot);
  const result = await f.executor.schema(f.ctx);
  expect(result.status).toBe('failed'); expect(result.message).toMatch(/JSON/);
});

it('builds an HTML page and real JavaScript using trusted tools without candidate node_modules', async () => {
  const f = await fixture(); const result = await build(f);
  expect(result.status, result.message).toBe('passed');
  expect(await readFile(path.join(f.buildRoot, 'dist/index.html'), 'utf8')).toContain('id="root"');
  expect(await bundleText(f.buildRoot)).toContain('worker fixture');
  expect(result.evidence).toBe(f.refs.get('build.log')?.hash);
}, 15_000);

it('builds the real product template including shared scene-renderer sources', async () => {
  const f = await fixture(true); const result = await build(f);
  expect(result.status).toBe('passed');
  expect(await readFile(path.join(f.buildRoot, 'dist/index.html'), 'utf8')).toContain('id="root"');
  expect((await bundleText(f.buildRoot)).length).toBeGreaterThan(1000);
}, 20_000);

it('does not execute mutable candidate configs or package scripts', async () => {
  const f = await fixture(); const sentinel = path.join(f.directory, 'must-not-execute');
  const code = "import { writeFileSync } from 'node:fs'; writeFileSync(" + JSON.stringify(sentinel) + ", 'executed'); throw new Error('untrusted config executed');";
  await writeFile(path.join(f.candidateRoot, 'vite.config.ts'), code);
  await writeFile(path.join(f.candidateRoot, 'postcss.config.js'), code);
  await writeFile(path.join(f.candidateRoot, 'should-not-run.mjs'), code);
  await writeFile(path.join(f.candidateRoot, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node should-not-run.mjs' } }));
  expect((await build(f)).status).toBe('passed');
  await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
}, 15_000);

it('excludes both candidate .env and parent VITE variables from the browser bundle', async () => {
  vi.stubEnv('VITE_CHECK_CANARY', 'TEST_ONLY_BUNDLE_CANARY_VALUE');
  const f = await fixture();
  await writeFile(path.join(f.candidateRoot, '.env'), 'VITE_CHECK_CANARY=TEST_ONLY_BUNDLE_CANARY_VALUE\n');
  await writeFile(path.join(f.buildRoot, 'src/App.tsx'), 'export default () => <main>{import.meta.env.VITE_CHECK_CANARY || "no canary"}</main>;');
  expect((await build(f)).status).toBe('passed');
  expect(await bundleText(f.buildRoot)).not.toContain('TEST_ONLY_BUNDLE_CANARY_VALUE');
}, 15_000);

it.each([
  { label: 'syntax errors', app: 'export default () => <main>broken;\n', css: undefined, reason: /syntax|parse|transform|Expected/i },
  { label: 'raw imports outside the snapshot', app: 'import value from "../../private-canary.txt?raw"; export default () => <main>{value}</main>;', css: undefined, reason: /UNSAFE_IMPORT/ },
  { label: 'CSS reads outside the snapshot', app: 'import "./attack.css"; export default () => <main/>;', css: 'body{background:url("../../private-canary.txt")}', reason: /UNSAFE_IMPORT/ },
  { label: 'Node builtin imports in candidate source', app: 'import fs from "node:fs"; export default () => <main>{String(fs)}</main>;', css: undefined, reason: /UNSAFE_IMPORT/ },
  { label: 'network CSS imports', app: 'import "./attack.css"; export default () => <main/>;', css: '@import "http://127.0.0.1:1/forbidden.css";', reason: /UNSAFE_IMPORT/ },
])('fails closed on $label', async ({ app, css, reason }) => {
  const f = await fixture();
  await writeFile(path.join(f.directory, 'private-canary.txt'), 'TEST_ONLY_FILE_CANARY_VALUE');
  await writeFile(path.join(f.buildRoot, 'src/App.tsx'), app);
  if (css) await writeFile(path.join(f.buildRoot, 'src/attack.css'), css);
  const result = await build(f);
  expect(result.status).toBe('failed'); expect(result.message).toMatch(reason);
  const { buffer } = await readArtifact(f.ctx.artifactsDir, f.ctx.runId, 'build.log');
  expect(buffer.toString('utf8')).not.toContain('TEST_ONLY_FILE_CANARY_VALUE');
}, 15_000);

it('does not spawn a worker for an already aborted request', async () => {
  const spy = observeSpawns(); const f = await fixture(); f.controller.abort();
  await expect(f.executor.schema(f.ctx)).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(spy).not.toHaveBeenCalled();
});

it('cancels its owned worker and confirms exit before stop returns', async () => {
  const spy = observeSpawns(); const f = await fixture(true);
  expect((await f.executor.schema(f.ctx)).status).toBe('passed');
  const { child } = workerSpawn(spy);
  const pending = f.executor.build(f.ctx); void pending.catch(() => {});
  f.controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(typeof f.executor.stop).toBe('function');
  await f.executor.stop?.(f.ctx.runId); await f.executor.stop?.(f.ctx.runId);
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}, 15_000);
