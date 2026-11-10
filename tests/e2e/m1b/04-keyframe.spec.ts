import { expect, test } from '@playwright/test';
import {
  captureCanvases, captureStudioCanvas, cropPng, enableCompare, openEditor, readScrollAt, scrollPreview, setSlider,
} from './editor';
import { getScene, putScene, readSceneFile, restoreSceneFile, snapshotSceneFile, waitFor } from './api';
import { compareAligned, silhouette } from '../m1a/visual';
import { writeArtifactFrom } from './artifact';

/**
 * 关键帧：预览滚到某位置 → 调开盖 → 记为此处关键帧 → 该位置姿态与配置一致；
 * 同 at ±0.02 应覆盖而不是新增。
 *
 * 量测方法：作品页在 at>0.2 时画布会被滚出视口上沿、模型顶边拍不到，所以位移量在
 * **Studio 对照视口**的完整画布上量（对照模式与作品页同 at、同配置、同模型）。
 * 对照模式会禁用编辑控件，所以“写之前”和“写之后”各进一次对照模式取图。
 * 另外先把旋转冻结，保证画面里唯一的位移来自开盖。
 */

test.describe('关键帧', () => {
  test.beforeAll(() => { snapshotSceneFile(); });
  test.afterAll(() => { expect(restoreSceneFile().matches, 'scene.config.json 没有还原').toBe(true); });

  test('记为此处关键帧：写入 at≈0.55 的 lid=0.12，视口在该位置的开盖量与配置一致', async ({ page }) => {
    const { frame } = await openEditor(page);
    const at = await scrollPreview(page, frame, 0.55);
    expect(at).toBeGreaterThan(0.52);
    expect(at).toBeLessThan(0.58);

    // 冻结旋转：旋转不随 at 变化，画面位移只可能来自开盖
    const base = (await getScene()).body;
    const frozen = structuredClone(base);
    const poseRotation = frozen.hero.model.rotation;
    frozen.scroll = [
      { at: 0, model: { rotation: poseRotation }, parts: { lid: { offset: [0, 0, 0] } } },
      { at: 0.6, model: { rotation: poseRotation }, parts: { lid: { offset: [0, 0.08, 0] } } },
    ];
    expect((await putScene(frozen)).status).toBe(200);
    await page.getByTestId('scene-load').click();
    await page.waitForTimeout(1_200);

    // 写之前：进对照模式取一张完整画布
    await enableCompare(page);
    const before = await captureStudioCanvas(page);
    const shapeBefore = await silhouette(before.png);
    const t = at / 0.6;
    const interpolated = 0.08 * (t * t * (3 - 2 * t));

    // 退出对照（否则编辑控件被禁用）→ 调开盖 → 记为此处关键帧
    await page.getByTestId('scene-compare').uncheck();
    await page.waitForTimeout(400);
    await setSlider(page, 'scene-lid', 0.12);
    await page.getByTestId('scene-save-keyframe').click();
    const updateMs = await waitFor(async () => {
      const config = readSceneFile();
      return config.scroll.some((entry) => Math.abs(entry.at - at) <= 0.021 && Math.abs((entry.parts?.lid?.offset?.[1] ?? -1) - 0.12) < 1e-3);
    }, 30_000, 150);

    // 写之后：再进对照模式取一张，量顶边位移
    await enableCompare(page);
    await page.waitForTimeout(600);
    const after = await captureStudioCanvas(page);
    const shapeAfter = await silhouette(after.png);
    const shiftPx = shapeBefore.bbox.minY - shapeAfter.bbox.minY;
    const expectedPx = (0.12 - interpolated) * shapeBefore.heightPx;

    const config = readSceneFile();
    const framesAt = config.scroll.filter((entry) => Math.abs(entry.at - at) <= 0.021);
    expect(framesAt.length, `关键帧数量不对：${JSON.stringify(config.scroll.map((entry) => entry.at))}`).toBe(1);
    expect(framesAt[0].at).toBeCloseTo(at, 2);

    // 该位置：作品页与对照视口一致（= 网页姿态与配置一致）
    const pair = await captureCanvases(page, frame);
    const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);

    writeArtifactFrom('keyframe-write.json', {
      at,
      configUpdateMs: updateMs,
      interpolatedBefore: interpolated,
      expectedShiftPx: expectedPx,
      measuredShiftPx: shiftPx,
      modelHeightPx: shapeBefore.heightPx,
      ratio: shiftPx / expectedPx,
      consistencyAtFrame: { changed: aligned.changedRatio, visibleHeight: pair.preview.visibleHeight },
      frames: config.scroll.map((entry) => ({ at: entry.at, lid: entry.parts?.lid?.offset ?? null })),
    });

    expect(shiftPx, `开盖量变化没有反映到画面上（期望约 ${expectedPx.toFixed(1)}px）`).toBeGreaterThan(expectedPx * 0.5);
    expect(shiftPx).toBeLessThan(expectedPx * 1.6);
    expect(aligned.changedRatio, `关键帧位置两边画面不一致：${aligned.changedRatio}`).toBeLessThan(0.01);

    // 同 at ±0.02 内再写一次：应覆盖而不是新增
    await page.getByTestId('scene-compare').uncheck();
    await page.waitForTimeout(400);
    const at2 = await scrollPreview(page, frame, Math.min(0.99, at + 0.01));
    await setSlider(page, 'scene-lid', 0.05);
    await page.getByTestId('scene-save-keyframe').click();
    await page.waitForTimeout(1_500);
    const afterSecond = readSceneFile();
    const nearby = afterSecond.scroll.filter((entry) => Math.abs(entry.at - at2) <= 0.021);
    expect(nearby.length, `±0.02 内应只有一帧：${JSON.stringify(afterSecond.scroll.map((entry) => entry.at))}`).toBe(1);
    expect(nearby[0].at).toBeCloseTo(at2, 2);
    expect(nearby[0].parts?.lid?.offset?.[1]).toBeCloseTo(0.05, 3);

    writeArtifactFrom('keyframe-overwrite.json', {
      at2,
      frames: afterSecond.scroll.map((entry) => ({ at: entry.at, lid: entry.parts?.lid?.offset ?? null })),
    });
  });

  test('出厂配置滚到 0.6：画面确实进入开盖姿态', async ({ page }) => {
    // 上一个用例改过配置（冻结旋转 + 新关键帧），这里先还原成出厂配置
    expect(restoreSceneFile().matches, '还原出厂配置失败').toBe(true);
    const original = readSceneFile();
    expect(JSON.stringify(original).includes('diffuser-4969889')).toBe(true);
    const { frame } = await openEditor(page);
    await page.waitForTimeout(1_500);
    const at0 = await captureCanvases(page, frame);
    const shape0 = await silhouette(at0.preview.png);
    await scrollPreview(page, frame, 0.6);
    await page.waitForTimeout(900);
    const at6 = await captureCanvases(page, frame);
    const shape6 = await silhouette(at6.preview.png);
    expect(await readScrollAt(page)).toBeGreaterThan(0.58);

    // 画布被滚出上沿一部分：把 at=0 的截图裁到同一批画布行再比较
    const offset = at6.preview.offsetY;
    const cropped = offset > 0 ? await cropPng(at0.preview.png, offset, at6.preview.visibleHeight) : at0.preview.png;
    const changed = await compareAligned(cropped, at6.preview.png, 3);

    writeArtifactFrom('keyframe-scroll-shipped.json', {
      shape0: shape0.bbox, shape6: shape6.bbox, offset, visibleHeight: at6.preview.visibleHeight, changed: changed.changedRatio,
    });
    expect(changed.changedRatio, '滚到 0.6 后画面没有变化').toBeGreaterThan(0.02);
  });
});
