/**
 * 第三轮【续跑】入口（mode=continuation）。
 *
 * 只执行：Studio 全套单测 → demo-safety → Lux3D E2E。
 * typecheck / build / server 单测在上一轮（a500 完整第三轮）与 762 定向自检中已通过且字节未变，
 * 这里以 linkedEvidence 引用，不重复长跑，也不把它们计成本次运行的结果。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const MODE = 'continuation';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-lux3d-continuation`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'Lux3D', 'focused', RUN_ID);
const ARTIFACTS = join(OUT, 'artifacts');
const GUARD_DIR = join(OUT, 'guard');
const GUARD_SCRIPT = join(ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs').replace(/\\/g, '/');
const RUN_STARTED = Date.now();
const CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const FROZEN = '037eda164ed307b118bb1933231dde327f6e606b';
const PRODUCT_PATHS = ['apps', 'packages', 'templates', 'scripts', 'package.json', 'pnpm-lock.yaml'];
const PORTS = [3001, 4018, 4019, 5173, 5174, 5175];
const LINKED = [
  {
    what: '第三轮完整 runner 的 typecheck / build / server 单测',
    runId: '2026-11-16T11-50-39-676Z-lux3d-focused',
    job: 'job_2990283e',
    relative: 'docs/reports/artifacts/Lux3D/focused/2026-11-16T11-50-39-676Z-lux3d-focused/manifest.json',
    note: '受测 a500ee8；typecheck ok / build ok / apps/server 450 通过；studio 1 例浏览器夹具失败（已在 76282dc 修复）',
  },
  {
    what: '76282dc 定向自检（workspace typecheck + 两个浏览器文件）',
    job: 'job_e193afcc',
    relative: '..\\m4\\.data\\lux3d-studio-check\\2026-11-16T12-19-23-488Z\\manifest.json',
    note: 'typecheck 0；speech-app + speech-browser 24/24；identityStable=true',
  },
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
  return { ...env, npm_config_verify_deps_before_run: 'false', ...extra };
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (args) => {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotePath=false', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} -> ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
  return result.stdout ?? '';
};
const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

mkdirSync(ARTIFACTS, { recursive: true });
mkdirSync(GUARD_DIR, { recursive: true });
// 独占创建本轮两个 guard 日志：已存在或写失败一律入口失败（不覆盖历史、不把缺失当 0 拦截）。
const BACKEND_GUARD_LOG = join(GUARD_DIR, 'backend.log');
const WORKER_GUARD_LOG = join(GUARD_DIR, 'test-worker.log');
for (const [role, file] of [['backend', BACKEND_GUARD_LOG], ['test-worker', WORKER_GUARD_LOG]]) {
  try {
    writeFileSync(file, '', { flag: 'wx' });
  } catch (error) {
    const problems = [`guard 日志无法独占创建（${role}）：${String(error).slice(0, 200)}`];
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, mode: MODE, entryFailure: { kind: 'guardLogCreate', problems }, guardDir: GUARD_DIR }, null, 2)}\n`);
    console.error(`entry failure: ${problems.join(' | ')}`);
    process.exit(3);
  }
}
if (!existsSync(CLI)) {
  console.error('missing local Playwright CLI');
  process.exit(2);
}

const problems = [];
const head = git(['rev-parse', 'HEAD']).trim();
writeFileSync(join(OUT, 'runner.log'), '');
const log = (message) => {
  console.log(message);
  writeFileSync(join(OUT, 'runner.log'), `${readFileSync(join(OUT, 'runner.log'), 'utf8')}${message}\n`);
};

/* ---------- 入口静态范围检查 ---------- */
const staticScope = {
  mode: MODE, head, frozen: FROZEN,
  productDiff: lines(git(['diff', '--name-only', FROZEN, 'HEAD', '--', ...PRODUCT_PATHS])),
  testDiff: lines(git(['diff', '--name-only', FROZEN, 'HEAD', '--', 'tests'])),
  dirty: lines(git(['status', '--porcelain', '--untracked-files=all'])).filter((line) => !line.includes('.data/') && !line.includes('fallback/') && !line.includes('docs/reports/artifacts/Lux3D/')),
};
if (staticScope.productDiff.length) problems.push(`产品/脚本/锁相对 ${FROZEN.slice(0, 7)} 有改动：${staticScope.productDiff.slice(0, 5).join(', ')}`);
const foreignTests = staticScope.testDiff.filter((file) => !file.startsWith('tests/e2e/lux3d/'));
if (foreignTests.length) problems.push(`测试树改动越界：${foreignTests.slice(0, 5).join(', ')}`);
const foreignDirty = staticScope.dirty.filter((line) => !line.startsWith('?? tests/e2e/lux3d/') && line !== '?? playwright.lux3d.config.ts' && !line.startsWith('M tests/e2e/lux3d/'));
if (foreignDirty.length) problems.push(`工作树有非本轮改动：${foreignDirty.slice(0, 5).join(' | ')}`);
writeFileSync(join(OUT, 'static-scope.json'), `${JSON.stringify(staticScope, null, 2)}\n`);

