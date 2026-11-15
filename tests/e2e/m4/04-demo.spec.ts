import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEMO_RUNS, REPO_ROOT } from './env';
import { wait, waitFor, writeArtifact } from './helpers';

/**
 * M4-D5：演示入口（只测 mock，绝不启动 real、不接阿里/厂商）。
 *
 * 覆盖：
 * 1. Sigint 正常关闭：manifest status=stopped、cleanup.perfect、forced 全 false、端口释放；
 * 2. 真实候选链路：mock 编码上游 → 生成候选 → 候选预览实际连到 plan.preview 的 HMR，
 *    10 秒内不出现循环导航（旧缺陷是连错 5175 导致无限刷新）；
 * 3. 固定 5175 被占用时不串实例：demo 用自己的随机端口照常工作；
 * 4. 父启动器被**硬杀**：真实 backend/frontends 及其孙进程（候选预览 Vite 等）按 PID+创建时间
 *    在有限时间内回收，且留下 orphan-cleanup 证据（不再只做观测就判过）。
 */

interface DemoHandle {
  child: ReturnType<typeof spawn>;
  runDir: string;
  plan: any;
  manifest: any;
  stdout: string;
  stderr: string;
}

/** 测试专用 driver：普通文件入口 import 产品 launch，用进程内 SIGINT 事件模拟 graceful 关闭。 */
const DRIVER = path.join(REPO_ROOT, 'tests', 'e2e', 'm4', 'support', 'demo-launch-driver.mjs');

/** 把阶段性证据追加进 record（主错/清理/证据分开保留）。 */
function progress(record: Record<string, unknown>, patch: Record<string, unknown>) {
  Object.assign(record, patch);
}

const recentRun = (): string | null => {
  if (!existsSync(DEMO_RUNS)) return null;
  const dirs = readdirSync(DEMO_RUNS).map((name) => path.join(DEMO_RUNS, name))
    .filter((dir) => statSync(dir).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
};

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = (open: boolean) => { socket.destroy(); resolve(open); };
  socket.setTimeout(800);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});

async function waitAsync(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  return false;
}

function processTable(): Array<{ pid: number; parent: number; created: string }> {
  const script = "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  const raw = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).stdout ?? '[]';
  const value = JSON.parse(raw.trim() || '[]');
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function descendantsOf(pid: number): Array<{ pid: number; created: string; depth: number }> {
  const table = processTable();
  const children = new Map<number, Array<{ pid: number; parent: number; created: string }>>();
  for (const item of table) {
    const list = children.get(item.parent) ?? [];
    list.push(item);
    children.set(item.parent, list);
  }
  const out: Array<{ pid: number; created: string; depth: number }> = [];
  const queue: Array<{ pid: number; created: string; depth: number }> = [{ pid, created: table.find((item) => item.pid === pid)?.created ?? new Date(0).toISOString(), depth: 0 }];
  const seen = new Set<number>([pid]);
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const child of children.get(current.pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      const next = { pid: child.pid, created: child.created, depth: current.depth + 1 };
      out.push(next);
      queue.push(next);
    }
  }
  return out.sort((a, b) => b.depth - a.depth);
}

/**
 * 进程快照：一次 CIM 查询拿到全表，避免"每个 PID 同步起一次 PowerShell"把测试 worker 阻塞，
 * 也让"存在性"和"创建时间"来自同一次观测。查询失败/超时 = null（调用方必须当成 unknown，绝不能当 gone）。
 */
function snapshotProcesses(): Map<number, string> | null {
  const script = "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  const text = (result.stdout ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map<number, string>();
    for (const row of rows) {
      if (!row || !Number.isInteger(row.pid) || typeof row.created !== 'string') continue;
      map.set(row.pid, row.created);
    }
    return map.size ? map : null;
  } catch { return null; }
}

/**
 * 判定"是否仍是本次受测的进程"：
 * - 快照失败 → unknown（不算 gone）；
 * - 快照里没有 → gone；
 * - 记录或观测到的创建时间无效（NaN / ≤0 / epoch 0）→ unknown，不参与 alive/reused 判定；
 * - 创建时间一致（≤2s 窗口）→ alive，否则 reused（PID 被复用）。
 */
