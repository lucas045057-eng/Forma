import { readFileSync, writeFileSync } from 'node:fs';
import type { Frame, Page } from '@playwright/test';
import { BACKEND_BASE, PREVIEW_PATH, TEMPLATE_CONFIG } from './env';

export interface AssetLike {
  id: string;
  taskId?: string;
  status: string;
  modelUrl?: string;
  metrics?: {
    before: { bytes: number; vertices: number };
    after: { bytes: number; vertices: number };
    durationMs: number;
    webReady?: boolean;
    parts?: { recognized: boolean; lid?: string; nodes: Array<{ sourceIndex: number; name: string }> };
  };
}

export async function getJson<T = any>(url: string): Promise<T> {
  const response = await fetch(url);
  return response.json() as Promise<T>;
}

/** 通过后端导入一个 mock 任务（mock 供的是 M1-A 的拆分模型），等到 ready。 */
export async function importAsset(taskId: string, timeoutMs = 120_000): Promise<AssetLike> {
  const submitted = await fetch(`${BACKEND_BASE}/assets/lux3d/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
  });
  const created = await submitted.json() as AssetLike;
  const deadline = Date.now() + timeoutMs;
  let asset = created;
  while (Date.now() < deadline) {
    asset = await getJson<AssetLike>(`${BACKEND_BASE}/assets/${created.id}`);
    if (asset.status === 'ready' || asset.status === 'failed' || asset.status === 'cancelled') return asset;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`资产 ${created.id} 未在超时前就绪：${JSON.stringify(asset)}`);
}

/** 打开作品页（直连模板 dev server，不走 Studio iframe）。 */
export async function openProductPage(page: Page, state: 'ready' | 'fallback' = 'ready'): Promise<Frame> {
  await page.goto(PREVIEW_PATH);
  const frame = page.mainFrame();
  await waitForScene(frame, state);
  return frame;
}

/** 打开 Studio 并选中某个资产，等 3D 视口 loaded。 */
export async function openStudioViewport(page: Page, assetId: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('asset-open').click();
  await page.getByTestId('asset-select').selectOption(assetId);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="model-viewport"]')?.getAttribute('data-loaded') === 'true',
    undefined,
    { timeout: 90_000 },
  );
}

/** 等作品页进入稳定渲染状态：ready 需要 canvas；fallback 必须等 canvas 已经移除（不是加载中）。 */
export async function waitForScene(frame: Frame, state: 'ready' | 'fallback', timeoutMs = 90_000): Promise<void> {
  await frame.waitForFunction((expected) => {
    const scene = document.querySelector('[data-testid="product-scene"]');
    if (!scene || scene.getAttribute('data-state') !== expected) return false;
    const canvas = scene.querySelector('canvas');
    return expected === 'fallback' ? canvas === null : canvas !== null;
  }, state, { timeout: timeoutMs });
}

export async function sceneScrollAt(frame: Frame): Promise<number> {
  return frame.evaluate(() => Number(document.querySelector('[data-testid="product-scene"]')?.getAttribute('data-scroll-at') ?? -1));
}

/**
 * 滚到指定的滚动进度（0–1），返回实际到达的 at。
 * at 由 scrollY 决定，像素级量化，所以会有微小误差。
 */
export async function scrollToAt(frame: Frame, at: number): Promise<number> {
  await frame.evaluate((target) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, Math.round(max * target));
  }, at);
  await frame.waitForFunction((target) => {
    const scene = document.querySelector('[data-testid="product-scene"]');
    const current = Number(scene?.getAttribute('data-scroll-at') ?? -1);
    return Math.abs(current - target) < 0.01;
  }, at, { timeout: 10_000 }).catch(() => {});
  await frame.page().waitForTimeout(350);
  return sceneScrollAt(frame);
}

export async function productCanvasRect(frame: Frame) {
  const box = await frame.locator('[data-testid="product-scene"] canvas').boundingBox();
  if (!box) throw new Error('作品页没有找到 canvas');
  return box;
}

/** 临时改 scene.config.json 做 HMR 验证，结束后一定还原（含字节校验）。 */
export async function withTempConfig<T>(content: string, work: () => Promise<T>): Promise<{ result: T; original: string }> {
  const original = readFileSync(TEMPLATE_CONFIG, 'utf8');
  try {
    writeFileSync(TEMPLATE_CONFIG, content, 'utf8');
    const result = await work();
    return { result, original };
  } finally {
    writeFileSync(TEMPLATE_CONFIG, original, 'utf8');
  }
}

/** 等页面自己反映某次改动（用于确认 HMR 生效），超时抛错。 */
export async function waitFor(page: Page, predicate: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error('等待条件超时');
}
