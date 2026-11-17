/**
 * Lux3D focused 验收 runner（唯一一次集中运行）。
 *
 * 顺序固定：typecheck → build → pnpm test → demo-safety → Lux3D（后端契约 + 模块历史 + 浏览器 E2E）。
 * 首败即停并记录 notExecuted；旧 full/193 套件不在本轮范围；0 retry / 0 skip / 逐例单 result。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { captureInputIdentity, diffInputIdentity } from './support/input-identity.mjs';

const ROOT = process.cwd();
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-lux3d-focused`;
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'Lux3D', 'focused', RUN_ID);
const ARTIFACTS = join(OUT, 'artifacts');
const GUARD_DIR = join(OUT, 'guard');
const GUARD_SCRIPT = join(ROOT, 'tests', 'e2e', 'm0a', 'no-real-network.cjs').replace(/\\/g, '/');
const RUN_STARTED = Date.now();
const MODE = 'full-focused';
const CONFIG = 'playwright.lux3d.config.ts';
const CONFIG_PATH = join(ROOT, CONFIG);
const CONFIG_SHA = createHash('sha256').update(readFileSync(CONFIG_PATH)).digest('hex');
const CLI = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
const FROZEN = '037eda164ed307b118bb1933231dde327f6e606b';
const PRODUCT_PATHS = ['apps', 'packages', 'templates', 'scripts', 'package.json', 'pnpm-lock.yaml'];
const PORTS = [3001, 4018, 4019, 5173, 5174, 5175];

const ENV_KEYS = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'OS',
  'PNPM_HOME', 'PLAYWRIGHT_BROWSERS_PATH', 'npm_config_cache', 'npm_config_store_dir',
];
const baseEnv = (extra = {}) => {
  const env = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  // 只把本轮必要变量显式注入；绝不继承 provider key / proxy / NODE_OPTIONS。
  // 关闭 pnpm 的自动依赖校验/bootstrap，避免隐式安装或联网。
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
const BACKEND_GUARD_LOG = join(GUARD_DIR, 'backend.log');
const WORKER_GUARD_LOG = join(GUARD_DIR, 'test-worker.log');
for (const [role, logFile] of [['backend', BACKEND_GUARD_LOG], ['test-worker', WORKER_GUARD_LOG]]) {
  try {
    writeFileSync(logFile, '', { flag: 'wx' });
  } catch (error) {
    const entryProblems = [`guard 日志无法独占创建（${role}）：${String(error).slice(0, 200)}`];
    writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, mode: MODE, entryFailure: { kind: 'guardLogCreate', problems: entryProblems }, guardDir: GUARD_DIR }, null, 2)}\n`);
    console.error(`entry failure: ${entryProblems.join(' | ')}`);
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

/* ---------- 入口静态范围检查（不改任何东西，只挡明显跑错） ---------- */
const staticScope = {
  mode: MODE,
  config: { file: CONFIG, absolutePath: CONFIG_PATH.split('\\').join('/'), sha256: CONFIG_SHA },
  head,
  frozen: FROZEN,
  productDiff: lines(git(['diff', '--name-only', FROZEN, 'HEAD', '--', ...PRODUCT_PATHS])),
  testDiff: lines(git(['diff', '--name-only', FROZEN, 'HEAD', '--', 'tests'])),
  dirty: lines(git(['status', '--porcelain', '--untracked-files=all'])).filter((line) => !line.includes('.data/') && !line.includes('fallback/') && !line.includes('docs/reports/artifacts/Lux3D/')),
};
if (staticScope.productDiff.length) problems.push(`产品/脚本/锁相对 ${FROZEN.slice(0, 7)} 有改动：${staticScope.productDiff.slice(0, 5).join(', ')}`);
const foreignTests = staticScope.testDiff.filter((file) => !file.startsWith('tests/e2e/lux3d/'));
if (foreignTests.length) problems.push(`测试树改动越界（只允许 tests/e2e/lux3d）：${foreignTests.slice(0, 5).join(', ')}`);
const foreignDirty = staticScope.dirty.filter((line) => !line.startsWith('?? tests/e2e/lux3d/') && line !== '?? playwright.lux3d.config.ts');
if (foreignDirty.length) problems.push(`工作树有非本轮改动：${foreignDirty.slice(0, 5).join(' | ')}`);
writeFileSync(join(OUT, 'static-scope.json'), `${JSON.stringify(staticScope, null, 2)}\n`);
if (problems.length) {
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, entryFailure: { kind: 'static-scope', problems }, head }, null, 2)}\n`);
  console.error(`entry failure: ${problems.join(' | ')}`);
  process.exit(3);
}

/* ---------- 输入身份 before（只读；任何测试之前） ---------- */
let inputIdentityBefore;
try {
  inputIdentityBefore = captureInputIdentity(ROOT);
  writeFileSync(join(OUT, 'input-identity-before.json'), `${JSON.stringify(inputIdentityBefore, null, 2)}\n`);
} catch (error) {
  const entryProblems = [`输入身份 before 采集失败：${String(error).slice(0, 300)}`];
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({ runId: RUN_ID, mode: MODE, entryFailure: { kind: 'inputIdentityCapture', problems: entryProblems }, head }, null, 2)}\n`);
  console.error(`entry failure: ${entryProblems.join(' | ')}`);
  process.exit(3);
}

