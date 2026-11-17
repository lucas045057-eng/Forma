import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  api, control, counters, fixtureBytes, jsxTarget, resetFake, restoreWorkRoot, uploadBytes, waitTask, writeEvidence,
  type LuxTaskView,
} from './support/api';
import { BACKEND_BASE, FIXTURES } from './env';
import type { APIRequestContext } from '@playwright/test';

/** 每个用例开始：fake 清零，默认单文件上传（blockSize 1MiB）避免无关分片上限干扰。 */
test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  restoreWorkRoot();
});

const fixtureSha = (name: string) => {
  const manifest = JSON.parse(readFileSync(path.join(FIXTURES, 'fixtures.json'), 'utf8')) as { files: Array<{ name: string; sha256: string }> };
  const entry = manifest.files.find((item) => item.name === name);
  if (!entry) throw new Error(`fixture missing: ${name}`);
  return entry.sha256;
};

const upl = async (request: APIRequestContext, kind: 'image' | 'glb', name: string) => {
  const result = await uploadBytes(request, { kind, filename: name, bytes: fixtureBytes(name) });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
};

const create = (request: APIRequestContext, body: { operation: string; parameters: unknown; idempotencyKey: string }) =>
  api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', body);

const readyAsset = async (request: APIRequestContext, key: string) => {
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: key });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const task = await waitTask(request, created.body.localId);
  const assetId = task.artifacts.find((item) => item.kind === 'model' && item.assetId)?.assetId;
  if (!assetId) throw new Error('task has no model assetId');
  return { task, assetId };
};

test('能力清单：10 类操作、计费与公开链接提示、上传上限，且不暴露密钥', async ({ request }) => {
  const result = await api<{ operations: Array<{ operation: string }>; billingNotice: string; upload: Record<string, number>; configured: boolean }>(request, 'GET', '/assets/lux3d/capabilities');
  expect(result.status).toBe(200);
  expect(result.body.operations).toHaveLength(10);
  expect(result.body.billingNotice).toContain('计费');
  expect(result.body.billingNotice).toContain('公开');
  expect(result.body.billingNotice).toContain('不提供云端删除');
  expect(result.body.upload.imageMaxBytes).toBe(10 * 1024 * 1024);
  expect(result.body.upload.modelMaxBytes).toBe(100 * 1024 * 1024);
  expect(JSON.stringify(result.body)).not.toContain('pi-fake-lux3d-key');
  writeEvidence('capabilities.json', result.body);
});

test('拖入阶段只有本地暂存：上传后不取云 token、不上传 OUS、不创建任务', async ({ request }) => {
  const upload = await upl(request, 'image', 'image.png');
  const after = await counters();
  expect(after.token).toBe(0);
  expect(after.ous.single + after.ous.init + after.ous.part).toBe(0);
  expect(after.creates).toBe(0);
  writeEvidence('drag-local-only.json', { upload, counters: after });
});

