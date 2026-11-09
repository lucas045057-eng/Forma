import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ARTIFACT_DIR } from './env';
import { imageStats, pixelDiff, writeArtifact } from './harness';

/**
 * Studio 3D 视口的浏览器侧验收：
 * 通过 UI 导入一个已完成的 mock 任务（mock 供的是真实香薰瓶 GLB），等模型加载完成后
 * 断言画布真的画出了东西，并且鼠标拖动后画面发生变化。
 */
test('Studio 3D 视口：加载处理后模型、画布非空、可拖动旋转、无运行错误', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  await page.goto('/');
  await page.getByTestId('asset-open').click();
  await expect(page.getByRole('dialog', { name: '3D 资产视口' })).toBeVisible();

  // 通过 UI 导入，走的是和用户一样的路径
  await page.getByTestId('asset-task-id').fill('7000002');
  await page.getByTestId('asset-import').click();

  await expect(page.getByTestId('asset-status'), '资产没有进入「可查看」').toContainText('可查看', { timeout: 90_000 });
  const viewport = page.locator('[data-testid="model-viewport"]');
  await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
  await expect(viewport.locator('.model-empty')).toHaveCount(0);

  const canvas = viewport.locator('canvas');
  await expect(canvas).toBeVisible();
  // 等首帧稳定（OrbitControls 有阻尼）
  await page.waitForTimeout(1_200);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const first = await canvas.screenshot();
  const firstStats = await imageStats(first);
  writeFileSync(path.join(ARTIFACT_DIR, 'viewport-initial.png'), first);

  // 画布不是纯背景：颜色数和亮度标准差都要有明显变化
  expect(firstStats.uniqueColors, `画布颜色过少：${JSON.stringify(firstStats)}`).toBeGreaterThan(20);
  expect(firstStats.stdDev, `画布几乎是纯色：${JSON.stringify(firstStats)}`).toBeGreaterThan(3);

  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 190, centerY + 30, { steps: 24 });
  await page.mouse.up();
  await page.waitForTimeout(1_000);

  const rotated = await canvas.screenshot();
  writeFileSync(path.join(ARTIFACT_DIR, 'viewport-rotated.png'), rotated);
  const rotatedStats = await imageStats(rotated);
  const diff = await pixelDiff(first, rotated);

  const unexpected = errors.filter((line) => !line.includes('favicon'));
  writeArtifact('viewport.json', {
    firstStats,
    rotatedStats,
    diff,
    errors: unexpected,
    screenshots: ['docs/reports/artifacts/M0-A/viewport-initial.png', 'docs/reports/artifacts/M0-A/viewport-rotated.png'],
  });

  expect(diff.ratio, `拖动后画面没有变化：${JSON.stringify(diff)}`).toBeGreaterThan(0.01);
  expect(unexpected, '浏览器运行期间出现错误').toEqual([]);
});
