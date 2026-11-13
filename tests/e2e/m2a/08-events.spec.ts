import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { M2A_DATA, SCENE_HISTORY, SERVER_DIR, TEMPLATE_DIR } from './env';
import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, MOCK_BASE, MOCK_KEY, MOCK_MODEL } from './env';
import { collectEvents, getScene, history, putScene, resetMock, restoreTemplate, waitFor } from './api';
import { freePort, startChild } from '../m0a/harness';
import { writeArtifactFrom } from './artifact';

/**
 * 事件补拉：
 * 1) 断开 WS → 期间产生事件 → `/events/history?since=` 能补齐（序号连续、current 正确）；
 * 2) 后端重启后 seq 接续，不归零（用独立数据目录的沙箱后端验证，不动主后端）。
 */

test.describe('事件与补拉', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('断开 WS 后的事件可以通过 since 补齐', async () => {
    await resetMock();
    const socket = await collectEvents();
    try {
      await waitFor(() => socket.events.some((event) => event.type === 'ready'), 15_000, 100);
      const start = socket.events.find((event) => event.type === 'ready')!.seq as number;
      socket.close();
      // 断线期间制造两个事件
      const config = (await getScene()).body;
      const one = structuredClone(config);
      one.hero.camera.fov = Math.min(60, config.hero.camera.fov + 3);
      expect((await putScene(one)).status).toBe(200);
      const two = structuredClone(config);
      two.hero.camera.fov = Math.min(60, config.hero.camera.fov + 5);
      expect((await putScene(two)).status).toBe(200);

      const replay = (await history(start)).body;
      const seqs = replay.events.map((event) => event.seq);
      expect(seqs.length, '补拉拿不到断线期间的事件').toBeGreaterThanOrEqual(2);
      expect(seqs.every((seq) => seq > start)).toBe(true);
      for (let index = 1; index < seqs.length; index += 1) expect(seqs[index]).toBe(seqs[index - 1] + 1);
      expect(replay.current).toBe(seqs.at(-1));
      expect(replay.events.some((event) => event.type === 'scene.changed')).toBe(true);
      expect(replay.truncated).toBe(false);

      writeArtifactFrom('events-replay.json', { start, seqs, current: replay.current, oldest: replay.oldest, truncated: replay.truncated });
    } finally {
      socket.close();
    }
  });

  test('后端重启后 seq 接续（独立沙箱数据目录）', async () => {
    const root = path.join(M2A_DATA, 'events-restart');
    rmSync(root, { recursive: true, force: true });
    const workRoot = path.join(root, 'work');
    const data = path.join(root, 'data');
    mkdirSync(path.join(workRoot, 'src'), { recursive: true });
    copyFileSync(path.join(TEMPLATE_DIR, 'src', 'scene.config.json'), path.join(workRoot, 'src', 'scene.config.json'));
    mkdirSync(path.join(workRoot, 'public', 'assets'), { recursive: true });
    const port = await freePort();
    const env = {
      PORT: String(port),
      WORK_ROOT: workRoot,
      WORK_DATA_DIR: path.join(data, 'm2'),
      ASSETS_DIR: path.join(data, 'assets'),
      SCENE_HISTORY_DIR: path.join(data, 'scene'),
      LUX3D_BASE: 'http://127.0.0.1:4019',
      LUX3D_API_KEY: 'unused',
      CODING_AGENT_BASE_URL: MOCK_BASE,
      CODING_AGENT_API_KEY: MOCK_KEY,
      CODING_AGENT_MODEL: MOCK_MODEL,
      PI_NET_GUARD_LOG: path.join(root, 'guard.log'),
      NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    };
    let backend = await startChild({
      command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR, env,
      readyUrl: `http://127.0.0.1:${port}/health`, label: 'events-sandbox',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      const first = await (await fetch(`${base}/scene`)).json();
      for (const fov of [38, 40]) {
        const next = structuredClone(first);
        next.hero.camera.fov = fov;
        const response = await fetch(`${base}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
        expect(response.status).toBe(200);
      }
      const before = await (await fetch(`${base}/events/history?since=0`)).json() as any;
      expect(before.current).toBeGreaterThanOrEqual(2);

      const closed = await backend.gracefulClose(30_000);
      expect(closed.code, closed.output).toBe(0);

      backend = await startChild({
        command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR, env,
        readyUrl: `http://127.0.0.1:${port}/health`, label: 'events-sandbox-restart',
      });
      const after = await (await fetch(`${base}/events/history?since=0`)).json() as any;
      expect(after.current, '重启后 seq 归零了').toBeGreaterThanOrEqual(before.current);
      expect(after.oldest).toBeLessThanOrEqual(before.oldest);
      expect(after.events.length).toBeGreaterThanOrEqual(before.events.length);
      // 重启后继续产生的事件序号接着往上走
      const config = await (await fetch(`${base}/scene`)).json();
      const next = structuredClone(config);
      next.hero.camera.fov = 42;
      await fetch(`${base}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      const latest = await (await fetch(`${base}/events/history?since=${after.current}`)).json() as any;
      expect(latest.events.length).toBeGreaterThanOrEqual(1);
      expect(latest.events[0].seq).toBe(after.current + 1);

      writeArtifactFrom('events-restart.json', { before: { current: before.current, oldest: before.oldest }, after: { current: after.current, oldest: after.oldest }, latestSeq: latest.events[0].seq });
    } finally {
      await backend.stop();
      rmSync(root, { recursive: true, force: true });
    }
    void SCENE_HISTORY;
  });
});