/* ---------- linked evidence（前轮已通过、本轮不重复执行） ---------- */
const linked = LINKED.map((item) => {
  const absolute = join(ROOT, item.relative);
  if (!existsSync(absolute)) return { ...item, available: false };
  const bytes = readFileSync(absolute);
  return { ...item, available: true, bytes: bytes.length, sha256: sha256(bytes) };
});
writeFileSync(join(OUT, 'linked-evidence.json'), `${JSON.stringify({ note: '这些步骤在字节未变的更早运行中通过；本文件是引用，不是本轮执行结果。', linked }, null, 2)}\n`);

if (problems.length) {
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, mode: MODE, entryFailure: { kind: 'static-scope', problems }, head, frozen: FROZEN }, null, 2)}\n`);
  console.error(`entry failure: ${problems.join(' | ')}`);
  process.exit(3);
}

/* ---------- 步骤 ---------- */
const steps = [
  { name: 'studio-unit', command: 'pnpm', args: ['--filter', '@spatial/studio', 'test'], shell: true },
  { name: 'demo-safety', command: process.execPath, args: ['--test', 'scripts/demo/safety.test.mjs'] },
  {
    name: 'lux3d-e2e',
    command: process.execPath,
    args: [CLI, 'test', '-c', 'playwright.lux3d.config.ts', '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, 'playwright-output')}`],
    reports: join(ARTIFACTS, 'playwright-results.json'),
    expectedTests: 49,
    env: {
      LUX3D_ARTIFACT_DIR: ARTIFACTS,
      LUX3D_GUARD_DIR: GUARD_DIR.replace(/\\/g, '/'),
      PI_NET_GUARD_LOG: join(GUARD_DIR, 'test-worker.log').replace(/\\/g, '/'),
      PI_NET_GUARD_ALLOW: '',
      NODE_OPTIONS: `--require "${GUARD_SCRIPT}"`,
      PLAYWRIGHT_JSON_OUTPUT_NAME: join(ARTIFACTS, 'playwright-results.json'),
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    },
  },
];

