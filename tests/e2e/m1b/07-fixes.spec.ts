import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BACKEND_LAUNCHER, M1B_DATA, SCENE_CONFIG, SERVER_DIR, SINGLE_GLB, TEMPLATE_ASSETS } from './env';
import {
  createSandbox, getScene, processLocal, rawRequest, readSceneFile, restoreSceneFile, sceneFileHash, snapshotSceneFile, waitFor,
} from './api';
import { freePort } from '../m0a/harness';
import { captureStudioCanvas, enableCompare, openEditor, scrollPreview, setSlider } from './editor';
import { compareAligned, silhouette } from '../m1a/visual';
import { writeArtifactFrom } from './artifact';

const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));
const BASE_CONFIG = JSON.parse(readFileSync(SCENE_CONFIG, 'utf8'));

/** 冻结旋转、只保留开盖轨道的临时配置（模型可替换）。 */
function frozenConfig(model: string, lidAt06 = 0.12): string {
  const rotation = [0, 1.0, 0];
  return JSON.stringify({
    ...BASE_CONFIG,
    model,
    hero: { ...BASE_CONFIG.hero, model: { rotation, scale: 1 } },
    scroll: [
      { at: 0, model: { rotation }, parts: { lid: { offset: [0, 0, 0] } } },
      { at: 0.6, model: { rotation }, parts: { lid: { offset: [0, lidAt06, 0] } } },
    ],
  }, null, 2);
}

async function gltfIo() {
  const { NodeIO } = requireFromServer('@gltf-transform/core');
  const { ALL_EXTENSIONS } = requireFromServer('@gltf-transform/extensions');
  const { MeshoptDecoder } = requireFromServer('meshoptimizer');
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
}

