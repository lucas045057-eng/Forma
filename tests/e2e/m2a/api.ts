import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { clickTarget, setPicking } from '../lib';
import {
  BACKEND_BASE, M2A_DATA, MOCK_BASE, REPO_ROOT, TEMPLATE_APP, WORK_DATA, WORK_ROOT,
} from './env';

export interface SelectionLike {
  src: string;
  cid: string;
  text?: string;
  bbox: number[];
  baseVersion: string;
  instances?: number;
  ancestors?: string[];
  note?: string;
}

export interface TaskLike {
  id: string;
  instruction: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  candidateId?: string;
  events: Array<{ type?: string; message?: string; at?: string }>;
  error?: { code: string; message: string };
  selection?: SelectionLike;
}

export interface CandidateLike {
  id: string;
  taskId: string;
  baseVersion: string;
  branch: string;
  previewUrl: string;
  diff: Array<{ path: string; patch: string }>;
  outOfScope: string[];
  checks: Array<{ name: string; status: string }>;
  decision: 'pending' | 'adopted' | 'discarded';
}

export interface HttpResult<T> { status: number; body: T; text: string; headers: Record<string, string> }

export async function http<T = any>(url: string, init?: RequestInit): Promise<HttpResult<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
}

const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
});

export const base = (url: string) => `${BACKEND_BASE}${url}`;
export const getVersion = () => http<{ version: string }>(base('/version'));
export const revertVersion = () => http(base('/version/revert'), { method: 'POST' });
export const submitTask = (instruction: string, selection?: SelectionLike) => http<TaskLike>(base('/tasks'), json('POST', selection ? { instruction, selection } : { instruction }));
export const listTasks = () => http<TaskLike[]>(base('/tasks'));
export const getTask = (id: string) => http<TaskLike>(base(`/tasks/${id}`));
export const cancelTask = (id: string) => http<TaskLike>(base(`/tasks/${id}/cancel`), { method: 'POST' });
export const listCandidates = () => http<CandidateLike[]>(base('/candidates'));
export const getCandidate = (id: string) => http<CandidateLike>(base(`/candidates/${id}`));
export const adoptCandidate = (id: string) => http(base(`/candidates/${id}/adopt`), { method: 'POST' });
export const discardCandidate = (id: string) => http(base(`/candidates/${id}/discard`), { method: 'POST' });
export const history = (since: number) => http<{ events: Array<{ type: string; seq: number }>; current: number; oldest: number; truncated: boolean }>(base(`/events/history?since=${since}`));
export const getScene = () => http<any>(base('/scene'));
export const putScene = (config: unknown) => http<any>(base('/scene'), json('PUT', config));
export const previewFetch = (url: string, method = 'GET') => http(base(url), { method });
export const setScript = (steps: Array<Array<{ name: string; args?: Record<string, unknown> }>>, delayMs = 0, mode: 'normal' | 'error' | 'text' = 'normal') =>
  http(`${MOCK_BASE}/__script`, json('POST', { steps, delayMs, mode }));
export const resetMock = () => http(`${MOCK_BASE}/__reset`, { method: 'POST' });
export const mockStats = () => http<{ calls: number; sessions: string[]; keys: Array<string | null>; steps: number; delayMs: number }>(`${MOCK_BASE}/__stats`);

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 120_000, intervalMs = 250): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await wait(intervalMs);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

/** 轮询任务直到进入终态（done/failed/cancelled）。 */
export async function waitForTask(id: string, timeoutMs = 180_000): Promise<TaskLike> {
  let last: TaskLike | null = null;
  await waitFor(async () => {
    last = (await getTask(id)).body;
    return ['done', 'failed', 'cancelled'].includes(last.status);
  }, timeoutMs, 300);
  return last!;
}

/** WS 事件收集器（用于“断开 → 产生事件 → 补拉”的用例）。 */
export async function collectEvents() {
  const events: Array<{ type: string; seq: number; [key: string]: unknown }> = [];
  const raw: string[] = [];
  const WebSocketImpl = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;
  const socket = new WebSocketImpl(`ws://127.0.0.1:3001/events`);
  socket.addEventListener('message', (event: { data: unknown }) => {
    const text = String(event.data);
    raw.push(text);
    try { events.push(JSON.parse(text)); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  return { events, raw, close: () => { try { socket.close(); } catch { /* ignore */ } } };
}

/** 等模板 dev server 转译后的 App.tsx 已经反映某个文本（git 写文件是原子替换，Vite 可能瞬时看到中间状态）。 */
export async function waitForTemplateModule(expected: string, timeoutMs = 90_000): Promise<number> {
  return waitFor(async () => {
    try {
      const response = await http('http://127.0.0.1:5174/preview/main/src/App.tsx');
      return response.status === 200 && response.text.includes(expected);
    } catch { return false; }
  }, timeoutMs, 400);
}

/** 打开作品页并等某个 testid 出现（开发服务刚被改过时允许一次重试）。 */
export async function openMainPreview(page: Page, expectedText: string, testId = 'buy-button'): Promise<void> {
  await waitForTemplateModule(expectedText);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/preview/main/');
    try {
      await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 25_000 });
      return;
    } catch { await wait(500); }
  }
  await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 30_000 });
}

