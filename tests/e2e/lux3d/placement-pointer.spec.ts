import { expect, test } from '@playwright/test';
import type { APIRequestContext, Frame, Locator, Page } from '@playwright/test';
import { api, control, resetFake, restoreWorkRoot, writeEvidence } from './support/api';
import { createTaskFromWorkbench, uploadAndRevealImage, type WorkbenchTask } from './support/workbench';

/**
 * 真实 Chromium 鼠标拖拽（非合成事件）：
 *  - 用 page.mouse down → 多步 move → up 触发 native HTML5 拖拽，跨 studio → 预览 iframe；
 *  - 只读观察器分两阶段：window capture 记录事件真实性（isTrusted/坐标/frame/命中），
 *    window bubble 用**同一事件**读 React 写入后的 dataTransfer.types/MIME（capture 早于 React，必为空）；
 *    两阶段按 observer 自己的序号/WeakMap 配对，互不覆盖；观察器不写 payload、不派发事件、不代浏览器 drop；
 *  - drop 用 capture（先于 bridge 的 stopImmediatePropagation）；命中按 closest('[data-testid="product-scene"]')。
 *  - 非侵入旁路：记录 iframe 收到的 placement:start/stop（origin/source/session 字段），不改 bridge、不写 payload。
 *  - 失败时在 page 仍存活的前提下把 main/preview 观测与面板/overlay 状态写独立证据（不掩盖首错）。
 *  - 放置面板出现后才取 iframe/目标几何，选一个**主文档 elementFromPoint 命中 preview-frame 且 iframe 内命中目标**的
 *    可见点；全遮挡直接失败，不隐藏面板、不改 DOM/payload、不换点击入口。
 *
 * 静态不可保证的部分（待运行验证）：Chromium/CDP 真实鼠标序列能否稳定产生跨 iframe native 拖拽、
 * 跨源 dataTransfer 在 drop 时可读、预览页是否存在真实滚动空间。若运行不成立，按实际失败报告，
 * 不回退成合成事件。
 */

const MIME = 'application/x-spatial-asset';

interface HitInfo { tag: string | null; testid: string | null; insideProductScene: boolean }
interface DragRecord {
  id: number; type: string; phase: 'capture'; trusted: boolean; clientX: number; clientY: number;
  dpr: number; frame: 'main' | 'preview'; hit: HitInfo | null;
}
interface MimeRecord { id: number | null; type: string; phase: 'bubble'; trusted: boolean; types: string[]; mime: string | null; readError: string | null }
interface PlacementMessageRecord {
  type: 'placement:start' | 'placement:stop';
  origin: string;
  sourceIsParent: boolean;
  sessionId: string | null;
  assetId: string | null;
  baseVersion: string | null;
  at: number;
}
interface DragLog {
  dragstart: DragRecord[]; dragover: DragRecord[]; drop: DragRecord[]; dragend: DragRecord[];
  mime: MimeRecord[]; messages: PlacementMessageRecord[];
}

