#!/usr/bin/env node
/**
 * M4 集中验收的顺序入口（一次性跑完，不逐卡返工）。
 *
 *   node tests/e2e/m4/full-regression.mjs --collect   # 只收集（各套件 --list），不构建/不跑单测/不起服务
 *   node tests/e2e/m4/full-regression.mjs             # 真正按顺序跑（首败即停）
 *
 * 顺序：
 *   1. pnpm typecheck
 *   2. pnpm build
 *   3. pnpm test（全量单测；D2_RUN_DIR 指向本轮目录）
 *   4. node --test scripts/demo/safety.test.mjs（不在 workspace test 过滤内，显式纳入）
 *   5. M4 独立 E2E（playwright.m4.config.ts）
 *   6. 旧九套 E2E（M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A/M3-B/M3-C）
 *
 * 门禁与判据（实现见 tests/e2e/m3b/runner-support.mjs，可脱离服务自验）：
 * - 身份：产品 + 脚本 + tests/e2e + Playwright 配置 + 锁的**真实字节** SHA256（含未跟踪未忽略文件）+ HEAD，
 *   run 起点 baseline，每步前后对照，偏离即该步失败并停止；
 * - 报告：三层状态分别检查、恰好一条 result、retry=0、拒绝 skip/flaky/errors、递归嵌套并以 stats.expected 对数；
 * - 历史证据：本步刷新的 tracked 证据先归档新字节/哈希，再按 blob 还原并用对象 id + status 校验；
 *   起跑时证据目录已脏则直接中止（exit 3），不覆盖归属不明的文件；
 * - 服务型步骤失败即停，后续步骤不会执行（如实记为未执行）；
 * - git 全部 `-c core.longpaths=true`；环境按白名单构造，不继承/不打印整个 process.env。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import {
  buildIdentity, evidenceArchiveTarget, identityDiff, planEvidenceRestore, sha256Hex, spawnAndAwait, verifyPlaywrightReport,
} from '../m3b/runner-support.mjs';

const ROOT = process.cwd();
const MODE = process.argv.includes('--collect') ? 'collect' : 'full';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M4', 'regression', RUN_ID);
const PLAYWRIGHT_CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const EVIDENCE_DIR = 'docs/reports/artifacts';

const IDENTITY_PATHS = ['apps', 'packages', 'templates', 'scripts', 'tests/e2e', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const LOCK_FILE = 'pnpm-lock.yaml';

/** M4 自己的独立套件（先跑，失败就不用再跑旧套件）。 */
const M4_SUITE = { name: 'm4', config: 'playwright.m4.config.ts' };
const OLD_SUITES = [
  { name: 'm0b', config: null },
  { name: 'm0a', config: 'playwright.m0a.config.ts' },
  { name: 'm1a', config: 'playwright.m1a.config.ts' },
  { name: 'm1b', config: 'playwright.m1b.config.ts' },
  { name: 'm2a', config: 'playwright.m2a.config.ts' },
  { name: 'm2b', config: 'playwright.m2b.config.ts' },
  { name: 'm3a', config: 'playwright.m3a.config.ts' },
  { name: 'm3b', config: 'playwright.m3b.config.ts' },
  { name: 'm3c', config: 'playwright.m3c.config.ts' },
];

const ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache', 'npm_config_store_dir',
];

const baseEnv = (extra = {}) => {
  const env = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
};

