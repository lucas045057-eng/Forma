import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { TEMPLATE_CONFIG } from './env';
import { writeArtifactFrom } from './artifact';
import { anchorExpectations, checkCompleteness, checkDeterministicAnchors } from '../checks';
import { setPicking } from '../lib';
import { openProductPage, productCanvasRect, withTempConfig } from './viewport';
import { captureRegion, comparePixels } from './visual';

/**
 * 回退与非法配置：
 * - 模型请求失败 → 显示占位、无 pageerror、购买等按钮仍可用；顺带跑回退态的
 *   N3 完整性检查（3D 成功态在 M0-B 的用例 9 里跑）。
 * - scene.config.json 改成非法 JSON / 不符合 Schema → 网页不白屏、不崩，
 *   并尽量验证「保留上一份合法配置」。
 */

const valid = JSON.parse(readFileSync(TEMPLATE_CONFIG, 'utf8'));

async function openStudioWaitingForPreview(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="preview-status"]')?.textContent?.includes('预览已连接') === true,
    undefined,
    { timeout: 45_000 },
  );
  const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('没有取到预览 iframe');
  await frame.waitForSelector('[data-testid="buy-button"]', { timeout: 45_000 });
  return frame;
}

test('模型请求失败：显示占位、无运行错误、按钮可用，回退态标记完整', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // 在进入页面前就拦掉模型请求，让首屏走失败回退
  await page.route('**/*diffuser-*.glb*', (route) => route.abort());

  const frame = await openStudioWaitingForPreview(page);
  await frame.waitForFunction(() => {
    const scene = document.querySelector('[data-testid="product-scene"]');
    return scene?.getAttribute('data-state') === 'fallback' && scene.querySelector('canvas') === null;
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(600);

  // 占位可见、说明失败而不是“还在加载”
  await expect(frame.locator('[data-testid="product-placeholder"]')).toBeVisible();
  expect(await frame.locator('[data-testid="product-scene"] canvas').count(), '失败后不应残留 canvas').toBe(0);

  // 按钮仍可用
  const buy = frame.locator('[data-testid="buy-button"]');
  await buy.click();
  await expect(frame.locator('[data-testid="action-status"]')).toHaveAttribute('data-purchases', '1');

  // 回退态的 N3 完整性 + 独立锚点（3D 成功态在 M0-B 用例 9 里跑）
  await setPicking(page, true);
  const completeness = await checkCompleteness(frame, 'fallback');
  const anchors = await checkDeterministicAnchors(page, frame, anchorExpectations('fallback'));

  const artifact = writeArtifactFrom('fallback.json', {
    pageErrors,
    completeness,
    anchors: { failures: anchors.failures, records: anchors.records.map((record) => ({ tag: record.tag, text: record.text, expectedFromAst: record.expectedFromAst, selectionSrc: record.selectionSrc })) },
  });
  expect(artifact).toBeTruthy();

  expect(pageErrors, '回退路径出现了未捕获异常').toEqual([]);
  expect(completeness.oracleFailures).toEqual([]);
  expect(completeness.expectedUniquePositions).toBeGreaterThan(0);
  expect(completeness.phantom, '回退态出现 AST 里没有的位置').toEqual([]);
  expect(completeness.missing, '回退态有该渲染却没标记的节点（含 Placeholder）').toEqual([]);
  expect(completeness.leaked, '回退态里不该出现 3D 分支的节点').toEqual([]);
  expect(completeness.unmarked, '回退态渲染树里有未标记元素').toEqual([]);
  expect(completeness.domUniqueSrcs).toBe(completeness.expectedUniquePositions);
  expect(anchors.failures).toEqual([]);
});

test('非法配置（坏 JSON / 不符合 Schema）：网页不白屏、不崩', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    (window as unknown as { __loads: number }).__loads = 1;
  });

  const frame = await openProductPage(page);
  await page.waitForTimeout(1_200);
  const box = await productCanvasRect(frame);
  const size = Math.floor(box.width);
  const baseline = await captureRegion(page, { x: Math.round(box.x), y: Math.round(box.y), width: size, height: size });

  const results: Array<Record<string, unknown>> = [];
  const broken = [
    { name: '截断的 JSON', content: '{\n  "model": "/assets/diffuser-4969889.glb",\n  "hero": {\n' },
    { name: 'Schema 不通过（fov=999）', content: JSON.stringify({ ...valid, hero: { ...valid.hero, camera: { ...valid.hero.camera, fov: 999 } } }, null, 2) },
    { name: 'Schema 不通过（scroll.at 非递增）', content: JSON.stringify({ ...valid, scroll: [{ at: 0.6, model: { rotation: [0, 1, 0] } }, { at: 0.2, model: { rotation: [0, 2, 0] } }] }, null, 2) },
  ];

  for (const entry of broken) {
    const mutation = await withTempConfig(entry.content, async () => {
      await page.waitForTimeout(2_500);
      const loads = await page.evaluate(() => (window as unknown as { __loads?: number }).__loads ?? 1);
      const canvasCount = await frame.locator('[data-testid="product-scene"] canvas').count();
      const mainBox = await frame.locator('main').boundingBox();
      const buyVisible = await frame.locator('[data-testid="buy-button"]').isVisible();
      let diff: Record<string, number> | null = null;
      if (canvasCount > 0) {
        const currentBox = await productCanvasRect(frame);
        const shot = await captureRegion(page, { x: Math.round(currentBox.x), y: Math.round(currentBox.y), width: size, height: size });
        diff = await comparePixels(baseline.png, shot.png);
      }
      return { loads, canvasCount, mainSize: mainBox ? [mainBox.width, mainBox.height] : null, buyVisible, diff };
    });
    results.push({ name: entry.name, ...mutation.result, restored: readFileSync(TEMPLATE_CONFIG, 'utf8') === mutation.original });
    // 每种写法都要还原成功，避免污染后续断言
    expect(readFileSync(TEMPLATE_CONFIG, 'utf8'), `写入「${entry.name}」后没有还原`).toEqual(mutation.original);
    await page.waitForTimeout(500);
  }

  const artifact = writeArtifactFrom('invalid-config.json', { pageErrors, results });
  expect(artifact).toBeTruthy();
  expect(pageErrors, '非法配置导致了未捕获异常').toEqual([]);
  for (const result of results) {
    expect(result.mainSize, `${String(result.name)} 时页面变成空白`).toBeTruthy();
    expect((result.mainSize as number[])[0]).toBeGreaterThan(500);
    expect(result.buyVisible, `${String(result.name)} 时购买按钮消失了`).toBe(true);
    // 没有整页重载时，应保留上一份合法配置（画面基本不变）
    if (result.loads === 1) {
      expect(result.canvasCount, `${String(result.name)} 时 3D 画布被移除（没保留上一份合法配置）`).toBeGreaterThan(0);
      expect((result.diff as { changedRatio: number }).changedRatio, `${String(result.name)} 时画面变了，说明非法配置被应用了`).toBeLessThan(0.02);
    }
  }
});