test('假图片被真实解码拒绝；非二进制上传被拒', async ({ request }) => {
  const svg = await uploadBytes(request, { kind: 'image', filename: 'looks-like.png', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') });
  expect(svg.status).toBe(400);
  expect((svg.body as unknown as { error?: { code?: string } }).error?.code).toBe('INVALID_IMAGE');
  const wrongType = await request.post(`${BACKEND_BASE}/assets/uploads?kind=image&filename=x.png`, {
    headers: { 'content-type': 'image/png' }, data: fixtureBytes('image.png'), failOnStatusCode: false,
  });
  expect(wrongType.status()).toBe(400);
});

test('GLB 上传按结构校验并识别骨骼', async ({ request }) => {
  const triangle = await upl(request, 'glb', 'triangle.glb');
  expect(triangle.kind).toBe('glb');
  expect(triangle.rigged).toBeFalsy();
  const skinned = await upl(request, 'glb', 'skinned.glb');
  expect(skinned.rigged).toBe(true);
  const broken = await uploadBytes(request, { kind: 'glb', filename: 'broken.glb', bytes: Buffer.from('glTF-not-really') });
  expect(broken.status).toBe(400);
  expect((broken.body as unknown as { error?: { code?: string } }).error?.code).toBe('INVALID_GLB');
});

test('图生 3D 全链：一次点击一次创建，token 与 OUS 凭证分离，产物带原件', async ({ request }) => {
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-image-1' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.stage).toBe('ready');
  const originals = task.artifacts.filter((item) => item.variant === 'original');
  expect(originals.some((item) => item.kind === 'model' && item.format === 'glb' && item.assetId)).toBe(true);
  const stats = await counters();
  expect(stats.creates).toBe(1);
  expect(stats.token).toBeGreaterThanOrEqual(1);
  expect(stats.ous.single).toBeGreaterThanOrEqual(1);
  expect(stats.headers.token?.authorization).toBe('pi-fake-lux3d-key');
  expect(stats.headers.token?.ousToken).toBeNull();
  expect(stats.headers.ous?.ousToken).toBe('pi-fake-ous-token');
  expect(stats.headers.ous?.authorization).toBeNull();
  expect(stats.createsLog[0].body.outputFormat).toEqual(['glb']);
  writeEvidence('image-to-3d.json', { task, stats });
});

test('同一幂等键同参数返回原任务；同键异参 409，且不产生新 POST', async ({ request }) => {
  const image = await upl(request, 'image', 'image.png');
  const params = { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] };
  const first = await create(request, { operation: 'image-to-3d', parameters: params, idempotencyKey: 'k-idem' });
  expect(first.status).toBe(202);
  await waitTask(request, first.body.localId);
  const repeat = await create(request, { operation: 'image-to-3d', parameters: params, idempotencyKey: 'k-idem' });
  expect(repeat.body.localId).toBe(first.body.localId);
  const conflict = await create(request, { operation: 'image-to-3d', parameters: { ...params, version: 'G1-Turbo' }, idempotencyKey: 'k-idem' });
  expect(conflict.status).toBe(409);
  expect((conflict.body as unknown as { error?: { code?: string } }).error?.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await counters()).creates).toBe(1);
});

test('int64 任务号无损：>2^53 原样保存、查询、进历史', async ({ request }) => {
  await control({ scenario: 'int64' });
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-int64' });
  expect(created.status).toBe(202);
  const localId = created.body.localId;
  try {
    // 产品是异步提交：202 响应里本来就没有 providerTaskId，等它回填后再断言。
    const backfilled = await waitTask(request, localId, { until: (task) => typeof task.providerTaskId === 'string' && task.providerTaskId === '9223372036854775807' });
    expect(typeof backfilled.providerTaskId).toBe('string');
    expect(backfilled.providerTaskId).toBe('9223372036854775807');
    const read = await waitTask(request, localId, { until: (task) => task.stage === 'ready' || task.stage === 'failed' });
    expect(read.stage).toBe('ready');
    expect(read.providerTaskId).toBe('9223372036854775807');
    expect(read.artifacts.some((item) => item.kind === 'model' && Boolean(item.assetId))).toBe(true);
    const history = await api<Array<{ providerTaskId: string }>>(request, 'GET', '/assets/lux3d/remote-history?page=1');
    expect(history.status).toBe(200);
    expect(history.body.some((item) => item.providerTaskId === '9223372036854775807')).toBe(true);
    writeEvidence('int64.json', { created: created.body, backfilled, read, history: history.body });
  } catch (error) {
    // 失败收尾：只停止本例拥有的任务，保留最初失败。
    await api(request, 'POST', `/assets/lux3d/tasks/${localId}/stop`).catch(() => undefined);
    throw error;
  }
});

test('响应丢失 + 历史恰有一项：保持未知、不自动认领，只有用户明确关联才绑定并留痕', async ({ request }) => {
  await control({ scenario: 'response-lost' });
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-lost' });
  expect(created.status).toBe(202);
  const unknown = await waitTask(request, created.body.localId, { until: (task) => task.stage === 'submit_unknown' });
  expect(unknown.providerTaskId).toBeUndefined();
  const resumed = await api<LuxTaskView>(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/resume`);
  expect(resumed.status).toBe(200);
  expect(resumed.body.providerTaskId).toBeUndefined();
  expect(resumed.body.resumeCandidates?.length).toBe(1);
  expect(resumed.body.note ?? '').toContain('不能自动认领');
  const candidateId = resumed.body.resumeCandidates![0].providerTaskId;
  const withoutConfirm = await api(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/link`, { providerTaskId: candidateId, confirmed: false });
  expect(withoutConfirm.status).toBe(400);
  expect((withoutConfirm.body as unknown as { error?: { code?: string } }).error?.code).toBe('CONFIRMATION_REQUIRED');
  const linked = await api<LuxTaskView>(request, 'POST', `/assets/lux3d/tasks/${created.body.localId}/link`, { providerTaskId: candidateId, confirmed: true });
  expect(linked.status).toBe(200);
  expect(linked.body.manualLink?.providerTaskId).toBe(candidateId);
  expect(linked.body.manualLink?.candidateCount).toBe(1);
  expect(linked.body.note).toContain('不等于证明');
  expect((await counters()).creates).toBe(1);
  // 关联后等它真实走到终态（ready 且有可用模型）再结束，避免任务滞留占用槽位。
  const settled = await waitTask(request, created.body.localId, { until: (task) => task.stage === 'ready' || task.stage === 'failed' });
  expect(settled.stage).toBe('ready');
  expect(settled.artifacts.some((item) => item.kind === 'model' && Boolean(item.assetId))).toBe(true);
  writeEvidence('unknown-and-link.json', { unknown, resumed: resumed.body, linked: linked.body, settled });
});

