#!/usr/bin/env node
/**
 * M2 已审查成品合并后的最终 mock 顺序回归（一次后台执行）。
 *
 * 每个步骤记录：命令、起止时间、退出码/信号、HEAD、pnpm-lock 摘要、生产源码树摘要、
 * 生产路径 git status、Playwright JSON 统计、端口/监听者归属，以及该步骤产出的证据快照。
 * 第一失败即停：杀掉本步骤的进程树（只按本步骤 PID），记录无法确认归属的残留端口后退出，
 * 不按端口号杀并行会话。
 *
 * 用法（从 workspace 根）：
 *   node tests/e2e/final-verification/run.mjs --run-id final-YYYYMMDD-HHMMSS --base b167907
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { scanTrackedSpecsForMarker } from './spec-scan.mjs';

const ROOT = process.cwd();
const arg = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const runId = arg('--run-id') ?? `final-${stamp()}`;
const BASE = arg('--base') ?? 'b167907';
const EVIDENCE = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M2-final', runId);
const LOGS = path.join(EVIDENCE, 'logs');
const REPORTS = path.join(EVIDENCE, 'reports');
const OUTPUT = path.join(EVIDENCE, 'output');
for (const dir of [EVIDENCE, LOGS, REPORTS, OUTPUT]) mkdirSync(dir, { recursive: true });

const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
const KNOWN_PORTS = [3001, 4011, 5173, 5174, 5175];
const PRODUCTION_PATHS = ['apps', 'packages', 'templates'];
const CONFIG_FILES = [
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'playwright.config.ts',
  'playwright.m0a.config.ts', 'playwright.m1a.config.ts', 'playwright.m1b.config.ts',
  'playwright.m2a.config.ts', 'playwright.m2b.config.ts',
];
const PRIOR_EVIDENCE = [
  'docs/reports/artifacts/M2-A/d3-run-11ed6da0',
  'docs/reports/artifacts/M2-A/d3-run-c0b6a407',
  'docs/reports/artifacts/M2-A/isolation-r6.json',
];

const exe = (file, args, options = {}) => execFileSync(file, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options }).trim();
const git = (...args) => exe('git', args);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fileHash = (file) => (existsSync(file) ? sha256(readFileSync(file)) : null);
const dirDigest = (relative) => {
  const absolute = path.join(ROOT, relative);
  if (!existsSync(absolute)) return null;
  if (!statSync(absolute).isDirectory()) return fileHash(absolute);
  const files = [];
  const walk = (folder, prefix) => {
    for (const name of readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const rel = `${prefix}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push(`${rel}:${fileHash(full)}`);
    }
  };
  walk(absolute, relative);
  return sha256(files.join('\n'));
};

const HEAD = git('rev-parse', 'HEAD');
const headCommits = git('log', '--oneline', `${BASE}..HEAD`).split('\n').filter(Boolean);
const lockHash = () => fileHash(path.join(ROOT, 'pnpm-lock.yaml'));
const productionStatus = () => git('status', '--porcelain', '--', ...PRODUCTION_PATHS);
const productionDigest = () => sha256(git('ls-tree', '-r', HEAD, '--', ...PRODUCTION_PATHS));
const testsDigest = () => sha256(git('ls-tree', '-r', HEAD, '--', 'tests/e2e'));
const configHashes = () => Object.fromEntries(CONFIG_FILES.map((file) => [file, fileHash(path.join(ROOT, file))]));
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psJson(script) {
  const output = exe('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return output ? JSON.parse(output) : null;
}

/** 只记录端口、PID、进程名与创建时间；不保存其他应用的完整命令行。 */
function portsSnapshot() {
  const script = [
    '$list=@()',
    `foreach($p in ${KNOWN_PORTS.join(',')}){`,
    '  $c=Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1',
    "  if($c){ $proc=Get-CimInstance Win32_Process -Filter \"ProcessId = $($c.OwningProcess)\"; $list += [pscustomobject]@{port=[int]$p; pid=[int]$c.OwningProcess; name=$proc.Name; started=$proc.CreationDate.ToString('o')} }",
    '}',
    "if($list.Count -eq 0){'[]'}else{@($list)|ConvertTo-Json -Compress}",
  ].join('\n');
  const parsed = psJson(script);
  return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { attempted: false };
  const result = spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
  return { attempted: true, pid, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 300) };
}

