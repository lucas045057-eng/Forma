import { rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { RUN_ID } from './env';
import {
  getJson,
  postJson,
  scenarioDir,
  startBackend,
  startMock,
  startStub,
  TERMINAL,
  waitForAsset,
  writeArtifact,
} from './harness';

interface FailureCase {
  name: string;
  mock?: string;
  stub?: string;
  timeoutMs?: number;
  submitOnly?: boolean;
  status: string;
  code: string;
  messageIncludes?: string;
}

const cases: FailureCase[] = [
  { name: '任务失败 status=4', mock: 'failed', status: 'failed', code: 'GENERATION_FAILED' },
  { name: '任务取消 status=6', mock: 'cancelled', status: 'cancelled', code: 'GENERATION_CANCELLED' },
  { name: '结果 URL 过期 403', mock: 'expired403', status: 'failed', code: 'OUTPUT_URL_EXPIRED', messageIncludes: '403' },
  { name: '结果 URL 过期 404', mock: 'expired404', status: 'failed', code: 'OUTPUT_URL_EXPIRED', messageIncludes: '404' },
  { name: '轮询超时', mock: 'timeout', timeoutMs: 1_200, status: 'failed', code: 'POLL_TIMEOUT' },
  { name: '未知任务状态', mock: 'unknown', status: 'failed', code: 'UNKNOWN_STATUS' },
  { name: '并发超限（create 返回 c 错误码）', stub: 'concurrency', submitOnly: true, status: 'submit_unknown', code: 'UPSTREAM_REJECTED' },
  { name: 'create 返回 HTTP 500（结果不明）', stub: 'create-500', submitOnly: true, status: 'submit_unknown', code: 'UPSTREAM_HTTP' },
  { name: '任务成功但没有 GLB 输出', stub: 'no-glb', status: 'failed', code: 'NO_GLB' },
];

test.describe('M0-A 失败路径：错误清晰、不卡死', () => {
  for (const item of cases) {
    test(item.name, async () => {
      const directory = scenarioDir(item.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '-'));
      rmSync(directory, { recursive: true, force: true });
      const upstream = item.mock
        ? await startMock({ scenario: item.mock })
        : await startStub({ mode: item.stub! });
      const backend = await startBackend({
        base: upstream.base,
        assetsDir: directory,
        pollMs: 50,
        timeoutMs: item.timeoutMs ?? 8_000,
      });
      const startedAt = Date.now();
      try {
        const submitted = await postJson(`${backend.base}/assets/lux3d`, {
          prompt: `failure case ${item.name}`,
          version: 'G1-Turbo',
          idempotencyKey: `failure-${RUN_ID}-${item.name}`,
        });
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
        const created = submitted.body as any;
        expect(created.id).toBeTruthy();

        let finalAsset: any = created;
        if (!item.submitOnly) {
          const waited = await waitForAsset(backend.base, created.id, (asset) => TERMINAL.has(asset.status), { timeoutMs: 30_000 });
          finalAsset = waited.asset;
        }
        const elapsedMs = Date.now() - startedAt;
        expect(elapsedMs, '失败路径不应卡住').toBeLessThan(25_000);

        expect(finalAsset.status, JSON.stringify(finalAsset)).toBe(item.status);
        expect(finalAsset.error?.code).toBe(item.code);
        if (item.messageIncludes) expect(finalAsset.error?.message).toContain(item.messageIncludes);
        expect(finalAsset.error?.message).toBeTruthy();
        // 错误信息里不应出现上游 key 或内部路径
        expect(JSON.stringify(finalAsset)).not.toContain('mock-only');
        expect(JSON.stringify(finalAsset)).not.toContain('raw.glb');

        // 上游确实被访问过（证明这个失败来自 mock 剧本，而不是配置问题）
        const stats = (await getJson(`${upstream.base}/__stats`)).body as { creates: number; gets: number };
        if (item.submitOnly) expect(stats.creates).toBeGreaterThanOrEqual(1);
        else expect(stats.gets).toBeGreaterThanOrEqual(1);

        // 终态之后不应继续轮询：再等一会儿，上游查询次数不再增长
        const beforeIdle = stats.gets;
        await new Promise((resolve) => setTimeout(resolve, 400));
        const afterIdle = (await getJson(`${upstream.base}/__stats`)).body as { creates: number; gets: number };
        expect(afterIdle.gets, '进入终态后仍在轮询').toBe(beforeIdle);

        writeArtifact(`failure-${item.name.replace(/[^\w\u4e00-\u9fa5-]+/g, '-')}.json`, {
          case: item,
          submitted: submitted.body,
          finalAsset,
          elapsedMs,
          stats: { before: stats, afterIdle },
        });
      } finally {
        await backend.stop();
        await upstream.stop();
      }
    });
  }
});