declare global {
  interface Window { __pointerDragLog?: DragLog }
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(480_000);

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

/** 只读观察器必须在页面脚本前注册（产品在 window capture 上 stopImmediatePropagation）。 */
async function installObservers(page: Page) {
  // Playwright 只注入回调源码文本，Node 模块常量不会随闭包进入浏览器；MIME 必须显式传参。
  await page.addInitScript((mimeType: string) => {
    const log: DragLog = { dragstart: [], dragover: [], drop: [], dragend: [], mime: [], messages: [] };
    (window as Window & { __pointerDragLog?: DragLog }).__pointerDragLog = log;
    let sequence = 0;
    const ids = new WeakMap<Event, number>();
    const hitInfo = (x: number, y: number): HitInfo => {
      const element = document.elementFromPoint(x, y);
      return {
        tag: element ? element.tagName : null,
        testid: element ? element.getAttribute('data-testid') : null,
        insideProductScene: Boolean(element && element.closest('[data-testid="product-scene"]')),
      };
    };
    const capture = (type: 'dragstart' | 'dragover' | 'drop' | 'dragend') => (event: DragEvent) => {
      const id = ++sequence;
      ids.set(event, id);
      log[type].push({
        id, type, phase: 'capture', trusted: event.isTrusted,
        clientX: event.clientX, clientY: event.clientY, dpr: window.devicePixelRatio,
        frame: window === window.parent ? 'main' : 'preview',
        hit: type === 'dragover' || type === 'drop' ? hitInfo(event.clientX, event.clientY) : null,
      });
    };
    // React 在 root 的 bubble 阶段写 dataTransfer；window bubble 晚于它，只读同一事件。
    const bubble = (event: DragEvent) => {
      const data = event.dataTransfer;
      let mime: string | null = null;
      let readError: string | null = null;
      try {
        mime = data ? (data.getData(mimeType) ?? null) : null;
      } catch (error) {
        // 可序列化的原始错误：证据里保留原因，不再吞成空值。
        readError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
      log.mime.push({
        id: ids.get(event) ?? null, type: event.type, phase: 'bubble', trusted: event.isTrusted,
        types: data ? Array.from(data.types) : [], mime, readError,
      });
    };
    for (const type of ['dragstart', 'dragover', 'drop', 'dragend'] as const) window.addEventListener(type, capture(type), true);
    for (const type of ['dragstart', 'dragover', 'drop'] as const) window.addEventListener(type, bubble, false);
    // 只读旁路：记录 iframe 是否真的收到 placement:start/stop，以及 origin/source/session 字段。
    // 不写 dataTransfer、不替浏览器 post 或 drop；受保护的 dragover store 读空是正常的。
    window.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: unknown; payload?: unknown } | null;
      if (!data || (data.type !== 'placement:start' && data.type !== 'placement:stop')) return;
      const payload = (data.payload ?? {}) as Record<string, unknown>;
      log.messages.push({
        type: data.type,
        origin: event.origin,
        sourceIsParent: event.source === window.parent,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
        assetId: typeof payload.assetId === 'string' ? payload.assetId : null,
        baseVersion: typeof payload.baseVersion === 'string' ? payload.baseVersion : null,
        at: performance.now(),
      });
    }, true);
  }, MIME);
}

async function createReadyTask(page: Page, request: APIRequestContext): Promise<WorkbenchTask> {
  await page.goto('/');
  await page.getByTestId('asset-open').click();
  await expect(page.getByTestId('lux-workbench')).toBeVisible({ timeout: 60_000 });
  const image = await uploadAndRevealImage(page);
  await image.check();
  // 绑定本次点击的 create localId；UI 必须真实显示该任务的 ready 卡与原件链接。
  return createTaskFromWorkbench(page, request, { label: 'pointer-create', click: () => page.getByTestId('lux-create').click() });
}

async function previewFrame(page: Page): Promise<Frame> {
  await expect(page.frameLocator('[data-testid="preview-frame"]').locator('[data-testid="product-scene"]')).toBeVisible({ timeout: 120_000 });
  const frame = page.frames().find((item) => item.url().includes('/preview/main/'));
  expect(frame, '预览 iframe 已挂载且 URL 为目标预览页').toBeTruthy();
  return frame!;
}

/** 真实滚动：优先预览文档，其次工作台页面；两者都没有真实滚动空间时显式失败（不伪造、不退化为合成事件）。 */
async function realScroll(page: Page, frame: Frame) {
  const preview = await frame.evaluate(() => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const max = Math.max(0, scroller.scrollHeight - window.innerHeight);
    if (max < 60) return { max, amount: 0 };
    scroller.scrollTop = Math.min(180, max);
    return { max, amount: scroller.scrollTop };
  });
  if (preview.amount > 0) return { scroller: 'preview-iframe', amount: preview.amount, max: preview.max };
  const main = await page.evaluate(() => {
    const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (max < 60) return { max, amount: 0 };
    window.scrollBy(0, 160);
    return { max, amount: window.scrollY };
  });
  if (main.amount > 0) return { scroller: 'studio-page', amount: main.amount, max: main.max };
  throw new Error(`没有真实滚动空间（preview.max=${preview.max}，studio.max=${main.max}）：需安全 fixture/视口设计，不退化为合成事件`);
}