function git(args) {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${result.status}：${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 400)}`);
  return `${result.stdout ?? ''}`;
}

const splitZ = (text) => text.split('\0').filter(Boolean);
const readHash = (file) => (existsSync(join(ROOT, file)) ? sha256Hex(readFileSync(join(ROOT, file))) : 'missing');

function currentIdentity() {
  const configs = splitZ(git(['ls-files', '-z', '--', ':(glob)playwright*.ts']));
  const paths = [...IDENTITY_PATHS, ...configs];
  const tracked = splitZ(git(['ls-files', '-z', '--', ...paths]));
  const untracked = splitZ(git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]));
  const entries = [...new Set([...tracked, ...untracked])].map((file) => ({ path: file, hash: readHash(file) }));
  const dirty = splitZ(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths])).map((line) => line.replace(/^.../, ''));
  return buildIdentity({ head: git(['rev-parse', 'HEAD']).trim(), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), entries, dirty, lockSha: readHash(LOCK_FILE) });
}

const evidenceHashes = () => new Map(splitZ(git(['ls-files', '-z', '--', EVIDENCE_DIR])).map((file) => [file, readHash(file)]));
const evidenceDirty = () => new Set(splitZ(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', EVIDENCE_DIR])).map((line) => line.replace(/^.../, '')));

function playwrightStep(suite) {
  const name = `${MODE === 'collect' ? 'collect' : 'e2e'}-${suite.name}`;
  const base = [PLAYWRIGHT_CLI, 'test'];
  if (suite.config) base.push('-c', suite.config);
  if (MODE === 'collect') return { name, command: process.execPath, args: [...base, '--list', '--reporter=list'], env: {}, verifyJson: null };
  const env = {
    PLAYWRIGHT_JSON_OUTPUT_NAME: join(OUT, `${name}-results.json`),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    M4_ARTIFACT_DIR: join(OUT, `${name}-artifacts`),
  };
  return {
    name, command: process.execPath,
    args: [...base, '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, `${name}-output`)}`],
    env, verifyJson: env.PLAYWRIGHT_JSON_OUTPUT_NAME,
  };
}

function steps() {
  if (MODE === 'collect') return [M4_SUITE, ...OLD_SUITES].map(playwrightStep);
  return [
    { name: 'typecheck', command: 'pnpm', args: ['typecheck'], env: {}, shell: true },
    { name: 'build', command: 'pnpm', args: ['build'], env: {}, shell: true },
    { name: 'unit', command: 'pnpm', args: ['test'], env: { D2_RUN_DIR: join(OUT, 'd2-browser') }, shell: true },
    { name: 'demo-safety', command: process.execPath, args: ['--test', 'scripts/demo/safety.test.mjs'], env: {} },
    playwrightStep(M4_SUITE),
    ...OLD_SUITES.map(playwrightStep),
  ].map((step) => ({ verifyJson: null, ...step }));
}

