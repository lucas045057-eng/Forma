#!/usr/bin/env node
/**
 * M3-B 验收用的完整回归顺序入口（本分支只准备，不正式启动）。
 *
 *   node tests/e2e/m3b/full-regression.mjs --collect     # 只做收集验证（--list），不跑任何用例/构建
 *   node tests/e2e/m3b/full-regression.mjs               # 真正按顺序跑（首败即停）
 *
 * 顺序：pnpm typecheck → pnpm build → pnpm test（全量单测）→ 旧七套 E2E → M3-B。
 *
 * 硬约束（按 Codex 复核要求）：
 * - 身份门禁用**工作区真实字节**：已跟踪产品文件的逐文件 SHA256 + 锁文件 SHA256 + 工作区脏/未跟踪状态，
 *   每步前后比较，不一致即判该步失败并停止（不是只看 index 摘要）。
 * - 所有 git 调用都带 `-c core.longpaths=true`；任何非零退出都直接失败，不把 stderr 当合法输出。
 * - Playwright 用**本仓库已安装的 CLI**（node_modules/@playwright/test/cli.js），不用 npx（可能触发下载）。
 * - 每个套件的 JSON reporter 与 outputDir 都定向到本次 run 目录，并在跑完后核对
 *   errors / expected / unexpected / skipped / flaky / 每个用例的实际状态；不只看退出码。
 * - 运行环境用显式白名单变量构造，不继承也不打印整个 process.env。
 * - 已归档的 tracked 证据凡是被套件刷新，按 blob 原样还原并在 manifest 里记下来。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MODE = process.argv.includes('--collect') ? 'collect' : 'full';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`;
const OUT = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M3-B', 'full-regression', RUN_ID);
const PLAYWRIGHT_CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

const PRODUCT_PATHS = ['apps', 'packages', 'templates', 'package.json', 'pnpm-workspace.yaml'];
const LOCK_FILE = 'pnpm-lock.yaml';
const EVIDENCE_DIR = path.join('docs', 'reports', 'artifacts');
const E2E_SUITES = [
  { name: 'm0b', config: null },
  { name: 'm0a', config: 'playwright.m0a.config.ts' },
  { name: 'm1a', config: 'playwright.m1a.config.ts' },
  { name: 'm1b', config: 'playwright.m1b.config.ts' },
  { name: 'm2a', config: 'playwright.m2a.config.ts' },
  { name: 'm2b', config: 'playwright.m2b.config.ts' },
  { name: 'm3a', config: 'playwright.m3a.config.ts' },
  { name: 'm3b', config: 'playwright.m3b.config.ts' },
];

/** 显式白名单：不继承整个 process.env。 */
const ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache', 'npm_config_store_dir',
];

function baseEnv(extra = {}) {
  const env = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}

