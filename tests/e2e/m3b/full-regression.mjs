#!/usr/bin/env node
/**
 * M3-B 验收用的完整回归顺序入口（本分支只准备，不正式启动）。
 *
 *   node tests/e2e/m3b/full-regression.mjs --collect     # 只收集（各套件 --list），不跑构建/单测/服务
 *   node tests/e2e/m3b/full-regression.mjs               # 真正按顺序跑（首败即停）
 *
 * 顺序：pnpm typecheck → pnpm build → pnpm test（全量单测）→ 旧七套 E2E → M3-B。
 *
 * 判据与门禁（判据实现见 runner-support.mjs，可脱离本脚本独立验证）：
 * - 报告：三层状态分别检查（expectedStatus=passed / test.status=expected / results[0].status=passed），
 *   恰好一条 result、retry=0、拒绝 skip/flaky/errors，递归统计 nested suites 并与 stats.expected 对数；
 * - 身份：产品 + tests/e2e + Playwright 配置 + 锁文件的**真实字节** SHA256（含未跟踪但未被忽略的文件），
 *   run 起点建立统一 baseline，每步 before/after 都与 baseline 对照，不一致即本步失败并停止；
 * - 历史证据：本步被刷新的 tracked 证据先归档新字节与哈希，再按 blob 还原；
 *   步骤开始前就已脏（归属不明）的证据文件一律不覆盖，直接判失败；
 * - 完成屏障：只以 close + 日志写完为结束；spawn ENOENT 之类只有 error/close 也会结束并记录；
 * - git 全部带 `-c core.longpaths=true`，非零退出直接失败；环境按白名单构造，不继承/不打印整个 process.env。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import {
  buildIdentity, evidenceArchiveTarget, identityDiff, planEvidenceRestore, sha256Hex, spawnAndAwait, verifyPlaywrightReport,
} from './runner-support.mjs';

const ROOT = process.cwd();
const MODE = process.argv.includes('--collect') ? 'collect' : 'full';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M3-B', 'full-regression', RUN_ID);
const PLAYWRIGHT_CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const EVIDENCE_DIR = 'docs/reports/artifacts';

const IDENTITY_PATHS = ['apps', 'packages', 'templates', 'tests/e2e', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
const LOCK_FILE = 'pnpm-lock.yaml';
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
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 退出码 ${result.status}：${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 400)}`);
  }
  return `${result.stdout ?? ''}`;
}

const splitZ = (text) => text.split('\0').filter(Boolean);
const readHash = (file) => {
  const full = join(ROOT, file);
  return existsSync(full) ? sha256Hex(readFileSync(full)) : 'missing';
};

function playwrightConfigs() {
  return splitZ(git(['ls-files', '-z', '--', ':(glob)playwright*.ts']));
}

/** 当前身份：已跟踪 + 未跟踪（未忽略）文件的真实字节 + 锁 SHA256 + HEAD。 */
function currentIdentity() {
  const paths = [...IDENTITY_PATHS, 'playwright.config.ts', ...playwrightConfigs().filter((file) => file.includes('playwright.'))];
  const tracked = splitZ(git(['ls-files', '-z', '--', ...paths]));
  const untracked = splitZ(git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]));
  const entries = [...new Set([...tracked, ...untracked])].map((file) => ({ path: file, hash: readHash(file) }));
  const dirty = splitZ(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths]))
    .map((entry) => entry.replace(/^.../, ''));
  return buildIdentity({
    head: git(['rev-parse', 'HEAD']).trim(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    entries,
    dirty,
    lockSha: readHash(LOCK_FILE),
  });
}

const evidenceFiles = () => splitZ(git(['ls-files', '-z', '--', EVIDENCE_DIR]));
const evidenceHashes = () => new Map(evidenceFiles().map((file) => [file, readHash(file)]));
const evidenceDirty = () => new Set(splitZ(git(['status', '--porcelain', '-z', '--', EVIDENCE_DIR])).map((entry) => entry.replace(/^.../, '')));

