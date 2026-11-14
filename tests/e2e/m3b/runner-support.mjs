/**
 * 完整回归入口的纯逻辑助手（无副作用，可独立验证）。
 *
 * 三类东西在这里，便于用真实数据 + 合成小样本反复核对，而不必启动任何 E2E 服务：
 * 1. Playwright JSON 报告的严格判据（三层状态、单 result、retry=0、nested suites、errors）；
 * 2. 身份摘要（工作区真实字节 + 锁 SHA256 + 脏状态 + HEAD）与逐步比对；
 * 3. 历史证据被刷新时的归档/还原计划（测试前已脏 = 归属不明，停止而不是覆盖）；
 * 4. spawn 的完成屏障（只认 close + 日志写完；ENOENT 只有 error/close 也要结束）。
 *
 * 这里不读 process.env、不写文件、不起进程（spawnAndAwait 只负责构造 Promise）。
 */
import { createHash } from 'node:crypto';

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/* ------------------------------------------------------------ Playwright JSON */

const flattenSuites = (suites, depth = 0, out = []) => {
  for (const suite of suites ?? []) {
    out.push({ suite, depth });
    if (Array.isArray(suite.suites)) flattenSuites(suite.suites, depth + 1, out);
  }
  return out;
};

/**
 * 严格核对 Playwright JSON reporter 的结果。
 * 三层状态不能混：
 *   test.expectedStatus = 'passed'（用例的期望）,
 *   test.status         = 'expected' | 'unexpected' | 'skipped' | 'flaky',
 *   results[i].status   = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
 */
export function verifyPlaywrightReport(report) {
  const problems = [];
  const counts = { suites: 0, specs: 0, tests: 0, results: 0, projects: [] };
  if (!report || typeof report !== 'object') return { ok: false, problems: ['报告不是对象'], counts };
  if (!Array.isArray(report.suites)) problems.push('报告缺少 suites 数组');

  if (Array.isArray(report.errors) && report.errors.length) {
    problems.push(`errors 非空（${report.errors.length}）：${JSON.stringify(report.errors[0]).slice(0, 200)}`);
  }
  const stats = report.stats ?? {};
  for (const key of ['unexpected', 'skipped', 'flaky']) {
    if (Number(stats[key] ?? 0) !== 0) problems.push(`stats.${key}=${stats[key]}（必须为 0）`);
  }

  const suites = flattenSuites(report.suites ?? []);
  counts.suites = suites.length;
  for (const { suite } of suites) {
    for (const spec of suite.specs ?? []) {
      counts.specs += 1;
      const label = `${spec.file ?? suite.file ?? '?'} › ${spec.title ?? '?'}`;
      if (spec.ok !== true) problems.push(`spec 未通过：${label}`);
      if (!Array.isArray(spec.tests) || spec.tests.length === 0) {
        problems.push(`spec 没有 test 记录：${label}`);
        continue;
      }
      for (const test of spec.tests) {
        counts.tests += 1;
        // 没有显式 projects 的配置里 projectName 是空串，归一成 (default) 便于读数。
        const project = test.projectName || '(default)';
        if (!counts.projects.includes(project)) counts.projects.push(project);
        if (test.expectedStatus !== 'passed') problems.push(`expectedStatus=${test.expectedStatus}（要求 passed）：${label} [${project}]`);
        if (test.status !== 'expected') problems.push(`test.status=${test.status}（要求 expected，skip/flaky/unexpected 都拒绝）：${label} [${project}]`);
        const annotations = (test.annotations ?? []).map((item) => String(item?.type ?? '')).filter(Boolean);
        if (annotations.some((type) => ['skip', 'fixme', 'fail'].includes(type))) problems.push(`用例带跳过/失败注解 ${annotations.join(',')}：${label} [${project}]`);
        const results = test.results ?? [];
        counts.results += results.length;
        if (results.length !== 1) problems.push(`results 数量=${results.length}（要求恰好 1，出现重试即失败）：${label} [${project}]`);
        results.forEach((result, index) => {
          if (result.status !== 'passed') problems.push(`results[${index}].status=${result.status}（要求 passed）：${label} [${project}]`);
          if (Number(result.retry ?? 0) !== 0) problems.push(`results[${index}].retry=${result.retry}（要求 0）：${label} [${project}]`);
          if (Array.isArray(result.errors) && result.errors.length) problems.push(`results[${index}] 带错误信息：${label} [${project}]`);
        });
      }
    }
  }

  if (counts.tests === 0) problems.push('没有收集/执行到任何 test 记录');
  const expected = Number(stats.expected ?? NaN);
  if (!Number.isFinite(expected)) problems.push('stats.expected 缺失');
  else if (expected !== counts.tests) problems.push(`stats.expected=${expected} 与实际 test 记录数 ${counts.tests} 不一致`);

  return { ok: problems.length === 0, problems, counts, stats };
}