function parsePlaywrightReport(file) {
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const counts = { total: 0, passed: 0, expectedFailed: 0, unexpectedlyPassed: 0, unexpectedFailed: 0, skipped: 0, flaky: 0 };
  const failedTests = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const item of spec.tests ?? []) {
        counts.total += 1;
        const result = (item.results ?? [])[0] ?? {};
        const status = result.status;
        if (status === 'passed') {
          counts.passed += 1;
          if (item.expectedStatus === 'failed') counts.unexpectedlyPassed += 1;
        } else if (status === 'failed') {
          if (item.expectedStatus === 'failed') counts.expectedFailed += 1;
          else { counts.unexpectedFailed += 1; failedTests.push(spec.title); }
        } else if (status === 'skipped') counts.skipped += 1;
        if (result.status === 'failed' && result.retry > 0) counts.flaky += 1;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  return { stats: report.stats ?? null, counts, failedTests };
}

function snapshotArtifacts(step) {
  const target = path.join(EVIDENCE, 'artifacts', step.id);
  const files = [];
  for (const relativeDir of step.artifactDirs ?? []) {
    const absoluteDir = path.join(ROOT, relativeDir);
    if (!existsSync(absoluteDir)) continue;
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(absoluteDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const from = path.join(absoluteDir, name);
      if (!statSync(from).isFile()) continue;
      copyFileSync(from, path.join(target, name));
      files.push({ file: `${relativeDir}/${name}`, sha256: fileHash(from) });
    }
  }
  return files;
}

const evidence = {
  schema: 1,
  runId,
  startedAt: now(),
  base: BASE,
  frozenHead: HEAD,
  commitsAfterBase: headCommits,
  productionDigest: productionDigest(),
  testsDigest: testsDigest(),
  lockHash: lockHash(),
  configHashes: configHashes(),
  environment: {
    node: process.version,
    pnpm: (() => { try { return exe('cmd.exe', ['/d', '/s', '/c', 'pnpm --version']); } catch { return null; } })(),
    playwrightBrowsersPath: BROWSERS,
    platform: process.platform,
    arch: process.arch,
    mock: 'loopback mock coding agent; fake key; outbound guard',
  },
  priorEvidence: Object.fromEntries(PRIOR_EVIDENCE.map((relative) => [relative, dirDigest(relative) ?? fileHash(path.join(ROOT, relative))])),
  steps: [],
  status: 'running',
};
const evidenceFile = path.join(EVIDENCE, 'evidence.json');
const writeEvidence = () => writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
writeEvidence();

const STEPS = [
  { id: 'typecheck', title: 'pnpm typecheck', command: 'pnpm typecheck', timeoutMs: 15 * 60_000, playwright: false },
  { id: 'build', title: 'pnpm build', command: 'pnpm build', timeoutMs: 20 * 60_000, playwright: false },
  { id: 'unit', title: 'pnpm test（完整单测）', command: 'pnpm test', timeoutMs: 20 * 60_000, playwright: false },
  {
    id: 'e2e-m0b', title: 'M0-B e2e（默认 config）',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.config.ts --reporter=list --reporter=json',
    timeoutMs: 45 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M0-B'],
  },
  {
    id: 'e2e-m0a', title: 'M0-A e2e',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m0a.config.ts --reporter=list --reporter=json',
    timeoutMs: 45 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M0-A'],
  },
  {
    id: 'e2e-m1a', title: 'M1-A e2e',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m1a.config.ts --reporter=list --reporter=json',
    timeoutMs: 45 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M1-A'],
  },
  {
    id: 'e2e-m1b', title: 'M1-B e2e',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m1b.config.ts --reporter=list --reporter=json',
    timeoutMs: 45 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M1-B'],
  },
  {
    id: 'e2e-m2a', title: 'M2-A e2e（完整，含 D3 五场景与 N4）',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2a.config.ts --reporter=list --reporter=json',
    timeoutMs: 60 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M2-A'],
  },
  {
    id: 'e2e-m2b', title: 'M2-B e2e（完整）',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2b.config.ts --reporter=list --reporter=json',
    timeoutMs: 60 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M2-B'],
  },
  {
    id: 'd3-standalone', title: 'D3 五场景单独复核（第二次，按身份/端口/decoy）',
    command: 'node node_modules/@playwright/test/cli.js test -c playwright.m2a.config.ts tests/e2e/m2a/zz-kill.spec.ts --reporter=list --reporter=json',
    timeoutMs: 20 * 60_000, playwright: true, e2e: true, artifactDirs: ['docs/reports/artifacts/M2-A'],
  },
];