function steps() {
  const e2e = E2E_SUITES.map((suite) => {
    const name = `${MODE === 'collect' ? 'collect' : 'e2e'}-${suite.name}`;
    const base = [PLAYWRIGHT_CLI, 'test'];
    if (suite.config) base.push('-c', suite.config);
    if (MODE === 'collect') return { name, command: process.execPath, args: [...base, '--list', '--reporter=list'], env: {}, verifyJson: null };
    return {
      name, command: process.execPath,
      args: [...base, '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, `${name}-output`)}`],
      env: {
        PLAYWRIGHT_JSON_OUTPUT_NAME: join(OUT, `${name}-results.json`),
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
      },
      verifyJson: join(OUT, `${name}-results.json`),
    };
  });
  if (MODE === 'collect') return e2e;
  return [
    { name: 'typecheck', command: 'pnpm', args: ['typecheck'], env: {}, shell: true, verifyJson: null },
    { name: 'build', command: 'pnpm', args: ['build'], env: {}, shell: true, verifyJson: null },
    { name: 'unit', command: 'pnpm', args: ['test'], env: {}, shell: true, verifyJson: null },
    ...e2e,
  ];
}

/** 归档被刷新的证据新字节，再按 blob 还原；归属不明则拒绝覆盖。 */
function archiveAndRestore(stepName, plan, records) {
  const problems = [];
  for (const file of plan.conflicts) problems.push(`证据文件在本步开始前就已脏（归属不明），拒绝覆盖：${file}`);
  for (const file of plan.created) problems.push(`本步出现了新的已跟踪证据文件，需人工确认：${file}`);
  for (const item of plan.restorable) {
    const source = join(ROOT, item.file);
    const target = evidenceArchiveTarget(OUT, stepName, item.file);
    mkdirSync(dirname(target), { recursive: true });
    const bytes = readFileSync(source);
    writeFileSync(target, bytes);
    const headBlobId = git(['rev-parse', `HEAD:${item.file.replaceAll('\\', '/')}`]).trim();
    const checkout = spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', item.file], { cwd: ROOT, encoding: 'utf8' });
    if (checkout.status !== 0) {
      problems.push(`还原 ${item.file} 失败：${(checkout.stderr ?? '').slice(0, 200)}`);
      continue;
    }
    const restoredId = spawnSync('git', ['-c', 'core.longpaths=true', 'hash-object', `--path=${item.file}`, source], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString().trim();
    const status = spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', '--', item.file], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString() ?? '';
    if (restoredId !== headBlobId || status.trim() !== '') problems.push(`还原 ${item.file} 未回到 blob（id=${String(restoredId).slice(0, 12)} expected=${headBlobId.slice(0, 12)} status=${status.trim().slice(0, 80)}）`);
    records.push({
      file: item.file, beforeSha256: item.beforeHash, afterSha256: item.afterHash,
      archivedTo: relative(ROOT, target).split('\\').join('/'), archivedBytes: bytes.length,
      headBlobId, restoredObjectId: restoredId ?? null, statusClean: status.trim() === '',
    });
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
    onChild: (child) => {
      child.stdout?.on('data', (chunk) => stream.write(chunk));
      child.stderr?.on('data', (chunk) => stream.write(chunk));
    },
  });
  // 日志写完才继续（close 之后再等 stream flush）。
  await new Promise((resolve) => stream.end(resolve));

  const finishedAt = new Date().toISOString();
  const after = { identity: currentIdentity(), evidence: evidenceHashes() };
  const problems = [];
  if (spawnResult.spawnError) problems.push(`进程启动失败：${spawnResult.spawnError}`);
  if (spawnResult.code !== 0) problems.push(`退出码 ${spawnResult.code}（signal=${spawnResult.signal}）`);
  problems.push(...identityDiff(baseline.identity, before.identity).map((item) => `步骤开始前就已偏离基线：${item}`));
  problems.push(...identityDiff(baseline.identity, after.identity).map((item) => `步骤结束后偏离基线：${item}`));

  const plan = planEvidenceRestore({ before: before.evidence, after: after.evidence, dirtyBefore: before.dirty });
  const archived = [];
  try { problems.push(...archiveAndRestore(step.name, plan, archived)); }
  catch (error) { problems.push(`归档/还原证据失败：${String(error).slice(0, 300)}`); }

  const record = {
    step: step.name, command: `${step.command} ${step.args.join(' ')}`, pid: spawnResult.pid,
    startedAt, finishedAt, durationMs: Date.now() - startedMs,
    code: spawnResult.code, signal: spawnResult.signal, spawnError: spawnResult.spawnError,
    log: relative(ROOT, logFile), identityStable: problems.length === 0,
    identityProblems: problems, evidenceArchived: archived,
    identity: { baseline: baseline.identity, before: before.identity, after: after.identity, drift: identityDiff(baseline.identity, after.identity) },
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
  console.error(`[full-regression] 找不到本仓库的 Playwright CLI：${PLAYWRIGHT_CLI}（不用 npx，避免触发下载）`);
  process.exit(2);
}
const baseline = { identity: currentIdentity(), evidence: evidenceHashes(), dirty: evidenceDirty() };
const manifest = {
  runId: RUN_ID, mode: MODE, startedAt: new Date().toISOString(), cwd: ROOT, node: process.version, pid: process.pid,
  playwrightCli: relative(ROOT, PLAYWRIGHT_CLI), envKeys: ENV_KEYS, baseline, evidenceDirtyAtStart: [...baseline.dirty], steps: [],
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[full-regression] mode=${MODE} out=${relative(ROOT, OUT)} identity=${baseline.identity.digest.slice(0, 12)} lock=${baseline.identity.lock.slice(0, 12)}`);

for (const step of steps()) {
  console.log(`[full-regression] ${step.name} …`);
  const record = await runStep(step, baseline);
  manifest.steps.push(record);
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendFileSync(join(OUT, 'manifest.log'), `${record.step} ok=${record.ok} code=${record.code} report=${record.report?.ok ?? '-'} archived=${record.evidenceArchived.length}\n`);
  if (!record.ok) {
    console.error(`[full-regression] ${record.step} 未通过：${record.identityProblems.join(' | ')}；证据 ${record.log}`);
    process.exit(1);
  }
}
console.log(`[full-regression] 全部 ${manifest.steps.length} 步通过；manifest=${relative(ROOT, join(OUT, 'manifest.json'))}`);