interface DropAttempt {
  client: { x: number; y: number };
  main: { x: number; y: number };
  mainHit: HitInfo & { isPreviewFrame: boolean };
  innerHit: HitInfo;
}
interface DropPoint extends DropAttempt {
  rect: { x: number; y: number; width: number; height: number };
  scrollTop: number; dpr: number; attempts: DropAttempt[]; visibleFully: boolean;
}

/**
 * SF1：放置面板已经出现（按钮仍按下）时才取几何，逐个候选点同时验证：
 *  主文档 elementFromPoint 命中 preview-frame；iframe 内 elementFromPoint 命中 product-scene 容器。
 * 全遮挡则以原始候选/命中节点显式失败；不隐藏面板、不改 DOM、不换点击入口。
 */
async function visibleDropPoint(page: Page, frame: Frame): Promise<DropPoint> {
  const iframeBox = await page.locator('[data-testid="preview-frame"]').boundingBox();
  if (!iframeBox) throw new Error('预览 iframe 没有主视口边界');
  const inner = await frame.evaluate(() => {
    const node = document.querySelector('[data-testid="product-scene"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const left = Math.max(rect.x, 4); const top = Math.max(rect.y, 4);
    const right = Math.min(rect.x + rect.width, viewport.width - 4); const bottom = Math.min(rect.y + rect.height, viewport.height - 4);
    const visible = right > left && bottom > top;
    const fractions = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
    const hits = fractions.map(([fx, fy]) => {
      const x = left + (right - left) * fx; const y = top + (bottom - top) * fy;
      const element = document.elementFromPoint(x, y);
      return {
        client: { x, y }, tag: element ? element.tagName : null,
        testid: element ? element.getAttribute('data-testid') : null,
        insideProductScene: Boolean(element && element.closest('[data-testid="product-scene"]')),
      };
    });
    const visibleFully = rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height;
    return { visible, visibleFully, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport, scrollTop: (document.scrollingElement ?? document.documentElement).scrollTop, dpr: window.devicePixelRatio, hits };
  });
  if (!inner) throw new Error('预览页缺少 product-scene');
  if (!inner.visible) throw new Error(`目标在预览视口内不可见：rect=${JSON.stringify(inner.rect)} viewport=${JSON.stringify(inner.viewport)}`);
  const attempts: DropAttempt[] = [];
  for (const hit of inner.hits) {
    const main = { x: iframeBox.x + hit.client.x, y: iframeBox.y + hit.client.y };
    const mainHit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { tag: element ? element.tagName : null, testid: element ? element.getAttribute('data-testid') : null, insideProductScene: Boolean(element && element.closest('[data-testid="product-scene"]')) };
    }, main);
    const attempt: DropAttempt = {
      client: hit.client, main,
      mainHit: { ...mainHit, isPreviewFrame: mainHit.testid === 'preview-frame' },
      innerHit: { tag: hit.tag, testid: hit.testid, insideProductScene: hit.insideProductScene },
    };
    attempts.push(attempt);
    if (attempt.mainHit.isPreviewFrame && attempt.innerHit.insideProductScene) {
      return { ...attempt, rect: inner.rect, scrollTop: inner.scrollTop, dpr: inner.dpr, attempts, visibleFully: inner.visibleFully };
    }
  }
  throw new Error(`放置目标在主视口全部被遮挡或未命中预览 iframe：${JSON.stringify(attempts).slice(0, 3000)}`);
}

