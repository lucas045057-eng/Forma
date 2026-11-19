import { expect, test, type Frame, type Page, type Route } from '@playwright/test';
import { openStudio, setPicking } from './lib';

async function scrollPreview(page: Page, frame: Frame) {
  const progress = page.locator('.viewport-mode-pill');
  const before = (await progress.innerText()).split('·').at(-1)!.trim();
  await frame.evaluate(() => window.scrollBy(0, window.scrollY > 200 ? -200 : 200));
  await expect(progress).not.toContainText(`· ${before}`);
}

test('退出选取后显示连线，滚动预览后隐藏，重新点选后恢复', async ({ page }) => {
  const frame = await openStudio(page);
  const link = page.getByTestId('selection-link');
  const button = frame.getByTestId('buy-button').first();
  await setPicking(page, true);
  await button.click();
  await expect(page.getByTestId('selection-json')).toBeVisible();
  await expect(link).toHaveCount(0);
  await setPicking(page, false);
  await expect(link).toBeVisible();
  await expect(link).toHaveCSS('pointer-events', 'none');
  await scrollPreview(page, frame);
  await expect(link).toHaveCount(0);
  await setPicking(page, true);
  await button.click();
  await setPicking(page, false);
  await expect(link).toBeVisible();
});

test('点选后在版本确认前滚动，不显示旧坐标的连线', async ({ page }) => {
  const frame = await openStudio(page);
  await setPicking(page, true);
  let captureRoute!: (route: Route) => void;
  const versionRequest = new Promise<Route>(resolve => { captureRoute = resolve; });
  await page.route('**/version', captureRoute, { times: 1 });
  await frame.getByTestId('buy-button').first().click();
  const route = await versionRequest;
  try {
    await scrollPreview(page, frame);
  } finally {
    await route.continue();
  }
  await expect(page.getByTestId('selection-json')).toBeVisible();
  await setPicking(page, false);
  await expect(page.getByTestId('selection-link')).toHaveCount(0);
});
