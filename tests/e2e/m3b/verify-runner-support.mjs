#!/usr/bin/env node
/**
 * 独立验证 runner-support.mjs 的纯逻辑（不启动任何 E2E / 服务 / 构建）。
 *
 * 数据来源：
 * - 已经真实执行过的 01-happy 报告（docs/reports/artifacts/M3-B/acceptance-precheck/playwright-results.json）；
 * - 以该真实报告为模板构造的最小样本：nested suites、失败、skip、retry、errors、expected-failed、stats 不一致；
 * - 身份/证据计划：直接构造 before/after 映射；
 * - spawn 故障：用固定不存在的命令验证"不会有 exit 也能结束"。
 *
 * 用法：node tests/e2e/m3b/verify-runner-support.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  buildIdentity, identityDiff, identityEqual, planEvidenceRestore, spawnAndAwait, verifyPlaywrightReport,
} from './runner-support.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M3-B', 'acceptance-precheck');
const REAL_REPORT = join(OUT, 'playwright-results.json');
const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String(error).slice(0, 600) });
  }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const real = JSON.parse(readFileSync(REAL_REPORT, 'utf8'));
const clone = () => JSON.parse(JSON.stringify(real));

/* 1. 真实报告：必须判通过 */
check('real-report-passes', () => {
  const verdict = verifyPlaywrightReport(real);
  assert(verdict.ok, `真实通过报告被判失败：${JSON.stringify(verdict.problems)}`);
  assert(verdict.counts.tests === 1, `test 计数应为 1，实际 ${verdict.counts.tests}`);
  assert(verdict.counts.results === 1, `result 计数应为 1，实际 ${verdict.counts.results}`);
  assert(verdict.counts.projects.length === 1, `应记录到 1 个 project，实际 ${JSON.stringify(verdict.counts.projects)}`);
  return { counts: verdict.counts, stats: verdict.stats };
});

/* 2. nested suites（test.describe 嵌套）也必须计数 */
check('nested-suites-counted', () => {
  const nested = clone();
  const inner = nested.suites[0].specs;
  nested.suites[0].specs = [];
  nested.suites[0].suites = [{ title: 'inner', file: nested.suites[0].file, specs: inner }];
  const verdict = verifyPlaywrightReport(nested);
  assert(verdict.ok, `嵌套 suite 被判失败：${JSON.stringify(verdict.problems)}`);
  assert(verdict.counts.specs === 1 && verdict.counts.tests === 1, `嵌套统计错误：${JSON.stringify(verdict.counts)}`);
  return verdict.counts;
});

/* 3. 失败结果必须被拒 */
check('failed-result-rejected', () => {
  const broken = clone();
  broken.suites[0].specs[0].tests[0].results[0].status = 'failed';
  broken.suites[0].specs[0].tests[0].status = 'unexpected';
  broken.suites[0].specs[0].ok = false;
  broken.stats.unexpected = 1;
  const verdict = verifyPlaywrightReport(broken);
  assert(!verdict.ok, '失败的 result 被判通过');
  assert(verdict.problems.some((item) => item.includes('results[0].status')), `没有指出 result 状态：${JSON.stringify(verdict.problems)}`);
  return verdict.problems.slice(0, 3);
});

/* 4. skip / expected-failed 必须被拒 */
check('skip-and-expected-failed-rejected', () => {
  const skipped = clone();
  skipped.suites[0].specs[0].tests[0].status = 'skipped';
  skipped.suites[0].specs[0].tests[0].expectedStatus = 'skipped';
  skipped.suites[0].specs[0].tests[0].results[0].status = 'skipped';
  skipped.stats.skipped = 1;
  const skippedVerdict = verifyPlaywrightReport(skipped);
  assert(!skippedVerdict.ok, 'skip 被判通过');
  const expectedFailed = clone();
  expectedFailed.suites[0].specs[0].tests[0].expectedStatus = 'failed';
  const expectedFailedVerdict = verifyPlaywrightReport(expectedFailed);
  assert(!expectedFailedVerdict.ok, 'expected-failed 被判通过');
  return { skipped: skippedVerdict.problems.slice(0, 2), expectedFailed: expectedFailedVerdict.problems.slice(0, 2) };
});

/* 5. 重试（两条 result）必须被拒，即使两条都是 passed */
check('retry-rejected', () => {
  const retried = clone();
  const test = retried.suites[0].specs[0].tests[0];
  test.results.push({ ...test.results[0], retry: 1 });
  retried.stats.flaky = 1;
  const verdict = verifyPlaywrightReport(retried);
  assert(!verdict.ok, '带重试的报告被判通过');
  assert(verdict.problems.some((item) => item.includes('results 数量=2')), `没有指出 result 数量：${JSON.stringify(verdict.problems)}`);
  return verdict.problems.slice(0, 3);
});