test('明确拒绝：保存失败分类，同键重试不产生新 POST', async ({ request }) => {
  await control({ scenario: 'reject' });
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-reject' });
  expect(created.status).toBe(202);
  const failed = await waitTask(request, created.body.localId, { until: (task) => task.stage === 'failed' || task.stage === 'submit_unknown' });
  expect(failed.stage).toBe('failed');
  expect(failed.error?.classification).toBe('rejected');
  const attempts = (await counters()).createAttempts;
  const retry = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-reject' });
  expect(retry.body.localId).toBe(created.body.localId);
  expect((await counters()).createAttempts).toBe(attempts);
  writeEvidence('rejected.json', { failed, attempts });
});

test('停止本地等待：有编号时只停查询，不谎称云端取消', async ({ request }) => {
  await control({ scenario: 'hold' });
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-stop' });
  const task = await waitTask(request, created.body.localId, { until: (item) => Boolean(item.providerTaskId) && ['queued', 'running'].includes(item.stage) });
  const stopped = await api<LuxTaskView>(request, 'POST', `/assets/lux3d/tasks/${task.localId}/stop`);
  expect(stopped.status).toBe(200);
  expect(stopped.body.note).toContain('不代表取消');
  expect(stopped.body.stage).not.toBe('cancelled');
  expect(stopped.body.providerTaskId).toBe(task.providerTaskId);
  writeEvidence('stop-waiting.json', stopped.body);
});