function archiveAndRestore(stepName, plan, records) {
  const problems = [];
  for (const file of plan.conflicts) problems.push(`证据文件在本步开始前就已脏（归属不明），拒绝覆盖：${file}`);
  for (const file of plan.created) problems.push(`本步出现新的已跟踪证据文件，需人工确认：${file}`);
  for (const item of plan.restorable) {
    const source = join(ROOT, item.file);
    const target = evidenceArchiveTarget(OUT, stepName, item.file);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = readFileSync(source);
    writeFileSync(target, bytes);
    const headBlobId = git(['rev-parse', `HEAD:${item.file.replaceAll('\\', '/')}`]).trim();
    const checkout = spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', item.file], { cwd: ROOT, encoding: 'utf8' });
    const restoredId = spawnSync('git', ['-c', 'core.longpaths=true', 'hash-object', `--path=${item.file}`, source], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString().trim();
    const status = spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', '--', item.file], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString() ?? '';
    if (checkout.status !== 0 || restoredId !== headBlobId || status.trim() !== '') problems.push(`还原 ${item.file} 未回到 blob`);
    records.push({ file: item.file, beforeSha256: item.beforeHash, afterSha256: item.afterHash, archivedTo: relative(ROOT, target).split('\\').join('/'), archivedBytes: bytes.length, headBlobId, restoredObjectId: restoredId ?? null, statusClean: status.trim() === '' });
  }
  return problems;
}

async function runStep(step, baseline) {
  const logFile = join(OUT, `${step.name}.log`);
  const stream = createWriteStream(logFile, { flags: 'a' });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const before = { identity: currentIdentity(), evidence: evidenceHashes(), dirty: evidenceDirty() };
  stream.write(`# ${step.name}: ${step.command} ${step.args.join(' ')}\n# started=${startedAt}\n`);
  const spawnResult = await spawnAndAwait(step.command, step.args, {
    spawn,
    spawnOptions: { cwd: ROOT, env: baseEnv(step.env), shell: step.shell === true, windowsHide: true },
    onChild: (child) => { child.stdout?.on('data', (c) => stream.write(c)); child.stderr?.on('data', (c) => stream.write(c)); },
  });
  await new Promise((resolve) => stream.end(resolve));
  const finishedAt = new Date().toISOString();
  const after = { identity: currentIdentity(), evidence: evidenceHashes() };
  const problems = [];
  if (spawnResult.spawnError) problems.push(`启动失败：${spawnResult.spawnError}`);
  if (spawnResult.code !== 0) problems.push(`退出码 ${spawnResult.code}（signal=${spawnResult.signal}）`);
  problems.push(...identityDiff(baseline.identity, before.identity).map((item) => `步骤开始前偏离基线：${item}`));
  problems.push(...identityDiff(baseline.identity, after.identity).map((item) => `步骤结束后偏离基线：${item}`));
  const plan = planEvidenceRestore({ before: before.evidence, after: after.evidence, dirtyBefore: before.dirty });
  const archived = [];
  try { problems.push(...archiveAndRestore(step.name, plan, archived)); }
  catch (error) { problems.push(`归档/还原证据失败：${String(error).slice(0, 300)}`); }
  const record = {
    step: step.name, command: `${step.command} ${step.args.join(' ')}`, pid: spawnResult.pid,
    startedAt, finishedAt, durationMs: Date.now() - startedMs,
    code: spawnResult.code, signal: spawnResult.signal, spawnError: spawnResult.spawnError,
    log: relative(ROOT, logFile), evidenceArchived: archived, problems,
  };
  if (step.verifyJson) {
    try {
      record.report = verifyPlaywrightReport(JSON.parse(readFileSync(step.verifyJson, 'utf8')));
      if (!record.report.ok) problems.push(...record.report.problems.map((item) => `报告核对失败：${item}`));
    } catch (error) {
      record.report = { ok: false, problems: [`读取/解析 JSON 报告失败：${String(error).slice(0, 200)}`] };
      problems.push(`报告核对失败：${record.report.problems[0]}`);
    }
  }
  record.ok = problems.length === 0;
  return record;
}

mkdirSync(OUT, { recursive: true });
if (!existsSync(PLAYWRIGHT_CLI)) {
  console.error(`[m4] 找不到本仓库的 Playwright CLI：${PLAYWRIGHT_CLI}`);
  process.exit(2);
}
const baseline = { identity: currentIdentity(), evidence: evidenceHashes(), dirty: evidenceDirty() };
const manifest = {
  runId: RUN_ID, mode: MODE, suite: 'M4', startedAt: new Date().toISOString(), cwd: ROOT, node: process.version, pid: process.pid,
  playwrightCli: relative(ROOT, PLAYWRIGHT_CLI), envKeys: ENV_KEYS, baseline, evidenceDirtyAtStart: [...baseline.dirty], steps: [],
  plan: MODE === 'collect' ? '只收集' : 'typecheck → build → pnpm test → demo-safety → M4 E2E → 旧九套 E2E',
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[m4] mode=${MODE} out=${relative(ROOT, OUT)} identity=${baseline.identity.digest.slice(0, 12)} lock=${baseline.identity.lock.slice(0, 12)}`);

if (baseline.dirty.size > 0) {
  manifest.entryFailure = { kind: 'entry', abort: 'evidenceDirtyAtStart', exitCode: 3, dirty: [...baseline.dirty].sort() };
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.error(`[m4] 入口失败（不是产品失败）：${EVIDENCE_DIR} 起跑前已脏 ${baseline.dirty.size} 项`);
  for (const file of [...baseline.dirty].sort()) console.error(`  dirty: ${file}`);
  process.exit(3);
}

for (const step of steps()) {
  console.log(`[m4] ${step.name} …`);
  const record = await runStep(step, baseline);
  manifest.steps.push(record);
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendFileSync(join(OUT, 'manifest.log'), `${record.step} ok=${record.ok} code=${record.code} report=${record.report?.ok ?? '-'} archived=${record.evidenceArchived.length}\n`);
  if (!record.ok) {
    console.error(`[m4] ${record.step} 未通过：${record.problems.join(' | ')}；证据 ${record.log}`);
    const executed = manifest.steps.map((item) => item.step);
    const pending = steps().map((item) => item.name).filter((name) => !executed.includes(name));
    manifest.failure = { step: record.step, problems: record.problems, executed, notExecuted: pending };
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.exit(1);
  }
}
console.log(`[m4] 全部 ${manifest.steps.length} 步通过；manifest=${relative(ROOT, join(OUT, 'manifest.json'))}`);
