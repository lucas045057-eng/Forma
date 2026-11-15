import path from 'node:path';
import type { Frame, Locator, Page } from '@playwright/test';
import { ARTIFACT_DIR, PREVIEW_PATH } from './env';
import { captureRegion, type Rect } from '../m1a/visual';

/** Studio 3D 场景编辑面板的操作封装（testid 见 docs/reports/M1-B-impl.md）。 */

export function previewFrame(page: Page): Promise<Frame> {
  return page.locator('[data-testid="preview-frame"]').elementHandle().then(async (handle) => {
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error('没有取到作品预览 iframe');
    return frame;
  });
}

export async function waitPreviewReady(frame: Frame): Promise<void> {
  await frame.waitForFunction(() => {
    const scene = document.querySelector('[data-testid="product-scene"]');
    return scene?.getAttribute('data-state') === 'ready' && scene.querySelector('canvas') !== null;
  }, undefined, { timeout: 90_000 });
}

/** 打开工作台 → 进入 3D 场景编辑 → 等预览与编辑器视口都就绪。 */
export async function openEditor(page: Page): Promise<{ frame: Frame }> {
  await page.goto('/');
  const frame = await previewFrame(page);
  await waitPreviewReady(frame);
  await page.getByTestId('scene-open').click();
  await page.locator('[data-testid="scene-panel"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scene-viewport"]')?.getAttribute('data-loaded') === 'true',
    undefined,
    { timeout: 90_000 },
  );
  await page.locator('[data-testid="scene-canvas"]').waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(400);
  return { frame };
}

/** 读取面板里“当前视口配置”的 JSON（在折叠的 <details> 里，innerText 会是空，取 textContent）。 */
export async function readPanelConfig(page: Page) {
  const text = (await page.getByTestId('scene-config').textContent()) ?? '';
  if (!text.trim()) throw new Error('scene-config 是空的');
  return JSON.parse(text);
}

export async function readScrollAt(page: Page): Promise<number> {
  return Number((await page.getByTestId('scene-scroll-at').textContent()) ?? NaN);
}

/** 设置 range 滑杆（React 受控组件，用原生 setter + input 事件触发 onChange）。 */
export async function setSlider(page: Page, testId: string, value: number): Promise<void> {
  await page.evaluate(({ id, next }) => {
    const element = document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement | null;
    if (!element) throw new Error(`找不到滑杆 ${id}`);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, String(next));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id: testId, next: value });
  await page.waitForTimeout(150);
}

export async function canvasRect(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('画布没有布局盒');
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/** 截图的"坐标窗口"：两次比较只有在同一窗口下才有意义。 */
export interface CaptureWindow {
  size: number;
  start: number;
  end: number;
  visibleHeight: number;
  previewRect: Rect;
  studioRect: Rect;
  frameRect: Rect;
  viewport: { width: number; height: number };
}

export interface CanvasPair {
  size: number;
  preview: { rect: Rect; png: Buffer; offsetY: number; visibleHeight: number };
  studio: { rect: Rect; png: Buffer };
  backing: { preview: number; studio: number; dpr: number };
  /** 该次截图实际使用的坐标窗口（用于"前后同一窗口"判定与诊断）。 */
  window: CaptureWindow;
}

/**
 * 截取两边画布的公共部分：
 * 作品页画布可能被滚出视口一部分，就取它剩下的可见行，再在 Studio 画布上截同样的行。
 */
/** 把编辑面板与页面的滚动都归零，保证画布完整可见。 */
export async function resetEditorScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    let node: HTMLElement | null = document.querySelector('[data-testid="scene-canvas"]');
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = 0;
      node = node.parentElement;
    }
  });
  await page.waitForTimeout(250);
}

export async function captureCanvases(page: Page, frame: Frame): Promise<CanvasPair> {
  // 先把编辑面板与页面都滚回顶部（点面板控件会把面板内部滚下去），否则画面会被截断
  await resetEditorScroll(page);
  const previewRect = await canvasRect(frame.locator('[data-testid="product-scene"] canvas'));
  const studioRect = await canvasRect(page.locator('[data-testid="scene-canvas"]'));
  // 预览 iframe 自己的可见区域：画布向上滚出时，超出 iframe 的部分会被工具栏等盖住
  const frameRect = await canvasRect(page.locator('[data-testid="preview-frame"]'));
  const size = Math.floor(Math.min(previewRect.width, studioRect.width));
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  // 以“画布坐标”算两个画布在各自容器内可见的行区间，取交集
  const visibleRows = (rect: Rect, clipTop: number, clipBottom: number) => ({
    start: Math.max(0, Math.ceil(clipTop - rect.y)),
    end: Math.min(Math.floor(rect.height), Math.floor(clipBottom - rect.y)),
  });
  const previewRows = visibleRows(previewRect, Math.max(0, frameRect.y), Math.min(viewport.height, frameRect.y + frameRect.height));
  const studioRows = visibleRows(studioRect, 0, viewport.height);
  const start = Math.max(previewRows.start, studioRows.start);
  const end = Math.min(previewRows.end, studioRows.end, start + size);
  const visibleHeight = end - start;
  if (visibleHeight < 120) {
    throw new Error(`两个画布的公共可见高度不足：${visibleHeight}（preview ${JSON.stringify(previewRows)}, studio ${JSON.stringify(studioRows)}）`);
  }
  const preview = await captureRegion(page, {
    x: Math.round(previewRect.x), y: Math.round(previewRect.y) + start, width: size, height: visibleHeight,
  });
  const studio = await captureRegion(page, {
    x: Math.round(studioRect.x), y: Math.round(studioRect.y) + start, width: size, height: visibleHeight,
  });
  const backing = await frame.evaluate(() => {
    const previewCanvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement | null;
    return { preview: previewCanvas?.width ?? -1, dpr: window.devicePixelRatio };
  });
  const studioBacking = await page.evaluate(() => {
    const studioCanvas = document.querySelector('[data-testid="scene-canvas"]') as HTMLCanvasElement;
    return { studio: studioCanvas.width, dpr: window.devicePixelRatio };
  });
  const captureWindow: CaptureWindow = { size, start, end, visibleHeight, previewRect, studioRect, frameRect, viewport };
  return {
    window: captureWindow,
    size,
    preview: { rect: previewRect, png: preview.png, offsetY: start, visibleHeight },
    studio: { rect: studioRect, png: studio.png },
    backing: { preview: backing.preview, studio: studioBacking.studio, dpr: studioBacking.dpr },
  };
}

