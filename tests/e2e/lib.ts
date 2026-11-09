import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from '@playwright/test';

/** Playwright 的 cwd 是配置文件所在目录（仓库根）。 */
export const REPO_ROOT = process.cwd();
export const TEMPLATE_ROOT = path.join(REPO_ROOT, 'templates', 'product-page');
export const ARTIFACT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'artifacts', 'M0-B');

/** 随机抽样的固定种子，写进测试报告。 */
export const SEED = 20261109;
export const SAMPLE_SIZE = 20;

export const STUDIO_ORIGIN = 'http://127.0.0.1:5173';

export interface MarkedElement {
  index: number;
  src: string;
  cid: string;
  tag: string;
  text: string;
}

export interface SourceHit {
  file: string;
  line: number;
  column: number;
  lineText: string;
  char: string;
  tag: string | null;
}

/** mulberry32：确定性 PRNG，保证随机抽样可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌后取前 n 个；同一输入与种子结果完全一致。 */
export function sampleDeterministic<T>(items: T[], count: number, seed: number): T[] {
  const random = mulberry32(seed);
  const pool = items.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

/** 解析 `文件:行:列`，并从 templates/product-page 读取原始源码，返回该位置字符与标签名。 */
export function readSourceAt(src: string): SourceHit {
  const match = /^(.+):(\d+):(\d+)$/.exec(src);
  if (!match) throw new Error(`src 不是 文件:行:列 格式：${src}`);
  const file = match[1];
  const line = Number(match[2]);
  const column = Number(match[3]);
  const absolute = path.resolve(TEMPLATE_ROOT, file);
  if (!absolute.startsWith(TEMPLATE_ROOT + path.sep)) throw new Error(`src 指向模板根之外：${src}`);
  const lines = readFileSync(absolute, 'utf8').split('\n');
  const lineText = lines[line - 1];
  if (lineText === undefined) throw new Error(`行号超出文件范围：${src}（文件共 ${lines.length} 行）`);
  const trimmed = lineText.replace(/\r$/, '');
  const char = trimmed[column - 1] ?? '';
  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(trimmed.slice(column - 1));
  return { file, line, column, lineText: trimmed, char, tag: tagMatch ? tagMatch[1].toLowerCase() : null };
}

/** 打开 Studio，等待预览 iframe 连接并渲染出模板。 */
export async function openStudio(page: Page): Promise<Frame> {
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`);
  });
  (page as Page & { __consoleErrors?: string[] }).__consoleErrors = consoleErrors;

  await page.goto('/');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="preview-status"]')?.textContent?.includes('预览已连接') === true,
    undefined,
    { timeout: 45_000 },
  );
  const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('未取到预览 iframe 的 Frame');
  await frame.waitForSelector('[data-testid="buy-button"]', { timeout: 45_000 });
  // 给 bridge 的 ready / Studio 状态同步留一点余量
  await page.waitForTimeout(300);
  return frame;
}

export function consoleErrorsOf(page: Page): string[] {
  return (page as Page & { __consoleErrors?: string[] }).__consoleErrors ?? [];
}

/** 枚举预览页所有带 data-src 的元素（DOM 顺序）。 */
export async function enumerateMarked(frame: Frame): Promise<MarkedElement[]> {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll('[data-src]')).map((element, index) => ({
      index,
      src: element.getAttribute('data-src') ?? '',
      cid: element.getAttribute('data-cid') ?? '',
      tag: element.tagName.toLowerCase(),
      text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    })),
  );
}

/** 取某个选择器命中的元素在 data-src 列表中的下标。 */
export async function markedIndexOf(frame: Frame, selector: string): Promise<number> {
  const index = await frame.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return -1;
    return Array.from(document.querySelectorAll('[data-src]')).indexOf(element);
  }, selector);
  if (index < 0) throw new Error(`选择器未命中带 data-src 的元素：${selector}`);
  return index;
}

/** 元素同 data-src 的实例数（以 DOM 为准，作为 instances 的期望值）。 */
export async function countInstances(frame: Frame, src: string): Promise<number> {
  return frame.evaluate(
    (value) => Array.from(document.querySelectorAll('[data-src]')).filter((el) => el.getAttribute('data-src') === value).length,
    src,
  );
}

/** 点击前的准备：把目标滚进预览视口中央。 */
async function scrollIntoView(frame: Frame, target: { index?: number; selector?: string }): Promise<void> {
  await frame.evaluate((arg) => {
    const element = arg.index !== undefined
      ? document.querySelectorAll('[data-src]')[arg.index]
      : document.querySelector(arg.selector ?? '');
    element?.scrollIntoView({ block: 'center', inline: 'center' });
  }, target);
  await frame.page().waitForTimeout(250);
}

/**
 * 找一个「命中的就是该元素本身」的视口内坐标（padding / 文字等未被后代覆盖的区域）。
 * 容器类元素常被后代完全覆盖，此时返回 null。
 */
async function findHitPoint(
  frame: Frame,
  target: { index?: number; selector?: string },
): Promise<{ x: number; y: number } | null> {
  return frame.evaluate((arg) => {
    const element = arg.index !== undefined
      ? (document.querySelectorAll('[data-src]')[arg.index] as HTMLElement | undefined)
      : (document.querySelector(arg.selector ?? '') as HTMLElement | null);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const steps = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (let ix = 1; ix < steps; ix += 1) {
      for (let iy = 1; iy < steps; iy += 1) {
        const x = rect.left + (rect.width * ix) / steps;
        const y = rect.top + (rect.height * iy) / steps;
        if (x < 0 || y < 0 || x >= vw - 1 || y >= vh - 1) continue;
        if (document.elementFromPoint(x, y) === element) return { x, y };
      }
    }
    return null;
  }, target);
}

export type ClickMode = 'mouse' | 'dom-dispatch';

export interface ClickOptions {
  button?: 'left' | 'right';
  clicks?: 1 | 2;
}

/**
 * 在预览页里点击目标。
 * 优先用真实鼠标事件（page.mouse），坐标由 iframe 在 Studio 中的位置换算；
 * 若元素被后代完全覆盖（容器类），退化为在元素自身上派发冒泡 click，
 * 仍会经过 bridge 的 window capture 拦截逻辑。实际使用的方式会被记录。
 * 右键 / 双击：传 options.button = 'right' 或 options.clicks = 2。
 */
export async function clickTarget(
  page: Page,
  frame: Frame,
  target: { index?: number; selector?: string },
  options: ClickOptions = {},
): Promise<ClickMode> {
  await scrollIntoView(frame, target);
  const point = await findHitPoint(frame, target);
  if (point) {
    const box = await page.locator('[data-testid="preview-frame"]').boundingBox();
    if (!box) throw new Error('预览 iframe 没有布局盒');
    const x = box.x + point.x;
    const y = box.y + point.y;
    if (options.clicks === 2) await page.mouse.dblclick(x, y, { button: options.button ?? 'left' });
    else await page.mouse.click(x, y, { button: options.button ?? 'left' });
    return 'mouse';
  }
  await frame.evaluate((arg) => {
    const element = arg.index !== undefined
      ? (document.querySelectorAll('[data-src]')[arg.index] as HTMLElement | undefined)
      : (document.querySelector(arg.selector ?? '') as HTMLElement | null);
    if (!element) throw new Error('点击目标不存在');
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, detail: 1 }));
  }, target);
  return 'dom-dispatch';
}

/** 把鼠标移到目标上（不按下），用于验证悬停高亮仍工作。 */
export async function hoverTarget(
  page: Page,
  frame: Frame,
  target: { index?: number; selector?: string },
): Promise<void> {
  await scrollIntoView(frame, target);
  const point = await findHitPoint(frame, target);
  if (!point) throw new Error('找不到可悬停的点');
  const box = await page.locator('[data-testid="preview-frame"]').boundingBox();
  if (!box) throw new Error('预览 iframe 没有布局盒');
  await page.mouse.move(box.x + point.x, box.y + point.y);
  await page.waitForTimeout(200);
}

/** 覆盖层里「悬停框」的数量：bridge 把悬停框画成橙色边框，选中框是青色。 */
export async function hoverBoxCount(frame: Frame): Promise<number> {
  return frame.evaluate(() => Array.from(document.querySelectorAll('[data-highlight-src]'))
    .filter((element) => (element as HTMLElement).style.borderColor.replace(/\s/g, '').includes('245,158,11')).length);
}

export async function selectionText(page: Page): Promise<string> {
  const panel = page.locator('[data-testid="selection-json"]');
  if ((await panel.count()) === 0) return '';
  return panel.innerText();
}

export async function readSelection(page: Page): Promise<Record<string, unknown>> {
  const text = await selectionText(page);
  if (!text) throw new Error('Selection 面板还没有内容');
  return JSON.parse(text) as Record<string, unknown>;
}

export async function waitForSelectionChange(page: Page, before: string): Promise<void> {
  await page.waitForFunction(
    (previous) => {
      const panel = document.querySelector('[data-testid="selection-json"]');
      return panel !== null && panel.textContent !== previous;
    },
    before,
    { timeout: 15_000 },
  );
}

/** 选中一个带标记的元素并返回 Selection。 */
export async function pickMarked(
  page: Page,
  frame: Frame,
  index: number,
): Promise<{ mode: ClickMode; selection: Record<string, unknown> }> {
  const before = await selectionText(page);
  const mode = await clickTarget(page, frame, { index });
  await waitForSelectionChange(page, before);
  return { mode, selection: await readSelection(page) };
}

export async function setPicking(page: Page, on: boolean): Promise<void> {
  const toggle = page.locator('[data-testid="pick-toggle"]');
  const pressed = await toggle.getAttribute('aria-pressed');
  if ((pressed === 'true') !== on) {
    await toggle.click();
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="pick-toggle"]')?.getAttribute('aria-pressed') === String(expected),
      on,
      { timeout: 10_000 },
    );
  }
  await page.waitForTimeout(150);
}

/** 高亮覆盖层里对应 src 的框数量。 */
export async function highlightBoxCount(frame: Frame, src: string): Promise<number> {
  return frame.evaluate(
    (value) => Array.from(document.querySelectorAll('[data-highlight-src]'))
      .filter((el) => el.getAttribute('data-highlight-src') === value).length,
    src,
  );
}

/**
 * 按「标签 + 自身静态文本」在预览页里定位元素，命中后临时打上 `data-e2e-target`，
 * 方便复用已有的真实鼠标点击逻辑。返回命中个数（应当正好 1 个）。
 * 自身文本 = 直接子级文本节点拼起来并折叠空白，和 AST 侧 JSXText 的口径一致。
 */
export async function markByOwnText(frame: Frame, tag: string, ownText: string): Promise<number> {
  return frame.evaluate(({ tag: tagName, text }) => {
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
    const ownTextOf = (element: Element) => normalize(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(''),
    );
    const matches = Array.from(document.querySelectorAll(tagName)).filter((element) => ownTextOf(element) === text);
    for (const element of matches) element.setAttribute('data-e2e-target', '1');
    return matches.length;
  }, { tag, text: ownText });
}

export async function clearE2eMarks(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    for (const element of Array.from(document.querySelectorAll('[data-e2e-target]'))) element.removeAttribute('data-e2e-target');
  });
}

/** 点击一个已被 `markByOwnText` 标记的元素。 */
export async function clickMarkedByText(page: Page, frame: Frame): Promise<ClickMode> {
  const mode = await clickTarget(page, frame, { selector: '[data-e2e-target="1"]' });
  await clearE2eMarks(frame);
  return mode;
}

/** 在预览页里注入一个探针对象，并把事件监听器挂在指定元素上（只影响本次页面，不改模板）。 */
export async function installEventProbe(frame: Frame, selector: string): Promise<void> {
  await frame.evaluate((target) => {
    const probe: Record<string, number> = {
      pointerdown: 0, mousedown: 0, mouseup: 0, click: 0, auxclick: 0,
      dblclick: 0, contextmenu: 0, submit: 0, keydown: 0, keyup: 0,
    };
    (window as unknown as { __probe: Record<string, number> }).__probe = probe;
    const element = document.querySelector(target);
    if (!element) throw new Error(`探针挂载目标不存在：${target}`);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'contextmenu']) {
      element.addEventListener(type, () => { probe[type] += 1; }, true);
    }
    element.addEventListener('keydown', () => { probe.keydown += 1; }, true);
    element.addEventListener('keyup', () => { probe.keyup += 1; }, true);
  }, selector);
}

/** 在预览页里注入「单输入框 + 无提交按钮」的表单，监听 submit（阻止真实导航）。 */
export async function installSingleInputForm(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const host = document.querySelector('[data-testid="benefits"]') ?? document.getElementById('root');
    if (!host) throw new Error('找不到注入宿点');
    const form = document.createElement('form');
    form.id = 'probe-form';
    const input = document.createElement('input');
    input.id = 'probe-input';
    input.type = 'text';
    input.setAttribute('style', 'display:block;width:160px;height:28px;margin:8px 0;');
    form.append(input);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const probe = (window as unknown as { __probe: Record<string, number> }).__probe;
      if (probe) probe.submit += 1;
    });
    host.after(form);
  });
}

export async function readProbe(frame: Frame): Promise<Record<string, number>> {
  return frame.evaluate(() => ({ ...((window as unknown as { __probe: Record<string, number> }).__probe ?? {}) }));
}

export async function previewHash(frame: Frame): Promise<string> {
  return frame.evaluate(() => window.location.hash);
}

/** 预览页里所有元素（用于完整性对照），带标记状态。 */
export async function domTagInventory(frame: Frame): Promise<{ total: number; unmarked: Array<{ tag: string; text: string }> }> {
  return frame.evaluate(() => {
    const scope = document.getElementById('root') ?? document.body;
    const all = Array.from(scope.querySelectorAll('*')).filter((element) =>
      !element.closest('[data-bridge-overlay]') && element.getAttribute('data-e2e-target') === null);
    const unmarked = all
      .filter((element) => !element.hasAttribute('data-src'))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
      }));
    return { total: all.length, unmarked };
  });
}

/** 运行时 DOM 里出现过的全部 data-src（去重）。 */
export async function domSrcSet(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => Array.from(new Set(Array.from(document.querySelectorAll('[data-src]'))
    .map((element) => element.getAttribute('data-src') ?? ''))).sort());
}

export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export async function screenshot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}
