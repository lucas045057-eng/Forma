import { spawn, execFileSync } from 'node:child_process';
import { mkdir, rename, symlink, unlink, lstat, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
process.chdir(root);
const git = (...args) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: root, encoding: 'utf8' }).trim();
async function identity() {
  const files = git('ls-files', '--', 'apps', 'packages', 'templates', 'tests/e2e/m1b', 'playwright.m1b.config.ts', 'pnpm-lock.yaml').split('\n');
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(root, file)))])));
}
const run = `.data/m1b-repro/${new Date().toISOString().replaceAll(':', '-')}`;
const out = path.resolve(root, run);
const evidence = path.resolve(root, 'docs/reports/artifacts/M1-B');
const original = path.join(out, 'original-evidence');
const artifacts = path.join(out, 'artifacts');
let moved = false;
let linked = false;
let code = 1;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashes(directory) {
  const entries = [];
  async function visit(base, relative = '') {
    for (const item of await readdir(base, { withFileTypes: true })) {
      const name = path.join(relative, item.name);
      if (item.isSymbolicLink()) throw new Error(`Unexpected evidence link: ${name}`);
      if (item.isDirectory()) await visit(path.join(base, item.name), name);
      else entries.push({ path: name, hash: sha(await readFile(path.join(base, item.name))) });
    }
  }
  await visit(directory);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
await mkdir(out, { recursive: true });
const manifest = { head: git('rev-parse', 'HEAD'), apps: git('rev-parse', 'HEAD:apps'), run, command: 'node node_modules/@playwright/test/cli.js test -c playwright.m1b.config.ts --workers=1 --retries=0 --reporter=list,json', started: new Date().toISOString() };
console.log(JSON.stringify(manifest));
try {
  manifest.draftDiff = git('diff', '--', 'apps/studio/src/scene-editor.css');
  manifest.identityBefore = await identity();
  const dirty = git('status', '--porcelain', '--', 'apps', 'packages', 'templates', 'tests', 'pnpm-lock.yaml', 'docs/reports/artifacts/M1-B');
  if (dirty !== 'M apps/studio/src/scene-editor.css') throw new Error(`Unexpected draft baseline: ${dirty}`);
  console.log(JSON.stringify({draftDiff: manifest.draftDiff, identityFiles: Object.keys(manifest.identityBefore).length}));
  if ((await lstat(evidence)).isSymbolicLink()) throw new Error('Evidence directory is already redirected');
  manifest.originalEvidence = await hashes(evidence);
  await mkdir(artifacts);
  await rename(evidence, original);
  moved = true;
  await symlink(artifacts, evidence, 'junction');
  linked = true;
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA, 'ms-playwright');
  if (browserPath !== browserPath.trim()) throw new Error('Browser path contains edge whitespace');
  code = await new Promise((resolve, reject) => {
    const command = `${manifest.command} --output=${run}/output`;
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: root, stdio: 'inherit', env: {
      ...process.env, CI: 'true', PLAYWRIGHT_BROWSERS_PATH: browserPath,
      PLAYWRIGHT_JSON_OUTPUT_FILE: `${run}/results.json`,
    } });
    child.once('error', reject);
    child.once('close', (exit, signal) => { manifest.signal = signal; resolve(exit ?? 1); });
  });
} catch (error) {
  manifest.entryOrCleanupError = String(error);
  console.error(error);
  code = 1;
} finally {
  try {
    if (linked) { await unlink(evidence); linked = false; }
    if (moved) { await rename(original, evidence); moved = false; }
    manifest.evidenceRestored = JSON.stringify(await hashes(evidence)) === JSON.stringify(manifest.originalEvidence);
    if (!manifest.evidenceRestored) throw new Error('Historical evidence did not match its original hashes');
    manifest.identityAfter = await identity();
    manifest.identityUnchanged = JSON.stringify(manifest.identityBefore) === JSON.stringify(manifest.identityAfter);
    if (!manifest.identityUnchanged) throw new Error('Frozen draft identity changed during verification');
    if (code === 0) {
      const report = JSON.parse(await readFile(path.join(out, 'results.json'), 'utf8'));
      const tests = [];
      const visit = suites => { for (const suite of suites ?? []) { for (const spec of suite.specs ?? []) tests.push(...spec.tests); visit(suite.suites); } };
      visit(report.suites);
      manifest.testSummary = { stats: report.stats, count: tests.length };
      if (tests.length !== 23 || report.errors?.length || tests.some(test => test.expectedStatus !== 'passed' || test.status !== 'expected' || test.results.length !== 1 || test.results[0].status !== 'passed' || test.results[0].retry !== 0)) throw new Error('Original 23 tests did not each pass once');
    }
  } catch (error) { manifest.cleanupError = String(error); console.error(error); code = 1; }
  manifest.finished = new Date().toISOString();
  manifest.exit = code;
  manifest.statusAfter = git('status', '--porcelain');
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ run, exit: code, evidenceRestored: manifest.evidenceRestored, statusAfter: manifest.statusAfter }));
}
process.exitCode = code;
