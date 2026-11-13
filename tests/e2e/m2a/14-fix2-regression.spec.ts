import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { M2A_DATA, WORK_ROOT } from './env';
import { freePort, startChild } from '../m0a/harness';
import { BACKEND_LAUNCHER, SERVER_DIR } from './env';
import { http, restoreTemplate } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * 回合 3：第二轮整改回归（F2/F3/F4）。
 *
 * F1（`src/` 自身是 junction）的本机情况已在回合 2 补测里说明：fs.cpSync 会让 Node 崩（0xC0000409），
 * 换成 copyFileSync 后能起作品副本，但在副本上提交任务会在建候选阶段失败（API 只返回
 * TASK_FAILED，不暴露底层原因），无法走到采用那一步；在主工作树上替换被 Vite 监视的 src 也不可靠。
 * 该路径由实现方 `apps/server/src/work/repo.test.ts` 覆盖，e2e 仍记为“未运行”。
 */

function sendUpgrade(port: number, host: string, pathname: string, origin = 'http://127.0.0.1:5173'): Promise<{ status: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', `Origin: ${origin}`, '', '',
      ].join('\r\n'));
    });
    let status = '';
    let settled = false;
    const done = (closed: boolean) => { if (!settled) { settled = true; socket.destroy(); resolve({ status: status.split('\r\n')[0] ?? '', closed }); } };
    socket.on('data', (chunk) => { status += chunk.toString('latin1'); if (/^HTTP\/1\.[01] 101/.test(status)) done(false); });
    socket.on('close', () => done(true));
    socket.on('error', () => done(true));
    setTimeout(() => done(true), 5000);
  });
}

async function startSandbox(options: { workRoot: string; dataDir: string; port?: number }) {
  const port = options.port ?? (await freePort());
  const child = await startChild({
    command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
    env: {
      PORT: String(port), WORK_ROOT: options.workRoot, WORK_DATA_DIR: options.dataDir,
      ASSETS_DIR: path.join(options.dataDir, '..', 'assets'), SCENE_HISTORY_DIR: path.join(options.dataDir, '..', 'scene'),
      LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'unused', PREVIEW_ORIGIN_PORT: '0',
    },
    readyUrl: `http://127.0.0.1:${port}/health`, label: 'round3-sandbox',
  });
  return { ...child, port, base: `http://127.0.0.1:${port}` };
}

