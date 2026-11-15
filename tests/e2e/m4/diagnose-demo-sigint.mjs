#!/usr/bin/env node
/**
 * 有界、隔离的 mock 生命周期 focused 诊断（只授权一次）。
 *
 * 目的：回答"`child.kill('SIGINT')` 到底能不能让 mock 启动器跑它自己的 SIGINT 处理器"，
 * 而不是拿 `signalCode` 或"进程不见了"来冒充"正常 stopped / forced=false"。
 *
 * 做三件事，全部真实记录 spawn/ready/exit(code,signal)/close、PID+创建时间、manifest 前后、端口前后：
 *   A. SIGINT；
 *   B. SIGTERM（对照：如果两种都不产生 stopped，说明 child.kill 在本机就是直接终止，没跑处理器）；
 *   C. 只读核对 A/B 留下的后代是否按 PID+创建时间消失、manifest 最终状态与 cleanup.problems。
 *
 * 边界（会写进报告）：
 * - 这是 Node `ChildProcess.kill()` 的**信号模拟**，**不是**真实 Windows 控制台上的 Ctrl+C；
 * - 启动器禁止 NODE_OPTIONS/execArgv 注入（自己是这么设计的），所以无法在子进程内装 SIGINT 观察器，
 *   只能通过 exit/close + manifest 间接判断处理器是否执行；
 * - 不改生产 launch/runtime、不改测试断言，只写证据。
 *
 * 用法：node tests/e2e/m4/diagnose-demo-sigint.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'docs', 'reports', 'artifacts', 'M4', 'regression', `${new Date().toISOString().replace(/[:.]/g, '-')}-sigint-diagnostic`);
const DEMO_RUNS = join(ROOT, '.data', 'demo-runs');
const sha = (b) => createHash('sha256').update(b).digest('hex');
mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function waitAsync(predicate, timeoutMs, intervalMs = 200) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return false;
}

function processCreated(pid) {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { '' }`], { encoding: 'utf8', timeout: 10000 });
  const text = (result.stdout ?? '').trim();
  return result.status === 0 && text ? text : null;
}

function descendantsOf(pid) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  const raw = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).stdout ?? '[]';
  const parsed = JSON.parse(raw.trim() || '[]');
  const table = Array.isArray(parsed) ? parsed : [parsed];
  const children = new Map();
  for (const item of table) {
    if (!item) continue;
    const list = children.get(item.parent) ?? [];
    list.push(item);
    children.set(item.parent, list);
  }
  const out = [];
  const queue = [{ pid, depth: 0 }];
  const seen = new Set([pid]);
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index].pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const next = { pid: child.pid, created: child.created, depth: queue[index].depth + 1 };
      out.push(next);
      queue.push(next);
    }
  }
  return out.sort((a, b) => b.depth - a.depth);
}

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = (open) => { socket.destroy(); resolve(open); };
  socket.setTimeout(800);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});

const recentRun = () => {
  if (!existsSync(DEMO_RUNS)) return null;
  const dirs = readdirSync(DEMO_RUNS).map((name) => join(DEMO_RUNS, name)).filter((dir) => statSync(dir).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
};

async function scenario(signal) {
  const before = recentRun();
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['scripts/demo/mock.mjs'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { signal, launcherPid: child.pid, launcherCreated: processCreated(child.pid), stdoutTail: '', stderrTail: '', events: [] };
  child.stdout.on('data', (chunk) => { record.stdoutTail = (record.stdoutTail + String(chunk)).slice(-1500); });
  child.stderr.on('data', (chunk) => { record.stderrTail = (record.stderrTail + String(chunk)).slice(-1500); });
  const startedAt = Date.now();
  const up = await waitAsync(() => record.stdoutTail.includes('Demo mode=mock') || child.exitCode !== null, 180_000);
  record.ready = up && child.exitCode === null;
  record.readyMs = Date.now() - startedAt;
  if (!record.ready) { record.error = 'mock demo did not become ready'; return record; }

  const runDir = recentRun();
  record.runDir = runDir ? relative(ROOT, runDir).split('\\').join('/') : null;
  await waitAsync(() => existsSync(join(runDir, 'manifest.json')), 30_000);
  record.manifestBefore = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  record.ports = record.manifestBefore.ports;
  record.descendantsBefore = descendantsOf(child.pid);
  record.portsBefore = { listening: [] };
  for (const port of Object.values(record.ports)) if (await portOpen(port)) record.portsBefore.listening.push(port);

  const sentAt = Date.now();
  const exit = new Promise((resolve) => child.once('exit', (code, sig) => resolve({ code, signal: sig, ms: Date.now() - sentAt })));
  const close = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig, ms: Date.now() - sentAt })));
  child.kill(signal);
  record.exit = await Promise.race([exit, wait(30_000).then(() => 'timeout')]);
  record.close = await Promise.race([close, wait(10_000).then(() => 'timeout')]);

  await wait(3000);
  record.manifestAfter = existsSync(join(runDir, 'manifest.json')) ? JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) : null;
  record.manifestStatusAfter = record.manifestAfter?.status ?? null;
  record.manifestCleanupAfter = record.manifestAfter?.cleanup ?? null;

  record.descendantsAfter = record.descendantsBefore.map((item) => {
    const now = processCreated(item.pid);
    const verdict = now === null ? 'gone' : (Math.abs(Date.parse(now) - Date.parse(item.created)) <= 2000 ? 'alive' : 'reused');
    return { ...item, verdict, now };
  });
  record.portsAfter = { listening: [] };
  for (const port of Object.values(record.ports)) if (await portOpen(port)) record.portsAfter.listening.push(port);
  return record;
}

const results = { at: new Date().toISOString(), note: '有界、隔离、mock 生命周期诊断。SIGINT/SIGTERM 都是 ChildProcess.kill 的**信号模拟**，不是真实 Windows 控制台 Ctrl+C；启动器禁止注入，无法在子进程内装 SIGINT 观察器，只能由 exit/close + manifest 间接判断处理器是否执行。', scenarios: [] };
for (const signal of ['SIGINT', 'SIGTERM']) {
  const record = await scenario(signal);
  results.scenarios.push(record);
  writeFileSync(join(OUT, `scenario-${signal}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

results.summary = results.scenarios.map((record) => ({
  signal: record.signal,
  ready: record.ready ?? false,
  exit: record.exit,
  close: record.close,
  manifestStatusAfter: record.manifestStatusAfter,
  cleanupProblems: record.manifestCleanupAfter?.problems ?? null,
  forcedChildren: (record.manifestCleanupAfter?.children ?? []).filter((item) => item.forced).length,
  portsAfter: record.portsAfter?.listening ?? null,
  descendantsAlive: (record.descendantsAfter ?? []).filter((item) => item.verdict === 'alive').map((item) => item.pid),
  descendantsReused: (record.descendantsAfter ?? []).filter((item) => item.verdict === 'reused').map((item) => item.pid),
}));
writeFileSync(join(OUT, 'diagnostic.json'), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(OUT, 'sha256-manifest.json'), `${JSON.stringify({
  at: new Date().toISOString(),
  payloadFiles: readdirSync(OUT).filter((name) => name !== 'sha256-manifest.json').length,
  manifestExcluded: 'sha256-manifest.json',
  entries: readdirSync(OUT).filter((name) => name !== 'sha256-manifest.json').map((name) => {
    const bytes = readFileSync(join(OUT, name));
    return { path: name, bytes: bytes.length, sha256: sha(bytes) };
  }),
}, null, 2)}\n`);
console.log(JSON.stringify(results.summary, null, 1));