function stillOwn(pid: number, created: string, snapshot: Map<number, string> | null): 'gone' | 'alive' | 'reused' | 'unknown' {
  const recorded = Date.parse(created);
  if (!Number.isFinite(recorded) || recorded <= 0) return 'unknown';
  if (snapshot === null) return 'unknown';
  const observedRaw = snapshot.get(pid);
  if (observedRaw === undefined) return 'gone';
  const observed = Date.parse(observedRaw);
  if (!Number.isFinite(observed) || observed <= 0) return 'unknown';
  return Math.abs(observed - recorded) <= 2000 ? 'alive' : 'reused';
}

async function startMockDemo(): Promise<DemoHandle> {
  const before = recentRun();
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, ['scripts/demo/mock.mjs'], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle: DemoHandle = { child, runDir: '', plan: null, manifest: null, stdout: '', stderr: '' };
  child.stdout!.on('data', (chunk) => { handle.stdout += String(chunk); });
  child.stderr!.on('data', (chunk) => { handle.stderr += String(chunk); });
  const started = await waitAsync(() => handle.stdout.includes('Demo mode=mock') || child.exitCode !== null, 180_000);
  expect(started && child.exitCode === null, `mock 演示启动失败：${handle.stderr.slice(-800)}`).toBe(true);
  const runDir = recentRun();
  expect(runDir, '没有生成新的 demo run 目录').not.toBeNull();
  expect(runDir, '复用了旧 demo run 目录').not.toBe(before);
  handle.runDir = runDir!;
  await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status === 'running', 60_000, 200);
  handle.plan = readJson(path.join(runDir!, 'plan.json'));
  handle.manifest = readJson(path.join(runDir!, 'manifest.json'));
  return handle;
}

async function stopHandle(handle: DemoHandle): Promise<void> {
  if (handle.child.exitCode !== null) return;
  handle.child.kill('SIGINT');
  await waitAsync(() => handle.child.exitCode !== null, 90_000);
}

