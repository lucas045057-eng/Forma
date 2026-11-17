import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { api, control, fixtureBytes, jsxTarget, resetFake, restoreWorkRoot, uploadBytes, waitTask, writeEvidence, type LuxTaskView } from './support/api';
import { approvePlacementTaskOnce } from './support/approvals';
import { BACKEND_BASE, WORK_ROOT } from './env';

/** 返工矩阵（3e49a98 / 3043349 语义）：F1 影子文件、F5 link 阶段、F6 部分产物、F7 分类、N9 inside、F8 主槽结构。 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

const readyAsset = async (request: APIRequestContext, key: string) => {
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  expect(image.status).toBe(201);
  const created = await api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', {
    operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: key,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const task = await waitTask(request, created.body.localId);
  return { task, assetId: task.artifacts.find((item) => item.kind === 'model' && item.assetId)!.assetId! };
};

const insertTarget = () => ({ kind: 'insert', src: jsxTarget('templates/product-page/src/App.tsx', '<Button data-testid="buy-button"'), cid: 'Button', ancestors: ['src/App.tsx:1:1'], position: 'after' });

test('N49/F1 影子渲染器：作品根存在 src/spatial-module.ts 时插入必须被拒；移除后同一放置可通过', async ({ request }) => {
  const shadow = path.join(WORK_ROOT, 'src', 'spatial-module.ts');
  // 先在干净基线上取版本、资产并建立会话：产品会在 /version 与放置确认时做受管审计（更早的安全边界）。
  const version = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const { assetId } = await readyAsset(request, 'k-shadow');
  const session = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: version });
  expect(session.status).toBe(200);
  writeFileSync(shadow, 'export const shadow = true;\n');
  const originalBytes = readFileSync(shadow);
  try {
    const blocked = await api<{ error?: { code?: string } }>(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, { target: insertTarget(), adjustment: { layout: { widthPercent: 80, align: 'center', offsetY: 0 } } });
    expect(blocked.status, JSON.stringify(blocked.body)).toBeGreaterThanOrEqual(400);
    expect(blocked.status).toBeLessThan(500);
    // 拒绝且不覆盖：影子文件必须逐字节保持原样。
    expect(readFileSync(shadow).equals(originalBytes), '影子文件被改写').toBe(true);
    writeEvidence('rework-f1-shadow-blocked.json', blocked.body);
  } finally {
    if (existsSync(shadow)) unlinkSync(shadow);
  }

  // 移除冲突后，同一路径的放置应能恢复成功。
  const cleanVersion = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const clean = await readyAsset(request, 'k-shadow-clean');
  const cleanSession = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId: clean.assetId, baseVersion: cleanVersion });
  expect(cleanSession.status).toBe(200);
  const allowed = await api<{ kind: string; task?: { id: string; status: string; candidateId?: string } }>(request, 'POST', `/assets/placements/${cleanSession.body.sessionId}/confirm`, { target: insertTarget(), adjustment: { layout: { widthPercent: 80, align: 'center', offsetY: 0 } } });
  expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  expect(allowed.body.kind).toBe('insert');
  const approvedTask = await approvePlacementTaskOnce((method, pathname, data) => api<unknown>(request, method, pathname, data), allowed.body.task!);
  const candidateId = approvedTask.candidateId!;
  const discarded = await api(request, 'POST', `/candidates/${candidateId}/discard`);
  expect(discarded.status).toBe(200);
  writeEvidence('rework-f1-shadow-clean.json', { allowed: allowed.body, discarded: discarded.body });
});

test('N51/F5 只有 submit_unknown 可关联：明确拒绝的任务 link 必须 4xx', async ({ request }) => {
  await control({ scenario: 'reject' });
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  const created = await api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', { operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-link-rejected' });
  const failed = await waitTask(request, created.body.localId, { until: (task) => ['failed', 'submit_unknown'].includes(task.stage) });
  expect(failed.stage).toBe('failed');
  const linked = await api<{ error?: { code?: string } }>(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/link`, { providerTaskId: '9100001', confirmed: true });
  expect(linked.status, JSON.stringify(linked.body)).toBeGreaterThanOrEqual(400);
  expect(linked.status).toBeLessThan(500);
  writeEvidence('rework-f5-link-rejected-task.json', { stage: failed.stage, linked: linked.body });
});

test('N52/F5 关联到远端失败（状态 4）的任务不得变成可查看模型', async ({ request }) => {
  await control({ scenario: 'response-lost' });
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  const created = await api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', { operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-link-failed-remote' });
  const unknown = await waitTask(request, created.body.localId, { until: (task) => task.stage === 'submit_unknown' });
  expect(unknown.providerTaskId).toBeUndefined();
  const resumed = await api<LuxTaskView>(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/resume`);
  expect(resumed.body.resumeCandidates?.length).toBe(1);
  await control({ scenario: 'reject-status' });
  const linked = await api<LuxTaskView>(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/link`, { providerTaskId: resumed.body.resumeCandidates![0].providerTaskId, confirmed: true });
  if (linked.status === 200) {
    const after = await waitTask(request, linked.body.localId, { until: (task) => ['ready', 'failed', 'cancelled', 'submit_unknown'].includes(task.stage), timeoutMs: 60_000 }).catch(() => linked.body);
    expect(after.stage).not.toBe('ready');
    expect(after.artifacts ?? []).toHaveLength(0);
    writeEvidence('rework-f5-remote-failed.json', { linked: linked.body, after });
  } else {
    expect(linked.status).toBeGreaterThanOrEqual(400);
    expect(linked.status).toBeLessThan(500);
    writeEvidence('rework-f5-remote-failed.json', { linked: linked.body });
  }
});

test('N53/F6 多产物部分失败：ZIP 403 但 GLB 成功时任务仍 ready 且 GLB 可下载', async ({ request }) => {
  await control({ scenario: 'zip-fail' });
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  const created = await api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', { operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['zip', 'glb'] }, idempotencyKey: 'k-partial' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.stage).toBe('ready');
  const glb = task.artifacts.find((item) => item.kind === 'model' && item.format === 'glb');
  expect(glb).toBeTruthy();
  const download = await request.get(`${BACKEND_BASE}${glb!.downloadUrl}`);
  expect(download.status()).toBe(200);
  expect(task.artifacts.some((item) => item.format === 'zip')).toBe(false);
  expect((task.note ?? '').length).toBeGreaterThan(0);
  writeEvidence('rework-f6-partial.json', task);
});

test('N54/F7 403 归类：HTTP 403 必须保持 submit_unknown（unknown），不得标 rejected', async ({ request }) => {
  await control({ scenario: 'forbid' });
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  const created = await api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', { operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-403' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId, { until: (item) => ['failed', 'submit_unknown'].includes(item.stage) });
  expect(task.stage).toBe('submit_unknown');
  expect(task.error?.classification).toBe('unknown');
  expect(task.error?.classification).not.toBe('rejected');
  writeEvidence('rework-f7-403.json', task);
});

test('N55/N9 inside 命中自闭合元素：返回明确错误，不静默改到后面', async ({ request }) => {
  const version = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const { assetId } = await readyAsset(request, 'k-inside');
  const session = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: version });
  const target = { kind: 'insert', src: jsxTarget('templates/product-page/src/App.tsx', '<br'), cid: 'br', ancestors: [], position: 'inside' };
  const result = await api<{ error?: { code?: string } }>(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, { target });
  expect(result.status).toBe(409);
  expect(result.body.error?.code).toBe('INSIDE_REQUIRES_CONTAINER');
  writeEvidence('rework-n9-inside.json', result.body);
});

test('F8 主槽结构：scene.config 不含动画字段，模块动画只属于实例配置', async ({ request }) => {
  const scene = (await api<Record<string, unknown>>(request, 'GET', '/scene')).body;
  expect(Object.keys(scene).sort()).toEqual(['hero', 'model', 'scroll']);
  expect('animation' in scene).toBe(false);
  const modules = await api<Array<{ config: Record<string, unknown> }>>(request, 'GET', '/assets/modules');
  expect(modules.status).toBe(200);
  for (const item of modules.body) expect(Object.keys(item.config)).toContain('animation');
  writeEvidence('rework-f8-scene-structure.json', { sceneKeys: Object.keys(scene), modules: modules.body.length });
});
