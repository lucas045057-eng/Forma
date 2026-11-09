import { rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BACKEND_BASE, MOCK_BASE, MOCK_FIXTURE, RUN_ID } from './env';
import {
  getJson,
  postJson,
  scenarioDir,
  startBackend,
  startMock,
  waitForAsset,
  writeArtifact,
} from './harness';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe('M0-A 幂等与「结果不明不重发」', () => {
  test('1. 同一幂等键顺序提交两次：只创建一次，返回同一条资产', async () => {
    const before = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const key = `idem-seq-${RUN_ID}`;
    const payload = { prompt: 'cedar diffuser bottle', version: 'G1-Turbo', idempotencyKey: key };

    const first = await postJson(`${BACKEND_BASE}/assets/lux3d`, payload);
    const second = await postJson(`${BACKEND_BASE}/assets/lux3d`, payload);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((second.body as any).id).toBe((first.body as any).id);

    await waitForAsset(BACKEND_BASE, (first.body as any).id, (asset) => asset.status === 'ready', { timeoutMs: 60_000 });
    const after = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const created = after.creates - before.creates;
    expect(created, '同一幂等键只应创建一次').toBe(1);
    writeArtifact('idempotency-sequential.json', { first: first.body, second: second.body, mockStats: { before, after } });
  });

  test('2. 同一幂等键并发提交两次：只创建一个远端任务', async () => {
    const before = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const key = `idem-concurrent-${RUN_ID}`;
    const payload = { prompt: 'amber glass bottle', version: 'G1-Turbo', idempotencyKey: key };

    const [a, b] = await Promise.all([
      postJson(`${BACKEND_BASE}/assets/lux3d`, payload),
      postJson(`${BACKEND_BASE}/assets/lux3d`, payload),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect((a.body as any).id).toBe((b.body as any).id);

    await waitForAsset(BACKEND_BASE, (a.body as any).id, (asset) => asset.status === 'ready', { timeoutMs: 60_000 });
    const after = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    expect(after.creates - before.creates, '并发同键不应重复创建').toBe(1);
    writeArtifact('idempotency-concurrent.json', { first: a.body, second: b.body, mockStats: { before, after } });
  });

  test('3. 同一幂等键不同参数：409，且不产生新任务', async () => {
    const before = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number };
    const key = `idem-conflict-${RUN_ID}`;
    const first = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'one bottle', version: 'G1-Turbo', idempotencyKey: key });
    expect(first.status).toBe(202);
    const conflict = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'another bottle', version: 'G1', idempotencyKey: key });
    expect(conflict.status).toBe(409);
    expect((conflict.body as any).error.code).toBe('IDEMPOTENCY_CONFLICT');
    const after = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number };
    expect(after.creates - before.creates).toBe(1);
    writeArtifact('idempotency-conflict.json', { conflict: conflict.body, mockStats: { before, after } });
  });

  test('4. 提交结果不明：不自动重发，同键再提交也不重发，只能查询远端后导入', async () => {
    const directory = scenarioDir('unclear');
    rmSync(directory, { recursive: true, force: true });
    const mock = await startMock({ fixture: MOCK_FIXTURE });
    const backend = await startBackend({ base: mock.base, assetsDir: directory, pollMs: 60 });
    let restarted: Awaited<ReturnType<typeof startMock>> | null = null;
    try {
      // 先确认链路是通的（这次会真的创建 1 个 mock 任务）
      const ok = await postJson(`${backend.base}/assets/lux3d`, { prompt: 'warm up', version: 'G1-Turbo', idempotencyKey: `unclear-warmup-${RUN_ID}` });
      expect(ok.status).toBe(202);
      await waitForAsset(backend.base, (ok.body as any).id, (asset) => asset.status === 'ready', { timeoutMs: 60_000 });
      const statsBefore = (await getJson(`${mock.base}/__stats`)).body as { creates: number; gets: number };
      expect(statsBefore.creates).toBe(1);

      // 关掉 mock → 提交结果不明
      await mock.stop();
      const unclear = await postJson(`${backend.base}/assets/lux3d`, { prompt: 'unclear result', version: 'G1-Turbo', idempotencyKey: `unclear-${RUN_ID}` });
      expect(unclear.status).toBe(202);
      const asset = unclear.body as any;
      expect(asset.status).toBe('submit_unknown');
      expect(asset.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(asset.error.message).toContain('重复生成');

      // 重新拉起 mock（同端口，计数从 0 开始）：如果服务偷偷重发，这里会看到 creates > 0
      restarted = await startMock({ port: mock.port, fixture: MOCK_FIXTURE });
      await sleep(2_500);
      const afterRestart = (await getJson(`${restarted.base}/__stats`)).body as { creates: number; gets: number };
      expect(afterRestart.creates, '提交结果不明后自动重发了一次').toBe(0);

      // 同一个幂等键再提交：仍然返回原来那条记录，也不重发
      const again = await postJson(`${backend.base}/assets/lux3d`, { prompt: 'unclear result', version: 'G1-Turbo', idempotencyKey: `unclear-${RUN_ID}` });
      expect((again.body as any).id).toBe(asset.id);
      expect((again.body as any).status).toBe('submit_unknown');
      const afterAgain = (await getJson(`${restarted.base}/__stats`)).body as { creates: number; gets: number };
      expect(afterAgain.creates).toBe(0);

      writeArtifact('idempotency-unclear.json', { asset, statsBefore, afterRestart, afterAgain });
    } finally {
      await restarted?.stop();
      await backend.stop();
      await mock.stop();
    }
  });
});
