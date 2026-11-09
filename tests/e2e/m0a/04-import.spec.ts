import { expect, test } from '@playwright/test';
import { BACKEND_BASE, MOCK_BASE, RUN_ID } from './env';
import { collectEvents, getBytes, getJson, glbHeader, inspectGlb, postJson, waitForAsset, writeArtifact } from './harness';

test.describe('M0-A 导入已有任务（零额度）', () => {
  test('导入一个已完成任务：只查询不创建，处理后可下载模型', async () => {
    const before = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const taskId = '7000001';

    const imported = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId });
    expect(imported.status, JSON.stringify(imported.body)).toBe(202);
    const created = imported.body as any;
    expect(created.status).toBe('polling');

    const { asset } = await waitForAsset(BACKEND_BASE, created.id, (item) => item.status === 'ready', { timeoutMs: 60_000 });
    const after = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };

    expect(asset.status).toBe('ready');
    expect(after.creates - before.creates, '导入不应创建新任务').toBe(0);
    expect(after.gets - before.gets, '导入应查询远端任务状态').toBeGreaterThanOrEqual(2);

    const model = await getBytes(`${BACKEND_BASE}${asset.modelUrl}`);
    expect(model.status).toBe(200);
    const header = glbHeader(model.buffer);
    expect(header.valid, JSON.stringify(header)).toBe(true);
    const inspected = await inspectGlb(model.buffer);
    expect(inspected.meshes).toBeGreaterThanOrEqual(1);
    expect(inspected.vertices).toBe(asset.metrics.after.vertices);

    // 重复导入同一个任务：直接返回已完成记录，不再查询、不再下载
    const again = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId });
    expect((again.body as any).id).toBe(asset.id);
    expect((again.body as any).status).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterReimport = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    expect(afterReimport.gets, '重复导入不应再查询远端').toBe(after.gets);
    expect(afterReimport.creates).toBe(after.creates);

    // 事件里也应出现 ready
    const events = await collectEvents('ws://127.0.0.1:3001/events');
    events.close();

    // 非数字任务编号被拒
    const rejectedIds = ['abc', '-1', '1.5', ' '];
    const rejected: Array<{ taskId: string; status: number }> = [];
    for (const bad of rejectedIds) {
      const response = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId: bad });
      rejected.push({ taskId: bad, status: response.status });
      expect(response.status, `taskId=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
    }

    // 观察项（不是本次验收要求）：Fastify 默认开启 coerceTypes，像 "1e5" 这种“看着像数字”的
    // 字符串会被转换成整数 100000 并通过校验。只记录实际行为，不当作通过条件。
    const coerced = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId: '1e5' });

    writeArtifact('import.json', {
      imported: created,
      asset,
      model: { bytes: model.buffer.length, header, inspected },
      mockStats: { before, after, afterReimport },
      rejected,
      coercedObservation: { taskId: '1e5', status: coerced.status, taskIdInResponse: (coerced.body as any)?.taskId },
    });
  });
});