function git(args) {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 退出码 ${result.status}：${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 400)}`);
  }
  return `${result.stdout ?? ''}`;
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function tracked(pathspec) {
  return git(['ls-files', '-z', '--', ...pathspec]).split('\0').filter(Boolean);
}

/** 产品身份：已跟踪产品文件逐字节 SHA256 + 锁文件 SHA256 + 工作区状态。 */
function productIdentity() {
  const files = tracked(PRODUCT_PATHS);
  const lines = files.map((file) => {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) return `${file}\0missing`;
    return `${file}\0${sha256(readFileSync(full))}`;
  }).sort();
  const status = git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...PRODUCT_PATHS]);
  const lockPath = path.join(ROOT, LOCK_FILE);
  return {
    head: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    files: files.length,
    digest: sha256(Buffer.from(lines.join('\n'))),
    lock: existsSync(lockPath) ? sha256(readFileSync(lockPath)) : 'missing',
    dirty: status.split('\0').filter(Boolean), // 未提交/未跟踪的产品路径
  };
}

/** 已归档证据的已跟踪文件哈希，用于发现"套件刷新了历史证据"。 */
function evidenceIdentity() {
  const files = tracked([EVIDENCE_DIR]);
  const map = new Map();
  for (const file of files) {
    const full = path.join(ROOT, file);
    map.set(file, existsSync(full) ? sha256(readFileSync(full)) : 'missing');
  }
  return map;
}

/** 被刷新的 tracked 证据按 blob 原样还原（归属明确：只还原 docs/reports/artifacts 下已跟踪文件）。 */
function restoreRefreshedEvidence(before) {
  const after = evidenceIdentity();
  const refreshed = [...after.keys()].filter((file) => before.get(file) !== after.get(file));
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', EVIDENCE_DIR]).split('\0').filter(Boolean);
  for (const file of refreshed) {
    const blob = spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', file], { cwd: ROOT, encoding: 'utf8' });
    if (blob.status !== 0) throw new Error(`还原历史证据 ${file} 失败：${blob.stderr ?? ''}`);
  }
  return { refreshed, untracked };
}

function runStep(step) {
  return new Promise((resolve) => {
    const logFile = path.join(OUT, `${step.name}.log`);
    const stream = createWriteStream(logFile, { flags: 'a' });
    const before = { product: productIdentity(), evidence: evidenceIdentity() };
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const child = spawn(step.command, step.args, { cwd: ROOT, env: baseEnv(step.env), shell: step.shell === true, windowsHide: true });
    stream.write(`# ${step.name}: ${step.command} ${step.args.join(' ')}\n# pid=${child.pid} started=${startedAt}\n`);
    child.stdout.on('data', (chunk) => stream.write(chunk));
    child.stderr.on('data', (chunk) => stream.write(chunk));
    child.on('error', (error) => stream.write(`# spawn error: ${String(error)}\n`));
    child.on('exit', (code, signal) => {
      const finishedAt = new Date().toISOString();
      const after = { product: productIdentity(), evidence: evidenceIdentity() };
      const problems = [];
      if (before.product.digest !== after.product.digest) problems.push('产品已跟踪文件字节在步骤内发生变化');
      if (before.product.lock !== after.product.lock) problems.push('锁文件 SHA256 在步骤内发生变化');
      if (JSON.stringify(before.product.dirty) !== JSON.stringify(after.product.dirty)) problems.push('产品工作区脏/未跟踪状态在步骤内发生变化');
      if (before.product.head !== after.product.head) problems.push('HEAD 在步骤内发生变化');
      let restored = { refreshed: [], untracked: [] };
      try { restored = restoreRefreshedEvidence(before.evidence); } catch (error) { problems.push(String(error)); }
      stream.end(`\n# exit=${code} signal=${signal} finished=${finishedAt} durationMs=${Date.now() - startedMs}\n# identityProblems=${JSON.stringify(problems)}\n# restoredEvidence=${JSON.stringify(restored)}\n`);
      resolve({
        step: step.name, command: `${step.command} ${step.args.join(' ')}`, pid: child.pid,
        startedAt, finishedAt, durationMs: Date.now() - startedMs, code, signal,
        log: path.relative(ROOT, logFile), identity: { before: before.product, after: after.product },
        identityStable: problems.length === 0, identityProblems: problems, restoredEvidence: restored,
      });
    });
  });
}

