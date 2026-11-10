import { expect, test } from '@playwright/test';
import { ARTIFACT_DIR } from './env';
import { getScene, putScene, sameJson, snapshotSceneFile, restoreSceneFile, readSceneFile, waitFor } from './api';
import { captureCanvases, enableCompare, openEditor, readPanelConfig, readScrollAt, scrollPreview, setSlider } from './editor';
import { compareAligned, compareNormalized } from '../m1a/visual';
import { writeArtifactFrom } from './artifact';

/**
 * M1 过关核心：工作台视口与作品页呈现一致。
 *
 * 接点来自 M1-B（scene-load → scene-match-size → scene-compare）：对照模式下 Studio 用
 * GET /scene 的已保存配置 + 同一个 modelUrl + 同一个 iframe 滚动位置渲染，隐藏所有手柄。
 * 阈值沿用 M1-A 的口径：对齐后同尺寸 < 0.5%，归一化 512² < 2%（理由见 M1-A 报告：
 * 两个独立 WebGL 渲染的抗锯齿差异只应出现在模型边缘，模型周长是千级像素）。
 */

const ALIGNED_THRESHOLD = 0.005;
const NORMALIZED_THRESHOLD = 0.02;

test.describe('一致性与配置来源', () => {
  test.beforeAll(() => { snapshotSceneFile(); });
  test.afterAll(() => {
    const { matches } = restoreSceneFile();
    expect(matches, 'scene.config.json 没有还原').toBe(true);
  });

  test('① 出厂配置：Studio 对照视口与作品页同尺寸画面一致，且用的是作品当前配置', async ({ page }) => {
    const { frame } = await openEditor(page);
    const server = await getScene();
    expect(server.status).toBe(200);

    await enableCompare(page);
    const panel = await readPanelConfig(page);
    // R1：Studio 读的必须是作品当前配置（对照模式下 scene-config 就是 GET /scene 的内容）
    expect(sameJson(panel, server.body), `面板配置与 GET /scene 不一致：${JSON.stringify(panel)}`).toBe(true);

    const pair = await captureCanvases(page, frame);
    const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
    const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);

    writeArtifactFrom('consistency-default.json', {
      config: panel,
      canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight, backing: pair.backing },
      diff: { aligned, normalized },
      threshold: { aligned: ALIGNED_THRESHOLD, normalized: NORMALIZED_THRESHOLD },
    });

    expect(pair.backing.preview, '两个画布的 backing 尺寸不一致').toBe(pair.backing.studio);
    expect(aligned.changedRatio, `出厂配置一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
    expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  });

  test('② 经 Studio 改动并经 PUT /scene 写入明显不同的相机后，两边仍然一致', async ({ page }) => {
    const { frame } = await openEditor(page);
    await enableCompare(page);

    // 先在 Studio 里改角度/环境光/主光，再“设为首屏”
    await setSlider(page, 'scene-rotation-y', 1.9);
    await setSlider(page, 'scene-ambient', 2.4);
    await setSlider(page, 'scene-key-intensity', 4.2);
    await setSlider(page, 'scene-temperature', 5200);
    const baseline = await captureCanvases(page, frame);
    await page.getByTestId('scene-save-hero').click();
    // 作品页通过 HMR 更新（不是整页刷新）
    const ms = await waitFor(async () => {
      const current = await captureCanvases(page, frame);
      return (await compareAligned(baseline.preview.png, current.preview.png, 3)).changedRatio > 0.02;
    }, 30_000, 250);

    const afterHero = (await getScene()).body;
    expect(afterHero.hero.lights.ambient).toBeCloseTo(2.4, 1);
    expect(afterHero.hero.model.rotation[1]).toBeCloseTo(1.9, 1);

    // 再用 PUT /scene 写一份相机/fov 明显不同的配置（模拟“改相机后设为首屏”）
    const variant = structuredClone(afterHero);
    variant.hero.camera = { position: [2.4, 1.5, 2.4], target: [0, 0.45, 0], fov: 42 };
    variant.hero.lights.key.color = '#9fd0ff';
    const written = await putScene(variant);
    expect(written.status, JSON.stringify(written.body)).toBe(200);

    await enableCompare(page);
    const panel = await readPanelConfig(page);
    expect(sameJson(panel, (await getScene()).body), '改配置后 Studio 仍没读到作品配置').toBe(true);
    await page.waitForTimeout(900);

    const pair = await captureCanvases(page, frame);
    const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
    const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);

    writeArtifactFrom('consistency-after-edit.json', {
      writeLatencyMs: ms,
      heroConfig: afterHero.hero,
      writtenCamera: variant.hero.camera,
      config: panel,
      canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight },
      diff: { aligned, normalized },
    });

    expect(aligned.changedRatio, `改动后一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
    expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  });

  test('③ 滚动到 at≈0.6（开盖姿态）时两边仍然一致', async ({ page }) => {
    const { frame } = await openEditor(page);
    await enableCompare(page);
    const at = await scrollPreview(page, frame, 0.6);
    expect(at, `滚动没到 0.6：${at}`).toBeGreaterThan(0.58);
    expect(at).toBeLessThan(0.62);
    await page.waitForTimeout(900);

    const panel = await readPanelConfig(page);
    const server = await getScene();
    expect(sameJson(panel, server.body), '滚动后 Studio 配置与作品配置不一致').toBe(true);
    expect(panel.scroll.some((frame: { at: number }) => Math.abs(frame.at - 0.6) < 1e-6), '配置里没有 at=0.6 的关键帧').toBe(true);

    const pair = await captureCanvases(page, frame);
    const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
    const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);
    const file = readSceneFile();

    writeArtifactFrom('consistency-scroll-06.json', {
      at,
      panelAt: await readScrollAt(page),
      configFrames: file.scroll.map((frame) => frame.at),
      canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight, hiddenTop: pair.preview.offsetY },
      diff: { aligned, normalized },
    });

    expect(aligned.changedRatio, `at≈0.6 一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
    expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  });

  test('还有：对照模式画的确实是 3D（不是空画布）', async ({ page }) => {
    const { frame } = await openEditor(page);
    await enableCompare(page);
    const pair = await captureCanvases(page, frame);
    const { silhouette } = await import('../m1a/visual');
    const shape = await silhouette(pair.studio.png);
    expect(shape.pixelCount, `对照视口画布几乎是空的：${JSON.stringify(shape)}`).toBeGreaterThan(2_000);
    expect(shape.heightPx).toBeGreaterThan(100);
    writeArtifactFrom('consistency-canvas-content.json', { studio: shape, artifactDir: ARTIFACT_DIR });
  });
});
