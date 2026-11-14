#!/usr/bin/env node
/**
 * M2-B 审批 helper 修正后的定向 checkpoint：完整 M2-B 12 条 → M3-A 11 条，首败即停。
 * 不重跑 typecheck/build/unit 或其它 E2E；只作修正验证，不是最终全套结论。
 * 刷新 tracked report artifacts 先复制到证据目录再还原；不覆盖 run1/run2/run3/stability/M2 历史。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const runId = value('--run-id') ?? 'run-20261114-m3a-ui-checkpoint';
const EVIDENCE = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M3-A', runId);
if (existsSync(EVIDENCE)) throw new Error(`证据目录已存在，拒绝覆盖：${EVIDENCE}`);
const LOGS = path.join(EVIDENCE, 'logs');
const REPORTS = path.join(EVIDENCE, 'reports');
const OUT = path.join(EVIDENCE, 'output');
for (const dir of [EVIDENCE, LOGS, REPORTS, OUT]) mkdirSync(dir, { recursive: true });
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const ports = [3001, 4011, 5173, 5174, 5175];
const exe = (file, argv) => execFileSync(file, argv, { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim();
const git = (...argv) => exe('git', argv);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fileHash = (file) => existsSync(file) ? sha(readFileSync(file)) : null;
const HEAD = git('rev-parse', 'HEAD');
const PROD = ['apps', 'packages', 'templates'];
const prodDigest = () => sha(git('ls-tree', '-r', HEAD, '--', ...PROD));
const lockHash = () => fileHash(path.join(ROOT, 'pnpm-lock.yaml'));
const prodStatus = () => git('status', '--porcelain', '--', ...PROD);
const portFree = (port) => new Promise((resolve) => { const s = net.connect({ port, host: '127.0.0.1' }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); s.setTimeout(800, () => { s.destroy(); resolve(true); }); });

const evidence = { runId, head: HEAD, startedAt: new Date().toISOString(), productionDigest: prodDigest(), lockHash: lockHash(), productionStatus: prodStatus(), steps: [], status: 'running' };
const evidenceFile = path.join(EVIDENCE, 'evidence.json');
const writeEvidence = () => writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
writeEvidence();

const steps = [
  { id: 'e2e-m2b', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2b.config.ts --reporter=list --reporter=json', timeoutMs: 45 * 60_000, expectedTests: 12 },
  { id: 'e2e-m3a', command: 'node node_modules/@playwright/test/cli.js test -c playwright.m3a.config.ts --reporter=list --reporter=json', timeoutMs: 30 * 60_000, expectedTests: 11 },
];

function parse(file) {
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const counts = { total: 0, passed: 0, expectedFailed: 0, unexpected: 0, skipped: 0, retries: 0 };
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const item of spec.tests ?? []) {
      counts.total += 1;
      const result = (item.results ?? [])[0] ?? {};
      if (result.status === 'passed') counts.passed += 1;
      else if (result.status === 'skipped') counts.skipped += 1;
      else if (result.status === 'failed' && item.expectedStatus === 'failed') counts.expectedFailed += 1;
      else if (result.status === 'failed') counts.unexpected += 1;
      counts.retries += Number(result.retry ?? 0);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return { stats: report.stats ?? null, counts };
}

function archiveRestore() {
  const modified = execFileSync('git', ['diff', '--name-only', '-z', '--', 'docs/reports/artifacts'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const dir = path.join(EVIDENCE, 'refreshed-artifacts');
  for (const rel of modified) {
    const to = path.join(dir, rel); mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(path.join(ROOT, rel), to);
  }
  if (modified.length) execFileSync('git', ['checkout', '--', ...modified], { cwd: ROOT, stdio: 'ignore' });
  return { files: modified.map((rel) => ({ file: rel, sha256: fileHash(path.join(dir, rel)) })), restored: modified.length };
}

async function runStep(step, index) {
  const record = { id: step.id, command: step.command, startedAt: new Date().toISOString() };
  const logFile = path.join(LOGS, `${String(index + 1).padStart(2, '0')}-${step.id}.log`);
  const reportFile = path.join(REPORTS, `${step.id}.json`);
  const before = { head: git('rev-parse', 'HEAD'), productionDigest: prodDigest(), lockHash: lockHash(), productionStatus: prodStatus(), ports: await Promise.all(ports.map(async (port) => [port, await portFree(port)])) };
  record.before = before;
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile };
  const command = `${step.command} --output="${path.resolve(OUT, step.id)}"`;
  writeFileSync(logFile, `# ${record.startedAt} ${command}\n`);
  const stream = (await import('node:fs')).createWriteStream(logFile, { flags: 'a' });
  const child = spawn(command, { cwd: ROOT, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream); child.stderr.pipe(stream);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); }, step.timeoutMs);
  const exit = await new Promise((resolve) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', (error) => resolve({ code: 127, signal: String(error) })); });
  clearTimeout(timer);
  await new Promise((resolve) => stream.end(resolve));
  record.finishedAt = new Date().toISOString(); record.durationMs = Date.now() - Date.parse(record.startedAt);
  record.exitCode = timedOut ? 124 : exit.code; record.signal = timedOut ? 'TIMEOUT' : exit.signal;
  record.after = { head: git('rev-parse', 'HEAD'), productionDigest: prodDigest(), lockHash: lockHash(), productionStatus: prodStatus(), ports: await Promise.all(ports.map(async (port) => [port, await portFree(port)])) };
  record.playwright = parse(reportFile);
  const counts = record.playwright?.counts;
  record.failed = record.exitCode !== 0 || Boolean(record.signal) || record.after.head !== evidence.head || record.after.lockHash !== evidence.lockHash || record.after.productionDigest !== evidence.productionDigest || Boolean(record.after.productionStatus) || !counts || counts.total !== step.expectedTests || counts.unexpected !== 0 || counts.expectedFailed !== 0 || counts.skipped !== 0 || counts.retries !== 0;
  evidence.steps.push(record); writeEvidence();
  console.log(`[${record.failed ? 'FAIL' : 'PASS'}] ${step.id} exit=${record.exitCode} ${Math.round(record.durationMs / 1000)}s ${counts ? `${counts.passed}/${counts.total}` : 'no-report'}`);
  if (record.failed) { if (!timedOut) spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); throw new Error(`步骤 ${step.id} 失败`); }
}

try {
  const busy = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  if (busy.length) { evidence.status = 'blocked'; evidence.blocked = { ports: busy }; evidence.finishedAt = new Date().toISOString(); writeEvidence(); console.log(`BLOCKED ports ${busy}`); process.exit(2); }
  for (let index = 0; index < steps.length; index += 1) await runStep(steps[index], index);
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.productionAfter = { digest: prodDigest(), lockHash: lockHash(), status: prodStatus() };
  evidence.refreshedArtifacts = archiveRestore();
  writeEvidence();
  writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify({ runId, head: HEAD, status: evidence.status,
    steps: evidence.steps.map((step) => ({ id: step.id, exitCode: step.exitCode, signal: step.signal, durationMs: step.durationMs, counts: step.playwright?.counts ?? null, failed: step.failed })),
    productionDigest: evidence.productionDigest, lockHash: evidence.lockHash, productionAfter: evidence.productionAfter, refreshedArtifacts: evidence.refreshedArtifacts.files.length }, null, 2)}\n`);
}
process.exit(evidence.status === 'passed' ? 0 : 1);