/** 读 Playwright JSON reporter 的结果，核对是否真的"全过、无重试、无跳过"。 */
function verifyPlaywrightJson(file) {
  if (!existsSync(file)) return { ok: false, problems: [`缺少 JSON 报告：${path.relative(ROOT, file)}`] };
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  if (Array.isArray(report.errors) && report.errors.length) problems.push(`errors 非空（${report.errors.length}）`);
  const stats = report.stats ?? {};
  for (const key of ['unexpected', 'skipped', 'flaky']) if (Number(stats[key] ?? 0) !== 0) problems.push(`stats.${key}=${stats[key]}`);
  let total = 0;
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      total += 1;
      if (!spec.ok) problems.push(`用例失败：${spec.title}`);
      for (const test of spec.tests ?? []) {
        const statuses = (test.results ?? []).map((result) => result.status);
        if (statuses.some((status) => status !== 'expected')) problems.push(`用例 ${spec.title} 状态非 expected：${statuses.join(',')}`);
        if (statuses.length > 1) problems.push(`用例 ${spec.title} 出现重试：${statuses.length} 次`);
        if (test.status !== 'expected') problems.push(`用例 ${spec.title} test.status=${test.status}`);
      }
    }
  }
  if (!total) problems.push('没有收集/执行到任何用例');
  if (Number(stats.expected ?? -1) !== total) problems.push(`stats.expected=${stats.expected} 与实际用例数 ${total} 不一致`);
  return { ok: problems.length === 0, problems, total, stats };
}

function steps() {
  const e2e = E2E_SUITES.map((suite) => {
    const base = [PLAYWRIGHT_CLI, 'test'];
    if (suite.config) base.push('-c', suite.config);
    const name = `${MODE === 'collect' ? 'collect' : 'e2e'}-${suite.name}`;
    return {
      name,
      command: process.execPath,
      args: MODE === 'collect'
        ? [...base, '--list']
        : [...base, '--retries=0', '--workers=1', `--output=${path.join(OUT, `${name}-output`)}`],
      env: MODE === 'collect' ? {} : { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(OUT, `${name}-results.json`), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') },
      verifyJson: MODE === 'collect' ? null : path.join(OUT, `${name}-results.json`),
    };
  });
  if (MODE === 'collect') return e2e; // 收集模式只收集，不跑 typecheck/build/单测
  return [
    { name: 'typecheck', command: 'pnpm', args: ['typecheck'], env: {}, verifyJson: null, shell: true },
    { name: 'build', command: 'pnpm', args: ['build'], env: {}, verifyJson: null, shell: true },
    { name: 'unit', command: 'pnpm', args: ['test'], env: {}, verifyJson: null, shell: true },
    ...e2e,
  ];
}

mkdirSync(OUT, { recursive: true });
const manifest = {
  runId: RUN_ID, mode: MODE, startedAt: new Date().toISOString(), cwd: ROOT, node: process.version, pid: process.pid,
  playwrightCli: path.relative(ROOT, PLAYWRIGHT_CLI), envKeys: ENV_KEYS, steps: [],
};
writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[full-regression] mode=${MODE} out=${path.relative(ROOT, OUT)}`);

if (!existsSync(PLAYWRIGHT_CLI)) {
  console.error(`[full-regression] 找不到本仓库的 Playwright CLI：${PLAYWRIGHT_CLI}（不用 npx 以免触发下载）`);
  process.exit(2);
}

for (const step of steps()) {
  console.log(`[full-regression] ${step.name} …`);
  const record = await runStep(step);
  if (step.verifyJson) Object.assign(record, { report: verifyPlaywrightJson(step.verifyJson) });
  manifest.steps.push(record);
  writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendFileSync(path.join(OUT, 'manifest.log'), `${record.step} exit=${record.code} identityStable=${record.identityStable} report=${record.report?.ok ?? '-'}\n`);
  const reportBad = record.report && !record.report.ok;
  if (record.code !== 0 || !record.identityStable || reportBad) {
    const reason = [
      record.code !== 0 ? `exit=${record.code}` : '',
      record.identityStable ? '' : `身份变化：${record.identityProblems.join('；')}`,
      reportBad ? `报告核对失败：${record.report.problems.join('；')}` : '',
    ].filter(Boolean).join(' | ');
    console.error(`[full-regression] ${record.step} 未通过（${reason}），按规则停止后续步骤；证据 ${record.log}`);
    process.exit(1);
  }
}
console.log(`[full-regression] 全部 ${manifest.steps.length} 步通过；manifest=${path.relative(ROOT, path.join(OUT, 'manifest.json'))}`);
