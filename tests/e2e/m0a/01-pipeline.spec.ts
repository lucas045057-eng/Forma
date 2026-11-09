import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  BACKEND_BASE,
  GUARD_LOG,
  GUARD_SCRIPT_ARG,
  M0A_DATA,
  MOCK_BASE,
  MOCK_FIXTURE,
  RUN_ID,
  SENTINEL_KEY,
} from './env';
import {
  collectEvents,
  getBytes,
  getJson,
  glbHeader,
  inspectGlb,
  postJson,
  readGuardLog,
  readGuardMarker,
  waitForAsset,
  writeArtifact,
} from './harness';

/** 用守卫 preload 跑一段脚本，返回输出和退出码（用于证明守卫真的会拦真实域名）。 */
function runGuardProbe(code: string, logFile: string): Promise<{ output: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`, PI_NET_GUARD_LOG: logFile },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('exit', (code) => resolve({ output, exitCode: code }));
  });
}

test.describe('M0-A 主链路（全程 mock Lux3D）', () => {
  test('1. 出站守卫自检：指向真实 Lux3D 域名的请求会被拦截并留痕', async () => {
    const logFile = path.join(M0A_DATA, 'net-guard-selftest.log');
    mkdirSync(M0A_DATA, { recursive: true });
    rmSync(logFile, { force: true });
    const probe = await runGuardProbe(
      "fetch('https://api.aholo3d.cn/lux3d/v1/generate/task/list')" +
      ".then(r => console.log('RESOLVED', r.status))" +
      ".catch(e => console.log('BLOCKED', (e.cause && e.cause.code) || e.code || e.message));",
      logFile,
    );
    const entries = readGuardLog(logFile);
    writeArtifact('guard-selftest.json', { probe, entries });

    expect(probe.output, '真实域名居然被放行').toContain('BLOCKED');
    expect(entries.map((entry) => entry.detail).join(' ')).toContain('api.aholo3d.cn');
  });

  test('2. 文生 3D：提交 → 轮询 0/1/3 → 下载 → 处理 → asset.ready', async () => {
    const mockBefore = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const events = await collectEvents(`ws://127.0.0.1:3001/events`);
    try {
      const submitted = await postJson(`${BACKEND_BASE}/assets/lux3d`, {
        prompt: 'wooden cap amber diffuser bottle',
        version: 'G1-Turbo',
        idempotencyKey: `pipeline-${RUN_ID}`,
      });

      expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
      const created = submitted.body as any;
      expect(created.status).toBe('polling');
      // mock 的任务编号是 9000000 + 第 N 次创建，说明这次确实由 mock 受理
      expect(created.taskId).toBe(String(9_000_000 + mockBefore.creates + 1));

      const { asset, seen } = await waitForAsset(BACKEND_BASE, created.id, (item) => item.status === 'ready', { timeoutMs: 60_000 });
      await events.waitFor((list) => list.some((event) => event.type === 'asset.ready' && event.asset?.id === created.id));

      // REST 侧
      expect(asset.modelUrl).toBe(`/assets/${created.id}/model.glb`);
      expect(asset.metrics).toBeTruthy();
      const { before, after, durationMs } = asset.metrics;
      expect(before.bytes).toBeGreaterThan(10_000_000);      // mock 供的是 13.3 MB 真模型
      expect(after.bytes).toBeLessThan(3_000_000);           // 每份 < 3 MB
      expect(after.vertices).toBeLessThan(100_000);          // 每份 < 10 万 POSITION 顶点
      expect(after.vertices).toBeLessThan(before.vertices);
      expect(durationMs).toBeGreaterThan(0);

      // 处理后的模型必须是能被解析的 GLB，且完成归一化
      const model = await getBytes(`${BACKEND_BASE}${asset.modelUrl}`);
      expect(model.status).toBe(200);
      expect(model.headers['content-type']).toContain('model/gltf-binary');
      const header = glbHeader(model.buffer);
      expect(header.valid, JSON.stringify(header)).toBe(true);
      const inspected = await inspectGlb(model.buffer);
      expect(inspected.meshes).toBeGreaterThanOrEqual(1);
      expect(inspected.vertices).toBe(after.vertices);
      expect(Math.abs(inspected.maxEdge - 1)).toBeLessThan(0.002);        // 最大边 = 1
      expect(Math.abs(inspected.bounds.min[1])).toBeLessThan(0.01);       // 底面中心在原点

      // WebSocket 侧：顺序与序号
      const mine = events.events.filter((event) => event.asset?.id === created.id);
      const statuses = mine.map((event) => event.asset?.status).filter(Boolean) as string[];
      expect(statuses.length).toBeGreaterThanOrEqual(4);
      expect(statuses.at(-1)).toBe('ready');
      expect(mine.at(-1)?.type).toBe('asset.ready');
      expect(statuses).toContain('downloading');
      expect(statuses).toContain('processing');
      expect(statuses.indexOf('downloading')).toBeLessThan(statuses.indexOf('processing'));
      expect(statuses.indexOf('processing')).toBeLessThan(statuses.length - 1);
      const sequences = mine.map((event) => event.sequence ?? 0);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);
      for (const event of mine) expect(event.ts).toBeTruthy();

      // 只打到 mock：mock 记到了 1 次创建和多次查询；后端出站守卫日志为空
      const mockAfter = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
      expect(mockAfter.creates - mockBefore.creates).toBe(1);
      expect(mockAfter.gets - mockBefore.gets).toBeGreaterThanOrEqual(3);
      const guard = readGuardLog(GUARD_LOG);
      const guardMarker = readGuardMarker(GUARD_LOG);
      expect(guardMarker?.active, '出站守卫没有被装进被测后端进程，日志为空不能作为依据').toBe(true);
      expect(guard, `后端尝试访问了非回环地址：${JSON.stringify(guard)}`).toEqual([]);

      // key 不出现在响应与事件里
      expect(JSON.stringify(asset)).not.toContain(SENTINEL_KEY);
      expect(events.raw.join('\n')).not.toContain(SENTINEL_KEY);

      writeArtifact('pipeline.json', {
        submitted: { status: submitted.status, asset: created },
        restStatuses: seen,
        finalAsset: asset,
        glb: { header, inspected, bytes: model.buffer.length },
        events: mine,
        mockStats: { before: mockBefore, after: mockAfter },
        guardLog: guard,
        guardMarker,
      });
    } finally {
      events.close();
    }
  });

  test('3. 图生 3D 与参数校验：img 走同一条 mock 链路，非法请求被拒', async () => {
    const mockBefore = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const submitted = await postJson(`${BACKEND_BASE}/assets/lux3d`, {
      img: 'https://example.com/diffuser.png',
      version: 'G1',
      idempotencyKey: `pipeline-img-${RUN_ID}`,
    });
    expect(submitted.status).toBe(202);
    const created = submitted.body as any;
    expect(created.status).toBe('polling');

    const { asset } = await waitForAsset(BACKEND_BASE, created.id, (item) => item.status === 'ready', { timeoutMs: 60_000 });
    expect(asset.metrics.after.vertices).toBeLessThan(100_000);
    const mockAfter = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    expect(mockAfter.creates - mockBefore.creates).toBe(1);

    // 非法输入：同时给 prompt 和 img、版本不认识、缺幂等键、img 非 https
    const both = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'x', img: 'https://example.com/x.png', version: 'G1', idempotencyKey: `bad-${RUN_ID}` });
    expect(both.status).toBe(400);
    const badVersion = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'x', version: 'G2', idempotencyKey: `bad2-${RUN_ID}` });
    expect(badVersion.status).toBe(400);
    const noKey = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'x', version: 'G1' });
    expect(noKey.status).toBe(400);
    const httpImg = await postJson(`${BACKEND_BASE}/assets/lux3d`, { img: 'http://example.com/x.png', version: 'G1', idempotencyKey: `bad3-${RUN_ID}` });
    expect(httpImg.status).toBe(400);
    // 被拒的请求不应产生任何创建
    const afterInvalid = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number };
    expect(afterInvalid.creates - mockBefore.creates).toBe(1);

    writeArtifact('image-to-3d.json', {
      asset,
      invalid: { both: both.status, badVersion: badVersion.status, noKey: noKey.status, httpImg: httpImg.status },
      mockStats: { before: mockBefore, after: mockAfter, afterInvalid },
    });
  });
});