/** 只截 Studio 对照画布的完整一刀（不受作品页滚动截断影响，用于像素量测）。 */
export async function captureStudioCanvas(page: Page): Promise<{ png: Buffer; size: number; rect: Rect }> {
  await resetEditorScroll(page);
  const rect = await canvasRect(page.locator('[data-testid="scene-canvas"]'));
  const size = Math.floor(Math.min(rect.width, rect.height));
  const region = await captureRegion(page, { x: Math.round(rect.x), y: Math.round(rect.y), width: size, height: size });
  return { png: region.png, size, rect };
}

/** 裁剪 PNG 的指定行区间（用于把两次不同滚动位置的截图对齐到同一批画布行）。 */
export async function cropPng(png: Buffer, top: number, height: number): Promise<Buffer> {
  const { createRequire } = await import('node:module');
  const { SERVER_DIR } = await import('./env');
  const sharp = createRequire(path.join(SERVER_DIR, 'package.json'))('sharp');
  return sharp(png).extract({ left: 0, top, width: (await sharp(png).metadata()).width, height }).png().toBuffer();
}

/** 点对照模式的三步：读取作品配置 → 匹配画布尺寸 → 打开对照。 */
export async function enableCompare(page: Page, options: { pinnedSize?: number } = {}): Promise<void> {
  await page.getByTestId('scene-load').click();
  await page.waitForTimeout(300);
  await page.getByTestId('scene-match-size').click();
  await page.waitForTimeout(300);
  if (options.pinnedSize) {
    await page.getByTestId('scene-size').fill(String(options.pinnedSize));
    await page.waitForTimeout(200);
  }
  await page.getByTestId('scene-compare').check();
  // 跨源后 Studio 读不到 iframe 的 DOM，改用 bridge 上报的画布宽度 + 两边 CSS 尺寸对比
  await page.waitForFunction((expectedMax) => {
    const studioCanvas = document.querySelector('[data-testid="scene-canvas"]') as HTMLCanvasElement | null;
    const sizeInput = document.querySelector('[data-testid="scene-size"]') as HTMLInputElement | null;
    if (!studioCanvas || !sizeInput) return false;
    const studioWidth = studioCanvas.getBoundingClientRect().width;
    const reported = Number(sizeInput.value);
    return Math.abs(studioWidth - reported) <= 1 && studioWidth > 200 && studioWidth <= expectedMax;
  }, 1600, { timeout: 30_000 });
  await page.waitForTimeout(900);
}

/** 把作品页画布固定成整数尺寸（避免小数尺寸引入重采样），返回该尺寸。 */
export async function pinPreviewCanvas(frame: Frame, size: number): Promise<void> {
  await frame.evaluate((target) => {
    const scene = document.querySelector('[data-testid="product-scene"]') as HTMLElement | null;
    if (!scene) throw new Error('没有找到 product-scene');
    scene.style.width = `${target}px`;
    scene.style.height = `${target}px`;
  }, size);
  await frame.waitForFunction((target) => {
    const canvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement | null;
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    return Math.abs(rect.width - target) <= 0.5 && Math.abs(rect.height - target) <= 0.5;
  }, size, { timeout: 20_000 });
  await frame.page().waitForTimeout(400);
}

/** 让作品页滚到指定进度（在 iframe 内滚动），返回工作台收到的 at。 */
export async function scrollPreview(page: Page, frame: Frame, at: number): Promise<number> {
  await frame.evaluate((target) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.round(max * target));
  }, at);
  await page.waitForFunction((target) => {
    const value = Number(document.querySelector('[data-testid="scene-scroll-at"]')?.textContent ?? NaN);
    return Number.isFinite(value) && Math.abs(value - target) < 0.02;
  }, at, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return readScrollAt(page);
}

export function artifactPath(name: string): string {
  return path.join(ARTIFACT_DIR, name);
}

export { PREVIEW_PATH };
