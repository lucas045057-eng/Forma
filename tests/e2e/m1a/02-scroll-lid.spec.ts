import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { TEMPLATE_CONFIG } from './env';
import { writeArtifactFrom } from './artifact';
import { openProductPage, productCanvasRect, scrollToAt, waitFor, withTempConfig } from './viewport';
import { captureRegion, comparePixels, silhouette } from './visual';

const shipped = JSON.parse(readFileSync(TEMPLATE_CONFIG, 'utf8')) as {
  model: string;
  hero: { camera: { position: number[]; target: number[]; fov: number }; model: { rotation: number[]; scale: number }; lights: { key: { intensity: number; color: string; direction: number[] }; ambient: number } };
  scroll: Array<{ at: number; model?: { rotation: number[] }; parts?: Record<string, { offset: number[] }> }>;
};

test('滚动关键帧：at≈0.6 时 lid 上移量与配置一致，at=0 复位，中间单调插值', async ({ page }) => {
  const frame = await openProductPage(page);
  await page.waitForTimeout(1_500);

  // ---------- A) 出厂配置：at≈0.6 行为 + 画面确实变化 ----------
  const before = await productCanvasRect(frame);
  const size = Math.floor(before.width);
  const at0 = await scrollToAt(frame, 0);
  expect(at0).toBe(0);
  const beforeBox = await productCanvasRect(frame);
  const baseline = await captureRegion(page, { x: Math.round(beforeBox.x), y: Math.round(beforeBox.y), width: size, height: size });

  const at06 = await scrollToAt(frame, 0.6);
  expect(at06, `滚动没有到达 0.6，实际 ${at06}`).toBeGreaterThan(0.58);
  expect(at06).toBeLessThan(0.62);
  const afterBox = await productCanvasRect(frame);
  // 画布会被滚出一部分，只比较两次都可见的那段画布内容
  const hidden = Math.round(beforeBox.y - afterBox.y);
  const visibleHeight = size - hidden;
  expect(hidden, '预期画布在 at=0.6 时被滚出上面一部分').toBeGreaterThan(0);
  expect(visibleHeight).toBeGreaterThan(300);
  const regionA = await captureRegion(page, { x: Math.round(beforeBox.x), y: Math.round(beforeBox.y) + hidden, width: size, height: visibleHeight });
  const regionB = await captureRegion(page, { x: Math.round(afterBox.x), y: Math.round(afterBox.y) + hidden, width: size, height: visibleHeight });
  const shippedDiff = await comparePixels(regionA.png, regionB.png);
  expect(shippedDiff.changedRatio, `at=0.6 时画面没有变化：${JSON.stringify(shippedDiff)}`).toBeGreaterThan(0.05);

  const shippedFrame = shipped.scroll.find((entry) => Math.abs(entry.at - 0.6) < 1e-6);
  expect(shippedFrame, '出厂配置里应有 at=0.6 的关键帧').toBeTruthy();
  expect(shippedFrame?.parts?.lid?.offset).toEqual([0, 0.08, 0]);
  const shippedZero = shipped.scroll.find((entry) => entry.at === 0);
  expect(shippedZero?.parts?.lid?.offset).toEqual([0, 0, 0]);

  // ---------- B) 临时配置：冻结旋转、把关键帧挪到 0.05，量测像素位移 ----------
  // 理由：出厂配置在 at=0.6 时画布会被滚出视口一部分，且旋转同时变化，
  // 无法把“lid 上移”单独量出来；这里只改关键帧位置与旋转（位移量仍是配置里的 0.08），
  // 换来一次干净的「位移 = 世界位移 × 每单位像素」对照。
  const temp = JSON.stringify({
    model: shipped.model,
    hero: { ...shipped.hero, model: { rotation: [0, 1.0, 0], scale: 1 } },
    scroll: [
      { at: 0, model: { rotation: [0, 1.0, 0] }, parts: { lid: { offset: [0, 0, 0] } } },
      { at: 0.05, model: { rotation: [0, 1.0, 0] }, parts: { lid: { offset: [0, 0.08, 0] } } },
    ],
  });

  const measured = await withTempConfig(temp, async () => {
    // 先把页面滚回顶部，否则画布会被截断，导致区域尺寸不一致
    await scrollToAt(frame, 0);
    // 等到新配置生效：hero 旋转从 0.52 改成 1.0，画面必然变化
    await waitFor(page, async () => {
      const box = await productCanvasRect(frame);
      const shot = await captureRegion(page, { x: Math.round(box.x), y: Math.round(box.y), width: size, height: size });
      const diff = await comparePixels(baseline.png, shot.png);
      return diff.changedRatio > 0.02;
    }, 30_000);

    await scrollToAt(frame, 0);
    const at0Box = await productCanvasRect(frame);
    const shot0 = await captureRegion(page, { x: Math.round(at0Box.x), y: Math.round(at0Box.y), width: size, height: size });
    const shape0 = await silhouette(shot0.png);

    await scrollToAt(frame, 0.025);
    const midBox = await productCanvasRect(frame);
    const shotMid = await captureRegion(page, { x: Math.round(midBox.x), y: Math.round(midBox.y), width: size, height: size });
    const shapeMid = await silhouette(shotMid.png);
    const atMid = await scrollToAt(frame, 0.025);

    await scrollToAt(frame, 0.05);
    const endBox = await productCanvasRect(frame);
    const shotEnd = await captureRegion(page, { x: Math.round(endBox.x), y: Math.round(endBox.y), width: size, height: size });
    const shapeEnd = await silhouette(shotEnd.png);
    const atEnd = await scrollToAt(frame, 0.05);

    // 再回 at=0，确认复位
    await scrollToAt(frame, 0);
    const resetBox = await productCanvasRect(frame);
    const shotReset = await captureRegion(page, { x: Math.round(resetBox.x), y: Math.round(resetBox.y), width: size, height: size });
    const shapeReset = await silhouette(shotReset.png);
    const resetDiff = await comparePixels(shot0.png, shotReset.png);

    return { shape0, shapeMid, shapeEnd, shapeReset, atMid, atEnd, resetDiff };
  });

  const { shape0, shapeMid, shapeEnd, shapeReset, atMid, atEnd, resetDiff } = measured.result;
  const modelHeightPx = shape0.heightPx;
  const expectedFull = 0.08 * modelHeightPx;
  const shiftMid = shape0.bbox.minY - shapeMid.bbox.minY;
  const shiftFull = shape0.bbox.minY - shapeEnd.bbox.minY;
  const shiftReset = Math.abs(shape0.bbox.minY - shapeReset.bbox.minY);

  const artifact = writeArtifactFrom('scroll-lid.json', {
    shipped: {
      at0,
      at06,
      canvas: { size, hidden, visibleHeight },
      changedRatio: shippedDiff.changedRatio,
      keyframes: shipped.scroll,
    },
    measured: {
      note: '临时把关键帧位置改到 0.05、冻结旋转，位移量仍是配置里的 0.08；测量后用原字节还原。',
      atMid,
      atEnd,
      modelHeightPx,
      expectedFullPx: expectedFull,
      shiftMidPx: shiftMid,
      shiftFullPx: shiftFull,
      shiftResetPx: shiftReset,
      ratio: { mid: shiftMid / expectedFull, full: shiftFull / expectedFull },
      bbox: { at0: shape0.bbox, mid: shapeMid.bbox, end: shapeEnd.bbox },
    },
  });
  expect(artifact).toBeTruthy();

  // 文件必须还原成原字节
  expect(readFileSync(TEMPLATE_CONFIG, 'utf8'), 'scene.config.json 没有还原').toEqual(measured.original);

  // 量化断言：位移应接近 8% 模型高度；中间位置约一半；回到 at=0 复位
  expect(shiftFull, `at=0.05 时 lid 没有上移（期望约 ${expectedFull.toFixed(1)}px）`).toBeGreaterThan(expectedFull * 0.7);
  expect(shiftFull).toBeLessThan(expectedFull * 1.4);
  expect(shiftMid, `中间位置插值不对（期望约 ${(expectedFull / 2).toFixed(1)}px）`).toBeGreaterThan(expectedFull * 0.3);
  expect(shiftMid).toBeLessThan(shiftFull * 0.85);
  expect(shiftReset, '回到 at=0 后画面没有复位').toBeLessThan(2);
  expect(resetDiff.changedRatio, '回到 at=0 后画面没有复位').toBeLessThan(0.002);
});