const runStep = (step) => new Promise((resolve) => {
  const logFile = join(OUT, `${step.name}.log`);
  writeFileSync(logFile, `# ${step.name}: ${step.command} ${step.args.join(' ')}\n# started=${new Date().toISOString()}\n`);
  const started = Date.now();
  const child = spawn(step.command, step.args, { cwd: ROOT, env: baseEnv(step.env), shell: step.shell === true, windowsHide: true });
  const append = (chunk) => {
    const text = String(chunk);
    writeFileSync(logFile, readFileSync(logFile, 'utf8') + text);
    process.stdout.write(text);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  let spawnError;
  child.once('error', (error) => { spawnError = error; append(`\n[spawn error] ${String(error)}\n`); });
  child.once('close', (code, signal) => resolve({ code, signal, spawnError, durationMs: Date.now() - started }));
});

const records = [];
let failed = false;
let failure;
for (const step of steps) {
  log(`[lux3d-continuation] ${step.name} …`);
  const result = await runStep(step);
  const record = { step: step.name, ...result, ok: !result.spawnError && result.code === 0, problems: [] };
  if (result.spawnError) record.problems.push(`启动失败：${result.spawnError}`);
  if (result.code !== 0) record.problems.push(`退出码 ${result.code}（signal=${result.signal}）`);
  if (step.reports) {
    try {
      const report = JSON.parse(readFileSync(step.reports, 'utf8'));
      const all = [];
      const specFiles = new Set();
      const walk = (suite) => { for (const spec of suite.specs ?? []) { if (typeof spec.file === 'string') specFiles.add(spec.file.split('\\\\').join('/')); for (const test of spec.tests ?? []) all.push({ spec, test }); } for (const child of suite.suites ?? []) walk(child); };
      for (const suite of report.suites ?? []) walk(suite);
      const stats = { expected: 0, unexpected: 0, skipped: 0, flaky: 0, results: 0, statuses: [] };
      for (const { spec, test } of all) {
        const results = test.results ?? [];
        stats.results += results.length;
        const last = results[results.length - 1];
        stats.statuses.push(last?.status);
        if (last?.status === 'passed') stats.expected += 1;
        else if (last?.status === 'skipped') stats.skipped += 1;
        else stats.unexpected += 1;
        if (test.status === 'flaky') stats.flaky += 1;
        if (results.length !== 1) record.problems.push(`用例 ${spec.title} 结果数 ${results.length}（应逐例单 result）`);
      }
      record.report = { stats, errors: report.errors ?? [], tests: all.length, expectedTests: step.expectedTests ?? null, specFiles: [...specFiles] };
      if (!all.length) record.problems.push('E2E 报告没有任何用例');
      if (stats.skipped) record.problems.push(`有 ${stats.skipped} 例被跳过`);
      if (stats.flaky) record.problems.push(`有 ${stats.flaky} 例 flaky`);
      if (stats.unexpected) record.problems.push(`有 ${stats.unexpected} 例未通过`);
      if ((report.errors ?? []).length) record.problems.push(`报告 errors 非空（${(report.errors ?? []).length}）`);
      // S2：仅在声明 expectedTests 的全套入口核对总数与重复 file/title。
      if (step.expectedTests !== undefined) {
        if (all.length !== step.expectedTests) record.problems.push(`E2E 用例总数 ${all.length} != 预期 ${step.expectedTests}（有测试文件未被发现？）`);
        const keys = all.map(({ spec }) => `${spec.file ?? ''}\u0000${spec.title}`);
        const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
        if (duplicates.length) record.problems.push(`E2E 存在重复 file/title：${duplicates.slice(0, 3).join(' | ')}`);
      }
      record.ok = record.ok && record.problems.length === 0;
    } catch (error) {
      record.problems.push(`读取/解析 JSON 报告失败：${String(error).slice(0, 200)}`);
      record.ok = false;
    }
  }
  records.push(record);
  log(`[lux3d-continuation] ${step.name} ok=${record.ok} code=${result.code} duration=${Math.round(result.durationMs / 1000)}s`);
  if (!record.ok) {
    failed = true;
    const executed = records.map((item) => item.step);
    failure = { step: record.step, problems: record.problems, executed, notExecuted: steps.map((item) => item.name).filter((name) => !executed.includes(name)) };
    break;
  }
}

/* ---------- guard 证据（成功/失败/未执行都要处理） ---------- */
const executedE2E = records.some((item) => item.step === 'lux3d-e2e');
const guardProblems = [];
/** Windows 路径比较：统一分隔符、去掉尾部分隔符、大小写不敏感；但仍是“完整绝对路径相等”而不是前缀。 */
const normalizedPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const EXPECTED_WORKER_LOG = normalizedPath(WORKER_GUARD_LOG);
const EXPECTED_BACKEND_LOG = normalizedPath(BACKEND_GUARD_LOG);
const readGuardLog = (role, file) => {
  if (!existsSync(file)) return { role, path: relative(ROOT, file).split('\\').join('/'), exists: false, bytes: 0, lines: 0, sha256: null };
  try {
    const bytes = readFileSync(file);
    const lines = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
    return { role, path: relative(ROOT, file).split('\\').join('/'), exists: true, bytes: bytes.length, lines: lines.length, sha256: sha256(bytes) };
  } catch (error) {
    guardProblems.push(`读取 guard 日志失败（${role}）：${String(error).slice(0, 160)}`);
    return { role, path: relative(ROOT, file).split('\\').join('/'), exists: false, bytes: 0, lines: 0, sha256: null, readError: String(error).slice(0, 160) };
  }
};
const readLoadedProof = (role, file) => {
  if (!existsSync(file)) return { role, path: relative(ROOT, file).split('\\').join('/'), exists: false };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    const mtimeMs = statSync(file).mtimeMs;
    return { role, path: relative(ROOT, file).split('\\').join('/'), exists: true, mtimeMs, value, fresh: mtimeMs >= RUN_STARTED - 2_000 };
  } catch (error) {
    guardProblems.push(`读取 guard 加载证据失败（${role}）：${String(error).slice(0, 160)}`);
    return { role, path: relative(ROOT, file).split('\\').join('/'), exists: false, error: String(error).slice(0, 160) };
  }
};
const guardEvidence = { at: new Date().toISOString(), executed: executedE2E, guardDir: relative(ROOT, GUARD_DIR).split('\\').join('/'), roles: [], problems: guardProblems };
if (!executedE2E) {
  guardEvidence.verdict = 'not-applicable';
  guardEvidence.note = 'Lux3D E2E 未执行（前序步骤失败），不伪造 guard 证据。';
} else {
  const backendLog = readGuardLog('backend', BACKEND_GUARD_LOG);
  const backendLoaded = readLoadedProof('backend', `${BACKEND_GUARD_LOG}.loaded`);
  guardEvidence.roles.push(backendLog, backendLoaded);
  if (!(backendLoaded.exists && backendLoaded.value?.active === true)) guardProblems.push('backend guard 未在本轮加载（缺少有效 .loaded 或 active!==true）');
  if (backendLoaded.exists && normalizedPath(backendLoaded.value?.logPath) !== EXPECTED_BACKEND_LOG) guardProblems.push(`backend .loaded 的日志路径不是本轮 backend.log：${String(backendLoaded.value?.logPath)}`);
  if (backendLoaded.exists && normalizedPath(backendLoaded.value?.guardDir) !== normalizedPath(GUARD_DIR)) guardProblems.push(`backend .loaded 的 guard 目录不是本轮目录：${String(backendLoaded.value?.guardDir)}`);
  if (backendLoaded.exists && typeof backendLoaded.value?.nodeOptions === 'string' && !backendLoaded.value.nodeOptions.includes('no-real-network.cjs')) guardProblems.push('backend .loaded 的 NODE_OPTIONS 未包含受控 guard preload');
  if (backendLoaded.exists && backendLoaded.fresh !== true) guardProblems.push('backend .loaded 不是本轮生成（mtime 早于本轮起点）');
  if (!backendLog.exists) guardProblems.push('backend guard 日志缺失（本轮未建立或已被删除），不得当作“零拦截”');
  if (backendLog.exists && backendLog.lines > 0) guardProblems.push(`backend guard 记录到 ${backendLog.lines} 次外联拦截`);

  const e2eRecord = records.find((item) => item.step === 'lux3d-e2e');
  const legacyRan = (e2eRecord?.report?.specFiles ?? []).some((file) => file.includes('legacy-work.spec.ts'));
  const workerProof = readLoadedProof('legacy-worker', join(GUARD_DIR, 'legacy-worker.loaded.json'));
  const workerLog = readGuardLog('test-worker', WORKER_GUARD_LOG);
  guardEvidence.roles.push(workerLog, workerProof, { legacyRan });
  if (legacyRan) {
    if (!(workerProof.exists && workerProof.value?.ready === true)) guardProblems.push('legacy worker 未证明 guard 已加载（ready!==true）');
    if (workerProof.exists && workerProof.value?.role !== 'legacy-worker') guardProblems.push('legacy worker 证据的 role 不正确');
    if (workerProof.exists && !(Number.isInteger(workerProof.value?.pid) && workerProof.value.pid > 0)) guardProblems.push('legacy worker 证据缺少有效 PID');
    if (workerProof.exists && normalizedPath(workerProof.value?.logPath) !== EXPECTED_WORKER_LOG) guardProblems.push(`legacy worker 证据的日志路径不是本轮 test-worker.log：${String(workerProof.value?.logPath)}`);
    if (workerProof.exists && workerProof.value?.guardLog !== undefined && normalizedPath(workerProof.value?.guardLog) !== EXPECTED_WORKER_LOG) guardProblems.push(`legacy worker 实际 guard 捕获的日志路径不是本轮 test-worker.log：${String(workerProof.value?.guardLog)}`);
    if (workerProof.exists && workerProof.fresh !== true) guardProblems.push('legacy worker 加载证据不是本轮生成');
  }
  if (!workerLog.exists) guardProblems.push('test-worker guard 日志缺失（本轮未建立或已被删除），不得当作“零拦截”');
  if (workerLog.exists && workerLog.lines > 0) guardProblems.push(`test worker guard 记录到 ${workerLog.lines} 次外联拦截`);
  guardEvidence.verdict = guardProblems.length ? 'fail' : 'pass';
}
guardEvidence.problems = guardProblems;
writeFileSync(join(GUARD_DIR, 'guard-evidence.json'), `${JSON.stringify(guardEvidence, null, 2)}\n`);

