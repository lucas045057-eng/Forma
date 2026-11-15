#!/usr/bin/env node
/**
 * 定向验证入口：只跑 M2-B 的"历史截断"这一例（不跑其它用例、不跑全轮）。
 *
 * 背景见 docs/reports/M3-C-test.md 第 11 节：正式轮的失败是测试前提错误。
 * 本轮 fixture 用**真实后端保留尾段**构造一次自洽截断（真实 events/current、oldest=尾段首 seq，
 * 满足 oldst<=current 与 0<since<oldest-1），head 与新 anchor 一律放行到真实后端。
 *
 * 这个入口自己负责"不污染历史证据"（tests/e2e/m2b/artifact.ts 写死 docs/reports/artifacts/M2-B）：
 * - 起跑前：证据目录必须干净，否则停止（归属不明绝不覆盖）；
 * - 结束后：本步刷新/新增的 tracked 证据**先归档新字节与哈希**，再按 blob 还原并用对象 id 校验；
 * - 全程记录受测 HEAD、锁 SHA256、spec SHA256、前后身份与工作区状态、命令/PID/时间/退出码；
 * - 用与正式轮同一套严格判据核对 JSON 报告（恰好一条 result、retry=0、expectedStatus=passed、无 skip/errors）。
 *
 * 用法：node tests/e2e/m2b/targeted-truncation.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { buildIdentity, evidenceArchiveTarget, identityDiff, planEvidenceRestore, sha256Hex, spawnAndAwait, verifyPlaywrightReport } from '../m3b/runner-support.mjs';

const ROOT = process.cwd();
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-m2b-targeted`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M3-C', 'regression', RUN_ID);
const CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const GREP = '历史截断';
const SPEC = join('tests', 'e2e', 'm2b', '02-takeover.spec.ts');
const EVIDENCE_DIR = 'docs/reports/artifacts';
const IDENTITY_PATHS = ['apps', 'packages', 'templates', 'tests/e2e', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];

const git = (args) => {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').slice(0, 300)}`);
  return `${result.stdout ?? ''}`;
};
const splitZ = (text) => text.split('\0').filter(Boolean);
const readHash = (file) => {
  const full = join(ROOT, file);
  return existsSync(full) ? sha256Hex(readFileSync(full)) : 'missing';
};
const evidenceHashes = () => new Map(splitZ(git(['ls-files', '-z', '--', EVIDENCE_DIR])).map((file) => [file, readHash(file)]));
const evidenceDirty = () => new Set(splitZ(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', EVIDENCE_DIR])).map((entry) => entry.replace(/^.../, '')));

function currentIdentity() {
  const paths = [...IDENTITY_PATHS, 'playwright.config.ts', ...splitZ(git(['ls-files', '-z', '--', ':(glob)playwright*.ts']))];
  const tracked = splitZ(git(['ls-files', '-z', '--', ...paths]));
  const untracked = splitZ(git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]));
  const entries = [...new Set([...tracked, ...untracked])].map((file) => ({ path: file, hash: readHash(file) }));
  const dirty = splitZ(git(['status', '--porcelain', '-z', '--untracked-files=all', '--', ...paths])).map((entry) => entry.replace(/^.../, ''));
  return buildIdentity({ head: git(['rev-parse', 'HEAD']).trim(), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).trim(), entries, dirty, lockSha: readHash('pnpm-lock.yaml') });
}

mkdirSync(OUT, { recursive: true });

// 1) 起跑前证据必须干净：已脏/未跟踪 = 归属不明，停止而不是覆盖。
const dirtyAtStart = evidenceDirty();
if (dirtyAtStart.size > 0) {
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, entryFailure: { kind: 'entry', reason: 'evidenceDirtyAtStart', dirty: [...dirtyAtStart] } }, null, 2)}\n`);
  console.error(`[targeted] 入口失败（不是产品/用例失败）：${EVIDENCE_DIR} 起跑前已脏 ${dirtyAtStart.size} 项`);
  for (const file of dirtyAtStart) console.error(`  dirty: ${file}`);
  process.exit(3);
}

const baseline = { identity: currentIdentity(), evidence: evidenceHashes() };
const identity = {
  head: baseline.identity.head,
  branch: baseline.identity.branch,
  identityDigest: baseline.identity.digest,
  lockSha256: baseline.identity.lock,
  specSha256: readHash(SPEC),
  productDirty: git(['status', '--porcelain', '--untracked-files=all', '--', 'apps', 'packages', 'templates', 'pnpm-lock.yaml']).trim(),
};

const args = [CLI, 'test', '-c', 'playwright.m2b.config.ts', '--grep', GREP, '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, 'output')}`];
const startedAt = new Date().toISOString();
const spawnResult = await spawnAndAwait(process.execPath, args, {
  spawn,
  spawnOptions: { cwd: ROOT, env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(OUT, 'results.json') }, windowsHide: true },
  onChild: (child) => {
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  },
});
const finishedAt = new Date().toISOString();
const after = { identity: currentIdentity(), evidence: evidenceHashes() };
const problems = [];
if (spawnResult.spawnError) problems.push(`启动失败：${spawnResult.spawnError}`);
if (spawnResult.code !== 0) problems.push(`退出码 ${spawnResult.code}（signal=${spawnResult.signal}）`);
problems.push(...identityDiff(baseline.identity, after.identity).map((item) => `身份漂移：${item}`));

// 2) 历史证据：先归档本步新字节，再按 blob 还原并校验对象 id。
const plan = planEvidenceRestore({ before: baseline.evidence, after: after.evidence, dirtyBefore: new Set() });
const archived = [];
for (const item of plan.restorable) {
  const source = join(ROOT, item.file);
  const target = evidenceArchiveTarget(OUT, 'run', item.file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const headBlobId = git(['rev-parse', `HEAD:${item.file.replaceAll('\\', '/')}`]).trim();
  const checkout = spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', item.file], { cwd: ROOT, encoding: 'utf8' });
  const restoredId = spawnSync('git', ['-c', 'core.longpaths=true', 'hash-object', `--path=${item.file}`, source], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString().trim();
  const statusClean = (spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', '--', item.file], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString() ?? '').trim() === '';
  if (checkout.status !== 0 || restoredId !== headBlobId || !statusClean) problems.push(`证据还原失败：${item.file}`);
  archived.push({
    file: item.file, beforeSha256: item.beforeHash, afterSha256: item.afterHash,
    archivedTo: relative(ROOT, target).split('\\').join('/'), archivedBytes: readFileSync(target).length,
    headBlobId, restoredObjectId: restoredId ?? null, statusClean,
  });
}
for (const file of plan.conflicts) problems.push(`步骤开始前就已脏（未覆盖）：${file}`);
for (const file of plan.created) problems.push(`本步新增的已跟踪证据（需人工确认）：${file}`);

let report = { ok: false, problems: ['报告缺失'] };
try {
  report = verifyPlaywrightReport(JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8')));
} catch (error) {
  report = { ok: false, problems: [`读取报告失败：${String(error).slice(0, 200)}`] };
}
if (!report.ok) problems.push(...report.problems.map((item) => `报告核对失败：${item}`));

const manifest = {
  runId: RUN_ID, scope: `单一用例（--grep ${GREP}）`, startedAt, finishedAt,
  command: `node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
  out: relative(ROOT, OUT).split('\\').join('/'),
  pid: spawnResult.pid, code: spawnResult.code, signal: spawnResult.signal, spawnError: spawnResult.spawnError,
  identity, afterIdentity: { head: after.identity.head, digest: after.identity.digest, lock: after.identity.lock },
  identityStable: identityDiff(baseline.identity, after.identity).length === 0,
  evidenceArchived: archived, report, problems,
  verdict: problems.length === 0 ? 'passed' : 'failed',
};
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n[targeted] ${manifest.verdict} code=${manifest.code} report=${report.ok ? `${report.counts?.tests} tests` : JSON.stringify(report.problems)} archived=${archived.length} out=${manifest.out}`);
if (problems.length) for (const problem of problems) console.error(`  - ${problem}`);
process.exit(manifest.verdict === 'passed' ? 0 : 1);