function blocked(reason, detail) {
  evidence.status = 'blocked';
  evidence.blocked = { reason, detail, at: now() };
  evidence.finishedAt = now();
  writeEvidence();
  console.log(`BLOCKED: ${reason}`);
  if (detail) console.log(JSON.stringify(detail, null, 2));
  process.exit(2);
}

/* ---------- 冻结前检查 ---------- */
try {
  exe('git', ['merge-base', '--is-ancestor', BASE, HEAD]);
} catch {
  blocked('base-not-ancestor', { base: BASE, head: HEAD });
}
if (productionStatus()) blocked('production-dirty-at-start', { status: productionStatus() });
const startPorts = portsSnapshot();
evidence.portsAtStart = startPorts;
if (startPorts.length) blocked('known-port-in-use-at-start', startPorts);
if (fileHash(path.join(ROOT, 'pnpm-lock.yaml')) == null) blocked('lockfile-missing', null);
// 只扫描被跟踪的 spec/test 用例文件；runner/fixture/证据不参与，避免自匹配。
const markerScan = scanTrackedSpecsForMarker({ cwd: ROOT });
evidence.testFailScan = {
  clean: markerScan.clean, reason: markerScan.reason, scannedFiles: markerScan.scannedFiles,
  matches: (markerScan.matches ?? []).slice(0, 10), status: markerScan.status, stderr: markerScan.stderr,
};
if (!markerScan.clean) blocked('test-fail-scan-blocked', evidence.testFailScan);
writeEvidence();
if (process.argv.includes('--preflight-only')) {
  evidence.status = 'preflight-ok';
  evidence.finishedAt = now();
  writeEvidence();
  console.log('PREFLIGHT OK');
  process.exit(0);
}