/* ---------- 步骤 ---------- */
const ARGS = [CLI, 'test', '-c', CONFIG, '--retries=0', '--workers=1', '--reporter=list,json', `--output=${join(OUT, 'playwright-output')}`];
const steps = [
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'], shell: true },
  { name: 'build', command: 'pnpm', args: ['build'], shell: true },
  { name: 'unit', command: 'pnpm', args: ['test'], shell: true },
  { name: 'demo-safety', command: process.execPath, args: ['--test', 'scripts/demo/safety.test.mjs'] },
  {
    name: 'lux3d-e2e',
    command: process.execPath,
    args: ARGS,
    reports: join(ARTIFACTS, 'playwright-results.json'),
    expectedTests: 49,
    env: {
      LUX3D_ARTIFACT_DIR: ARTIFACTS,
      LUX3D_GUARD_DIR: GUARD_DIR.replace(/\\/g, '/'),
      PI_NET_GUARD_LOG: WORKER_GUARD_LOG.replace(/\\/g, '/'),
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
  const child = spawn(step.command, step.args, {
    cwd: ROOT, env: baseEnv(step.env), shell: step.shell === true, windowsHide: true,
  });
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
  log(`[lux3d] ${step.name} …`);
  const result = await runStep(step);
  const record = { step: step.name, ...result, ok: !result.spawnError && result.code === 0, problems: [] };
  if (result.spawnError) record.problems.push(`启动失败：${result.spawnError}`);
  if (result.code !== 0) record.problems.push(`退出码 ${result.code}（signal=${result.signal}）`);
  if (step.reports) {
    try {
      const report = JSON.parse(readFileSync(step.reports, 'utf8'));
      const suites = report.suites ?? [];
      const all = [];
      const specFiles = new Set();
      const walk = (suite) => { for (const spec of suite.specs ?? []) { if (typeof spec.file === 'string') specFiles.add(spec.file.split('\\\\').join('/')); for (const test of spec.tests ?? []) all.push({ spec, test }); } for (const child of suite.suites ?? []) walk(child); };
      for (const suite of suites) walk(suite);
      const stats = { expected: 0, unexpected: 0, skipped: 0, flaky: 0, results: 0, retries: 0, statuses: [] };
      for (const { spec, test } of all) {
        const results = test.results ?? [];
        stats.results += results.length;
        stats.retries += Math.max(0, results.length - 1);
        const last = results[results.length - 1];
        stats.statuses.push(last?.status);
        if (last?.status === 'passed') stats.expected += 1;
        else if (last?.status === 'skipped') stats.skipped += 1;
        else stats.unexpected += 1;
        if (test.status === 'flaky') stats.flaky += 1;
        if (results.length !== 1) record.problems.push(`用例 ${spec.title} 结果数 ${results.length}（应逐例单 result）`);
      }
      record.report = { ok: true, stats, errors: report.errors ?? [], tests: all.length, expectedTests: step.expectedTests ?? null, specFiles: [...specFiles] };
      if (!all.length) record.problems.push('E2E 报告没有任何用例');
      if (stats.skipped) record.problems.push(`有 ${stats.skipped} 例被跳过`);
      if (stats.flaky) record.problems.push(`有 ${stats.flaky} 例 flaky`);
      if (stats.unexpected) record.problems.push(`有 ${stats.unexpected} 例未通过`);
      if ((report.errors ?? []).length) record.problems.push(`报告 errors 非空（${(report.errors ?? []).length}）`);
      // S2：仅在声明 expectedTests 的全套入口核对总数与重复 file/title，防止漏发现文件仍判全绿。
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
  log(`[lux3d] ${step.name} ok=${record.ok} code=${result.code} duration=${Math.round(result.durationMs / 1000)}s`);
  if (!record.ok) {
    failed = true;
    const executed = records.map((item) => item.step);
    const notExecuted = steps.map((item) => item.name).filter((name) => !executed.includes(name));
    failure = { step: record.step, problems: record.problems, executed, notExecuted };
    break;
  }
}

/* ---------- 输入身份 after（首败/全部结束后都要收） ---------- */
const identityProblems = [];
let inputIdentityAfter;
let inputIdentityDiff;
try {
  inputIdentityAfter = captureInputIdentity(ROOT);
  writeFileSync(join(OUT, 'input-identity-after.json'), `${JSON.stringify(inputIdentityAfter, null, 2)}\n`);
  inputIdentityDiff = diffInputIdentity(inputIdentityBefore, inputIdentityAfter);
  writeFileSync(join(OUT, 'input-identity-diff.json'), `${JSON.stringify(inputIdentityDiff, null, 2)}\n`);
  if (inputIdentityDiff.headDrift) identityProblems.push(`HEAD 漂移：${inputIdentityDiff.headBefore} -> ${inputIdentityDiff.headAfter}`);
  for (const path of inputIdentityDiff.changed) identityProblems.push(`运行中被修改的输入：${path}`);
  for (const path of inputIdentityDiff.added) identityProblems.push(`运行中新增的输入：${path}`);
  for (const path of inputIdentityDiff.removed) identityProblems.push(`运行中删除的输入：${path}`);
} catch (error) {
  identityProblems.push(`输入身份 after 采集/比较失败：${String(error).slice(0, 300)}`);
  writeFileSync(join(OUT, 'input-identity-diff.json'), `${JSON.stringify({ error: String(error).slice(0, 300), head: head }, null, 2)}\n`);
}

/* ---------- guard 证据（成功/失败/未执行都处理） ---------- */
const executedE2E = records.some((item) => item.step === 'lux3d-e2e');
const guardProblems = [];
const normalizedPath = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const EXPECTED_BACKEND_LOG = normalizedPath(BACKEND_GUARD_LOG);
const EXPECTED_WORKER_LOG = normalizedPath(WORKER_GUARD_LOG);
const readGuardLog = (role, guardFile) => {
  if (!existsSync(guardFile)) return { role, path: relative(ROOT, guardFile).split('\\').join('/'), exists: false, bytes: 0, lines: 0, sha256: null };
  try {
    const bytes = readFileSync(guardFile);
    return { role, path: relative(ROOT, guardFile).split('\\').join('/'), exists: true, bytes: bytes.length, lines: bytes.toString('utf8').split(/\r?\n/).filter(Boolean).length, sha256: sha256(bytes) };
  } catch (error) {
    guardProblems.push(`读取 guard 日志失败（${role}）：${String(error).slice(0, 160)}`);
    return { role, path: relative(ROOT, guardFile).split('\\').join('/'), exists: false, bytes: 0, lines: 0, sha256: null, readError: String(error).slice(0, 160) };
  }
};
const readLoadedProof = (role, proofFile) => {
  if (!existsSync(proofFile)) return { role, path: relative(ROOT, proofFile).split('\\').join('/'), exists: false };
  try {
    const value = JSON.parse(readFileSync(proofFile, 'utf8'));
    return { role, path: relative(ROOT, proofFile).split('\\').join('/'), exists: true, fresh: statSync(proofFile).mtimeMs >= RUN_STARTED - 2000, value };
  } catch (error) {
    guardProblems.push(`读取 guard 加载证据失败（${role}）：${String(error).slice(0, 160)}`);
    return { role, path: relative(ROOT, proofFile).split('\\').join('/'), exists: false, error: String(error).slice(0, 160) };
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
  if (backendLoaded.exists && normalizedPath(backendLoaded.value?.logPath) !== EXPECTED_BACKEND_LOG) guardProblems.push('backend .loaded 的日志路径不是本轮 backend.log');
  if (backendLoaded.exists && normalizedPath(backendLoaded.value?.guardDir) !== normalizedPath(GUARD_DIR)) guardProblems.push('backend .loaded 的 guard 目录不是本轮目录');
  if (backendLoaded.exists && typeof backendLoaded.value?.nodeOptions === 'string' && !backendLoaded.value.nodeOptions.includes('no-real-network.cjs')) guardProblems.push('backend .loaded 的 NODE_OPTIONS 未包含受控 guard preload');
  if (backendLoaded.exists && backendLoaded.fresh !== true) guardProblems.push('backend .loaded 不是本轮生成');
  if (!backendLog.exists) guardProblems.push('backend guard 日志缺失，不得当作“零拦截”');
  if (backendLog.exists && backendLog.lines > 0) guardProblems.push(`backend guard 记录到 ${backendLog.lines} 次外联拦截`);
  const workerLog = readGuardLog('test-worker', WORKER_GUARD_LOG);
  const workerProof = readLoadedProof('legacy-worker', join(GUARD_DIR, 'legacy-worker.loaded.json'));
  const e2eRecord = records.find((item) => item.step === 'lux3d-e2e');
  const legacyRan = (e2eRecord?.report?.specFiles ?? []).some((specFile) => specFile.includes('legacy-work.spec.ts'));
  guardEvidence.roles.push(workerLog, workerProof, { legacyRan });
  if (legacyRan) {
    if (!(workerProof.exists && workerProof.value?.ready === true)) guardProblems.push('legacy worker 未证明 guard 已加载（ready!==true）');
    if (workerProof.exists && workerProof.value?.role !== 'legacy-worker') guardProblems.push('legacy worker 证据的 role 不正确');
    if (workerProof.exists && !(Number.isInteger(workerProof.value?.pid) && workerProof.value.pid > 0)) guardProblems.push('legacy worker 证据缺少有效 PID');
    if (workerProof.exists && normalizedPath(workerProof.value?.logPath) !== EXPECTED_WORKER_LOG) guardProblems.push('legacy worker 证据的日志路径不是本轮 test-worker.log');
    if (workerProof.exists && workerProof.value?.guardLog !== undefined && normalizedPath(workerProof.value?.guardLog) !== EXPECTED_WORKER_LOG) guardProblems.push('legacy worker 实际 guard 捕获的日志不是本轮 test-worker.log');
    if (workerProof.exists && workerProof.fresh !== true) guardProblems.push('legacy worker 加载证据不是本轮生成');
  }
  if (!workerLog.exists) guardProblems.push('test-worker guard 日志缺失，不得当作“零拦截”');
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
  fixtureValidation = { present: true, bytes: bytes.length, sha256: sha256(bytes), generatedAt, source: '.data/pi-lux3d/fixtures/validation.json', reuseNote: 'generatedAt 早于本轮起点则为复用' };
}
const post = {
  at: new Date().toISOString(),
  guard: { verdict: guardEvidence.verdict, problems: guardProblems },
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

const linkedEvidence = [
  { what: '上一轮完整 continuation（history context，不参与本轮门禁/计数）', runId: '2026-11-16T12-50-27-688Z-lux3d-continuation', relative: 'docs/reports/artifacts/Lux3D/focused/2026-11-16T12-50-27-688Z-lux3d-continuation/manifest.json' },
  { what: '4 例定向诊断原始错误响应证据（history context）', runId: '2026-11-16T13-35-23-073Z-lux3d-diagnostic', relative: 'docs/reports/artifacts/Lux3D/focused/2026-11-16T13-35-23-073Z-lux3d-diagnostic/manifest.json' },
].map((item) => {
  const absolute = join(ROOT, item.relative);
  return { ...item, available: existsSync(absolute), sha256: existsSync(absolute) ? sha256(readFileSync(absolute)) : null };
});
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({
  runId: RUN_ID, mode: MODE, head, frozen: FROZEN,
  config: { file: CONFIG, absolutePath: CONFIG_PATH.split('\\').join('/'), sha256: CONFIG_SHA },
  stepPlan: steps.map((item) => item.name), args: ARGS,
  linkedEvidence,
  steps: records, failure, problems, guardEvidence, guardProblems,
  inputIdentity: {
    digestBefore: inputIdentityBefore?.digest ?? null,
    digestAfter: inputIdentityAfter?.digest ?? null,
    headBefore: inputIdentityBefore?.head ?? null,
    headAfter: inputIdentityAfter?.head ?? null,
    diff: inputIdentityDiff ?? null,
    problems: identityProblems,
  },
}, null, 2)}\n`);

const files = [];
const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push(file); } };
walk(OUT);
const SELF = 'sha256-manifest.json';
const payload = files.filter((file) => relative(OUT, file).split('\\').join('/') !== SELF)
  .map((file) => { const bytes = readFileSync(file); return { path: relative(OUT, file).split('\\').join('/'), bytes: bytes.length, sha256: sha256(bytes) }; })
  .sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(join(OUT, SELF), `${JSON.stringify({ at: new Date().toISOString(), runId: RUN_ID, payloadFiles: payload.length, manifestExcluded: SELF, entries: payload }, null, 2)}\n`);
const mismatched = payload.filter((entry) => { const bytes = readFileSync(join(OUT, entry.path)); return bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256; });

console.log(JSON.stringify({
  runDir: relative(ROOT, OUT).split('\\').join('/'),
  head, failed, problems, guard: { verdict: guardEvidence.verdict, problems: guardProblems }, configSha256: CONFIG_SHA,
  inputIdentity: { digestBefore: inputIdentityBefore?.digest ?? null, digestAfter: inputIdentityAfter?.digest ?? null, stable: inputIdentityDiff?.stable ?? null, problems: identityProblems },
  steps: records.map((item) => ({ step: item.step, ok: item.ok, code: item.code, stats: item.report?.stats })),
  payloadFiles: payload.length, shaMismatch: mismatched.length,
  ports: post.ports, templatesClean: post.templatesStatus.length === 0,
}, null, 1));
process.exit(problems.length || failed || guardProblems.length || identityProblems.length ? 1 : 0);
