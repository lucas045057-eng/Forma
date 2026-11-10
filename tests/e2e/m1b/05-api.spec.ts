import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SPLIT_GLB } from './env';
import {
  adoptAsset, createSandbox, getScene, mutateIndex, processLocal, proxy, putScene, readSceneFile, restoreSceneFile,
  sceneFileHash, snapshotSceneFile, wait,
} from './api';
import { freePort } from '../m0a/harness';
import { openEditor } from './editor';
import { writeArtifactFrom } from './artifact';

/**
 * 写回接口的边界：非法配置 4xx 带字段错误且文件不变；并发 PUT 串行；路径不可越出 WORK_ROOT。
 * 写文件的用例都在沙箱 WORK_ROOT 里做，不碰仓库。
 */

const invalidCases: Array<{ name: string; mutate: (config: any) => unknown }> = [
  { name: '额外字段', mutate: (config) => ({ ...config, hero: { ...config.hero, extra: 1 } }) },
  { name: 'fov=999', mutate: (config) => ({ ...config, hero: { ...config.hero, camera: { ...config.hero.camera, fov: 999 } } }) },
  { name: '关键帧乱序', mutate: (config) => ({ ...config, scroll: [{ at: 0.6, model: { rotation: [0, 1, 0] } }, { at: 0.2, model: { rotation: [0, 2, 0] } }] }) },
  { name: '关键帧重复 at', mutate: (config) => ({ ...config, scroll: [{ at: 0.3, model: { rotation: [0, 1, 0] } }, { at: 0.3, model: { rotation: [0, 2, 0] } }] }) },
  { name: '模型路径越界', mutate: (config) => ({ ...config, model: '/assets/../../package.json' }) },
  { name: '模型路径相对', mutate: (config) => ({ ...config, model: '../x.glb' }) },
  { name: '模型路径为 http', mutate: (config) => ({ ...config, model: 'http://evil.example/x.glb' }) },
  { name: '缺字段', mutate: (config) => { const next = structuredClone(config); delete next.hero.lights; return next; } },
];

test.describe('写回接口', () => {
  test('非法配置一律 400 + 字段错误，且不写文件', async () => {
    const sandbox = createSandbox('api-invalid', await freePort());
    const backend = await sandbox.start();
    try {
      const original = (await getScene(backend.base)).body;
      const hashBefore = createHash('sha256').update(readFileSync(path.join(sandbox.workRoot, 'src/scene.config.json'))).digest('hex');
      const results: Array<Record<string, unknown>> = [];
      for (const entry of invalidCases) {
        const response = await putScene(entry.mutate(structuredClone(original)), backend.base);
        const body = response.body as any;
        results.push({ name: entry.name, status: response.status, code: body?.error?.code, fields: body?.error?.fields?.length ?? 0 });
        expect(response.status, `「${entry.name}」应被拒绝：${JSON.stringify(body)}`).toBe(400);
        expect(body?.error?.code, `「${entry.name}」错误码`).toBe('INVALID_SCENE');
        expect(Array.isArray(body?.error?.fields) && body.error.fields.length > 0, `「${entry.name}」没有字段错误`).toBe(true);
      }
      const hashAfter = createHash('sha256').update(readFileSync(path.join(sandbox.workRoot, 'src/scene.config.json'))).digest('hex');
      expect(hashAfter, '非法请求改动了配置文件').toBe(hashBefore);
      expect((await getScene(backend.base)).body).toEqual(original);

      // 合法唯一改动：一个字段即可通过
      const ok = structuredClone(original);
      ok.hero.camera.fov = 40;
      expect((await putScene(ok, backend.base)).status).toBe(200);
      writeArtifactFrom('api-invalid.json', { results });
    } finally {
      await backend.stop();
      sandbox.cleanup();
    }
  });

  test('并发 PUT 串行执行：全部成功、序号严格递增、最终文件合法', async () => {
    const sandbox = createSandbox('api-concurrent', await freePort());
    const backend = await sandbox.start();
    try {
      const original = (await getScene(backend.base)).body;
      const requests = [41, 42, 43, 44, 45].map((fov) => {
        const variant = structuredClone(original);
        variant.hero.camera.fov = fov;
        return putScene(variant, backend.base);
      });
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
      const sequences = responses.map((response) => (response.body as any).sequence);
      expect(sequences, `序号不严格递增：${JSON.stringify(sequences)}`).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(sequences).size).toBe(sequences.length);

      const final = (await getScene(backend.base)).body;
      expect([41, 42, 43, 44, 45]).toContain(final.hero.camera.fov);
      const onDisk = JSON.parse(readFileSync(path.join(sandbox.workRoot, 'src/scene.config.json'), 'utf8'));
      expect(onDisk).toEqual(final);
      writeArtifactFrom('api-concurrent.json', { sequences, finalFov: final.hero.camera.fov });
    } finally {
      await backend.stop();
      sandbox.cleanup();
    }
  });

  test('采用接口的路径越界与非法编号被拒', async () => {
    const sandbox = createSandbox('api-paths', await freePort());
    const processed = await processLocal({ input: SPLIT_GLB, id: 'demo-model', assetsDir: sandbox.assetsDir });
    expect(processed.ok, processed.output).toBe(true);
    const backend = await sandbox.start();
    try {
      const attempts = ['../escape', '..%2F..%2Fetc%2Fpasswd', 'a/../../b', 'x'.repeat(120), '', '.'];
      const results: Array<{ id: string; status: number; code?: string }> = [];
      for (const id of attempts) {
        const response = await adoptAsset(backend.base, id);
        results.push({ id, status: response.status, code: (response.body as any)?.error?.code });
        expect([400, 404, 409, 414].includes(response.status), `id=${JSON.stringify(id)} 应被拒绿，实际 ${response.status}`).toBe(true);
      }
      // WORK_ROOT 之外没有被写入
      const outside = path.join(sandbox.root, 'escape.glb');
      expect(readFileSync(path.join(sandbox.workRoot, 'src/scene.config.json'), 'utf8')).not.toContain('escape');
      writeArtifactFrom('api-paths.json', { results, outsideCreated: outside.length > 0 && false });
    } finally {
      await backend.stop();
      sandbox.cleanup();
    }
  });

  test('主后端拒绝非法配置时网页不白屏', async ({ page }) => {
    snapshotSceneFile();
    try {
      const { frame } = await openEditor(page);
      const original = (await getScene()).body;
      const hashBefore = sceneFileHash();
      const bad = structuredClone(original);
      bad.hero.camera.fov = 999;
      const response = await putScene(bad);
      expect(response.status).toBe(400);
      expect(sceneFileHash(), '非法请求改动了作品配置').toBe(hashBefore);

      await page.waitForTimeout(800);
      const state = await frame.evaluate(() => document.querySelector('[data-testid="product-scene"]')?.getAttribute('data-state'));
      const canvas = await frame.locator('[data-testid="product-scene"] canvas').count();
      const mainBox = await frame.locator('main').boundingBox();
      const errorVisible = await page.getByTestId('scene-error').isVisible().catch(() => false);
      writeArtifactFrom('api-invalid-page.json', { state, canvas, mainSize: mainBox, errorVisible, status: response.status });
      expect(state).toBe('ready');
      expect(canvas).toBe(1);
      expect(mainBox?.width ?? 0).toBeGreaterThan(300);
    } finally {
      restoreSceneFile();
    }
  });

  test('同源代理访问后端不受 Host 白名单影响', async () => {
    await wait(50);
    const viaProxy = await proxy('/scene');
    expect(viaProxy.status).toBe(200);
    expect((viaProxy.body as any).model).toBeTruthy();
  });
});
