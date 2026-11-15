# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-speech.spec.ts >> M4-D2 语音确认闭环（转写与提交均为替身） >> 录音中页面隐藏：立即取消并发送 DELETE，麦克风轨道被释放
- Location: tests\e2e\m4\01-speech.spec.ts:122:3

# Error details

```
Error: 等待条件超时（15000ms）
```

# Test source

```ts
  1  | import { spawnSync } from 'node:child_process';
  2  | import { mkdirSync, writeFileSync } from 'node:fs';
  3  | import path from 'node:path';
  4  | import type { Frame, Page } from '@playwright/test';
  5  | import { ARTIFACT_DIR, BACKEND_BASE, MOCK_BASE, REPO_ROOT } from './env';
  6  | 
  7  | export interface HttpResponse<T> { status: number; body: T; text: string; headers: Record<string, string> }
  8  | 
  9  | export async function http<T = any>(url: string, init?: RequestInit): Promise<HttpResponse<T>> {
  10 |   const response = await fetch(url, init);
  11 |   const text = await response.text();
  12 |   let body: unknown = text;
  13 |   try { body = text ? JSON.parse(text) : null; } catch { /* 保留原始文本 */ }
  14 |   return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
  15 | }
  16 | 
  17 | export const jsonRequest = (method: string, payload?: unknown): RequestInit =>
  18 |   (payload === undefined
  19 |     ? { method }
  20 |     : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  21 | 
  22 | export const base = (url: string) => `${BACKEND_BASE}${url}`;
  23 | 
  24 | export const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
  25 | 
  26 | export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000, intervalMs = 200): Promise<number> {
  27 |   const started = Date.now();
  28 |   while (Date.now() - started < timeoutMs) {
  29 |     if (await predicate()) return Date.now() - started;
  30 |     await wait(intervalMs);
  31 |   }
> 32 |   throw new Error(`等待条件超时（${timeoutMs}ms）`);
     |         ^ Error: 等待条件超时（15000ms）
  33 | }
  34 | 
  35 | /** 证据写到本轮 run 目录（M4_ARTIFACT_DIR），不写死历史路径。 */
  36 | export function writeArtifact(name: string, data: unknown): string {
  37 |   mkdirSync(ARTIFACT_DIR, { recursive: true });
  38 |   const file = path.join(ARTIFACT_DIR, name);
  39 |   writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  40 |   return file;
  41 | }
  42 | 
  43 | /** 把作品目录还原成 git 里的样子（测试会往里面写；结束时必须干净）。 */
  44 | export function restoreTemplate(): { status: string; clean: boolean } {
  45 |   spawnSync('git', ['-c', 'core.longpaths=true', 'checkout', '--', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  46 |   spawnSync('git', ['-c', 'core.longpaths=true', 'clean', '-fd', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  47 |   const status = spawnSync('git', ['-c', 'core.longpaths=true', 'status', '--porcelain', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  48 |   const text = `${status.stdout ?? ''}${status.stderr ?? ''}`.trim();
  49 |   return { status: text, clean: !text };
  50 | }
  51 | 
  52 | export const getVersion = () => http<{ version: string }>(base('/version'));
  53 | export const listCandidates = () => http<any[]>(base('/candidates'));
  54 | export const getCandidate = (id: string) => http<any>(base(`/candidates/${encodeURIComponent(id)}`));
  55 | export const getScene = () => http<any>(base('/scene'));
  56 | export const modelProvenance = () => http<any>(base('/scene/model-provenance'));
  57 | export const listFallbacks = () => http<any[]>(base('/assets/fallbacks'));
  58 | export const importFallback = (presetId: string) => http(base(`/assets/fallbacks/${encodeURIComponent(presetId)}/import`), jsonRequest('POST'));
  59 | export const adoptAsset = (id: string) => http(base(`/assets/${encodeURIComponent(id)}/adopt`), jsonRequest('POST'));
  60 | export const revertVersion = () => http(base('/version/revert'), { method: 'POST' });
  61 | export const getAsset = (id: string) => http<any>(base(`/assets/${encodeURIComponent(id)}`));
  62 | 
  63 | export const resetMock = () => http(`${MOCK_BASE}/__reset`, { method: 'POST' });
  64 | export const setScript = (steps: unknown[], delayMs = 0) =>
  65 |   http(`${MOCK_BASE}/__script`, jsonRequest('POST', { steps, delayMs }));
  66 | 
  67 | /** 打开 Studio 并等预览连接（其它套件的既有做法）。 */
  68 | export async function openStudio(page: Page): Promise<void> {
  69 |   await page.goto('/');
  70 |   await page.locator('[data-testid="preview-status"]').waitFor({ state: 'visible', timeout: 60_000 });
  71 |   await waitFor(async () => (await page.locator('[data-testid="preview-status"]').innerText()).includes('预览已连接'), 90_000, 300);
  72 | }
  73 | 
  74 | export async function previewFrame(page: Page): Promise<Frame> {
  75 |   const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  76 |   const frame = await handle?.contentFrame();
  77 |   if (!frame) throw new Error('没有取到作品预览 iframe');
  78 |   return frame;
  79 | }
  80 | 
  81 | /** 在实际 iframe 里点选一个元素，返回 selection JSON（用于"录音时指着 A"这类场景）。 */
  82 | export async function pickElement(page: Page, testId: string): Promise<any> {
  83 |   await page.getByTestId('pick-toggle').click();
  84 |   const frame = await previewFrame(page);
  85 |   const target = frame.locator(`[data-testid="${testId}"]`).first();
  86 |   await target.scrollIntoViewIfNeeded();
  87 |   const box = await target.boundingBox();
  88 |   if (!box) throw new Error(`找不到元素 ${testId}`);
  89 |   await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  90 |   const panel = page.locator('[data-testid="selection-json"]');
  91 |   await panel.waitFor({ state: 'visible', timeout: 30_000 });
  92 |   const selection = JSON.parse(await panel.innerText());
  93 |   await page.getByTestId('pick-toggle').click();
  94 |   return selection;
  95 | }
  96 | 
```