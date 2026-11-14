# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 06-viewport.spec.ts >> Studio 3D 视口：加载处理后模型、画布非空、可拖动旋转、无运行错误
- Location: tests\e2e\m0a\06-viewport.spec.ts:12:1

# Error details

```
Error: 资产没有进入「可查看」

expect(locator).toContainText(expected) failed

Locator: getByTestId('asset-status')
Expected substring: "可查看"
Received string:    "失败lux3d-7000002模型下载返回 HTTP 500"
Timeout: 90000ms

Call log:
  - 资产没有进入「可查看」 getByTestId('asset-status') with timeout 90000ms
  - waiting for getByTestId('asset-status')
    2 × locator resolved to <div data-testid="asset-status">…</div>
      - unexpected value "等待生成lux3d-7000002"
    177 × locator resolved to <div data-testid="asset-status">…</div>
        - unexpected value "失败lux3d-7000002模型下载返回 HTTP 500"

```

```yaml
- heading "失败" [level=3]
- code: lux3d-7000002
- alert: 模型下载返回 HTTP 500
```

# Test source

```ts
  1  | import { mkdirSync, writeFileSync } from 'node:fs';
  2  | import path from 'node:path';
  3  | import { expect, test } from '@playwright/test';
  4  | import { ARTIFACT_DIR } from './env';
  5  | import { imageStats, pixelDiff, writeArtifact } from './harness';
  6  | 
  7  | /**
  8  |  * Studio 3D 视口的浏览器侧验收：
  9  |  * 通过 UI 导入一个已完成的 mock 任务（mock 供的是真实香薰瓶 GLB），等模型加载完成后
  10 |  * 断言画布真的画出了东西，并且鼠标拖动后画面发生变化。
  11 |  */
  12 | test('Studio 3D 视口：加载处理后模型、画布非空、可拖动旋转、无运行错误', async ({ page }) => {
  13 |   const errors: string[] = [];
  14 |   page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  15 |   page.on('console', (message) => {
  16 |     if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  17 |   });
  18 | 
  19 |   await page.goto('/');
  20 |   await page.getByTestId('asset-open').click();
  21 |   await expect(page.getByRole('dialog', { name: '3D 资产视口' })).toBeVisible();
  22 | 
  23 |   // 通过 UI 导入，走的是和用户一样的路径
  24 |   await page.getByTestId('asset-task-id').fill('7000002');
  25 |   await page.getByTestId('asset-import').click();
  26 | 
> 27 |   await expect(page.getByTestId('asset-status'), '资产没有进入「可查看」').toContainText('可查看', { timeout: 90_000 });
     |                                                                 ^ Error: 资产没有进入「可查看」
  28 |   const viewport = page.locator('[data-testid="model-viewport"]');
  29 |   await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
  30 |   await expect(viewport.locator('.model-empty')).toHaveCount(0);
  31 | 
  32 |   const canvas = viewport.locator('canvas');
  33 |   await expect(canvas).toBeVisible();
  34 |   // 等首帧稳定（OrbitControls 有阻尼）
  35 |   await page.waitForTimeout(1_200);
  36 | 
  37 |   mkdirSync(ARTIFACT_DIR, { recursive: true });
  38 |   const first = await canvas.screenshot();
  39 |   const firstStats = await imageStats(first);
  40 |   writeFileSync(path.join(ARTIFACT_DIR, 'viewport-initial.png'), first);
  41 | 
  42 |   // 画布不是纯背景：颜色数和亮度标准差都要有明显变化
  43 |   expect(firstStats.uniqueColors, `画布颜色过少：${JSON.stringify(firstStats)}`).toBeGreaterThan(20);
  44 |   expect(firstStats.stdDev, `画布几乎是纯色：${JSON.stringify(firstStats)}`).toBeGreaterThan(3);
  45 | 
  46 |   const box = await canvas.boundingBox();
  47 |   expect(box).toBeTruthy();
  48 |   const centerX = box!.x + box!.width / 2;
  49 |   const centerY = box!.y + box!.height / 2;
  50 |   await page.mouse.move(centerX, centerY);
  51 |   await page.mouse.down();
  52 |   await page.mouse.move(centerX + 190, centerY + 30, { steps: 24 });
  53 |   await page.mouse.up();
  54 |   await page.waitForTimeout(1_000);
  55 | 
  56 |   const rotated = await canvas.screenshot();
  57 |   writeFileSync(path.join(ARTIFACT_DIR, 'viewport-rotated.png'), rotated);
  58 |   const rotatedStats = await imageStats(rotated);
  59 |   const diff = await pixelDiff(first, rotated);
  60 | 
  61 |   const unexpected = errors.filter((line) => !line.includes('favicon'));
  62 |   writeArtifact('viewport.json', {
  63 |     firstStats,
  64 |     rotatedStats,
  65 |     diff,
  66 |     errors: unexpected,
  67 |     screenshots: ['docs/reports/artifacts/M0-A/viewport-initial.png', 'docs/reports/artifacts/M0-A/viewport-rotated.png'],
  68 |   });
  69 | 
  70 |   expect(diff.ratio, `拖动后画面没有变化：${JSON.stringify(diff)}`).toBeGreaterThan(0.01);
  71 |   expect(unexpected, '浏览器运行期间出现错误').toEqual([]);
  72 | });
  73 | 
```