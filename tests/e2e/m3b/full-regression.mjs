#!/usr/bin/env node
/**
 * M3-B 验收前的完整回归顺序入口（本分支只准备，不正式启动）。
 *
 *   node tests/e2e/m3b/full-regression.mjs --collect     # 只做收集验证（--list），不跑任何用例
 *   node tests/e2e/m3b/full-regression.mjs               # 真正按顺序跑完整回归（首败即停）
 *
 * 顺序：pnpm typecheck → pnpm build → pnpm test（全量单测）→ 旧七套 E2E → M3-B。
 * 约束：0 retry、禁止 --only/--grep 过滤、每步新证据目录、逐步记录 HEAD/工作区/产品摘要/PID/时间/退出码/原始日志。
 * 长任务必须由 orbital/bin/bg.cmd 在沙箱外启动；脚本自己不做轮询或重试。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MODE = process.argv.includes('--collect') ? 'collect' : 'full';
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`;
const OUT = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M3-B', 'full-regression', RUN_ID);

const E2E_SUITES = [
  { name: 'm0b', args: ['playwright', 'test'], env: {} },
  { name: 'm0a', args: ['playwright', 'test', '-c', 'playwright.m0a.config.ts'], env: {} },
  { name: 'm1a', args: ['playwright', 'test', '-c', 'playwright.m1a.config.ts'], env: {} },
  { name: 'm1b', args: ['playwright', 'test', '-c', 'playwright.m1b.config.ts'], env: {} },
  { name: 'm2a', args: ['playwright', 'test', '-c', 'playwright.m2a.config.ts'], env: {} },
  { name: 'm2b', args: ['playwright', 'test', '-c', 'playwright.m2b.config.ts'], env: {} },
  { name: 'm3a', args: ['playwright', 'test', '-c', 'playwright.m3a.config.ts'], env: {} },
  { name: 'm3b', args: ['playwright', 'test', '-c', 'playwright.m3b.config.ts'], env: {} },
];

const STEPS = [
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'], env: {}, e2e: false },
  { name: 'build', command: 'pnpm', args: ['build'], env: {}, e2e: false },
  { name: 'unit', command: 'pnpm', args: ['test'], env: {}, e2e: false },
  ...E2E_SUITES.map((suite) => ({
    name: `${MODE === 'collect' ? 'collect' : 'e2e'}-${suite.name}`,
    command: 'npx',
    args: MODE === 'collect' ? [...suite.args, '--list'] : [...suite.args, '--retries=0', '--workers=1'],
    env: suite.env,
    e2e: true,
  })),
];

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function productDigest() {
  // 已跟踪的产品/配置/锁文件状态摘要：内容变更会改变这份摘要（不看时间戳）。
  const listed = spawnSync('git', ['ls-files', '-s', 'apps', 'packages', 'templates', 'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const staged = git(['diff', '--cached', '--stat']);
  const dirty = git(['status', '--porcelain', '--', 'apps', 'packages', 'templates', 'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml']);
  return {
    indexDigest: createHash('sha256').update(listed.stdout ?? '').digest('hex'),
    staged: staged.out,
    dirty: dirty.out,
  };
}

function snapshotState() {
  return {
    at: new Date().toISOString(),
    head: git(['rev-parse', 'HEAD']).out,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']).out,
    status: git(['status', '--porcelain']).out,
    product: productDigest(),
    lockFile: git(['hash-object', 'pnpm-lock.yaml']).out,
  };
}

function runStep(step) {
  return new Promise((resolve) => {
    const logFile = path.join(OUT, `${step.name}.log`);
    const stream = createWriteStream(logFile, { flags: 'a' });
    const before = snapshotState();
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    // 每个套件必须把 reporter JSON 与实际 outputDir 重定向到本次 run 目录：
    // 否则会覆写仓库里已归档的 tracked 证据（默认 M0-B/M2-A/M2-B 等）。
    const args = step.e2e ? [...step.args, `--output=${path.join(OUT, `${step.name}-output`)}`] : step.args;
    const env = {
      ...process.env,
      ...step.env,
      ...(step.e2e ? { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(OUT, `${step.name}-results.json`) } : {}),
    };
    const child = spawn(step.command, args, { cwd: ROOT, env, shell: process.platform === 'win32', windowsHide: true });
    stream.write(`# ${step.name}: ${step.command} ${args.join(' ')}\n# pid=${child.pid} started=${startedAt}\n`);
    child.stdout.on('data', (chunk) => stream.write(chunk));
    child.stderr.on('data', (chunk) => stream.write(chunk));
    child.on('error', (error) => stream.write(`# spawn error: ${String(error)}\n`));
    child.on('exit', (code, signal) => {
      const finishedAt = new Date().toISOString();
      stream.end(`\n# exit=${code} signal=${signal} finished=${finishedAt} durationMs=${Date.now() - startedMs}\n`);
      const after = snapshotState();
      resolve({
        step: step.name, command: `${step.command} ${args.join(' ')}`, pid: child.pid,
        startedAt, finishedAt, durationMs: Date.now() - startedMs, code, signal,
        log: path.relative(ROOT, logFile),
        before, after, identityStable: before.head === after.head && before.product.indexDigest === after.product.indexDigest,
      });
    });
  });
}

mkdirSync(OUT, { recursive: true });
const manifest = { runId: RUN_ID, mode: MODE, startedAt: new Date().toISOString(), cwd: ROOT, node: process.version, pid: process.pid, steps: [] };
writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[full-regression] mode=${MODE} out=${OUT}`);
for (const step of STEPS) {
  console.log(`[full-regression] ${step.name} …`);
  const record = await runStep(step);
  manifest.steps.push(record);
  writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  appendFileSync(path.join(OUT, 'manifest.log'), `${record.step} exit=${record.code} durationMs=${record.durationMs} pid=${record.pid}\n`);
  if (record.code !== 0) {
    console.error(`[full-regression] ${record.step} 失败（exit=${record.code}），按规则停止后续步骤；证据见 ${record.log}`);
    process.exit(1);
  }
}
console.log(`[full-regression] 全部 ${STEPS.length} 步通过；manifest=${path.relative(ROOT, path.join(OUT, 'manifest.json'))}`);
