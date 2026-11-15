import { expect, test } from '@playwright/test';
import { ARTIFACT_DIR } from './env';
import { openStudio, restoreTemplate, writeArtifact } from './helpers';

/**
 * M4-D4：视觉与布局（仅 Chromium；1440×900 / 1280×800 / 390×844）。
 *
 * 断言面：场景编辑模式下对照画布不被容器裁掉（保留原尺寸 + 真实横向滚动）、
 * 溢出时给出提示、滚动容器可用键盘聚焦、页面本身不产生意外的整页横向溢出。
 * 不改任何产品阈值或渲染参数，只测实际 rect / scrollWidth。
 */

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '390x844', width: 390, height: 844 },
];

test.describe('M4-D4 布局与焦点', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}：场景画布不被裁切、横向滚动可用、聚焦可达`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await openStudio(page);
      await page.getByTestId('scene-open').click();
      await page.getByTestId('scene-panel').waitFor({ state: 'visible', timeout: 60_000 });
      const viewportEl = page.getByTestId('scene-viewport');
      await viewportEl.waitFor({ state: 'visible', timeout: 60_000 });

      const metrics = await page.evaluate(() => {
        const canvas = document.querySelector('[data-testid="scene-viewport"]') as HTMLElement | null;
        const scroll = canvas?.closest('[data-testid="scene-canvas-scroll"], .scene-canvas-scroll') as HTMLElement | null;
        const hint = document.querySelector('[data-testid="scene-size-hint"]') as HTMLElement | null;
        const canvasRect = canvas?.getBoundingClientRect();
        const scrollRect = scroll?.getBoundingClientRect();
        return {
          canvas: canvasRect ? { left: canvasRect.left, right: canvasRect.right, width: canvasRect.width } : null,
          scroll: scrollRect ? { left: scrollRect.left, right: scrollRect.right, width: scrollRect.width, scrollWidth: scroll!.scrollWidth, clientWidth: scroll!.clientWidth } : null,
          hintVisible: hint ? !hint.hidden && getComputedStyle(hint).display !== 'none' : false,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
          viewportWidth: window.innerWidth,
        };
      });

      expect(metrics.canvas, '找不到场景画布').not.toBeNull();
      expect(metrics.scroll, '找不到承载原尺寸画布的滚动容器').not.toBeNull();
      // 画布保留原尺寸：不被 transform 缩小；被裁切时必须有横向滚动兜底。
      const canvasWidth = metrics.canvas!.width;
      const scrollWidth = metrics.scroll!.scrollWidth;
      const clientWidth = metrics.scroll!.clientWidth;
      expect(canvasWidth, `画布宽度异常：${JSON.stringify(metrics)}`).toBeGreaterThan(200);
      expect(scrollWidth + 0.5, `画布比滚动容器内容区还宽，说明被裁切：${JSON.stringify(metrics)}`).toBeGreaterThanOrEqual(canvasWidth);
      const overflow = scrollWidth > clientWidth + 1;
      if (overflow) expect(metrics.hintVisible, `溢出时没有显示尺寸提示：${JSON.stringify(metrics)}`).toBe(true);

      // 滚动容器可聚焦（键盘可达）
      const focusable = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="scene-canvas-scroll"], .scene-canvas-scroll') as HTMLElement | null;
        if (!scroll) return null;
        scroll.focus();
        return { tabIndex: scroll.tabIndex, isActive: document.activeElement === scroll };
      });
      expect(focusable?.isActive, `滚动容器无法获得键盘焦点：${JSON.stringify(focusable)}`).toBe(true);

      // 页面级不允许出现无法解释的横向溢出（场景列内部滚动是允许的）。
      expect(metrics.pageOverflow, `整页出现横向溢出 ${metrics.pageOverflow}px`).toBeLessThanOrEqual(2);

      await page.screenshot({ path: `${ARTIFACT_DIR}/layout-${viewport.name}.png`, fullPage: false });
      writeArtifact(`layout-${viewport.name}.json`, { viewport, metrics, focusable });
    });
  }
});