test('分片上传：小 blockSize 走 init/part/status，且 OUS 不带 API 密钥', async ({ request }) => {
  await control({ blockSize: 32 });
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'image-to-3d', parameters: { imageUploadId: image.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-blocks' });
  expect(created.status).toBe(202);
  await waitTask(request, created.body.localId);
  const stats = await counters();
  expect(stats.ous.init).toBeGreaterThanOrEqual(1);
  expect(stats.ous.part).toBeGreaterThanOrEqual(1);
  expect(stats.ous.status).toBeGreaterThanOrEqual(1);
  expect(stats.ous.single).toBe(0);
  expect(stats.headers.ous?.authorization).toBeNull();
  writeEvidence('block-upload.json', stats);
});

test('动画模型：产物保留原件，不生成破坏动画的优化件', async ({ request }) => {
  await control({ scenario: 'animated' });
  const model = await upl(request, 'glb', 'animated.glb');
  const created = await create(request, { operation: 'part-split', parameters: { modelUploadId: model.id }, idempotencyKey: 'k-anim' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.stage).toBe('ready');
  expect(task.artifacts.every((item) => item.variant === 'original')).toBe(true);
  expect(task.artifacts[0].kind).toBe('model');
  expect(task.artifacts[0].sha256).toBe(fixtureSha('animated.glb'));
  writeEvidence('animation-preserved.json', task);
});

test('材质迁移：NOT_REQUESTED 占位不挤掉真实槽位，笔记说明未请求格式', async ({ request }) => {
  const model = await upl(request, 'glb', 'triangle.glb');
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'material-transfer', parameters: { modelUploadId: model.id, imageUploadId: image.id, version: 'v3.0-standard', outputFormat: ['zip', 'glb'] }, idempotencyKey: 'k-material' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.stage).toBe('ready');
  expect(task.artifacts.some((item) => item.format === 'glb' && item.kind === 'model')).toBe(true);
  expect(task.artifacts.some((item) => item.format === 'zip' && item.kind === 'archive')).toBe(true);
  expect(task.artifacts.some((item) => item.format === 'usdz')).toBe(false);
  expect(task.note ?? '').toContain('未请求');
  writeEvidence('material-transfer.json', task);
});

test('四视图：四张图片按前斜/后斜/侧面/背面顺序输出', async ({ request }) => {
  const image = await upl(request, 'image', 'image.png');
  const created = await create(request, { operation: 'four-view', parameters: { imageUploadId: image.id }, idempotencyKey: 'k-four' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.artifacts.filter((item) => item.kind === 'image')).toHaveLength(4);
  const labels = (task.artifacts as unknown as Array<{ label?: string }>).map((item) => item.label);
  expect(labels).toEqual(['前斜视图', '后斜视图', '侧面', '背面']);
  writeEvidence('four-view.json', task);
});

test('自动绑骨：status=3 但返回 error JSON 时判失败，不标成功', async ({ request }) => {
  await control({ scenario: 'rig-error' });
  const model = await upl(request, 'glb', 'triangle.glb');
  const created = await create(request, { operation: 'humanoid-rig', parameters: { modelUploadId: model.id }, idempotencyKey: 'k-rig' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId, { until: (item) => ['ready', 'failed'].includes(item.stage) });
  expect(task.stage).toBe('failed');
  expect(task.error?.code).toBe('RIG_FAILED');
  writeEvidence('rig-error.json', task);
});

test('动画重定向：部分动作失败时只交付成功动作并保留说明', async ({ request }) => {
  const model = await upl(request, 'glb', 'skinned.glb');
  const created = await create(request, { operation: 'animation-retarget', parameters: { modelUploadId: model.id, animationIds: ['Idle_Loop', 'Walk_Loop'], animationOutputMode: 'separate', outFormat: 'glb' }, idempotencyKey: 'k-retarget' });
  expect(created.status).toBe(202);
  const task = await waitTask(request, created.body.localId);
  expect(task.stage).toBe('ready');
  // 合同：只交付成功动作的原件；网页优化件只能派生自那个成功原件，失败动作不得出现在任何交付物里。
  const originals = task.artifacts.filter((item) => item.variant === 'original');
  const optimized = task.artifacts.filter((item) => item.variant === 'optimized');
  expect(originals).toHaveLength(1);
  expect(originals[0].animationId).toBe('Walk_Loop');
  // 先要求成功原件带真实 URL hash，再比较优化件，避免 undefined === undefined 空证通过。
  expect(originals[0].sourceUrlHash).toMatch(/^[a-f0-9]{64}$/);
  // 失败动作不得出现在任何 artifact（原件或优化）的片段字段里。
  expect(task.artifacts.some((item) => item.animationId === 'Idle_Loop' || (item.animationIds ?? []).includes('Idle_Loop'))).toBe(false);
  for (const item of optimized) expect(item.sourceUrlHash).toBe(originals[0].sourceUrlHash);
  expect(task.note).toContain('未交付动作');
  expect(task.note).toContain('Idle_Loop');
  writeEvidence('retarget-partial.json', { task, originalCount: originals.length, optimizedCount: optimized.length });
});

test('导出：GLB 必须选择目标格式；转换接口不接受 glb', async ({ request }) => {
  const model = await upl(request, 'glb', 'triangle.glb');
  const missing = await create(request, { operation: 'export', parameters: { modelUploadId: model.id, outputFormat: [] }, idempotencyKey: 'k-export-0' });
  expect(missing.status).toBe(400);
  expect((missing.body as unknown as { error?: { code?: string } }).error?.code).toBe('INVALID_OPERATION_INPUT');
  const bad = await create(request, { operation: 'export', parameters: { modelUploadId: model.id, outputFormat: ['glb'] }, idempotencyKey: 'k-export-1' });
  expect(bad.status).toBe(400);
  const ok = await create(request, { operation: 'export', parameters: { modelUploadId: model.id, outputFormat: ['stl'] }, idempotencyKey: 'k-export-2' });
  expect(ok.status).toBe(202);
  const task = await waitTask(request, ok.body.localId);
  expect(task.artifacts.some((item) => item.format === 'stl')).toBe(true);
  writeEvidence('export.json', task);
});

test('产物下载与 use-input：原件可复用，优化件不能当下一步输入', async ({ request }) => {
  const { task } = await readyAsset(request, 'k-artifact');
  const original = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'model')!;
  const download = await request.get(`${BACKEND_BASE}${original.downloadUrl}`);
  expect(download.status()).toBe(200);
  expect((await download.body()).length).toBe(original.bytes);
  const optimized = task.artifacts.find((item) => item.variant === 'optimized');
  if (optimized) {
    const rejected = await api(request, 'POST', `/assets/lux3d/tasks/${task.localId}/artifacts/${optimized.id}/use-input`);
    expect(rejected.status).toBe(409);
    expect((rejected.body as unknown as { error?: { code?: string } }).error?.code).toBe('OPTIMIZED_NOT_INPUT');
  }
  const reused = await api<{ id: string; kind: string }>(request, 'POST', `/assets/lux3d/tasks/${task.localId}/artifacts/${original.id}/use-input`);
  expect(reused.status).toBe(200);
  expect(reused.body.kind).toBe('glb');
  writeEvidence('artifact-reuse.json', { original, optimized: optimized?.id ?? null, reused: reused.body });
});

test('远端历史：分页/状态过滤原样透传，非法参数 400', async ({ request }) => {
  await readyAsset(request, 'k-history');
  const history = await api<Array<{ providerTaskId: string }>>(request, 'GET', '/assets/lux3d/remote-history?page=1&status=3');
  expect(history.status).toBe(200);
  expect(history.body.length).toBeGreaterThanOrEqual(1);
  const stats = await counters();
  expect(stats.listQueries.at(-1)?.pagesize).toBe('100');
  expect(stats.listQueries.at(-1)?.status).toBe('3');
  expect((await api(request, 'GET', '/assets/lux3d/remote-history?status=2')).status).toBe(400);
  expect((await api(request, 'GET', '/assets/lux3d/remote-history?page=0')).status).toBe(400);
});

test('放置会话：资产未就绪/版本变化拒绝；伪造 kind 与路径穿越被拒', async ({ request }) => {
  const notReady = await api(request, 'POST', '/assets/placements/sessions', { assetId: 'no-such-asset', baseVersion: 'x' });
  expect(notReady.status).toBe(409);
  const version = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const { assetId } = await readyAsset(request, 'k-place');
  const session = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: version });
  expect(session.status, JSON.stringify(session.body)).toBe(200);
  const stale = await api(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: `${version}-old` });
  expect(stale.status).toBe(409);
  expect((stale.body as unknown as { error?: { code?: string } }).error?.code).toBe('STALE_PLACEMENT');
  const forgedKind = await api(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, { target: { kind: 'replace', src: jsxTarget('templates/product-page/src/components/Button.tsx', '<button'), cid: 'button', ancestors: [], position: 'inside' } });
  expect(forgedKind.status).toBe(409);
  expect((forgedKind.body as unknown as { error?: { code?: string } }).error?.code).toBe('PLACEMENT_TARGET_MISMATCH');
  const traversal = await api(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, { target: { kind: 'insert', src: 'src/../secret.tsx:1:1', cid: 'div', ancestors: [], position: 'after' } });
  expect(traversal.status).toBe(400);
  writeEvidence('placement-negatives.json', { notReady: notReady.body, stale: stale.body, forgedKind: forgedKind.body, traversal: traversal.body });
});

test('主槽替换：确认后 scene 采用新模型，撤回恢复（随后还原模板）', async ({ request }) => {
  const version = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const { assetId } = await readyAsset(request, 'k-replace');
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body;
  const session = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: version });
  expect(session.status).toBe(200);
  const target = { kind: 'replace', src: jsxTarget('templates/product-page/src/components/ProductHero.tsx', '<div className="product-scene"'), cid: 'div', ancestors: [], position: 'inside' };
  const confirmed = await api<{ kind: string; version: string }>(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, { target });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(confirmed.body.kind).toBe('replace');
  const after = (await api<{ model: string }>(request, 'GET', '/scene')).body;
  expect(after.model).toBe(`/assets/${assetId}.glb`);
  const undo = await api(request, 'POST', '/scene/undo');
  expect(undo.status).toBe(200);
  const restored = (await api<{ model: string }>(request, 'GET', '/scene')).body;
  expect(restored.model).toBe(before.model);
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('replace-main-slot.json', { before: before.model, after: after.model, restored: restored.model });
});
