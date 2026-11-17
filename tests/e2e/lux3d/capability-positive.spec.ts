import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { api, control, counters, fixtureBytes, resetFake, uploadBytes, waitTask, writeEvidence, type LuxTaskView } from './support/api';
import { BACKEND_BASE, SERVER_DIR } from './env';

/**
 * 能力正例补齐（独立于既有 42 例）：三条缺创建链路的能力 + 绑骨成功分支。
 *
 * 每条都走真实产品 create → poll ready → 产品本地 download，再做字节级结构与 sha/length 对账；
 * 不只看 artifact metadata。fake 只返回合法 animated/skinned/triangle/image fixture，
 * 用显式 scenario 控制；不改产品、不伪造被测响应。
 */

const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));
interface GltfDocument {
  getRoot(): {
    listMeshes(): Array<{ listPrimitives(): Array<{ getAttribute(name: string): unknown }> }>;
    listAnimations(): Array<{ listChannels(): unknown[]; listSamplers(): unknown[] }>;
    listSkins(): Array<{ listJoints(): unknown[] }>;
  };
}
const gltf = requireFromServer('@gltf-transform/core') as { NodeIO: new () => { readBinary(bytes: Uint8Array): Promise<GltfDocument> } };
const io = new gltf.NodeIO();

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

const upl = async (request: APIRequestContext, kind: 'image' | 'glb', name: string) => {
  const result = await uploadBytes(request, { kind, filename: name, bytes: fixtureBytes(name) });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
};

const create = (request: APIRequestContext, body: { operation: string; parameters: unknown; idempotencyKey: string }) =>
  api<LuxTaskView>(request, 'POST', '/assets/lux3d/operations', body);