/* ------------------------------------------------------------------ 身份摘要 */

/** 由 [{path, hash}] + 锁 + 脏状态 + HEAD 生成身份摘要（顺序无关）。 */
export function buildIdentity({ head, branch, entries, dirty = [], lockSha }) {
  const lines = entries.map((entry) => `${entry.path}\0${entry.hash}`).sort().join('\n');
  return {
    head: head ?? null,
    branch: branch ?? null,
    files: entries.length,
    digest: sha256Hex(Buffer.from(`${lines}\n#lock:${lockSha ?? 'missing'}\n#dirty:${dirty.join(',')}`)),
    lock: lockSha ?? 'missing',
    dirty: [...dirty].sort(),
  };
}

export function identityEqual(a, b) {
  if (!a || !b) return false;
  return a.digest === b.digest && a.lock === b.lock && a.head === b.head;
}

export function identityDiff(baseline, current) {
  const problems = [];
  if (!baseline || !current) return ['缺少身份基线或当前身份'];
  if (baseline.digest !== current.digest) problems.push(`内容摘要变化（baseline=${baseline.digest.slice(0, 12)} now=${current.digest.slice(0, 12)}）`);
  if (baseline.lock !== current.lock) problems.push(`锁文件 SHA256 变化（${String(baseline.lock).slice(0, 12)} → ${String(current.lock).slice(0, 12)}）`);
  if (baseline.head !== current.head) problems.push(`HEAD 变化（${baseline.head} → ${current.head}）`);
  if (JSON.stringify(baseline.dirty) !== JSON.stringify(current.dirty)) problems.push('工作区脏/未跟踪状态变化');
  return problems;
}

/* ------------------------------------------------------- 历史证据归档/还原计划 */

/**
 * 汇总"这一步刷新了哪些已跟踪证据"，并区分归属：
 * - restorable：本步才变脏 → 可以先归档新字节再按 blob 还原；
 * - conflicts：步骤开始前就已经脏（归属不明）→ 禁止覆盖，必须停下；
 * - created：本步新出现但不在 before 里的已跟踪文件（异常，按冲突处理）。
 */
export function planEvidenceRestore({ before, after, dirtyBefore }) {
  const conflicts = [];
  const restorable = [];
  const created = [];
  for (const [file, hash] of after) {
    const previous = before.get(file);
    if (previous === hash) continue;
    if (previous === undefined) { created.push(file); continue; }
    if (dirtyBefore.has(file)) conflicts.push(file);
    else restorable.push({ file, beforeHash: previous, afterHash: hash });
  }
  for (const file of before.keys()) if (!after.has(file)) conflicts.push(file); // 被删掉也算异常
  return { restorable, conflicts, created };
}

/** 归档路径：保留原相对路径，落在本次 run 目录下，避免覆盖历史证据。 */
export function evidenceArchiveTarget(runDir, stepName, file) {
  return `${runDir}/evidence-refresh/${stepName}/${file.split('\\').join('/')}`;
}

/* ------------------------------------------------------------ spawn 完成屏障 */

/**
 * 只以 'close'（stdio 已关闭）+ 日志写完作为完成屏障；'error'（如 ENOENT）也要结束，
 * 否则 Promise 会一直 pending。返回 { pid, code, signal, spawnError, ok }。
 * spawn 实现显式注入，方便用“固定不存在的命令”做短故障验证。
 */
export function spawnAndAwait(command, args, { spawn: spawnImpl, spawnOptions = {}, onChild } = {}) {
  if (typeof spawnImpl !== 'function') {
    return Promise.resolve({ pid: null, code: null, signal: null, spawnError: 'SPAWN_IMPL_MISSING', ok: false });
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload); } };
    let child;
    try {
      child = spawnImpl(command, args, spawnOptions);
    } catch (error) {
      finish({ pid: null, code: null, signal: null, spawnError: String(error), ok: false });
      return;
    }
    try { onChild?.(child); } catch { /* 记录回调本身不能拖死步骤 */ }
    child.once('error', (error) => {
      finish({ pid: child.pid ?? null, code: null, signal: null, spawnError: String(error?.code ?? error), ok: false });
    });
    child.once('close', (code, signal) => {
      finish({ pid: child.pid ?? null, code, signal, spawnError: null, ok: code === 0 });
    });
  });
}
