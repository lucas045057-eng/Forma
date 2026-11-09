import { expect, test } from '@playwright/test';
import { BACKEND_BASE, MOCK_BASE, RUN_ID, SENTINEL_KEY } from './env';
import { collectEvents, getBytes, getJson, postJson, waitForAsset, writeArtifact } from './harness';

/** 路径穿越与信息泄露的尝试清单（都是 encodeURIComponent 之后的形态，避免被 URL 规范化吃掉）。 */
const traversal = [
  '%2e%2e%2fpackage.json',
  '%2e%2e%2f%2e%2e%2fpackage.json',
  '..%5C..%5CWindows%5Cwin.ini',
  '%2Fetc%2Fpasswd',
  'C%3A%5CWindows%5Cwin.ini',
  'index.json',
  '%2e%2e%2findex.json',
  'a%00b',
  'x'.repeat(200),
  'lux3d-9000001%2F..%2Findex.json',
  '%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json',
];

/** 只要命中任一，就说明读到了资产目录以外的文件。 */
const leakMarkers = ['root:x:0:0:', '[extensions]', '"@spatial/server"', '"dependencies"', '[fonts]', 'Microsoft Corporation'];

test.describe('M0-A 路径穿越与密钥泄露', () => {
  test('1. /assets/:id 与 /assets/:id/model.glb 的穿越 id 全部被拒', async () => {
    const results: Array<Record<string, unknown>> = [];
    const failures: string[] = [];
    for (const id of traversal) {
      for (const suffix of ['', '/model.glb']) {
        const response = await getJson(`${BACKEND_BASE}/assets/${id}${suffix}`);
        const leaked = leakMarkers.filter((marker) => response.text.includes(marker));
        const record = { id: id.length > 40 ? `${id.slice(0, 12)}…(${id.length})` : id, suffix, status: response.status, leaked };
        results.push(record);
        if (response.status === 200) failures.push(`GET /assets/${record.id}${suffix} 返回 200`);
        if (leaked.length) failures.push(`GET /assets/${record.id}${suffix} 泄露了 ${leaked.join(',')}`);
      }
    }

    // 合法但不存在的 id：确认路由本身是通的（404 + NOT_FOUND），不是整站都在 404
    const unknown = await getJson(`${BACKEND_BASE}/assets/nonexistent-id`);
    expect(unknown.status).toBe(404);
    expect((unknown.body as any).error.code).toBe('NOT_FOUND');

    writeArtifact('security-traversal.json', { results, failures, unknown: { status: unknown.status, body: unknown.body } });
    expect(failures, '存在没有被拒绝的穿越请求').toEqual([]);
  });

  test('2. 响应、模型下载与 WebSocket 事件里都不含上游 key', async () => {
    const imported = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId: '7000009' });
    expect(imported.status).toBe(202);
    const id = (imported.body as any).id;
    const { asset } = await waitForAsset(BACKEND_BASE, id, (item) => item.status === 'ready', { timeoutMs: 60_000 });

    const events = await collectEvents('ws://127.0.0.1:3001/events');
    await new Promise((resolve) => setTimeout(resolve, 600));
    events.close();

    const list = await getJson(`${BACKEND_BASE}/assets`);
    const single = await getJson(`${BACKEND_BASE}/assets/${id}`);
    const model = await getBytes(`${BACKEND_BASE}${asset.modelUrl}`);
    const health = await getJson(`${BACKEND_BASE}/health`);

    const bodies = {
      list: list.text,
      single: single.text,
      health: health.text,
      modelHead: model.buffer.subarray(0, 2048).toString('latin1'),
      events: events.raw.join('\n'),
      modelHeaders: JSON.stringify(model.headers),
    };
    const leaks = Object.entries(bodies).filter(([, text]) => text.includes(SENTINEL_KEY)).map(([name]) => name);
    // 模型二进制里可能会随机出现 ASCII 片段，这里只看文件头和事件；key 是字符串形式，命中即视为泄露
    const authorizationHeader = Object.keys(model.headers).filter((name) => name.toLowerCase() === 'authorization');

    writeArtifact('security-key-leak.json', {
      sentinel: SENTINEL_KEY,
      leaks,
      authorizationHeader,
      modelHeaders: model.headers,
      eventCount: events.events.length,
      mockStats: (await getJson(`${MOCK_BASE}/__stats`)).body,
    });

    expect(leaks, '上游 key 出现在了响应/事件里').toEqual([]);
    expect(authorizationHeader, '模型响应回显了 Authorization 头').toEqual([]);
    expect(Object.keys(model.headers)).not.toContain('www-authenticate');
  });

  test('3. 跨源 Origin 被拒（后端只服务同源工作台）', async () => {
    const response = await fetch(`${BACKEND_BASE}/assets`, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
    const body = await response.json() as any;
    expect(body.error.code).toBe('ORIGIN_DENIED');

    // 同源 Origin 放行
    const allowed = await fetch(`${BACKEND_BASE}/assets`, { headers: { origin: BACKEND_BASE } });
    expect(allowed.status).toBe(200);
    writeArtifact('security-origin.json', { denied: { status: response.status, body }, allowed: allowed.status });
  });

  test('4. 幂等键本身不落盘成明文（索引里只有哈希）', async () => {
    const plaintextKey = `plaintext-probe-${RUN_ID}`;
    const submitted = await postJson(`${BACKEND_BASE}/assets/lux3d`, { prompt: 'hash probe', version: 'G1-Turbo', idempotencyKey: plaintextKey });
    expect(submitted.status).toBe(202);
    await waitForAsset(BACKEND_BASE, (submitted.body as any).id, (item) => item.status === 'ready', { timeoutMs: 60_000 });

    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const indexFile = path.join(process.cwd(), '.data', 'pi-m0a', 'assets', 'index.json');
    const index = readFileSync(indexFile, 'utf8');
    writeArtifact('security-idempotency-hash.json', {
      containsPlaintext: index.includes(plaintextKey),
      entry: (JSON.parse(index) as any[]).find((entry) => entry.id === (submitted.body as any).id),
    });
    expect(index.includes(plaintextKey), '幂等键明文出现在索引文件里').toBe(false);
  });
});