const pngSize = (bytes: Buffer) => {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

async function downloadOriginal(request: APIRequestContext, artifact: { downloadUrl: string; bytes: number; sha256: string }) {
  const response = await request.get(`${BACKEND_BASE}${artifact.downloadUrl}`);
  expect(response.status()).toBe(200);
  const bytes = Buffer.from(await response.body());
  expect(bytes.length).toBe(artifact.bytes);
  expect(sha256(bytes)).toBe(artifact.sha256);
  return bytes;
}

async function stopOwned(request: APIRequestContext, localId: string) {
  await api(request, 'POST', `/assets/lux3d/tasks/${localId}/stop`).catch(() => undefined);
}

test('正例：text-to-3d 仅文本 prompt 即可创建，产品下载的 GLB 可解析且带网格', async ({ request }) => {
  const prompt = 'A low-poly fox figurine standing on a wooden base';
  const created = await create(request, { operation: 'text-to-3d', parameters: { prompt, outputFormat: ['glb'] }, idempotencyKey: 'k-text-3d' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const localId = created.body.localId;
  try {
    const task = await waitTask(request, localId);
    expect(task.stage).toBe('ready');
    const original = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'model' && item.format === 'glb');
    expect(original, JSON.stringify(task.artifacts)).toBeTruthy();
    expect(original!.assetId).toBeTruthy();
    const bytes = await downloadOriginal(request, original!);
    const document = await io.readBinary(new Uint8Array(bytes));
    const meshes = document.getRoot().listMeshes();
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    expect(meshes.some((mesh) => mesh.listPrimitives().some((primitive) => Boolean(primitive.getAttribute('POSITION'))))).toBe(true);
    const stats = await counters();
    expect(stats.creates).toBe(1);
    expect(stats.createAttempts).toBe(1);
    expect(stats.createsLog.map((item) => item.operation)).toEqual(['text-to-3d']);
    const body = stats.createsLog[0].body;
    expect(body.prompt).toBe(prompt);
    expect(body.img).toBeUndefined();
    expect(body.imgs).toBeUndefined();
    writeEvidence('capability-positive-text-to-3d.json', { task, bytes: { length: bytes.length, sha256: sha256(bytes) }, meshes: meshes.length, stats });
  } catch (error) {
    await stopOwned(request, localId);
    throw error;
  }
});

test('正例：image 多模态生图（图+prompt），下载 PNG 校验后将字节回传为本地输入', async ({ request }) => {
  const image = await upl(request, 'image', 'image.png');
  const prompt = 'Turn the reference into a soft clay style icon';
  const created = await create(request, { operation: 'image', parameters: { prompt, imageUploadId: image.id }, idempotencyKey: 'k-image-multimodal' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const localId = created.body.localId;
  try {
    const task = await waitTask(request, localId);
    expect(task.stage).toBe('ready');
    const original = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'image');
    expect(original, JSON.stringify(task.artifacts)).toBeTruthy();
    expect(original!.format).toBe('png');
    expect(task.inputRefs ?? []).toContain(image.id);
    const bytes = await downloadOriginal(request, original!);
    const size = pngSize(bytes);
    expect(size.width).toBeGreaterThan(0);
    expect(size.height).toBeGreaterThan(0);
    const reupload = await uploadBytes(request, { kind: 'image', filename: 'generated.png', bytes });
    expect(reupload.status, JSON.stringify(reupload.body)).toBe(201);
    expect(reupload.body.bytes).toBe(bytes.length);
    expect(reupload.body.sha256).toBe(sha256(bytes));
    const stats = await counters();
    expect(stats.creates).toBe(1);
    expect(stats.createAttempts).toBe(1);
    expect(stats.createsLog.map((item) => item.operation)).toEqual(['image']);
    const body = stats.createsLog[0].body;
    expect(body.prompt).toBe(prompt);
    expect(typeof body.img).toBe('string');
    writeEvidence('capability-positive-image.json', { task, bytes: { length: bytes.length, sha256: sha256(bytes), ...size }, reupload: reupload.body, stats });
  } catch (error) {
    await stopOwned(request, localId);
    throw error;
  }
});

test('正例：articulation-animation 接受 GLB+动作描述，下载产物确有动画通道', async ({ request }) => {
  await control({ scenario: 'animated' });
  const model = await upl(request, 'glb', 'triangle.glb');
  const prompt = 'Slowly wiggle like a rubber toy';
  const created = await create(request, { operation: 'articulation-animation', parameters: { modelUploadId: model.id, prompt }, idempotencyKey: 'k-articulation' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const localId = created.body.localId;
  try {
    const task = await waitTask(request, localId);
    expect(task.stage).toBe('ready');
    const original = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'model' && item.format === 'glb');
    expect(original, JSON.stringify(task.artifacts)).toBeTruthy();
    const bytes = await downloadOriginal(request, original!);
    const document = await io.readBinary(new Uint8Array(bytes));
    const animations = document.getRoot().listAnimations();
    expect(animations.length).toBeGreaterThanOrEqual(1);
    expect(animations[0].listChannels().length).toBeGreaterThanOrEqual(1);
    expect(animations[0].listSamplers().length).toBeGreaterThanOrEqual(1);
    const stats = await counters();
    expect(stats.creates).toBe(1);
    expect(stats.createAttempts).toBe(1);
    expect(stats.createsLog.map((item) => item.operation)).toEqual(['articulation-animation']);
    const body = stats.createsLog[0].body;
    expect(typeof body.glbUrl).toBe('string');
    expect(body.prompt).toBe(prompt);
    writeEvidence('capability-positive-articulation.json', { task, bytes: { length: bytes.length, sha256: sha256(bytes) }, animations: { count: animations.length, channels: animations[0].listChannels().length }, stats });
  } catch (error) {
    await stopOwned(request, localId);
    throw error;
  }
});

test('正例：humanoid-rig 接受 skinned GLB，下载产物确有 skin/joints 与蒙皮属性', async ({ request }) => {
  await control({ scenario: 'skinned' });
  const model = await upl(request, 'glb', 'skinned.glb');
  const created = await create(request, { operation: 'humanoid-rig', parameters: { modelUploadId: model.id }, idempotencyKey: 'k-rig-success' });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const localId = created.body.localId;
  try {
    const task = await waitTask(request, localId);
    expect(task.stage).toBe('ready');
    const original = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'model' && item.format === 'glb');
    expect(original, JSON.stringify(task.artifacts)).toBeTruthy();
    const bytes = await downloadOriginal(request, original!);
    const document = await io.readBinary(new Uint8Array(bytes));
    const root = document.getRoot();
    const skins = root.listSkins();
    expect(skins.length).toBeGreaterThanOrEqual(1);
    expect(skins[0].listJoints().length).toBeGreaterThanOrEqual(1);
    const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
    expect(primitives.some((primitive) => Boolean(primitive.getAttribute('JOINTS_0')) && Boolean(primitive.getAttribute('WEIGHTS_0')))).toBe(true);
    const stats = await counters();
    expect(stats.creates).toBe(1);
    expect(stats.createAttempts).toBe(1);
    expect(stats.createsLog.map((item) => item.operation)).toEqual(['humanoid-rig']);
    const body = stats.createsLog[0].body;
    expect(typeof body.modelUrl).toBe('string');
    writeEvidence('capability-positive-rig.json', { task, bytes: { length: bytes.length, sha256: sha256(bytes) }, skins: skins.length, joints: skins[0].listJoints().length, stats });
  } catch (error) {
    await stopOwned(request, localId);
    throw error;
  }
});
