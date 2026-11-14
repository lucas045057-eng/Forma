#!/usr/bin/env node
/**
 * M3-A 合并后独立验收顺序入口：typecheck/build/单测 + M0/M1/M2 全部 e2e + M3-A。
 * 首败即停；每步记录命令/起止/exit/signal/HEAD/lock/prod 摘要/端口；结束后归档并还原
 * 被本轮刷新的 tracked report artifacts，避免覆盖 M2 历史。
 *
 * 用法：node tests/e2e/m3a/run-validation.mjs --run-id run-YYYYMMDD-HHMMSS
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const runId = value('--run-id') ?? `run-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}`;
const EVIDENCE = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M3-A', runId);
const LOGS = path.join(EVIDENCE, 'logs');
const REPORTS = path.join(EVIDENCE, 'reports');
const OUT = path.join(EVIDENCE, 'output');
for (const dir of [EVIDENCE, LOGS, REPORTS, OUT]) mkdirSync(dir, { recursive: true });
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');

const exe = (file, argv, options = {}) => execFileSync(file, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options }).trim();
const git = (...argv) => exe('git', argv);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fileHash = (file) => existsSync(file) ? sha(readFileSync(file)) : null;
const HEAD = git('rev-parse', 'HEAD');
const BASE = value('--base') ?? '012d9a65b4242cad2407a40c34614b2d162c8032';
const PROD = ['apps', 'packages', 'templates'];
const productionDigest = () => sha(git('ls-tree', '-r', HEAD, '--', ...PROD));
const lockHash = () => fileHash(path.join(ROOT, 'pnpm-lock.yaml'));
const prodStatus = () => git('status', '--porcelain', '--', ...PROD);
const ports = [3001, 4011, 5173, 5174, 5175];
const portFree = (port) => new Promise((resolve) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); s.setTimeout(800, () => { s.destroy(); resolve(true); }); });

const steps = [
  { id: 'typecheck', command: 'pnpm typecheck', timeoutMs: 20 * 60_000 },
  { id: 'build', command: 'pnpm build', timeoutMs: 20 * 60_000 },
  { id: 'unit', command: 'pnpm test', timeoutMs: 20 * 60_000 },
  { id: 'e2e-m0b', command: 'node node_modules/@playwright/test/cli.js test -c playwright.config.ts --reporter=list --reporter=json', timeoutMs: 45 * 60_000, playwright: true },
  { id: 'e2e-m0a', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m0a.config.ts --reporter=list --reporter=json', timeoutMs: 45 * 60_000, playwright: true },
  { id: 'e2e-m1a', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m1a.config.ts --reporter=list --reporter=json', timeoutMs: 45 * 60_000, playwright: true },
  { id: 'e2e-m1b', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m1b.config.ts --reporter=list --reporter=json', timeoutMs: 45 * 60_000, playwright: true },
  { id: 'e2e-m2a', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2a.config.ts --reporter=list --reporter=json', timeoutMs: 60 * 60_000, playwright: true },
  { id: 'e2e-m2b', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2b.config.ts --reporter=list --reporter=json', timeoutMs: 60 * 60_000, playwright: true },
  { id: 'e2e-m3a', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m3a.config.ts --reporter=list --reporter=json', timeoutMs: 30 * 60_000, playwright: true },
];

const evidence = {
  runId, head: HEAD, base: BASE, startedAt: new Date().toISOString(),
  productionDigest: productionDigest(), lockHash: lockHash(), productionStatus: prodStatus(), steps: [], status: 'running',
};
const evidenceFile = path.join(EVIDENCE, 'evidence.json');
const writeEvidence = () => writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);

function parsePlaywright(file) {
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const counts = { total: 0, passed: 0, expectedFailed: 0, unexpected: 0, skipped: 0 };
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const item of spec.tests ?? []) {
      counts.total += 1;
      const result = (item.results ?? [])[0] ?? {};
      if (result.status === 'passed') counts.passed += 1;
      else if (result.status === 'skipped') counts.skipped += 1;
      else if (result.status === 'failed' && item.expectedStatus === 'failed') counts.expectedFailed += 1;
      else if (result.status === 'failed') counts.unexpected += 1;
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return { stats: report.stats ?? null, counts };
}

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target); else copyFileSync(source, target);
  }
}

function archiveAndRestoreArtifacts() {
  const modified = execFileSync('git', ['diff', '--name-only', '-z', '--', 'docs/reports/artifacts'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const archive = path.join(EVIDENCE, 'refreshed-artifacts');
  for (const relative of modified) {
    const from = path.join(ROOT, relative), to = path.join(archive, relative);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  if (modified.length) execFileSync('git', ['checkout', '--', ...modified], { cwd: ROOT, stdio: 'ignore' });
  return { files: modified.map((relative) => ({ file: relative, sha256: fileHash(path.join(archive, relative)) })), restored: modified.length };
}

async function runStep(step, index) {
  const record = { id: step.id, command: step.command, startedAt: new Date().toISOString() };
  const logFile = path.join(LOGS, `${String(index + 1).padStart(2, '0')}-${step.id}.log`);
  const reportFile = path.join(REPORTS, `${step.id}.json`);
  const before = { head: git('rev-parse', 'HEAD'), lockHash: lockHash(), productionDigest: productionDigest(), productionStatus: prodStatus(), ports: await Promise.all(ports.map(async (port) => [port, await portFree(port)])) };
  record.before = before;
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS };
  if (step.playwright) env.PLAYWRIGHT_JSON_OUTPUT_NAME = reportFile;
  const command = step.playwright ? `${step.command} --output="${path.resolve(OUT, step.id)}"` : step.command;
  writeFileSync(logFile, `# ${record.startedAt} ${command}\n`);
  const logStream = (await import('node:fs')).createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, { cwd: ROOT, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream); child.stderr.pipe(logStream);
  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); }, step.timeoutMs);
  const exit = await new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', (error) => resolve({ code: 127, signal: String(error) })); });
  clearTimeout(timer);
  await new Promise((resolve) => logStream.end(resolve));
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.now() - started;
  record.exitCode = timedOut ? 124 : exit.code;
  record.signal = timedOut ? 'TIMEOUT' : exit.signal;
  record.after = { head: git('rev-parse', 'HEAD'), lockHash: lockHash(), productionDigest: productionDigest(), productionStatus: prodStatus(), ports: await Promise.all(ports.map(async (port) => [port, await portFree(port)])) };
  if (step.playwright) record.playwright = parsePlaywright(reportFile);
  record.failed = record.exitCode !== 0 || Boolean(record.signal) || record.after.head !== evidence.head || record.after.lockHash !== evidence.lockHash || record.after.productionDigest !== evidence.productionDigest || Boolean(record.after.productionStatus);
  evidence.steps.push(record);
  writeEvidence();
  console.log(`[${record.failed ? 'FAIL' : 'PASS'}] ${step.id} exit=${record.exitCode} ${Math.round(record.durationMs / 1000)}s${record.playwright ? ` ${record.playwright.counts.passed}/${record.playwright.counts.total}` : ''}`);
  if (record.failed) {
    if (!timedOut) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    throw new Error(`步骤 ${step.id} 失败`);
  }
}

async function main() {
  const busy = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  if (busy.length) {
    evidence.status = 'blocked'; evidence.blocked = { ports: busy }; evidence.finishedAt = new Date().toISOString(); writeEvidence();
    console.log(`BLOCKED ports ${busy}`); process.exit(2);
  }
  try { execFileSync('git', ['merge-base', '--is-ancestor', BASE, HEAD], { cwd: ROOT, stdio: 'ignore' }); }
  catch { evidence.status = 'blocked'; evidence.blocked = { reason: 'base-not-ancestor', base: BASE, head: HEAD }; writeEvidence(); process.exit(2); }
  writeEvidence();
  try {
    for (let index = 0; index < steps.length; index += 1) await runStep(steps[index], index);
    evidence.status = 'passed';
    console.log(`ALL PASSED ${steps.length} steps`);
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    evidence.finishedAt = new Date().toISOString();
    evidence.productionAfter = { digest: productionDigest(), lockHash: lockHash(), status: prodStatus() };
    evidence.refreshedArtifacts = archiveAndRestoreArtifacts();
    writeEvidence();
    writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify({
      runId, head: HEAD, status: evidence.status,
      steps: evidence.steps.map((step) => ({ id: step.id, exitCode: step.exitCode, signal: step.signal, durationMs: step.durationMs, playwright: step.playwright?.counts ?? null, failed: step.failed })),
      productionDigest: evidence.productionDigest, lockHash: evidence.lockHash, productionAfter: evidence.productionAfter,
      refreshedArtifacts: evidence.refreshedArtifacts.files.length,
    }, null, 2)}\n`);
  }
  process.exit(evidence.status === 'passed' ? 0 : 1);
}
main().catch((error) => { console.error(error); evidence.status = 'failed'; evidence.error = String(error); writeEvidence(); process.exit(1); });