/* ---------- 步骤执行 ---------- */
async function runStep(step, index) {
  const logFile = path.join(LOGS, `${String(index + 1).padStart(2, '0')}-${step.id}.log`);
  const reportFile = path.join(REPORTS, `${step.id}.json`);
  const outputDir = path.join(OUTPUT, step.id);
  mkdirSync(outputDir, { recursive: true });
  const record = {
    id: step.id, title: step.title, command: step.command,
    startedAt: now(), log: path.relative(ROOT, logFile), report: step.playwright ? path.relative(ROOT, reportFile) : null,
    before: {
      head: git('rev-parse', 'HEAD'),
      lockHash: lockHash(),
      productionDigest: productionDigest(),
      productionStatus: productionStatus(),
      ports: step.e2e ? portsSnapshot() : null,
    },
  };
  evidence.currentStep = record;
  writeEvidence();

  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS };
  if (step.playwright) env.PLAYWRIGHT_JSON_OUTPUT_NAME = reportFile;
  const command = step.playwright ? `${step.command} --output="${path.resolve(outputDir)}"` : step.command;

  const started = Date.now();
  const logStream = createWriteStream(logFile);
  logStream.write(`# ${now()} ${command}\n`);
  const child = spawn(command, { cwd: ROOT, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, step.timeoutMs);
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  logStream.end();

  record.finishedAt = now();
  record.durationMs = Date.now() - started;
  record.exitCode = timedOut ? 124 : exit.code;
  record.signal = timedOut ? 'TIMEOUT' : exit.signal;
  record.after = {
    head: git('rev-parse', 'HEAD'),
    lockHash: lockHash(),
    productionDigest: productionDigest(),
    productionStatus: productionStatus(),
    ports: step.e2e ? portsSnapshot() : null,
  };
  if (step.playwright) record.playwright = parsePlaywrightReport(reportFile);
  record.artifacts = snapshotArtifacts(step);
  writeFileSync(path.join(EVIDENCE, 'artifacts', `${step.id}-index.json`), `${JSON.stringify(record.artifacts, null, 2)}\n`);

  const reasons = [];
  if (record.exitCode !== 0) reasons.push(`exit=${record.exitCode}`);
  if (record.signal) reasons.push(`signal=${record.signal}`);
  if (record.after.head !== evidence.frozenHead) reasons.push(`HEAD 变化：${record.after.head}`);
  if (record.after.lockHash !== evidence.lockHash) reasons.push('pnpm-lock 摘要变化');
  if (record.after.productionDigest !== evidence.productionDigest) reasons.push('生产源码树摘要变化');
  if (record.after.productionStatus) reasons.push(`生产路径变成脏：${record.after.productionStatus.slice(0, 400)}`);
  if (record.playwright) {
    const counts = record.playwright.counts;
    if (counts.expectedFailed > 0) reasons.push(`出现 ${counts.expectedFailed} 个 expected-failed（已修 retry/N4 不再接受）`);
    if (counts.unexpectedlyPassed > 0) reasons.push(`出现 ${counts.unexpectedlyPassed} 个“预期失败但通过”`);
  }
  record.failed = reasons.length > 0;
  record.failureReasons = reasons;
  evidence.steps.push(record);
  delete evidence.currentStep;
  writeEvidence();

  const label = record.failed ? 'FAIL' : 'PASS';
  const extra = record.playwright ? ` (${record.playwright.counts.passed} passed, ${record.playwright.counts.unexpectedFailed} failed, ${record.playwright.counts.expectedFailed} expected-failed, ${record.playwright.counts.skipped} skipped)` : '';
  console.log(`[${label}] ${step.id} exit=${record.exitCode} ${Math.round(record.durationMs / 1000)}s${extra}`);

  if (record.failed) {
    record.cleanup = { ownTreeKill: killTree(child.pid), at: now() };
    await sleep(1500);
    record.cleanup.portsAfterCleanup = portsSnapshot();
    evidence.status = 'failed';
    evidence.failure = { step: step.id, reasons };
    evidence.finishedAt = now();
    evidence.priorEvidenceAfter = Object.fromEntries(PRIOR_EVIDENCE.map((relative) => [relative, dirDigest(relative) ?? fileHash(path.join(ROOT, relative))]));
    evidence.priorEvidenceUnchanged = PRIOR_EVIDENCE.every((relative) => evidence.priorEvidence[relative] === evidence.priorEvidenceAfter[relative]);
    writeEvidence();
    throw new Error(`步骤 ${step.id} 失败：${reasons.join('；')}`);
  }
  return record;
}

(async () => {
  for (let index = 0; index < STEPS.length; index += 1) {
    try {
      await runStep(STEPS[index], index);
    } catch {
      // runStep 已写入失败证据；清理自己的步骤进程后退出。
      const last = evidence.steps.at(-1);
      if (last?.cleanup?.portsAfterCleanup?.length) {
        console.log(`注意：仍有已知端口监听，未按端口强杀，请按证据核对归属：${JSON.stringify(last.cleanup.portsAfterCleanup)}`);
      }
      writeEvidence();
      process.exit(1);
    }
  }
  evidence.status = 'passed';
  evidence.finishedAt = now();
  evidence.priorEvidenceAfter = Object.fromEntries(PRIOR_EVIDENCE.map((relative) => [relative, dirDigest(relative) ?? fileHash(path.join(ROOT, relative))]));
  evidence.priorEvidenceUnchanged = PRIOR_EVIDENCE.every((relative) => evidence.priorEvidence[relative] === evidence.priorEvidenceAfter[relative]);
  evidence.steps.forEach((step) => {
    writeFileSync(path.join(EVIDENCE, 'logs', `${step.id}.summary.json`), `${JSON.stringify({ id: step.id, exitCode: step.exitCode, signal: step.signal, durationMs: step.durationMs, playwright: step.playwright }, null, 2)}\n`);
  });
  writeEvidence();
  writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify({
    runId, frozenHead: evidence.frozenHead, status: evidence.status, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    steps: evidence.steps.map((step) => ({
      id: step.id, exitCode: step.exitCode, signal: step.signal, durationMs: step.durationMs,
      playwright: step.playwright ? step.playwright.counts : null,
    })),
    priorEvidenceUnchanged: evidence.priorEvidenceUnchanged,
  }, null, 2)}\n`);
  console.log(`ALL PASSED: ${STEPS.length} steps; evidence ${path.relative(ROOT, EVIDENCE)}`);
  process.exit(0);
})();
