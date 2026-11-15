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

/** 场景历史撤销：资产采用的是 SceneService.adopt（压 scene history），还原走这里，不是 /version/revert。 */
export const undoScene = () => http(base('/scene/undo'), { method: 'POST' });

/** 通过真实 HTTP 取资产 model.glb 的字节，算 SHA256（用于核对来源绑定的字节）。 */
export async function assetModelHash(id: string): Promise<string> {
  const response = await fetch(`${BACKEND_BASE}/assets/${encodeURIComponent(id)}/model.glb`);
  if (!response.ok) throw new Error(`取模型字节失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(buffer).digest('hex');
}

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

/**
 * 在真实作品 iframe 里点选一个元素，返回**本次**选择。
 *
 * 旧实现有明确竞态：面板 [data-testid=selection-json] 在**上一次**选择后一直是可见的，
 * 所以 `waitFor({state:'visible'})` 立刻返回并读到**上一个**对象（A），于是 A/B 用例里
 * "两个对象不同"的断言被前一次选择污染。这里改成对"这一次"的屏障 + 真实事件证据：
 *
 * 1. 观测父窗口真实收到的 `pick:result` 消息（只记录，不伪造）；
 * 2. 先在 iframe 里用**实际点击坐标**做 elementFromPoint 审计，记录命中元素与其 data-src；
 * 3. 点击后必须同时满足：**新的 pick:result 出现**（序号增加）、其 payload 的 src 与命中元素同源、
 *    面板文本**与点击前不同**，才读取 selection；
 * 4. 返回 { selection, hit, message } 供用例在证据里记录坐标/命中/message 序列。
 *    不删除任何 notEqual 或冲突断言，也不改目标选择。
 */
export interface PickAudit {
  selection: any;
  hit: { tag: string | null; testId: string | null; src: string | null; point: { x: number; y: number } };
  message: { index: number; src: string | null; origin: string | null };
  before: { panelText: string; messages: number };
}

export async function pickElement(page: Page, testId: string): Promise<PickAudit> {
  // 记录真实 pick:result（观测，不造消息）；同一页面只装一次。
  await page.evaluate(() => {
    const target = window as any;
    if (target.__pickResults) return;
    target.__pickResults = [];
    window.addEventListener('message', (event) => {
      const data = (event as MessageEvent).data;
      if (!data || data.type !== 'pick:result') return;
      target.__pickResults.push({ at: Date.now(), src: data.payload?.src ?? null, origin: event.origin ?? null });
    });
  });

  await page.getByTestId('pick-toggle').click();
  try {
    const frame = await previewFrame(page);
    const target = frame.locator(`[data-testid="${testId}"]`).first();
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`找不到元素 ${testId}`);

    const panel = page.locator('[data-testid="selection-json"]');
    const before = {
      panelText: (await panel.count()) > 0 ? await panel.innerText().catch(() => '') : '',
      messages: await page.evaluate(() => ((window as any).__pickResults?.length ?? 0) as number),
    };

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // 实际命中审计：把主框架坐标换算成 iframe 内坐标，用元素文档自己在真实位置做 elementFromPoint。
    const hit = await frame.evaluate(({ expected }) => {
      const all = [...document.querySelectorAll('[data-src]')];
      const found = all.find((element) => element.getAttribute('data-testid') === expected) ?? null;
      const box2 = found?.getBoundingClientRect();
      const probeX = box2 ? box2.left + box2.width / 2 : 0;
      const probeY = box2 ? box2.top + box2.height / 2 : 0;
      const hitElement = found ? document.elementFromPoint(probeX, probeY) : null;
      const marked = hitElement?.closest('[data-src]') as HTMLElement | null;
      return {
        tag: hitElement ? hitElement.tagName.toLowerCase() : null,
        testId: (hitElement as HTMLElement | null)?.getAttribute?.('data-testid') ?? null,
        src: marked?.getAttribute('data-src') ?? null,
        point: { x: probeX, y: probeY },
      };
    }, { expected: testId }).catch(() => ({ tag: null, testId: null, src: null, point: { x: 0, y: 0 } }));

    await page.mouse.click(x, y);

    // 屏障：新的 pick:result + 面板文本变化，二者同时成立才算"这一次"完成。
    await waitFor(async () => {
      const messages = await page.evaluate(() => ((window as any).__pickResults?.length ?? 0) as number);
      if (messages <= before.messages) return false;
      const text = (await panel.count()) > 0 ? await panel.innerText().catch(() => '') : '';
      return text !== '' && text !== before.panelText;
    }, 30_000, 100);

    const selection = JSON.parse(await panel.innerText());
    const messages = await page.evaluate(() => (window as any).__pickResults as Array<{ src: string | null; origin: string | null }>);
    const last = messages[messages.length - 1];
    // 同源核对：这次 message 的 src 必须与面板里的 selection.src 一致（不靠猜、不靠旧值）。
    if (last?.src && selection?.src) {
      const same = last.src === selection.src;
      if (!same) throw new Error(`pick:result 与面板 selection 不一致：message=${last.src} panel=${selection.src}`);
    }
    return { selection, hit, message: { index: messages.length - 1, src: last?.src ?? null, origin: last?.origin ?? null }, before };
  } finally {
    await page.getByTestId('pick-toggle').click();
  }
}
