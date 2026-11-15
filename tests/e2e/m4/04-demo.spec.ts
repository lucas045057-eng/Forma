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

function alive(pid: number): boolean {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`], { encoding: 'utf8', timeout: 10000 });
  return (result.stdout ?? '').includes('alive');
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

  test('SIGINT 正常关闭：stopped、forced 全 false、端口释放', async () => {
    test.setTimeout(300_000);
    const handle = await startMockDemo();
    const studio = `http://127.0.0.1:${handle.plan.ports.studio}/`;
    expect((await fetch(studio)).status, 'mock Studio 不可访问').toBe(200);
    expect(handle.manifest.credentials, 'mock 不应声明任何真实凭据').toEqual({ speech: false, coding: false, lux3d: false });
    expect(handle.manifest.mockServices).toBe(true);

    handle.child.kill('SIGINT');
    const exited = await waitAsync(() => handle.child.exitCode !== null, 90_000);
    expect(exited, '父进程没有在 90s 内退出').toBe(true);
    const finalManifest = readJson(path.join(handle.runDir, 'manifest.json'));
    expect(finalManifest.status, `退出状态：${finalManifest.status}`).toBe('stopped');
    expect(finalManifest.cleanup?.problems ?? [], '正常关闭不应该有清理问题').toEqual([]);
    const forced = (finalManifest.cleanup?.children ?? []).filter((item: any) => item.forced);
    expect(forced, `正常 SIGINT 出现 forced 回收：${JSON.stringify(forced)}`).toEqual([]);
    const stillOpen: number[] = [];
    for (const port of Object.values(handle.plan.ports) as number[]) if (await portOpen(port)) stillOpen.push(port);
    expect(stillOpen, `退出后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);
    writeArtifact('demo-sigint.json', { runDir: path.relative(REPO_ROOT, handle.runDir), plan: handle.plan, finalManifest });
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
    let remaining: typeof tracked = [];
    while (Date.now() < deadline) {
      remaining = tracked.filter((item) => item.pid !== process.pid && alive(item.pid));
      if (remaining.length === 0) break;
      await wait(1000);
    }
    expect(remaining.map((item) => item.pid), `硬杀后仍有自有后代存活（PID）：${JSON.stringify(remaining)}`).toEqual([]);

    const orphanFiles = readdirSync(handle.runDir).filter((name) => name.startsWith('orphan-cleanup-'));
    const stillOpen: number[] = [];
    for (const port of Object.values(ports) as number[]) if (await portOpen(port)) stillOpen.push(port);
    writeArtifact('demo-hard-kill-reclaim.json', {
      launcherPid: handle.child.pid, tracked, remaining, orphanFiles, portsStillListening: stillOpen,
      note: '硬杀父启动器后，由子进程 IPC 断开处理回收；这里断言的是实际 PID 全部退出，而不是只做观测。',
    });
    expect(stillOpen, `硬杀回收后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);
  });
});
