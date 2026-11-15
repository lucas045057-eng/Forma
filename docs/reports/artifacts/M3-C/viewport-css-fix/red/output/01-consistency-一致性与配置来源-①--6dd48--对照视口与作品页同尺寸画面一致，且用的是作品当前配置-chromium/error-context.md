# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-consistency.spec.ts >> 一致性与配置来源 >> ① 出厂配置：Studio 对照视口与作品页同尺寸画面一致，且用的是作品当前配置
- Location: tests\e2e\m1b\01-consistency.spec.ts:27:3

# Error details

```
Error: 出厂配置一致性超阈值：{"shift":{"x":0,"y":0},"changed":0.005291005291005291,"mean":2.818167184569301}

expect(received).toBeLessThan(expected)

Expected: < 0.005
Received:   0.005291005291005291
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { ARTIFACT_DIR } from './env';
  3   | import { getScene, putScene, sameJson, snapshotSceneFile, restoreSceneFile, readSceneFile, waitFor } from './api';
  4   | import { captureCanvases, enableCompare, openEditor, readPanelConfig, readScrollAt, scrollPreview, setSlider } from './editor';
  5   | import { compareAligned, compareNormalized } from '../m1a/visual';
  6   | import { writeArtifactFrom } from './artifact';
  7   | 
  8   | /**
  9   |  * M1 过关核心：工作台视口与作品页呈现一致。
  10  |  *
  11  |  * 接点来自 M1-B（scene-load → scene-match-size → scene-compare）：对照模式下 Studio 用
  12  |  * GET /scene 的已保存配置 + 同一个 modelUrl + 同一个 iframe 滚动位置渲染，隐藏所有手柄。
  13  |  * 阈值沿用 M1-A 的口径：对齐后同尺寸 < 0.5%，归一化 512² < 2%（理由见 M1-A 报告：
  14  |  * 两个独立 WebGL 渲染的抗锯齿差异只应出现在模型边缘，模型周长是千级像素）。
  15  |  */
  16  | 
  17  | const ALIGNED_THRESHOLD = 0.005;
  18  | const NORMALIZED_THRESHOLD = 0.02;
  19  | 
  20  | test.describe('一致性与配置来源', () => {
  21  |   test.beforeAll(() => { snapshotSceneFile(); });
  22  |   test.afterAll(() => {
  23  |     const { matches } = restoreSceneFile();
  24  |     expect(matches, 'scene.config.json 没有还原').toBe(true);
  25  |   });
  26  | 
  27  |   test('① 出厂配置：Studio 对照视口与作品页同尺寸画面一致，且用的是作品当前配置', async ({ page }) => {
  28  |     const { frame } = await openEditor(page);
  29  |     const server = await getScene();
  30  |     expect(server.status).toBe(200);
  31  | 
  32  |     await enableCompare(page);
  33  |     const panel = await readPanelConfig(page);
  34  |     // R1：Studio 读的必须是作品当前配置（对照模式下 scene-config 就是 GET /scene 的内容）
  35  |     expect(sameJson(panel, server.body), `面板配置与 GET /scene 不一致：${JSON.stringify(panel)}`).toBe(true);
  36  | 
  37  |     const pair = await captureCanvases(page, frame);
  38  |     const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
  39  |     const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);
  40  | 
  41  |     writeArtifactFrom('consistency-default.json', {
  42  |       config: panel,
  43  |       canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight, backing: pair.backing },
  44  |       diff: { aligned, normalized },
  45  |       threshold: { aligned: ALIGNED_THRESHOLD, normalized: NORMALIZED_THRESHOLD },
  46  |     });
  47  | 
  48  |     expect(pair.backing.preview, '两个画布的 backing 尺寸不一致').toBe(pair.backing.studio);
> 49  |     expect(aligned.changedRatio, `出厂配置一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
      |                                                                                                                                                      ^ Error: 出厂配置一致性超阈值：{"shift":{"x":0,"y":0},"changed":0.005291005291005291,"mean":2.818167184569301}
  50  |     expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  51  |   });
  52  | 
  53  |   test('② 经 Studio 改动并经 PUT /scene 写入明显不同的相机后，两边仍然一致', async ({ page }) => {
  54  |     const { frame } = await openEditor(page);
  55  |     await enableCompare(page);
  56  | 
  57  |     // 先在 Studio 里改角度/环境光/主光，再“设为首屏”
  58  |     await setSlider(page, 'scene-rotation-y', 1.9);
  59  |     await setSlider(page, 'scene-ambient', 2.4);
  60  |     await setSlider(page, 'scene-key-intensity', 4.2);
  61  |     await setSlider(page, 'scene-temperature', 5200);
  62  |     const baseline = await captureCanvases(page, frame);
  63  |     await page.getByTestId('scene-save-hero').click();
  64  |     // 作品页通过 HMR 更新（不是整页刷新）
  65  |     const ms = await waitFor(async () => {
  66  |       const current = await captureCanvases(page, frame);
  67  |       return (await compareAligned(baseline.preview.png, current.preview.png, 3)).changedRatio > 0.02;
  68  |     }, 30_000, 250);
  69  | 
  70  |     const afterHero = (await getScene()).body;
  71  |     expect(afterHero.hero.lights.ambient).toBeCloseTo(2.4, 1);
  72  |     expect(afterHero.hero.model.rotation[1]).toBeCloseTo(1.9, 1);
  73  | 
  74  |     // 再用 PUT /scene 写一份相机/fov 明显不同的配置（模拟“改相机后设为首屏”）
  75  |     const variant = structuredClone(afterHero);
  76  |     variant.hero.camera = { position: [2.4, 1.5, 2.4], target: [0, 0.45, 0], fov: 42 };
  77  |     variant.hero.lights.key.color = '#9fd0ff';
  78  |     const written = await putScene(variant);
  79  |     expect(written.status, JSON.stringify(written.body)).toBe(200);
  80  | 
  81  |     await enableCompare(page);
  82  |     const panel = await readPanelConfig(page);
  83  |     expect(sameJson(panel, (await getScene()).body), '改配置后 Studio 仍没读到作品配置').toBe(true);
  84  |     await page.waitForTimeout(900);
  85  | 
  86  |     const pair = await captureCanvases(page, frame);
  87  |     const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
  88  |     const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);
  89  | 
  90  |     writeArtifactFrom('consistency-after-edit.json', {
  91  |       writeLatencyMs: ms,
  92  |       heroConfig: afterHero.hero,
  93  |       writtenCamera: variant.hero.camera,
  94  |       config: panel,
  95  |       canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight },
  96  |       diff: { aligned, normalized },
  97  |     });
  98  | 
  99  |     expect(aligned.changedRatio, `改动后一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
  100 |     expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  101 |   });
  102 | 
  103 |   test('③ 滚动到 at≈0.6（开盖姿态）时两边仍然一致', async ({ page }) => {
  104 |     const { frame } = await openEditor(page);
  105 |     await enableCompare(page);
  106 |     const at = await scrollPreview(page, frame, 0.6);
  107 |     expect(at, `滚动没到 0.6：${at}`).toBeGreaterThan(0.58);
  108 |     expect(at).toBeLessThan(0.62);
  109 |     await page.waitForTimeout(900);
  110 | 
  111 |     const panel = await readPanelConfig(page);
  112 |     const server = await getScene();
  113 |     expect(sameJson(panel, server.body), '滚动后 Studio 配置与作品配置不一致').toBe(true);
  114 |     expect(panel.scroll.some((frame: { at: number }) => Math.abs(frame.at - 0.6) < 1e-6), '配置里没有 at=0.6 的关键帧').toBe(true);
  115 | 
  116 |     const pair = await captureCanvases(page, frame);
  117 |     const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
  118 |     const normalized = await compareNormalized(pair.preview.png, pair.studio.png, 512);
  119 |     const file = readSceneFile();
  120 | 
  121 |     writeArtifactFrom('consistency-scroll-06.json', {
  122 |       at,
  123 |       panelAt: await readScrollAt(page),
  124 |       configFrames: file.scroll.map((frame) => frame.at),
  125 |       canvas: { size: pair.size, visibleHeight: pair.preview.visibleHeight, hiddenTop: pair.preview.offsetY },
  126 |       diff: { aligned, normalized },
  127 |     });
  128 | 
  129 |     expect(aligned.changedRatio, `at≈0.6 一致性超阈值：${JSON.stringify({ shift: aligned.shift, changed: aligned.changedRatio, mean: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
  130 |     expect(normalized.changedRatio).toBeLessThan(NORMALIZED_THRESHOLD);
  131 |   });
  132 | 
  133 |   test('还有：对照模式画的确实是 3D（不是空画布）', async ({ page }) => {
  134 |     const { frame } = await openEditor(page);
  135 |     await enableCompare(page);
  136 |     const pair = await captureCanvases(page, frame);
  137 |     const { silhouette } = await import('../m1a/visual');
  138 |     const shape = await silhouette(pair.studio.png);
  139 |     expect(shape.pixelCount, `对照视口画布几乎是空的：${JSON.stringify(shape)}`).toBeGreaterThan(2_000);
  140 |     expect(shape.heightPx).toBeGreaterThan(100);
  141 |     writeArtifactFrom('consistency-canvas-content.json', { studio: shape, artifactDir: ARTIFACT_DIR });
  142 |   });
  143 | });
  144 | 
```