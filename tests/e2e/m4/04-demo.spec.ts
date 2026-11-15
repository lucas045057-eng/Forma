import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DEMO_RUNS, REPO_ROOT } from './env';
import { wait, waitFor, writeArtifact } from './helpers';

/**
 * M4-D5：演示入口隔离启动（只测 mock）。
 *
 * - 只用 `scripts/demo/mock.mjs`：它不读 .env、不加载 pnpm dev、上游固定 loopback 模拟；
 * - 断言 manifest 的 credentials 全 false、mockServices=true、Studio 真实可访问；
 * - 中断（SIGINT）后只等自有子进程关闭，核对 status 与端口释放；
 * - 硬杀父进程的情形只**观测记录**（不当作通过证据），用于暴露孤儿风险。
 *
 * 绝不启动 real 模式，不发真实阿里/厂商请求，不提交任何付费任务。
 */

const recentRun = (): string | null => {
  if (!existsSync(DEMO_RUNS)) return null;
  const dirs = readdirSync(DEMO_RUNS).map((name) => path.join(DEMO_RUNS, name))
    .filter((dir) => statSync(dir).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
};

const readManifest = (runDir: string) => JSON.parse(readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));

const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = (open: boolean) => { socket.destroy(); resolve(open); };
  socket.setTimeout(800);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
});

test.describe('M4-D5 演示入口（截断在 mock）', () => {
  test('mock 隔离启动 → 凭据全 false → SIGINT 后自有子进程与端口释放', async () => {
    test.setTimeout(300_000);
    const before = recentRun();
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['scripts/demo/mock.mjs'], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    const started = await waitForAsync(() => stdout.includes('Demo mode=mock') || child.exitCode !== null, 180_000, 300);
    void started;
    expect(child.exitCode, `mock 演示启动失败：${stderr.slice(-600)}`).toBeNull();

    const runDir = recentRun();
    expect(runDir, '没有生成新的 demo run 目录').not.toBeNull();
    expect(runDir, '复用了旧的 demo run 目录').not.toBe(before);
    await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')), 30_000, 200);
    const manifest = readManifest(runDir!);
    expect(manifest.mode).toBe('mock');
    expect(manifest.mockServices).toBe(true);
    expect(manifest.credentials, 'mock 模式不应声明任何真实凭据').toEqual({ speech: false, coding: false, lux3d: false });
    expect(manifest.status).toBe('running');

    const studio = `http://127.0.0.1:${manifest.ports.studio}/`;
    const response = await fetch(studio);
    expect(response.status, 'mock Studio 不可访问').toBe(200);

    // 只通知自有父进程退出；等它自己收拾子进程。
    child.kill('SIGINT');
    const closed = await waitForAsync(() => child.exitCode !== null, 90_000, 200);
    void closed;
    expect(child.exitCode, '父进程没有在 90s 内退出').not.toBeNull();
    const finalManifest = readManifest(runDir!);
    const problems = finalManifest.cleanup?.problems ?? [];
    expect(finalManifest.status, `退出后状态不是 stopped/cleanup_failed：${finalManifest.status}`).toContain('stop');
    expect(problems, `清理问题：${JSON.stringify(problems)}`).toEqual([]);
    const ports = Object.values(finalManifest.ports) as number[];
    const stillOpen: number[] = [];
    for (const port of ports) if (await portOpen(port)) stillOpen.push(port);
    expect(stillOpen, `退出后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);

    writeArtifact('demo-mock-lifecycle.json', { runDir: path.relative(REPO_ROOT, runDir!), manifest, finalManifest, stillOpen, stdout: stdout.slice(-1200), stderr: stderr.slice(-1200) });
  });

  test('硬杀父进程：只记录孤儿观测（不当作通过证据）', async () => {
    test.setTimeout(300_000);
    const before = recentRun();
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['scripts/demo/mock.mjs'], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    await waitForAsync(() => stdout.includes('Demo mode=mock') || child.exitCode !== null, 180_000, 300);
    const runDir = recentRun();
    expect(runDir).not.toBeNull();
    expect(runDir).not.toBe(before);
    await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')), 30_000, 200);
    const manifest = readManifest(runDir!);
    const childPids = (manifest.children ?? []).map((item: any) => item.pid);

    // 强杀父进程整棵树（模拟异常终止）
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    await wait(3000);
    const pidsAlive = childPids.filter((pid: number) => {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`], { encoding: 'utf8' });
      return (result.stdout ?? '').includes('alive');
    });
    const ports = Object.values(manifest.ports) as number[];
    const stillOpen: number[] = [];
    for (const port of ports) if (await portOpen(port)) stillOpen.push(port);
    // 硬杀是不可捕获的：这里只记录事实，不用它证明"自主回收"。
    writeArtifact('demo-mock-hard-kill-observation.json', {
      runDir: path.relative(REPO_ROOT, runDir!),
      children: manifest.children, pidsAlive, portsStillListening: stillOpen,
      note: '硬杀父进程不可捕获；本文件只记录观测，不作为清理能力通过证据。',
    });
    // 清理由测试侧显式完成（按 PID 归属），避免遗留进程影响后续步骤。
    for (const pid of pidsAlive) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  });
});

async function waitForAsync(predicate: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await wait(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