test.describe('第二轮整改回归', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('F2：预览源只接受本机 Host，外来 Host 的 GET/HEAD 403、WebSocket 升级被断开', async () => {
    const { rawRequest } = await import('../m1b/api');
    const evil = await rawRequest({ host: 'evil.example:5175', pathname: '/preview/main/', port: 5175 });
    const wrongPort = await rawRequest({ host: '127.0.0.1:5999', pathname: '/preview/main/', port: 5175 });
    const lookalike = await rawRequest({ host: 'localhost.evil.example:5175', pathname: '/preview/main/', port: 5175 });
    const good = await rawRequest({ host: '127.0.0.1:5175', pathname: '/preview/main/', port: 5175 });
    const evilWs = await sendUpgrade(5175, 'evil.example:5175', '/preview/main/hmr');
    const wrongOriginWs = await sendUpgrade(5175, '127.0.0.1:5175', '/preview/main/hmr', 'https://evil.example');

    writeArtifactFrom('round3-f2-preview-host.json', {
      evil: evil.status, wrongPort: wrongPort.status, lookalike: lookalike.status, good: good.status,
      evilWs, wrongOriginWs,
    });

    expect(evil.status, '外来 Host 应 403').toBe(403);
    expect(wrongPort.status, '端口不匹配应 403').toBe(403);
    expect(lookalike.status, '相似域名应 403').toBe(403);
    expect(good.status).toBe(200);
    expect(evilWs.closed, '外来 Host 的 WS 升级应被断开').toBe(true);
    expect(/101/.test(evilWs.status)).toBe(false);
    expect(/101/.test(wrongOriginWs.status), '外来 Origin 的 WS 升级应被断开').toBe(false);
  });

  test('F3：版本库里已跟踪 src/deploy.pem 时，后端启动即失败 UNSAFE_TRACKED_FILE', async () => {
    const root = path.join(M2A_DATA, 'f3');
    const work = path.join(root, 'work');
    const dataDir = path.join(root, 'data');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    for (const entry of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
      writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
    }
    for (const entry of ['src/App.tsx', 'src/main.tsx', 'src/components/Button.tsx']) {
      mkdirSync(path.join(work, path.dirname(entry)), { recursive: true });
      writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
    }
    mkdirSync(path.join(work, 'public'), { recursive: true });

    const first = await startSandbox({ workRoot: work, dataDir });
    await http(`${first.base}/version`);
    await first.stop();

    const gitDir = path.join(dataDir, 'work.git');
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', [`--git-dir=${gitDir}`, `--work-tree=${work}`, ...args], { encoding: 'utf8' });
    writeFileSync(path.join(work, 'src', 'deploy.pem'), 'SENTINEL-PEM', 'utf8');
    git('add', '-f', 'src/deploy.pem');
    git('-c', 'user.email=pi@test', '-c', 'user.name=pi', 'commit', '-q', '-m', 'seed tracked pem');

    const port = await freePort();
    const failed = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(process.execPath, [BACKEND_LAUNCHER], {
        cwd: SERVER_DIR,
        env: {
          ...process.env, PORT: String(port), WORK_ROOT: work, WORK_DATA_DIR: dataDir,
          ASSETS_DIR: path.join(root, 'assets'), SCENE_HISTORY_DIR: path.join(root, 'scene'),
          LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'unused', PREVIEW_ORIGIN_PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('exit', (code) => resolve({ code, output }));
      setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
    });

    writeArtifactFrom('round3-f3-audit.json', { exitCode: failed.code, mentionsTrackedFile: failed.output.includes('UNSAFE_TRACKED_FILE') });
    expect(failed.code, '启动应当失败').not.toBe(0);
    expect(failed.output).toContain('UNSAFE_TRACKED_FILE');
    rmSync(root, { recursive: true, force: true });
  });

  test('F4：同一 work-data 目录的第二个后端 INSTANCE_LOCKED 且不碰事件日志；重启 seq 接续', async () => {
    const root = path.join(M2A_DATA, 'f4');
    const work = path.join(root, 'work');
    const dataDir = path.join(root, 'data');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    for (const entry of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
      writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
    }
    for (const entry of ['src/App.tsx', 'src/main.tsx', 'src/components/Button.tsx']) {
      mkdirSync(path.join(work, path.dirname(entry)), { recursive: true });
      writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
    }
    mkdirSync(path.join(work, 'public'), { recursive: true });
    writeFileSync(path.join(work, 'src', 'scene.config.json'), readFileSync(path.join(WORK_ROOT, 'src', 'scene.config.json')));

    const first = await startSandbox({ workRoot: work, dataDir });
    let restarted: Awaited<ReturnType<typeof startSandbox>> | null = null;
    try {
      const scene = (await http(`${first.base}/scene`)).body;
      await http(`${first.base}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...scene, hero: { ...scene.hero, camera: { ...scene.hero.camera, fov: 38 } } }) });
      const logFile = path.join(dataDir, 'events.jsonl');
      const before = readFileSync(logFile, 'utf8');

      let locked = false;
      try { await startSandbox({ workRoot: work, dataDir }); } catch (error) {
        expect(String(error), `第二个实例应 INSTANCE_LOCKED：${String(error)}`).toContain('INSTANCE_LOCKED');
        locked = true;
      }
      expect(locked, '第二个实例没有失败').toBe(true);
      expect(readFileSync(logFile, 'utf8'), '第二个实例改动了事件日志').toBe(before);

      const beforeSeq = (await http(`${first.base}/events/history?since=0`)).body as { current: number };
      await first.stop();
      restarted = await startSandbox({ workRoot: work, dataDir });
      const afterSeq = (await http(`${restarted.base}/events/history?since=0`)).body as { current: number };
      expect(afterSeq.current, '重启后 seq 归零了').toBeGreaterThanOrEqual(beforeSeq.current);

      writeArtifactFrom('round3-f4-instance-lock.json', { beforeSeq: beforeSeq.current, afterRestart: afterSeq.current, logUnchanged: true, locked });
    } finally {
      await restarted?.stop();
      await first.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
});