test.describe('M4-D5 演示入口（mock）', () => {
  test.describe.configure({ mode: 'serial' });

  test('进程内 SIGINT 处理模拟：launch 自身的 graceful 收尾（非真实控制台 Ctrl+C）', async () => {
    test.setTimeout(420_000);
    const record: Record<string, unknown> = { boundary: 'in-process SIGINT emit simulation, NOT real Windows console Ctrl+C' };
    let child: ReturnType<typeof spawn> | null = null;
    let primary: unknown = undefined;
    const cleanupErrors: string[] = [];
    try {
      const before = recentRun();
      const env: Record<string, string> = { ...process.env } as Record<string, string>;
      delete env.NODE_OPTIONS;
      // 普通文件入口 + IPC：不注入 NODE_OPTIONS/execArgv，launch 用的仍是产品实现（无替身 options）。
      child = spawn(process.execPath, [DRIVER], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      record.driverPid = child.pid;
      const ready = await waitAsync(() => stdout.includes('Demo mode=mock') || child!.exitCode !== null, 180_000);
      expect(ready && child.exitCode === null, `driver 未能就绪：${stderr.slice(-600)}`).toBe(true);

      const runDir = recentRun();
      expect(runDir, '没有生成新的 demo run 目录').not.toBe(before);
      expect(runDir).not.toBeNull();
      await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status === 'running', 60_000, 200);
      const plan = readJson(path.join(runDir!, 'plan.json'));
      const manifestBefore = readJson(path.join(runDir!, 'manifest.json'));
      expect(manifestBefore.credentials, 'mock 不应声明任何真实凭据').toEqual({ speech: false, coding: false, lux3d: false });
      const tracked = descendantsOf(child.pid!);
      const ports = Object.values(plan.ports) as number[];
      const portsOpenBefore: number[] = [];
      for (const port of ports) if (await portOpen(port)) portsOpenBefore.push(port);
      progress(record, { runDir: path.relative(REPO_ROOT, runDir!), plan, manifestBefore, tracked: tracked.length, portsOpenBefore });

      // 只发出进程内 SIGINT 事件；launch 自己的 once('SIGINT') 处理器负责 graceful shutdown。
      const sentAt = Date.now();
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) => {
        child!.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - sentAt }));
      });
      const closed = new Promise<number>((resolve) => {
        child!.once('close', () => resolve(Date.now() - sentAt));
      });
      child.send({ type: 'sigint' });

      const exitInfo = await Promise.race([exited, wait(120_000).then(() => 'timeout' as const)]);
      const closeMs = await Promise.race([closed, wait(30_000).then(() => 'timeout' as const)]);
      record.exit = exitInfo;
      record.closeMs = closeMs;

      // 关键判据：不是"进程没了"，而是 manifest 真的由 launch 写成 stopped 且没有 forced。
      await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status !== 'running', 120_000, 300);
      const finalManifest = readJson(path.join(runDir!, 'manifest.json'));
      expect(finalManifest.status, `退出后状态不是 stopped：${finalManifest.status}`).toBe('stopped');
      expect(finalManifest.cleanup?.problems ?? [], '正常 SIGINT 不应该有清理问题').toEqual([]);
      const forced = (finalManifest.cleanup?.children ?? []).filter((item: any) => item.forced);
      expect(forced, `正常 SIGINT 出现 forced 回收：${JSON.stringify(forced)}`).toEqual([]);

      const stillOpen: number[] = [];
      for (const port of ports) if (await portOpen(port)) stillOpen.push(port);
      expect(stillOpen, `graceful 收尾后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);

      const sigintSnapshot = snapshotProcesses();
      expect(sigintSnapshot, '进程快照查询失败，不能据此判定后代已退出').not.toBeNull();
      const verdicts = tracked.map((item) => ({ pid: item.pid, created: item.created, verdict: stillOwn(item.pid, item.created, sigintSnapshot) }));
      expect(verdicts.filter((item) => item.verdict === 'alive'), `仍有受测后代存活：${JSON.stringify(verdicts.filter((item) => item.verdict === 'alive'))}`).toEqual([]);
      expect(verdicts.filter((item) => item.verdict === 'unknown'), `进程查询未知，不能判定已退出：${JSON.stringify(verdicts.filter((item) => item.verdict === 'unknown'))}`).toEqual([]);
      progress(record, { finalManifest, stillOpen, verdicts });
    } catch (error) {
      primary = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error;
    } finally {
      // 主错误、清理错误、证据写入分别保留，互不覆盖。
      if (child && child.exitCode === null) {
        try { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch (error) { cleanupErrors.push(String(error)); }
      }
    }
    writeArtifact('demo-sigint-in-process.json', { ...record, primary, cleanupErrors });
    if (primary) throw new Error(`进程内 SIGINT 模拟失败：${JSON.stringify(primary).slice(0, 600)}`);
    expect(cleanupErrors, `收尾清理错误：${JSON.stringify(cleanupErrors)}`).toEqual([]);
  });

  test('真实候选链路：候选 HMR 连 plan.preview，10s 内无循环导航', async () => {
    test.setTimeout(420_000);
    const handle = await startMockDemo();
    const { ports } = handle.plan;
    const api = `http://127.0.0.1:${ports.api}`;
    const version = (await (await fetch(`${api}/version`)).json()).version;
    // 用 mock 编码上游支持的固定示例（购买区下移），直接走真实任务/候选链路。
    const submitted = await fetch(`${api}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: '把购买区向下移动一点', selection: { src: 'src/App.tsx:30:11', baseVersion: version, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' }, instances: 1, ancestors: [] } }),
    });
    expect(submitted.status, `提交任务失败：${submitted.status}`).toBe(202);
    const task = await (await submitted.json() as any);
    const done = await waitFor(async () => {
      const current = await (await fetch(`${api}/tasks/${task.id}`)).json() as any;
      return current.status === 'done' ? current : false;
    }, 180_000, 500);
    void done;
    const taskFinal = await (await fetch(`${api}/tasks/${task.id}`)).json() as any;
    expect(taskFinal.status).toBe('done');
    const candidateId = taskFinal.candidateId;
    expect(candidateId).toBeTruthy();

    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      const sockets: string[] = [];
      const navigations: string[] = [];
      page.on('websocket', (socket) => sockets.push(socket.url()));
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
      const candidateUrl = `http://127.0.0.1:${ports.preview}/preview/c/${candidateId}/`;
      await page.goto(candidateUrl);
      await page.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 90_000 });
      const baselineNavigations = navigations.length;
      await wait(10_000);
      const extraNavigations = navigations.length - baselineNavigations;
      const hmr = sockets.filter((url) => url.includes(`:${ports.preview}/`));
      expect(extraNavigations, `候选预览 10 秒内发生 ${extraNavigations} 次导航（疑似连错端口循环刷新）；sockets=${JSON.stringify(sockets)}`).toBeLessThanOrEqual(1);
      expect(hmr.length, `候选 HMR 没有连到 plan.preview(${ports.preview})：${JSON.stringify(sockets)}`).toBeGreaterThan(0);
      writeArtifact('demo-candidate-hmr.json', { ports, candidateId, sockets, navigations, extraNavigations, candidateUrl });
    } finally {
      await browser.close();
    }
    await stopHandle(handle);
  });

  test('固定 5175 被占用时不串实例（demo 用自己的随机预览端口）', async () => {
    test.setTimeout(300_000);
    const occupy = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { occupy.once('error', reject); occupy.listen(5175, '127.0.0.1', resolve); });
    try {
      const handle = await startMockDemo();
      expect(handle.plan.ports.preview, 'demo 预览端口不能等于被占用的 5175').not.toBe(5175);
      expect((await fetch(`http://127.0.0.1:${handle.plan.ports.studio}/`)).status).toBe(200);
      const backend = await fetch(`http://127.0.0.1:${handle.plan.ports.api}/health`);
      expect(backend.status).toBe(200);
      writeArtifact('demo-port-5175-occupied.json', { plan: handle.plan, occupied: 5175 });
      await stopHandle(handle);
    } finally {
      await new Promise<void>((resolve) => occupy.close(() => resolve()));
    }
  });

  test('父启动器被硬杀：真实 backend/frontends 及孙进程按 PID+创建时间回收，并留失败证据', async () => {
    test.setTimeout(480_000);
    const handle = await startMockDemo();
    const { ports } = handle.plan;
    // 让真实后端产生候选，从而派生候选预览 Vite（孙进程）。
    const version = (await (await fetch(`http://127.0.0.1:${ports.api}/version`)).json()).version;
    await fetch(`http://127.0.0.1:${ports.api}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: '把购买区向下移动一点', selection: { src: 'src/App.tsx:30:11', baseVersion: version, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' }, instances: 1, ancestors: [] } }),
    });
    await waitFor(async () => {
      const list = await (await fetch(`http://127.0.0.1:${ports.api}/candidates`)).json() as any[];
      return Array.isArray(list) && list.length > 0;
    }, 180_000, 500);

    const owned = descendantsOf(handle.child.pid!);
    const tracked = [{ pid: handle.child.pid!, created: new Date(0).toISOString(), depth: 0 }, ...owned];
    expect(owned.length, '硬杀前没有找到任何孙进程').toBeGreaterThan(0);

    // 只杀启动器本身（不 /T），把回收责任交给子进程的 IPC 断开处理。
    spawnSync('taskkill', ['/F', '/PID', String(handle.child.pid)], { stdio: 'ignore' });
    await wait(2000);

    const deadline = Date.now() + 90_000;
    let remaining: Array<{ pid: number; created: string; depth: number }> = [];
    let reused: number[] = [];
    let unknown: Array<{ pid: number; verdict: string }> = [];
    while (Date.now() < deadline) {
      const snapshot = snapshotProcesses();
      const verdicts = tracked.map((item) => ({ item, verdict: snapshot === null ? 'unknown' as const : stillOwn(item.pid, item.created, snapshot) }));
      remaining = verdicts.filter((entry) => entry.verdict === 'alive').map((entry) => entry.item);
      reused = verdicts.filter((entry) => entry.verdict === 'reused').map((entry) => entry.item.pid);
      unknown = verdicts.filter((entry) => entry.verdict === 'unknown').map((entry) => ({ pid: entry.item.pid, verdict: entry.verdict }));
      if (remaining.length === 0 && unknown.length === 0) break;
      await wait(1000);
    }
    expect(remaining.map((item) => item.pid), `硬杀后仍有自有后代存活（PID）：${JSON.stringify(remaining)}`).toEqual([]);
    // 查询未知同样不能当作"已退出"：单独失败，要求重跑或人工确认。
    expect(unknown, `进程查询未知，不能据此判定回收：${JSON.stringify(unknown)}`).toEqual([]);

    const orphanFiles = readdirSync(handle.runDir).filter((name) => name.startsWith('orphan-cleanup-'));
    const stillOpen: number[] = [];
    for (const port of Object.values(ports) as number[]) if (await portOpen(port)) stillOpen.push(port);
    writeArtifact('demo-hard-kill-reclaim.json', {
      launcherPid: handle.child.pid, tracked, remaining, reused, unknown, orphanFiles, portsStillListening: stillOpen,
      note: '硬杀父启动器后，这里只断言"本次受测的 PID（以创建时间核对）全部消失"；它不能证明是 IPC 断开处理器或 watchdog 执行的回收——在 Windows 上无 detached 的子进程可能由系统直接终止（推断，未泛化证实）。watchdog 的因果证据只来自 fixture 角色主动断开 IPC + close 挂起那条分支。',
    });
    expect(stillOpen, `硬杀回收后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);
  });
});
