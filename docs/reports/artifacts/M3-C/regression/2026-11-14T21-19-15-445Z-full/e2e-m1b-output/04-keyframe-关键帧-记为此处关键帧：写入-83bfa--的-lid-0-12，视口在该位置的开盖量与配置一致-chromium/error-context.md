# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-keyframe.spec.ts >> 关键帧 >> 记为此处关键帧：写入 at≈0.55 的 lid=0.12，视口在该位置的开盖量与配置一致
- Location: tests\e2e\m1b\04-keyframe.spec.ts:23:3

# Error details

```
Error: 开盖量变化没有反映到画面上（期望约 15.7px）

expect(received).toBeGreaterThan(expected)

Expected: > 7.869154859999998
Received:   0
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import {
  3   |   captureCanvases, captureStudioCanvas, cropPng, enableCompare, openEditor, readScrollAt, scrollPreview, setSlider,
  4   | } from './editor';
  5   | import { getScene, putScene, readSceneFile, restoreSceneFile, snapshotSceneFile, waitFor } from './api';
  6   | import { compareAligned, silhouette } from '../m1a/visual';
  7   | import { writeArtifactFrom } from './artifact';
  8   | 
  9   | /**
  10  |  * 关键帧：预览滚到某位置 → 调开盖 → 记为此处关键帧 → 该位置姿态与配置一致；
  11  |  * 同 at ±0.02 应覆盖而不是新增。
  12  |  *
  13  |  * 量测方法：作品页在 at>0.2 时画布会被滚出视口上沿、模型顶边拍不到，所以位移量在
  14  |  * **Studio 对照视口**的完整画布上量（对照模式与作品页同 at、同配置、同模型）。
  15  |  * 对照模式会禁用编辑控件，所以“写之前”和“写之后”各进一次对照模式取图。
  16  |  * 另外先把旋转冻结，保证画面里唯一的位移来自开盖。
  17  |  */
  18  | 
  19  | test.describe('关键帧', () => {
  20  |   test.beforeAll(() => { snapshotSceneFile(); });
  21  |   test.afterAll(() => { expect(restoreSceneFile().matches, 'scene.config.json 没有还原').toBe(true); });
  22  | 
  23  |   test('记为此处关键帧：写入 at≈0.55 的 lid=0.12，视口在该位置的开盖量与配置一致', async ({ page }) => {
  24  |     const { frame } = await openEditor(page);
  25  |     const at = await scrollPreview(page, frame, 0.55);
  26  |     expect(at).toBeGreaterThan(0.52);
  27  |     expect(at).toBeLessThan(0.58);
  28  | 
  29  |     // 冻结旋转：旋转不随 at 变化，画面位移只可能来自开盖
  30  |     const base = (await getScene()).body;
  31  |     const frozen = structuredClone(base);
  32  |     const poseRotation = frozen.hero.model.rotation;
  33  |     frozen.scroll = [
  34  |       { at: 0, model: { rotation: poseRotation }, parts: { lid: { offset: [0, 0, 0] } } },
  35  |       { at: 0.6, model: { rotation: poseRotation }, parts: { lid: { offset: [0, 0.08, 0] } } },
  36  |     ];
  37  |     expect((await putScene(frozen)).status).toBe(200);
  38  |     await page.getByTestId('scene-load').click();
  39  |     await page.waitForTimeout(1_200);
  40  | 
  41  |     // 写之前：进对照模式取一张完整画布
  42  |     await enableCompare(page);
  43  |     const before = await captureStudioCanvas(page);
  44  |     const shapeBefore = await silhouette(before.png);
  45  |     const t = at / 0.6;
  46  |     const interpolated = 0.08 * (t * t * (3 - 2 * t));
  47  | 
  48  |     // 退出对照（否则编辑控件被禁用）→ 调开盖 → 记为此处关键帧
  49  |     await page.getByTestId('scene-compare').uncheck();
  50  |     await page.waitForTimeout(400);
  51  |     await setSlider(page, 'scene-lid', 0.12);
  52  |     await page.getByTestId('scene-save-keyframe').click();
  53  |     const updateMs = await waitFor(async () => {
  54  |       const config = readSceneFile();
  55  |       return config.scroll.some((entry) => Math.abs(entry.at - at) <= 0.021 && Math.abs((entry.parts?.lid?.offset?.[1] ?? -1) - 0.12) < 1e-3);
  56  |     }, 30_000, 150);
  57  | 
  58  |     // 写之后：再进对照模式取一张，量顶边位移
  59  |     await enableCompare(page);
  60  |     await page.waitForTimeout(600);
  61  |     const after = await captureStudioCanvas(page);
  62  |     const shapeAfter = await silhouette(after.png);
  63  |     const shiftPx = shapeBefore.bbox.minY - shapeAfter.bbox.minY;
  64  |     const expectedPx = (0.12 - interpolated) * shapeBefore.heightPx;
  65  | 
  66  |     const config = readSceneFile();
  67  |     const framesAt = config.scroll.filter((entry) => Math.abs(entry.at - at) <= 0.021);
  68  |     expect(framesAt.length, `关键帧数量不对：${JSON.stringify(config.scroll.map((entry) => entry.at))}`).toBe(1);
  69  |     expect(framesAt[0].at).toBeCloseTo(at, 2);
  70  | 
  71  |     // 该位置：作品页与对照视口一致（= 网页姿态与配置一致）
  72  |     const pair = await captureCanvases(page, frame);
  73  |     const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
  74  | 
  75  |     writeArtifactFrom('keyframe-write.json', {
  76  |       at,
  77  |       configUpdateMs: updateMs,
  78  |       interpolatedBefore: interpolated,
  79  |       expectedShiftPx: expectedPx,
  80  |       measuredShiftPx: shiftPx,
  81  |       modelHeightPx: shapeBefore.heightPx,
  82  |       ratio: shiftPx / expectedPx,
  83  |       consistencyAtFrame: { changed: aligned.changedRatio, visibleHeight: pair.preview.visibleHeight },
  84  |       frames: config.scroll.map((entry) => ({ at: entry.at, lid: entry.parts?.lid?.offset ?? null })),
  85  |     });
  86  | 
> 87  |     expect(shiftPx, `开盖量变化没有反映到画面上（期望约 ${expectedPx.toFixed(1)}px）`).toBeGreaterThan(expectedPx * 0.5);
      |                                                                      ^ Error: 开盖量变化没有反映到画面上（期望约 15.7px）
  88  |     expect(shiftPx).toBeLessThan(expectedPx * 1.6);
  89  |     expect(aligned.changedRatio, `关键帧位置两边画面不一致：${aligned.changedRatio}`).toBeLessThan(0.01);
  90  | 
  91  |     // 同 at ±0.02 内再写一次：应覆盖而不是新增
  92  |     await page.getByTestId('scene-compare').uncheck();
  93  |     await page.waitForTimeout(400);
  94  |     const at2 = await scrollPreview(page, frame, Math.min(0.99, at + 0.01));
  95  |     await setSlider(page, 'scene-lid', 0.05);
  96  |     await page.getByTestId('scene-save-keyframe').click();
  97  |     await page.waitForTimeout(1_500);
  98  |     const afterSecond = readSceneFile();
  99  |     const nearby = afterSecond.scroll.filter((entry) => Math.abs(entry.at - at2) <= 0.021);
  100 |     expect(nearby.length, `±0.02 内应只有一帧：${JSON.stringify(afterSecond.scroll.map((entry) => entry.at))}`).toBe(1);
  101 |     expect(nearby[0].at).toBeCloseTo(at2, 2);
  102 |     expect(nearby[0].parts?.lid?.offset?.[1]).toBeCloseTo(0.05, 3);
  103 | 
  104 |     writeArtifactFrom('keyframe-overwrite.json', {
  105 |       at2,
  106 |       frames: afterSecond.scroll.map((entry) => ({ at: entry.at, lid: entry.parts?.lid?.offset ?? null })),
  107 |     });
  108 |   });
  109 | 
  110 |   test('出厂配置滚到 0.6：画面确实进入开盖姿态', async ({ page }) => {
  111 |     // 上一个用例改过配置（冻结旋转 + 新关键帧），这里先还原成出厂配置
  112 |     expect(restoreSceneFile().matches, '还原出厂配置失败').toBe(true);
  113 |     const original = readSceneFile();
  114 |     expect(JSON.stringify(original).includes('diffuser-4969889')).toBe(true);
  115 |     const { frame } = await openEditor(page);
  116 |     await page.waitForTimeout(1_500);
  117 |     const at0 = await captureCanvases(page, frame);
  118 |     const shape0 = await silhouette(at0.preview.png);
  119 |     await scrollPreview(page, frame, 0.6);
  120 |     await page.waitForTimeout(900);
  121 |     const at6 = await captureCanvases(page, frame);
  122 |     const shape6 = await silhouette(at6.preview.png);
  123 |     expect(await readScrollAt(page)).toBeGreaterThan(0.58);
  124 | 
  125 |     // 画布被滚出上沿一部分：把 at=0 的截图裁到同一批画布行再比较
  126 |     const offset = at6.preview.offsetY;
  127 |     const cropped = offset > 0 ? await cropPng(at0.preview.png, offset, at6.preview.visibleHeight) : at0.preview.png;
  128 |     const changed = await compareAligned(cropped, at6.preview.png, 3);
  129 | 
  130 |     writeArtifactFrom('keyframe-scroll-shipped.json', {
  131 |       shape0: shape0.bbox, shape6: shape6.bbox, offset, visibleHeight: at6.preview.visibleHeight, changed: changed.changedRatio,
  132 |     });
  133 |     expect(changed.changedRatio, '滚到 0.6 后画面没有变化').toBeGreaterThan(0.02);
  134 |   });
  135 | });
  136 | 
```