/* ---------- 运行后证据 ---------- */
const fixtureValidationSource = join(ROOT, '.data', 'pi-lux3d', 'fixtures', 'validation.json');
let fixtureValidation = { present: false };
if (existsSync(fixtureValidationSource)) {
  const bytes = readFileSync(fixtureValidationSource);
  writeFileSync(join(OUT, 'fixtures-validation.json'), bytes);
  let generatedAt;
  try { generatedAt = JSON.parse(bytes.toString('utf8'))?.at; } catch { generatedAt = undefined; }
  fixtureValidation = { present: true, bytes: bytes.length, sha256: sha256(bytes), generatedAt, source: '.data/pi-lux3d/fixtures/validation.json', reuseNote: '若 generatedAt 早于本轮起点，则本轮为复用而非重新生成' };
}
const post = {
  at: new Date().toISOString(),
  mode: MODE,
  guard: { verdict: guardEvidence.verdict, problems: guardProblems, guardDir: guardEvidence.guardDir },
  fixturesValidation: fixtureValidation,
  head: git(['rev-parse', 'HEAD']).trim(),
  productDiff: lines(git(['diff', '--name-only', FROZEN, 'HEAD', '--', ...PRODUCT_PATHS])),
  templatesStatus: lines(git(['status', '--porcelain', '--untracked-files=all', '--', 'templates/product-page'])),
  ports: spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => /LISTENING/i.test(line)).map((line) => line.split(/\s+/))
    .filter((cols) => PORTS.includes(Number(String(cols[1]).split(':').pop())))
    .map((cols) => ({ address: cols[1], pid: cols[cols.length - 1] })),
};
if (post.productDiff.length) problems.push(`运行后产品字节漂移：${post.productDiff.slice(0, 5).join(', ')}`);
if (post.templatesStatus.length) problems.push(`运行后模板未还原：${post.templatesStatus.slice(0, 5).join(' | ')}`);
writeFileSync(join(OUT, 'post-run.json'), `${JSON.stringify(post, null, 2)}\n`);

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, mode: MODE, head, frozen: FROZEN, stepPlan: steps.map((item) => item.name), linked, steps: records, failure, problems, guardEvidence, guardProblems }, null, 2)}\n`);

const files = [];
const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push(file); } };
walk(OUT);
const SELF = 'sha256-manifest.json';
const payload = files.filter((file) => relative(OUT, file).split('\\').join('/') !== SELF)
  .map((file) => { const bytes = readFileSync(file); return { path: relative(OUT, file).split('\\').join('/'), bytes: bytes.length, sha256: sha256(bytes) }; })
  .sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(OUT, SELF), `${JSON.stringify({ at: new Date().toISOString(), runId: RUN_ID, mode: MODE, payloadFiles: payload.length, manifestExcluded: SELF, entries: payload }, null, 2)}\n`);
const mismatched = payload.filter((entry) => { const bytes = readFileSync(join(OUT, entry.path)); return bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256; });

console.log(JSON.stringify({
  runDir: relative(ROOT, OUT).split('\\').join('/'), mode: MODE, head, frozen: FROZEN,
  failed, problems,
  stepPlan: steps.map((item) => item.name),
  steps: records.map((item) => ({ step: item.step, ok: item.ok, code: item.code, report: item.report?.stats })),
  linked: linked.map((item) => ({ what: item.what, available: item.available, sha256: item.sha256 })),
  guard: { verdict: guardEvidence.verdict, problems: guardProblems },
  payloadFiles: payload.length, shaMismatch: mismatched.length, ports: post.ports, templatesClean: post.templatesStatus.length === 0,
}, null, 1));
process.exit(problems.length || failed || guardProblems.length ? 1 : 0);