test.describe('审查整改项', () => {
  test('R2：识别失败但源模型自带 lid/spatialPart 的 GLB，处理后不再被开盖轨道移动', async ({ page }) => {
    snapshotSceneFile();
    const fakeSource = path.join(M1B_DATA, 'fake-lid.glb');
    const fakeHosted = path.join(TEMPLATE_ASSETS, 'test-fakelid.glb');
    let sandbox: ReturnType<typeof createSandbox> | null = null;
    try {
      // 1) 造一个“识别失败但带 lid 标记”的模型：单 mesh 改名 lid 并打上 spatialPart
      const io = await gltfIo();
      const document = await io.readBinary(new Uint8Array(readFileSync(SINGLE_GLB)));
      const node = document.getRoot().listNodes()[0];
      node.setName('lid');
      node.setExtras({ ...(node.getExtras() as Record<string, unknown>), spatialPart: 'lid' });
      await io.write(fakeSource, document);

      // 2) 过管线处理（识别应当失败，且源模型自带的标记要被清掉）
      sandbox = createSandbox('r2-lid', await freePort());
      const processed = await processLocal({ input: fakeSource, id: 'fake-lid', assetsDir: sandbox.assetsDir });
      expect(processed.ok, processed.output).toBe(true);
      const index = JSON.parse(readFileSync(path.join(sandbox.assetsDir, 'index.json'), 'utf8')) as any[];
      const entry = index.find((item) => item.id === 'fake-lid');
      expect(entry?.metrics?.parts?.recognized, '单 mesh 模型不该被识别出部件').toBe(false);

      const outputModel = path.join(sandbox.assetsDir, 'fake-lid', 'model.glb');
      const output = await io.readBinary(new Uint8Array(readFileSync(outputModel)));
      const marked = output.getRoot().listNodes()
        .filter((item) => (item.getExtras() as Record<string, unknown>).spatialPart !== undefined)
        .map((item) => item.getName());
      expect(marked, `识别失败时源模型自带的 spatialPart 没被清除：${JSON.stringify(marked)}`).toEqual([]);

      // 3) 放进作品目录（临时），冻结旋转，只留开盖轨道
      copyFileSync(outputModel, fakeHosted);
      writeFileSync(SCENE_CONFIG, frozenConfig('/assets/test-fakelid.glb'), 'utf8');

      const { frame } = await openEditor(page);
      await enableCompare(page);
      await scrollPreview(page, frame, 0);
      await page.waitForTimeout(600);
      const fakeAt0 = await captureStudioCanvas(page);
      await scrollPreview(page, frame, 0.6);
      await page.waitForTimeout(800);
      const fakeAt6 = await captureStudioCanvas(page);
      const fakeShape0 = await silhouette(fakeAt0.png);
      const fakeShape6 = await silhouette(fakeAt6.png);
      const shiftFake = fakeShape0.bbox.minY - fakeShape6.bbox.minY;
      const changedFake = await compareAligned(fakeAt0.png, fakeAt6.png, 3);

      // 4) 出厂模型 + 同一份临时配置：应当正常开盖
      writeFileSync(SCENE_CONFIG, frozenConfig('/assets/diffuser-4969889.glb'), 'utf8');
      await enableCompare(page);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="scene-viewport"]')?.getAttribute('data-loaded') === 'true',
        undefined,
        { timeout: 60_000 },
      );
      await scrollPreview(page, frame, 0);
      await page.waitForTimeout(800);
      const goodAt0 = await captureStudioCanvas(page);
      await scrollPreview(page, frame, 0.6);
      await page.waitForTimeout(800);
      const goodAt6 = await captureStudioCanvas(page);
      const goodShape0 = await silhouette(goodAt0.png);
      const goodShape6 = await silhouette(goodAt6.png);
      const shiftGood = goodShape0.bbox.minY - goodShape6.bbox.minY;
      const expectedGood = 0.12 * goodShape0.heightPx;

      writeArtifactFrom('fix-r2-lid-gating.json', {
        fake: { recognized: entry?.metrics?.parts?.recognized, markedNodes: marked, shiftPx: shiftFake, changed: changedFake.changedRatio, heightPx: fakeShape0.heightPx },
        factory: { shiftPx: shiftGood, expectedPx: expectedGood, heightPx: goodShape0.heightPx, ratio: shiftGood / expectedGood },
      });

      expect(Math.abs(shiftFake), `识别失败时 lid 节点仍被移动了（位移 ${shiftFake}px）`).toBeLessThanOrEqual(2);
      expect(shiftGood, `出厂模型没有正常开盖（位移 ${shiftGood}px，期望约 ${expectedGood.toFixed(0)}px）`).toBeGreaterThan(expectedGood * 0.5);
    } finally {
      restoreSceneFile();
      sandbox?.cleanup();
      rmSync(fakeHosted, { force: true });
      rmSync(fakeSource, { force: true });
      expect(existsSync(fakeHosted)).toBe(false);
    }
  });

  test('R3：第二个后端实例被资产目录锁拒绝，第一个不受影响；强杀后锁能接管', async () => {
    const sandbox = createSandbox('r3-lock', await freePort());
    const processed = await processLocal({ input: SINGLE_GLB, id: 'lock-model', assetsDir: sandbox.assetsDir });
    expect(processed.ok, processed.output).toBe(true);

    const first = await sandbox.start();
    let third: Awaited<ReturnType<typeof sandbox.start>> | null = null;
    try {
      const indexFile = path.join(sandbox.assetsDir, 'index.json');
      const indexHash = sceneFileHash(indexFile);
      const secondPort = await freePort();
      const second = await new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(process.execPath, [BACKEND_LAUNCHER], {
          cwd: SERVER_DIR,
          env: {
            ...process.env,
            PORT: String(secondPort),
            WORK_ROOT: sandbox.workRoot,
            SCENE_HISTORY_DIR: sandbox.historyDir,
            ASSETS_DIR: sandbox.assetsDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += String(chunk); });
        child.stderr.on('data', (chunk) => { output += String(chunk); });
        child.once('exit', (code) => resolve({ code, output }));
        setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
      });

      expect(second.code, `第二个实例没有失败退出：${second.output}`).not.toBe(0);
      expect(second.output).toContain('INSTANCE_LOCKED');
      // 第一个实例的数据没被碰
      expect(sceneFileHash(indexFile), '第二个实例改动了索引').toBe(indexHash);
      expect(existsSync(path.join(sandbox.assetsDir, 'lock-model', 'model.glb'))).toBe(true);
      expect((await getScene(first.base)).status).toBe(200);

      // 强杀第一个：锁文件残留，下一个实例应能接管
      await first.stop();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const lockLeft = existsSync(path.join(sandbox.assetsDir, '.instance.lock'));
      third = await sandbox.start();
      const takeover = (await getScene(third.base)).status;

      writeArtifactFrom('fix-r3-instance-lock.json', {
        secondExit: { code: second.code, hasLockedMessage: second.output.includes('INSTANCE_LOCKED') },
        indexUnchanged: true,
        artifactIntact: true,
        lockFileLeft: lockLeft,
        takeoverStatus: takeover,
      });
      expect(takeover).toBe(200);
    } finally {
      await third?.stop();
      await first.stop().catch(() => {});
      sandbox.cleanup();
    }
  });

  test('B1：非本机 Host/Origin 被 403 HOST_DENIED，经 Studio 代理的正常请求不受影响', async () => {
    const evil = await rawRequest({ host: 'evil.example:3001', pathname: '/assets', origin: 'http://evil.example:3001' });
    expect(evil.status, `evil Host 没被拒：${evil.text}`).toBe(403);
    expect(evil.text).toContain('HOST_DENIED');

    const evilOriginOnly = await rawRequest({ host: '127.0.0.1:3001', pathname: '/assets', origin: 'http://evil.example:3001' });
    expect(evilOriginOnly.status).toBe(403);

    const loopback = await rawRequest({ host: '127.0.0.1:3001', pathname: '/assets' });
    expect(loopback.status).toBe(200);

    // 经 Studio 的 Vite 代理（Host 为 127.0.0.1:5173，仍是 loopback）
    const viaProxy = await rawRequest({ host: '127.0.0.1:5173', pathname: '/assets', port: 5173 });
    expect(viaProxy.status).toBe(200);

    writeArtifactFrom('fix-b1-host.json', {
      evil: { status: evil.status, body: evil.text.slice(0, 120) },
      evilOriginOnly: evilOriginOnly.status,
      loopback: loopback.status,
      viaProxy: viaProxy.status,
    });
  });

  test('S1：从 +π 附近调到 −π 附近记关键帧，写入的是展开后的短弧角度', async ({ page }) => {
    snapshotSceneFile();
    try {
      const { frame } = await openEditor(page);
      const reference = readSceneFile().hero.model.rotation[1];
      const at = await scrollPreview(page, frame, 0.5);
      await setSlider(page, 'scene-rotation-y', -3.1);
      await page.getByTestId('scene-save-keyframe').click();
      await waitFor(() => readSceneFile().scroll.some((entry) => Math.abs(entry.at - at) <= 0.021), 20_000, 150);

      const config = readSceneFile();
      const written = config.scroll.find((entry) => Math.abs(entry.at - at) <= 0.021)!;
      const angle = written.model!.rotation[1];
      writeArtifactFrom('fix-s1-unwrap.json', { at, reference, sliderValue: -3.1, writtenAngle: angle, shortArc: Math.abs(angle - reference) < Math.PI });

      expect(angle, `角度没有展开：${angle}`).toBeGreaterThan(Math.PI);
      expect(angle).toBeLessThan(Math.PI + 0.2);
      expect(Math.abs(angle - reference), '写入的角度不是短弧').toBeLessThan(Math.PI);
    } finally {
      restoreSceneFile();
      expect(readFileSync(SCENE_CONFIG, 'utf8')).toContain('"at": 0.6');
    }
  });
});