/** 真实鼠标序列：结果卡按下 → 多步移动穿过 iframe → 在目标上松开；不使用任何合成/手动 drop。返回实际使用点。 */
async function realDrag(page: Page, frame: Frame, card: Locator, label: string): Promise<DropPoint> {
  await card.hover();
  await expect(card, '本次任务的结果卡已可拖（hover 已准备放置会话）').toHaveAttribute('draggable', 'true', { timeout: 60_000 });
  const box = await card.boundingBox();
  if (!box) throw new Error('结果卡没有边界');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  let released = false;
  let completed = false;
  let point: DropPoint | undefined;
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 24, start.y + 24, { steps: 6 });
    await expect(page.getByTestId('asset-placement'), '真实 dragstart 后才出现放置面板').toBeVisible({ timeout: 30_000 });
    // SF1：面板已出现、按键未松开，此时才取当前几何与实际可用落点。
    point = await visibleDropPoint(page, frame);
    const steps = 14;
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps;
      await page.mouse.move(start.x + (point.main.x - start.x) * ratio, start.y + (point.main.y - start.y) * ratio, { steps: 4 });
    }
    await expect.poll(() => frame.evaluate(() => {
      const overlay = document.querySelector('[data-placement-overlay="true"]');
      return overlay ? getComputedStyle(overlay).display : 'none';
    }), { timeout: 20_000 }).toBe('block');
    await page.mouse.move(point.main.x, point.main.y);
    await page.mouse.up();
    released = true;
    await expect(page.getByTestId('placement-target'), '真实 drop 后应得到目标').toBeVisible({ timeout: 60_000 });
    completed = true;
    return point;
  } finally {
    if (!released) await page.mouse.up().catch(() => undefined);
    if (!completed && page.isClosed() === false) {
      // 失败时页面仍存活：把 main/preview 观测、面板/overlay 状态、实际落点写成独立证据。
      // 证据写失败不得掩盖首错；单独尝试写 evidenceFailure。
      try {
        const logs = await readLogs(page, frame);
        const ui = await inspectPlacementUi(page, frame);
        writeEvidence(`pointer-drag-attempt-${label}.json`, { label, at: new Date().toISOString(), point: point ?? null, logs, ui });
      } catch (evidenceError) {
        try {
          writeEvidence(`pointer-drag-attempt-${label}-evidence-failure.json`, { label, at: new Date().toISOString(), evidenceFailure: String(evidenceError) });
        } catch { /* 不掩盖首错 */ }
      }
    }
  }
}