/* 6. errors / stats.expected 不一致 */
check('errors-and-stats-rejected', () => {
  const withErrors = clone();
  withErrors.errors = [{ message: 'boom' }];
  assert(!verifyPlaywrightReport(withErrors).ok, 'errors 非空被判通过');
  const wrongStats = clone();
  wrongStats.stats.expected = 2;
  const verdict = verifyPlaywrightReport(wrongStats);
  assert(!verdict.ok && verdict.problems.some((item) => item.includes('stats.expected')), 'stats.expected 不一致未被拒');
  return verdict.problems.slice(0, 2);
});

/* 7. 身份：稳定/字节变化/锁变化/脏状态变化 */
check('identity-detection', () => {
  const base = buildIdentity({ head: 'h1', branch: 'b', entries: [{ path: 'a.ts', hash: 'x' }, { path: 'b.ts', hash: 'y' }], dirty: [], lockSha: 'L1' });
  const same = buildIdentity({ head: 'h1', branch: 'b', entries: [{ path: 'b.ts', hash: 'y' }, { path: 'a.ts', hash: 'x' }], dirty: [], lockSha: 'L1' });
  assert(identityEqual(base, same), '顺序不同但内容相同的身份被判不等');
  assert(identityDiff(base, same).length === 0, '相同身份的 diff 非空');
  const bytesChanged = buildIdentity({ head: 'h1', branch: 'b', entries: [{ path: 'a.ts', hash: 'x2' }, { path: 'b.ts', hash: 'y' }], dirty: [], lockSha: 'L1' });
  assert(identityDiff(base, bytesChanged).some((item) => item.includes('内容摘要')), '字节变化没有被发现');
  const lockChanged = buildIdentity({ head: 'h1', branch: 'b', entries: [{ path: 'a.ts', hash: 'x' }, { path: 'b.ts', hash: 'y' }], dirty: [], lockSha: 'L2' });
  assert(identityDiff(base, lockChanged).some((item) => item.includes('锁文件')), '锁变化没有被发现');
  const dirtyChanged = buildIdentity({ head: 'h1', branch: 'b', entries: [{ path: 'a.ts', hash: 'x' }, { path: 'b.ts', hash: 'y' }], dirty: ['?? tests/e2e/new.spec.ts'], lockSha: 'L1' });
  assert(identityDiff(base, dirtyChanged).some((item) => item.includes('脏/未跟踪')), '未跟踪文件变化没有被发现');
  return { same: true, bytes: true, lock: true, dirty: true };
});

/* 8. 证据归档/还原计划：本步刷新可还原，步骤前已脏必须冲突 */
check('evidence-plan', () => {
  const before = new Map([['docs/reports/artifacts/M0-B/playwright-results.json', 'head1'], ['docs/reports/artifacts/M1-A/x.json', 'head2'], ['docs/reports/artifacts/M2-A/y.json', 'head3']]);
  const after = new Map([['docs/reports/artifacts/M0-B/playwright-results.json', 'new1'], ['docs/reports/artifacts/M1-A/x.json', 'new2'], ['docs/reports/artifacts/M2-A/y.json', 'head3']]);
  const plan = planEvidenceRestore({ before, after, dirtyBefore: new Set(['docs/reports/artifacts/M1-A/x.json']) });
  assert(plan.restorable.length === 1 && plan.restorable[0].file.endsWith('M0-B/playwright-results.json'), `可还原项不对：${JSON.stringify(plan.restorable)}`);
  assert(plan.conflicts.length === 1 && plan.conflicts[0].endsWith('M1-A/x.json'), `冲突项不对：${JSON.stringify(plan.conflicts)}`);
  assert(plan.created.length === 0, '不该有 created');
  return plan;
});

/* 9. spawn 故障：不存在的命令必须在有界时间内结束（不能挂起） */
await (async () => {
  const started = Date.now();
  const bounded = await Promise.race([
    spawnAndAwait('definitely-not-a-real-command-m3b-xyz', [], { spawn, spawnOptions: { cwd: ROOT, windowsHide: true } }),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 15_000)),
  ]);
  results.push({
    name: 'spawn-enoent-bounded',
    ok: Boolean(bounded && !bounded.hung && bounded.spawnError && bounded.ok === false),
    detail: { ...bounded, elapsedMs: Date.now() - started },
  });
})();

const failed = results.filter((item) => !item.ok);
const summary = {
  at: new Date().toISOString(),
  // 自述性：记录验证时的 HEAD 与未提交文件，避免后人把"工作区版本"误当成某个提交的产物。
  head: spawnSync('git', ['-c', 'core.longpaths=true', 'rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString().trim() ?? null,
  worktreeDirty: (spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', '--', 'tests/e2e/m3b'], { cwd: ROOT, encoding: 'utf8' }).stdout?.toString() ?? '').split('\n').map((line) => line.trim()).filter(Boolean),
  helper: 'tests/e2e/m3b/runner-support.mjs',
  data: { realReport: relative(ROOT, REAL_REPORT).split('\\').join('/'), realReportStats: real.stats },
  total: results.length,
  passed: results.length - failed.length,
  results,
  failed: failed.map((item) => item.name),
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'runner-support-verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ total: results.length, failed: summary.failed, results: results.map((item) => `${item.ok ? 'ok' : 'FAIL'} ${item.name}`) }, null, 2));
process.exit(failed.length ? 1 : 0);
