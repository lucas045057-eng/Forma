import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';
import { ARTIFACT_DIR, BACKEND_BASE, MOCK_BASE, REPO_ROOT } from './env';

export interface HttpResponse<T> { status: number; body: T; text: string; headers: Record<string, string> }

export async function http<T = any>(url: string, init?: RequestInit): Promise<HttpResponse<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* 保留原始文本 */ }
  return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
}

export const jsonRequest = (method: string, payload?: unknown): RequestInit =>
  (payload === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

export const base = (url: string) => `${BACKEND_BASE}${url}`;

export const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000, intervalMs = 200): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await wait(intervalMs);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

/** 证据写到本轮 run 目录（M4_ARTIFACT_DIR），不写死历史路径。 */
export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

/** 把作品目录还原成 git 里的样子（测试会往里面写；结束时必须干净）。 */
export function restoreTemplate(): { status: string; clean: boolean } {
  spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  spawnSync('git', ['-c', 'core.longpaths=true', 'clean', '-fd', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const text = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim();
  return { status: text, clean: !text };
}

export const getVersion = () => http<{ version: string }>(base('/version'));
export const listCandidates = () => http<any[]>(base('/candidates'));
export const getCandidate = (id: string) => http<any>(base(`/candidates/${encodeURIComponent(id)}`));
export const getScene = () => http<any>(base('/scene'));
export const modelProvenance = () => http<any>(base('/scene/model-provenance'));
export const listFallbacks = () => http<any[]>(base('/assets/fallbacks'));
export const importFallback = (presetId: string) => http(base(`/assets/fallbacks/${encodeURIComponent(presetId)}/import`), jsonRequest('POST'));
export const adoptAsset = (id: string) => http(base(`/assets/${encodeURIComponent(id)}/adopt`), jsonRequest('POST'));
export const revertVersion = () => http(base('/version/revert'), { method: 'POST' });
export const getAsset = (id: string) => http<any>(base(`/assets/${encodeURIComponent(id)}`));

export const resetMock = () => http(`${MOCK_BASE}/__reset`, { method: 'POST' });
export const setScript = (steps: unknown[], delayMs = 0) =>
  http(`${MOCK_BASE}/__script`, jsonRequest('POST', { steps, delayMs }));

/** 打开 Studio 并等预览连接（其它套件的既有做法）。 */
export async function openStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('[data-testid="preview-status"]').waitFor({ state: 'visible', timeout: 60_000 });
  await waitFor(async () => (await page.locator('[data-testid="preview-status"]').innerText()).includes('预览已连接'), 90_000, 300);
}

export async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('没有取到作品预览 iframe');
  return frame;
}

/** 在实际 iframe 里点选一个元素，返回 selection JSON（用于"录音时指着 A"这类场景）。 */
export async function pickElement(page: Page, testId: string): Promise<any> {
  await page.getByTestId('pick-toggle').click();
  const frame = await previewFrame(page);
  const target = frame.locator(`[data-testid="${testId}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`找不到元素 ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const panel = page.locator('[data-testid="selection-json"]');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const selection = JSON.parse(await panel.innerText());
  await page.getByTestId('pick-toggle').click();
  return selection;
}
