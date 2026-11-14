#!/usr/bin/env node
/**
 * 固定十题真实模型验收 / loopback mock 接线验证的后台顺序入口。
 *
 * 用法：
 *   node tests/e2e/real-model/run.mjs --mode mock --run-id mock-wiring-YYYYMMDD-HHMMSS [--limit N]
 *   node tests/e2e/real-model/run.mjs --mode real --run-id real-YYYYMMDD-HHMMSS
 *
 * - real 模式只检查 apps/server/.env 里三个字段名存在，不读取/打印值；由 spec 读取并只传给后端子进程。
 * - mock 模式启动 loopback agent-mock（4011，假 key），不读 .env、不发真实请求。
 * - 任何模式都要求 3001/5173/5174/5175 在开始前空闲，避免抢并行会话端口。
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const value = (name) => { const inline = args.find((item) => item.startsWith(`${name}=`)); if (inline) return inline.slice(name.length + 1); const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const mode = value('--mode') === 'real' ? 'real' : 'mock';
const runId = value('--run-id') ?? `${mode}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}`;
const limit = value('--limit');
const evidence = path.join(ROOT, 'docs', 'reports', 'artifacts', 'M2-real-model', runId);
mkdirSync(evidence, { recursive: true });
const logFile = path.join(evidence, 'run.log');
const log = (line) => { const text = `[${new Date().toISOString()}] ${line}\n`; writeFileSync(logFile, text, { flag: 'a' }); console.log(text.trimEnd()); };
const writeRun = (value) => writeFileSync(path.join(evidence, 'run.json'), `${JSON.stringify(value, null, 2)}\n`);

function portFree(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.setTimeout(800, () => { socket.destroy(); resolve(true); });
  });
}

async function main() {
  const blocked = [];
  for (const port of [3001, 4011, 5173, 5174, 5175]) {
    if (!(await portFree(port))) blocked.push(port);
  }
  if (mode === 'real') {
    const envFile = path.join(ROOT, 'apps', 'server', '.env');
    if (!existsSync(envFile)) blocked.push('apps/server/.env missing');
    else {
      const names = new Set(readFileSync(envFile, 'utf8').split(/\r?\n/).map((line) => line.trim().split('=')[0]).filter(Boolean));
      for (const name of ['CODING_AGENT_BASE_URL', 'CODING_AGENT_API_KEY', 'CODING_AGENT_MODEL']) if (!names.has(name)) blocked.push(`.env missing ${name}`);
    }
  } else if (!(await portFree(4011))) {
    blocked.push(4011);
  }
  if (blocked.length) {
    writeRun({ mode, runId, status: 'blocked', blocked, finishedAt: new Date().toISOString() });
    log(`BLOCKED: ${JSON.stringify(blocked)}`);
    process.exit(2);
  }

  const startedAt = new Date().toISOString();
  let mock = null;
  if (mode === 'mock') {
    mock = spawn(process.execPath, [path.join(ROOT, 'tests', 'e2e', 'm2a', 'agent-mock.mjs')], {
      cwd: path.join(ROOT, 'apps', 'server'),
      env: { ...process.env, MOCK_PORT: '4011', MOCK_KEY: 'mock-only' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    mock.stdout.on('data', (chunk) => { output += chunk; });
    mock.stderr.on('data', (chunk) => { output += chunk; });
    const ready = Date.now() + 20_000;
    let up = false;
    while (Date.now() < ready) {
      try { const response = await fetch('http://127.0.0.1:4011/__stats'); if (response.ok) { up = true; break; } } catch { /* retry */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!up) {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(mock.pid)], { stdio: 'ignore' });
      writeRun({ mode, runId, status: 'blocked', reason: 'mock agent failed to start', output: output.slice(-2000), finishedAt: new Date().toISOString() });
      log('BLOCKED: mock agent failed to start');
      process.exit(2);
    }
  }

  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright'),
    PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(evidence, 'playwright.json'),
    REAL_MODEL_MODE: mode,
    REAL_MODEL_RUN_DIR: evidence,
  };
  if (limit) env.REAL_MODEL_CASE_LIMIT = limit;
  if (value('--only-results') === '1') env.REAL_MODEL_ONLY_RESULTS = '1';

  log(`starting ${mode} run ${runId}${limit ? ` limit=${limit}` : ''}`);
  const started = Date.now();
  const child = spawn(process.execPath, [
    'node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.realmodel.config.ts',
    '--reporter=list', '--reporter=json', `--output=${path.join(evidence, 'output')}`,
  ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { const text = String(chunk); output += text; writeFileSync(logFile, text, { flag: 'a' }); });
  child.stderr.on('data', (chunk) => { const text = String(chunk); output += text; writeFileSync(logFile, text, { flag: 'a' }); });
  const exit = await new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  if (mock) spawnSync('taskkill', ['/T', '/F', '/PID', String(mock.pid)], { stdio: 'ignore' });

  let stats = null;
  try { stats = JSON.parse(readFileSync(path.join(evidence, 'playwright.json'), 'utf8')).stats ?? null; } catch { /* ignore */ }
  let results = null;
  try { results = JSON.parse(readFileSync(path.join(evidence, 'results.json'), 'utf8')); } catch { /* ignore */ }
  const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })();
  const summary = {
    mode, runId, head, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
    exitCode: exit.code, signal: exit.signal,
    playwright: stats,
    passedCases: results?.passed ?? null,
    totalCases: results?.total ?? null,
    cases: results?.cases ?? null,
    status: results?.status ?? (exit.code === 0 ? 'passed' : 'failed'),
  };
  writeRun(summary);
  log(`finished mode=${mode} exit=${exit.code} cases=${results?.passed ?? '?'}/${results?.total ?? '?'}`);
  process.exit(exit.code ?? 1);
}

main().catch((error) => {
  log(`runner error: ${error instanceof Error ? error.stack : String(error)}`);
  writeRun({ mode, runId, status: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() });
  process.exit(1);
});
