import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { BACKEND_BASE, TEMPLATE_MODEL } from './env';
import { importAsset, openProductPage, openStudioViewport, productCanvasRect } from './viewport';
import { captureRegion, compareAligned, compareNormalized, imageStats } from './visual';
import { writeArtifactFrom } from './artifact';

/**
 * M1 过关核心的前半：同一份渲染参数下，Studio 资产视口与作品页首屏要画出同一张图。
 *
 * M1-A 的现状：Studio 用的是 `defaultSceneConfig`（M1-B 才会接同一份 scene.config.json），
 * 但两者的相机/灯光/模型姿态在 scrollAt=0 时逐项相同（同一个默认值），模型也来自同一条
 * 处理管线。所以本轮验证的是「同一模型 + 同一渲染参数」的一致性；真正的「同一份文件」
 * 对比要等 M1-B 提供 Studio 的配置来源接点。
 */

/** 阈值：见报告。同尺寸（允许 ≤3px 平移对齐）后单通道差 > 24 的像素比例上限。 */
const ALIGNED_THRESHOLD = 0.005;
/** 归一化 512² 后的宽容阈值（作为交叉校验）。 */
const NORMALIZED_THRESHOLD = 0.02;

test('一致性：Studio 视口与作品页首屏渲染同一模型，像素差异低于阈值', async ({ page }) => {
  const asset = await importAsset('8100001');
  expect(asset.status, JSON.stringify(asset)).toBe('ready');

  // 1) 作品页首屏（scrollAt = 0）
  const frame = await openProductPage(page);
  await page.waitForTimeout(1_500);
  const productBox = await productCanvasRect(frame);
  const size = Math.floor(productBox.width);
  expect(size).toBeGreaterThan(300);
  // 画布的 CSS 尺寸是小数（588.2），会让帧缓冲被拉伸而引入亚像素重采样。
  // 把作品页画布也固定到整数尺寸，两边才能按像素 1:1 比较。
  await frame.evaluate((target) => {
    const scene = document.querySelector('[data-testid="product-scene"]') as HTMLElement | null;
    if (!scene) throw new Error('没有找到 product-scene');
    scene.style.width = `${target}px`;
    scene.style.height = `${target}px`;
  }, size);
  await page.waitForFunction((target) => {
    const canvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return Math.abs(rect.width - target) <= 0.05 && Math.abs(rect.height - target) <= 0.05;
  }, size, { timeout: 20_000 });
  await page.waitForTimeout(800);
  const productBox2 = await productCanvasRect(frame);
  const product = await captureRegion(page, { x: Math.round(productBox2.x), y: Math.round(productBox2.y), width: size, height: size });
  const productStats = await imageStats(product.png);
  expect(productStats.uniqueColors, '作品页画布看不出模型').toBeGreaterThan(50);
  const productCanvasInfo = await frame.evaluate(() => {
    const canvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement;
    return { cssWidth: canvas.getBoundingClientRect().width, backingWidth: canvas.width, dpr: window.devicePixelRatio };
  });

  // 2) Studio 资产视口：把视口尺寸设成与作品页画布一致，做真正的同尺寸对比
  await openStudioViewport(page, asset.id);
  await page.evaluate((target) => {
    const area = document.querySelector('[data-testid="model-viewport"]') as HTMLElement | null;
    if (!area) throw new Error('没有找到资产视口');
    area.style.width = `${target}px`;
    area.style.height = `${target}px`;
    area.style.flex = 'none';
  }, size);
  await page.waitForFunction((target) => {
    const canvas = document.querySelector('[data-testid="model-viewport"] canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return Math.abs(rect.width - target) <= 1 && Math.abs(rect.height - target) <= 1;
  }, size, { timeout: 30_000 });
  await page.waitForTimeout(1_500);
  const studioBox = await page.locator('[data-testid="model-viewport"] canvas').boundingBox();
  if (!studioBox) throw new Error('Studio 没有 canvas');
  const studio = await captureRegion(page, { x: Math.round(studioBox.x), y: Math.round(studioBox.y), width: size, height: size });
  const studioStats = await imageStats(studio.png);
  const studioCanvasInfo = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="model-viewport"] canvas') as HTMLCanvasElement;
    return { cssWidth: canvas.getBoundingClientRect().width, backingWidth: canvas.width, dpr: window.devicePixelRatio };
  });

  // 3) 两份模型是不是同一份产物（同一条管线）
  const committed = readFileSync(TEMPLATE_MODEL);
  const served = Buffer.from(await (await fetch(`${BACKEND_BASE}${asset.modelUrl}`)).arrayBuffer());
  const hash = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

  const aligned = await compareAligned(product.png, studio.png, 3);
  const normalized = await compareNormalized(product.png, studio.png, 512);

  const artifact = writeArtifactFrom('consistency.json', {
    note: 'Studio 使用 defaultSceneConfig；作品页使用 src/scene.config.json。两者的 camera/lights/model 在 scrollAt=0 时相同。',
    threshold: { aligned: ALIGNED_THRESHOLD, normalized: NORMALIZED_THRESHOLD },
    canvas: { product: { width: productBox2.width, height: productBox2.height }, studio: { width: studioBox.width, height: studioBox.height }, comparedSize: size, productCanvasInfo, studioCanvasInfo },
    images: { product: productStats, studio: studioStats },
    models: {
      committed: { bytes: committed.length, sha256: hash(committed) },
      served: { bytes: served.length, sha256: hash(served) },
      identical: hash(committed) === hash(served),
    },
    diff: { aligned, normalized },
  });

  expect(artifact).toBeTruthy();
  expect(aligned.changedRatio, `同尺寸（对齐后）像素差异过大：${JSON.stringify({ shift: aligned.shift, changedRatio: aligned.changedRatio, meanAbsDiff: aligned.meanAbsDiff })}`).toBeLessThan(ALIGNED_THRESHOLD);
  expect(normalized.changedRatio, `归一化后像素差异过大：${JSON.stringify(normalized)}`).toBeLessThan(NORMALIZED_THRESHOLD);
});