async function inspectPlacementUi(page: Page, frame: Frame) {
  const panel = page.getByTestId('asset-placement');
  const panelCount = await panel.count();
  const panelVisible = panelCount > 0 ? await panel.isVisible() : false;
  const targetCount = await page.getByTestId('placement-target').count();
  const overlay = await frame.evaluate(() => {
    const element = document.querySelector('[data-placement-overlay="true"]');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { display: getComputedStyle(element).display, text: element.textContent, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  });
  const scroll = await frame.evaluate(() => ({ scrollTop: (document.scrollingElement ?? document.documentElement).scrollTop, dpr: window.devicePixelRatio }));
  return { panelCount, panelVisible, targetCount, overlay, scroll };
}

async function readLogs(page: Page, frame: Frame) {
  const read = (target: Page | Frame) => target.evaluate(() => (window as Window & { __pointerDragLog?: DragLog }).__pointerDragLog
    ?? { dragstart: [], dragover: [], drop: [], dragend: [], mime: [], messages: [] });
  return { main: await read(page), preview: await read(frame) };
}

async function confirmAndUndo(page: Page, request: APIRequestContext, before: string) {
  await expect(page.getByTestId('placement-target')).toContainText('替换');
  await page.getByTestId('placement-confirm').click();
  await expect.poll(async () => (await api<{ model: string }>(request, 'GET', '/scene')).body.model, { timeout: 120_000 }).not.toBe(before);
  const after = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  expect(after).toMatch(/^\/assets\/.+\.glb$/);
  expect((await api(request, 'POST', '/scene/undo')).status).toBe(200);
  expect((await api<{ model: string }>(request, 'GET', '/scene')).body.model).toBe(before);
  return after;
}

function expectDragEvidence(logs: Awaited<ReturnType<typeof readLogs>>, point: DropPoint) {
  const start = logs.main.dragstart.at(-1);
  expect(start, '主文档应收到真实 dragstart').toBeTruthy();
  expect(start!.trusted, 'dragstart 必须 trusted').toBe(true);
  expect(start!.frame).toBe('main');
  const bubble = logs.main.mime.filter((item) => item.type === 'dragstart' && item.id === start!.id).at(-1);
  expect(bubble, '同一 dragstart 事件在 window bubble 的只读记录').toBeTruthy();
  expect(bubble!.id).toBe(start!.id);
  expect(bubble!.readError, `bubble 读取 MIME 不应报错（实际 ${bubble!.readError}）`).toBeNull();
  expect(bubble!.types, 'React 写入后 dataTransfer.types 应含本应用 MIME').toContain(MIME);
  expect(typeof bubble!.mime, `bubble.mime 应为非空 string（实际 ${JSON.stringify(bubble!.mime)}）`).toBe('string');
  expect(bubble!.mime!.length).toBeGreaterThan(0);
  const payload = JSON.parse(bubble!.mime!) as { sessionId?: unknown; assetId?: unknown } | null;
  expect(typeof payload?.sessionId).toBe('string');
  expect(typeof payload?.assetId).toBe('string');
  const drop = logs.preview.drop.at(-1);
  expect(drop, '预览 iframe 应收到真实 drop').toBeTruthy();
  expect(drop!.trusted, 'drop 必须 trusted').toBe(true);
  expect(drop!.hit?.insideProductScene, `drop 应命中目标容器（实际 ${JSON.stringify(drop!.hit)}）`).toBe(true);
  expect(Math.abs(drop!.clientX - point.client.x)).toBeLessThanOrEqual(6);
  expect(Math.abs(drop!.clientY - point.client.y)).toBeLessThanOrEqual(6);
  return { start: start!, bubble: bubble!, drop: drop! };
}

test('真实鼠标拖拽（基线）：结果卡 dragstart → 跨 iframe drop，确认后采用并可撤回', async ({ page, request }) => {
  await installObservers(page);
  const binding = await createReadyTask(page, request);
  const frame = await previewFrame(page);
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  const point = await realDrag(page, frame, binding.card, 'baseline');
  expect(point.scrollTop).toBe(0);
  const logs = await readLogs(page, frame);
  const evidence = expectDragEvidence(logs, point);
  const after = await confirmAndUndo(page, request, before);
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('pointer-drag-baseline.json', { point, dragstart: evidence.start, mime: evidence.bubble, drop: evidence.drop, before, after, cleanup });
});

test('真实鼠标拖拽 + 真实非零滚动：滚动后目标仍命中，放置仍正确', async ({ page, request }) => {
  await installObservers(page);
  const binding = await createReadyTask(page, request);
  const frame = await previewFrame(page);
  const scroll = await realScroll(page, frame);
  expect(scroll.amount).toBeGreaterThan(0);
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  const point = await realDrag(page, frame, binding.card, 'scroll');
  if (scroll.scroller === 'preview-iframe') expect(point.scrollTop).toBeGreaterThan(0);
  const logs = await readLogs(page, frame);
  const evidence = expectDragEvidence(logs, point);
  const after = await confirmAndUndo(page, request, before);
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('pointer-drag-scroll.json', { scroll, point, dragstart: evidence.start, mime: evidence.bubble, drop: evidence.drop, before, after, cleanup });
});

test('真实鼠标拖拽 · DPR=2 环境：放置仍正确（仅环境值，不代表真实坐标）', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await installObservers(page);
    const binding = await createReadyTask(page, request);
    const frame = await previewFrame(page);
    const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
    const point = await realDrag(page, frame, binding.card, 'dpr2');
    expect(point.dpr).toBe(2);
    const logs = await readLogs(page, frame);
    const evidence = expectDragEvidence(logs, point);
    expect(evidence.start.dpr).toBe(2);
    expect(evidence.drop.dpr).toBe(2);
    const after = await confirmAndUndo(page, request, before);
    const cleanup = restoreWorkRoot();
    expect(cleanup.after).toBe('');
    writeEvidence('pointer-drag-dpr2.json', { point, dragstart: evidence.start, mime: evidence.bubble, drop: evidence.drop, before, after, cleanup, note: '仅 devicePixelRatio 环境值，未验证真实物理坐标' });
  } finally {
    await context.close();
  }
});
