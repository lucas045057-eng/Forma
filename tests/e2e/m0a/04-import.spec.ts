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

    // 数字形态的任务号仍然可用（防止“收紧过度”的反向对照）
    const numeric = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId: 7000010 });
    expect(numeric.status, JSON.stringify(numeric.body)).toBe(202);
    await waitForAsset(BACKEND_BASE, (numeric.body as any).id, (item) => item.status === 'ready', { timeoutMs: 60_000 });

    // 任务号必须是安全正整数，或不含前导零的十进制数字字符串。
    // 之前 “1e5” 会被 Fastify 的 coerceTypes 当成 100000 接受（“观察项”），整改后已改为正式拒绝。
    const invalidTaskIds: unknown[] = ['abc', '-1', '1.5', ' ', '1e5', '0123', ' 123', '0', '', 9007199254740993];
    const beforeInvalid = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const rejected: Array<{ taskId: unknown; status: number; code: string | null }> = [];
    for (const bad of invalidTaskIds) {
      const response = await postJson(`${BACKEND_BASE}/assets/lux3d/import`, { taskId: bad });
      rejected.push({ taskId: bad, status: response.status, code: (response.body as any)?.error?.code ?? null });
      expect(response.status, `taskId=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
      expect((response.body as any)?.error?.code, `taskId=${JSON.stringify(bad)} 的错误码`).toBe('INVALID_TASK');
    }
    // 被拒的请求不应碰上游：creates / gets 都不变
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterInvalid = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    expect(afterInvalid.creates, '非法 taskId 触发了上游创建').toBe(beforeInvalid.creates);
    expect(afterInvalid.gets, '非法 taskId 触发了上游查询').toBe(beforeInvalid.gets);

    writeArtifact('import.json', {
      imported: created,
      asset,
      model: { bytes: model.buffer.length, header, inspected },
      mockStats: { before, after, afterReimport, beforeInvalid, afterInvalid },
      numericControl: { taskId: 7000010, status: numeric.status },
      rejected,
    });
  });
});