/** 从 Studio 点选真实元素拿到 Selection，再把 baseVersion 换成作品版本库的当前提交。 */
export async function pickSelection(page: Page, testId = 'buy-button'): Promise<SelectionLike> {
  await page.goto('/');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="preview-status"]')?.textContent?.includes('预览已连接') === true,
    undefined,
    { timeout: 90_000 },
  );
  const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('没有取到作品预览 iframe');
  await frame.locator(`[data-testid="${testId}"]`).first().waitFor({ state: 'visible', timeout: 60_000 });
  await setPicking(page, true);
  // 复用 M0-B 的点击逻辑：先把目标滚进视口，再找一个命中它自身的点，按 iframe 偏移换算
  await clickTarget(page, frame, { selector: `[data-testid="${testId}"]` });
  const panel = page.locator('[data-testid="selection-json"]');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const selection = JSON.parse(await panel.innerText()) as SelectionLike;
  await setPicking(page, false);
  selection.baseVersion = (await getVersion()).body.version;
  return selection;
}

/** 候选预览的 Vite HMR 客户端无法通过后端代理建立 WS，会反复 reload；测试里用桩代替它验证内容本身。 */
export const VITE_CLIENT_STUB = `
export const createHotContext = () => ({ data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {} });
export const updateStyle = () => {};
export const removeStyle = () => {};
export const injectQuery = (url) => url;
export const ErrorOverlay = class {};
`;

export async function stubViteClient(page: Page): Promise<void> {
  await page.route('**/@vite/client', (route) => route.fulfill({ contentType: 'application/javascript', body: VITE_CLIENT_STUB }));
}

/** 打开候选预览（默认装上 HMR 客户端桩，见 09-known-defect 用例的说明）。 */
export async function openCandidatePreview(page: Page, candidateId: string, options: { stub?: boolean } = {}): Promise<string> {
  if (options.stub !== false) await stubViteClient(page);
  const url = `http://127.0.0.1:3001/preview/c/${candidateId}/`;
  await page.goto(url);
  return url;
}

/** 数一下页面在给定时间内导航了几次（用于证明 reload 循环）。 */
export async function countNavigations(page: Page, ms: number): Promise<number> {
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });
  await wait(ms);
  return navigations;
}

/* ------------------------------------------------------------------ 文件与进程 */

export const candidateDir = (id: string) => path.join(WORK_DATA, 'candidates', id);
export const gitDir = path.join(WORK_DATA, 'work.git');

export function git(args: string[]): { code: number | null; out: string } {
  const result = spawnSync('git', ['--git-dir', gitDir, '--work-tree', WORK_ROOT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

export function branches(): string[] {
  return git(['branch', '--list', '--format=%(refname:short)']).out.split('\n').map((line) => line.trim()).filter(Boolean);
}

export const appText = () => readFileSync(TEMPLATE_APP, 'utf8');

/** 把作品目录还原成 git 里的样子（测试会往里面写；结束时必须干净）。 */
export function restoreTemplate(): { status: string; clean: boolean } {
  spawnSync('git', ['checkout', '--', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  spawnSync('git', ['clean', '-fd', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', 'templates/product-page'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: `${status.stdout ?? ''}${status.stderr ?? ''}`.trim(), clean: !`${status.stdout ?? ''}`.trim() };
}

/** 依赖 junction 是否完好：候选目录删除不应沿着 junction 删到真实依赖。 */
export function dependenciesIntact(): { nodeModules: number; pnpm: number; ok: boolean } {
  const count = (folder: string) => { try { return readdirSync(folder).length; } catch { return -1; } };
  const nodeModules = count(path.join(WORK_ROOT, 'node_modules'));
  const pnpm = count(path.join(REPO_ROOT, 'node_modules', '.pnpm'));
  return { nodeModules, pnpm, ok: nodeModules > 0 && pnpm > 100 && existsSync(path.join(WORK_ROOT, 'node_modules', 'vite')) };
}

export function removeWorkData(): void {
  rmSync(M2A_DATA, { recursive: true, force: true });
}
