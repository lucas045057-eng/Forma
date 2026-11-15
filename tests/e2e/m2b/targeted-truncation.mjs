#!/usr/bin/env node
/**
 * 定向验证入口：只跑 M2-B 的"历史截断"这一例（不跑其它用例、不跑全轮）。
 *
 * 背景见 docs/reports/M3-C-test.md 第 11 节：正式轮的失败是测试前提错误（route 对所有
 * /events/history 永久返回 truncated，真实后端不可能这样），产品同步合同本身正确。
 * 这里用最小修正后的 fixture 重跑同一断言：过旧 cursor 截断一次，head/新 anchor 补拉走真实后端。
 *
 * 约束：
 * - 新 run 目录、0 retry、无 --repeat-each、不 skip、filter 只针对这一例标题；
 * - 记录 HEAD / 锁 SHA256 / 工作区状态 / 命令 / PID / 起止时间 / 退出码；
 * - 用与正式轮同一套严格判据（tests/e2e/m3b/runner-support.mjs）核对 JSON 报告。
 *
 * 用法：node tests/e2e/m2b/targeted-truncation.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnAndAwait, verifyPlaywrightReport } from '../m3b/runner-support.mjs';

const ROOT = process.cwd();
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-m2b-targeted`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M3-C', 'regression', RUN_ID);
const CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const GREP = '历史截断';

const git = (args) => {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${(result.stderr ?? '').slice(0, 300)}`);
  return `${result.stdout ?? ''}`.trim();
};
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

mkdirSync(OUT, { recursive: true });
const identity = {
  head: git(['rev-parse', 'HEAD']),
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
  lockSha256: sha256(readFileSync(join(ROOT, 'pnpm-lock.yaml'))),
  productDirty: git(['status', '--porcelain', '--untracked-files=all', '--', 'apps', 'packages', 'templates', 'pnpm-lock.yaml']),
  specSha256: sha256(readFileSync(join(ROOT, 'tests', 'e2e', 'm2b', '02-takeover.spec.ts'))),
};

const args = [CLI, 'test', '-c', 'playwright.m2b.config.ts', '--grep', GREP, '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, 'output')}`];
const startedAt = new Date().toISOString();
const spawnResult = await spawnAndAwait(process.execPath, args, {
  spawn,
  spawnOptions: {
    cwd: ROOT,
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: join(OUT, 'results.json') },
    windowsHide: true,
  },
  onChild: (child) => {
    child.stdout?.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk));
  },
});
const finishedAt = new Date().toISOString();

const reportFile = join(OUT, 'results.json');
let report = { ok: false, problems: ['报告缺失'] };
try {
  report = verifyPlaywrightReport(JSON.parse(readFileSync(reportFile, 'utf8')));
} catch (error) {
  report = { ok: false, problems: [`读取报告失败：${String(error).slice(0, 200)}`] };
}
const manifest = {
  runId: RUN_ID, scope: `单一用例（--grep ${GREP}）`, startedAt, finishedAt,
  command: `node ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
  out: relative(ROOT, OUT).split('\\').join('/'),
  pid: spawnResult.pid, code: spawnResult.code, signal: spawnResult.signal, spawnError: spawnResult.spawnError,
  identity, report,
  verdict: spawnResult.code === 0 && report.ok ? 'passed' : 'failed',
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\n[targeted] ${manifest.verdict} code=${manifest.code} report=${report.ok ? `${report.counts.tests} tests` : JSON.stringify(report.problems)} out=${manifest.out}`);
process.exit(manifest.verdict === 'passed' ? 0 : 1);
