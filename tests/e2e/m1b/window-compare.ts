import type { Frame, Page } from '@playwright/test';
import { canvasRect, resetEditorScroll, type CanvasPair, type CaptureWindow } from './editor';
import { captureRegion, compareAligned } from '../m1a/visual';

/**
 * 同窗口前后比较（M1-B 专项最小测试侧修正，返工二）。
 *
 * 背景：三条 M1-B 失败都是 `compareAligned(baseline.preview.png, current.preview.png)` 抛
 * `尺寸不一致：378x378 vs 378x341` —— 同一个作品预览在写入前后两个时刻的截图，
 * 而 `captureCanvases()` 每次按**当下**的预览 iframe 可见区重算坐标窗口，
 * 写回过渡期里提示行出现/消失就会让两次 PNG 尺寸不同。
 *
 * 本模块只做三件事，全部在**原先的预算与阈值**内：
 *  1. 采样前证明基线真的就绪（场景 `data-loaded`、写回控件可用、无"状态待同步"）；
 *  2. 采样时要求"写回控件可用 + 提示消失 + 窗口几何/backing 与基线完全一致"，再用**基线坐标**截图；
 *  3. 把真实请求结果与每次尝试的几何/UI 诊断原样记录（成功与失败都写），不吞异常、不做固定 sleep。
 */

/* ------------------------------------------------------------------ 观察真实请求 */

export interface ObservedResponse { status: number | null; body: string | null; error?: string }

/**
 * 观测一次真实请求（不修改、不重放）。必须在触发动作**之前**调用，动作后再 await。
 * 观测失败只记录到返回值里（便于证据），调用方仍按 status 断言。
 */
export function observeResponse(page: Page, method: string, pathname: string, timeoutMs = 60_000): Promise<ObservedResponse> {
  return page
    .waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === pathname, { timeout: timeoutMs })
    .then(async (response) => ({ status: response.status(), body: (await response.text()).slice(0, 2_000) }))
    .catch((error) => ({ status: null, body: null, error: String(error).slice(0, 200) }));
}

/* ------------------------------------------------------------------ 只读几何 / 状态 */

export async function readBacking(page: Page, frame: Frame): Promise<CaptureWindow['backing']> {
  const preview = await frame.evaluate(() => {
    const canvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement | null;
    return { width: canvas?.width ?? -1, dpr: window.devicePixelRatio };
  });
  const studio = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="scene-canvas"]') as HTMLCanvasElement | null;
    return { width: canvas?.width ?? -1, dpr: window.devicePixelRatio };
  });
  return { preview: preview.width, studio: studio.width, dpr: Math.max(preview.dpr, studio.dpr) };
}

/** 只读几何：不重置滚动、不截图；按当前布局算出"如果现在截图会用的窗口"，并带 backing 与行区间。 */
export async function readCaptureWindow(page: Page, frame: Frame): Promise<CaptureWindow> {
  const previewRect = await canvasRect(frame.locator('[data-testid="product-scene"] canvas'));
  const studioRect = await canvasRect(page.locator('[data-testid="scene-canvas"]'));
  const frameRect = await canvasRect(page.locator('[data-testid="preview-frame"]'));
  const size = Math.floor(Math.min(previewRect.width, studioRect.width));
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const visibleRows = (rect: { x: number; y: number; width: number; height: number }, clipTop: number, clipBottom: number) => ({
    start: Math.max(0, Math.ceil(clipTop - rect.y)),
    end: Math.min(Math.floor(rect.height), Math.floor(clipBottom - rect.y)),
  });
  const previewRows = visibleRows(previewRect, Math.max(0, frameRect.y), Math.min(viewport.height, frameRect.y + frameRect.height));
  const studioRows = visibleRows(studioRect, 0, viewport.height);
  const start = Math.max(previewRows.start, studioRows.start);
  const end = Math.min(previewRows.end, studioRows.end, start + size);
  const backing = await readBacking(page, frame);
  return { size, start, end, visibleHeight: end - start, previewRect, studioRect, frameRect, viewport, previewRows, studioRows, backing };
}

/** 几何 + backing 是否与基线一致（位置/尺寸容差 1px；backing 必须完全相等）。 */
export function sameWindow(a: CaptureWindow, b: CaptureWindow): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1;
  const rectEqual = (p: { x: number; y: number; width: number; height: number }, q: typeof p) =>
    near(p.x, q.x) && near(p.y, q.y) && near(p.width, q.width) && near(p.height, q.height);
  return a.size === b.size && a.start === b.start && a.end === b.end && a.visibleHeight === b.visibleHeight
    && rectEqual(a.previewRect, b.previewRect) && rectEqual(a.studioRect, b.studioRect) && rectEqual(a.frameRect, b.frameRect)
    && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height
    && a.backing.preview === b.backing.preview && a.backing.studio === b.backing.studio && a.backing.dpr === b.backing.dpr;
}

/** 两次窗口不同的具体原因（写进失败信息，不用"看起来不一样"糊过去）。 */
export function windowDiff(a: CaptureWindow, b: CaptureWindow): string[] {
  const diff: string[] = [];
  const push = (label: string, x: number, y: number, tol: number) => { if (Math.abs(x - y) > tol) diff.push(`${label}: ${x} vs ${y}`); };
  push('size', a.size, b.size, 0);
  push('start', a.start, b.start, 0);
  push('end', a.end, b.end, 0);
  push('visibleHeight', a.visibleHeight, b.visibleHeight, 0);
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    push(`previewRect.${key}`, a.previewRect[key], b.previewRect[key], 1);
    push(`studioRect.${key}`, a.studioRect[key], b.studioRect[key], 1);
    push(`frameRect.${key}`, a.frameRect[key], b.frameRect[key], 1);
  }
  push('viewport.width', a.viewport.width, b.viewport.width, 0);
  push('viewport.height', a.viewport.height, b.viewport.height, 0);
  push('backing.preview', a.backing.preview, b.backing.preview, 0);
  push('backing.studio', a.backing.studio, b.backing.studio, 0);
  push('backing.dpr', a.backing.dpr, b.backing.dpr, 0);
  return diff;
}

export interface GateState { undoEnabled: boolean; saveEnabled: boolean; sceneLoaded: string | null; hints: string[] }

/**
 * 真实 UI 状态：`scene-undo`/`scene-save-hero` 是否可用（不在 busy / 未持作品锁 / 已同步）、
 * 场景是否 `data-loaded`、页面是否还显示"状态待同步"。
 * **不吞异常**：DOM 读取/定位失败会抛出（那属于真实失败，不能当作"暂时不可用"继续等）。
 */
export async function readGate(page: Page): Promise<GateState> {
  const undoEnabled = await page.getByTestId('scene-undo').isEnabled();
  const saveEnabled = await page.getByTestId('scene-save-hero').isEnabled();
  const sceneLoaded = await page.locator('[data-testid="scene-viewport"]').getAttribute('data-loaded');
  const hints = (await page.locator('[role="status"]').allInnerTexts())
    .map((text) => text.trim())
    .filter((text) => text.includes('状态待同步'));
  return { undoEnabled, saveEnabled, sceneLoaded, hints };
}

/** 基线必须真的就绪：场景已加载 + 写回控件可用 + 无提示。 */
export async function assertBaselineReady(page: Page, frame: Frame): Promise<{ gate: GateState; window: CaptureWindow }> {
  const gate = await readGate(page);
  if (gate.sceneLoaded !== 'true') throw new Error(`基线场景未加载：data-loaded=${gate.sceneLoaded}`);
  if (!gate.undoEnabled || !gate.saveEnabled) throw new Error(`基线写回控件不可用：${JSON.stringify(gate)}`);
  if (gate.hints.length) throw new Error(`基线仍显示状态待同步：${JSON.stringify(gate.hints)}`);
  const window = await readCaptureWindow(page, frame);
  if (window.visibleHeight < 120) throw new Error(`基线公共可见高度不足：${window.visibleHeight}`);
  return { gate, window };
}

/* ------------------------------------------------------------------ 截图 */

/** 用**指定窗口**截两边（坐标与基线完全一致）；`captureRegion` 返回 `Region`，PNG 在 `.png`。 */
export async function captureWithWindow(page: Page, frame: Frame, captureWindow: CaptureWindow): Promise<CanvasPair> {
  const size = captureWindow.size;
  const visibleHeight = captureWindow.visibleHeight;
  const preview = await captureRegion(page, {
    x: Math.round(captureWindow.previewRect.x), y: Math.round(captureWindow.previewRect.y) + captureWindow.start, width: size, height: visibleHeight,
  });
  const studio = await captureRegion(page, {
    x: Math.round(captureWindow.studioRect.x), y: Math.round(captureWindow.studioRect.y) + captureWindow.start, width: size, height: visibleHeight,
  });
  const backing = await readBacking(page, frame);
  return {
    window: captureWindow,
    size,
    preview: { rect: captureWindow.previewRect, png: preview.png, offsetY: preview.offset.y, visibleHeight },
    studio: { rect: captureWindow.studioRect, png: studio.png },
    backing,
  };
}

export interface CaptureAttempt {
  at: number;
  ok: boolean;
  reason?: string;
  changedRatio?: number;
  window?: CaptureWindow;
  gate?: GateState;
}

/**
 * 取"同一窗口"的当前画面：先做与基线相同的滚动归零，再要求
 * (a) 写回控件可用、(b) 无"状态待同步"、(c) 场景 data-loaded、(d) 几何+backing 与基线一致；
 * 任一不满足返回 ok=false + 原因（调用方在预算内继续观察，不静默对齐）。
 */
export async function captureWhenStable(page: Page, frame: Frame, baseline: CanvasPair): Promise<{ attempt: CaptureAttempt; pair?: CanvasPair }> {
  await resetEditorScroll(page);
  const gate = await readGate(page);
  const window = await readCaptureWindow(page, frame);
  const at = Date.now();
  if (!gate.undoEnabled || !gate.saveEnabled) return { attempt: { ok: false, at, reason: '写回控件仍不可用（busy/作品锁/未同步）', window, gate } };
  if (gate.hints.length) return { attempt: { ok: false, at, reason: '仍显示状态待同步提示', window, gate } };
  if (gate.sceneLoaded !== 'true') return { attempt: { ok: false, at, reason: `场景未加载：data-loaded=${gate.sceneLoaded}`, window, gate } };
  if (window.visibleHeight < 120) return { attempt: { ok: false, at, reason: `公共可见高度不足：${window.visibleHeight}`, window, gate } };
  const diff = windowDiff(window, baseline.window);
  if (diff.length) return { attempt: { ok: false, at, reason: `几何/backing 与基线不同：${diff.join('; ')}`, window, gate } };
  const pair = await captureWithWindow(page, frame, baseline.window);
  return { attempt: { ok: true, at, window, gate }, pair };
}

/* ------------------------------------------------------------------ 等待变化 */

export interface PairChangeResult {
  /** 从 startedAt（动作前）到满足条件的实际耗时。 */
  elapsedMs: number;
  changedRatio: number;
  attempts: CaptureAttempt[];
}

/** 同一窗口下等待画面变化；预算从 startedAt 算，绝不超过总预算。 */
export async function waitForPairChange(
  page: Page, frame: Frame, baseline: CanvasPair,
  options: { startedAt: number; threshold: number; timeoutMs: number; intervalMs: number; mode?: 'increase' | 'decrease' },
): Promise<PairChangeResult> {
  const deadline = options.startedAt + options.timeoutMs;
  const attempts: CaptureAttempt[] = [];
  const record = (attempt: CaptureAttempt) => attempts.push({ ...attempt, at: attempt.at - options.startedAt });
  while (Date.now() <= deadline) {
    const { attempt, pair } = await captureWhenStable(page, frame, baseline);
    if (attempt.ok && pair) {
      const aligned = await compareAligned(baseline.preview.png, pair.preview.png, 3);
      const satisfied = options.mode === 'decrease' ? aligned.changedRatio < options.threshold : aligned.changedRatio > options.threshold;
      record({ ...attempt, changedRatio: aligned.changedRatio, ok: satisfied, reason: satisfied ? undefined : `画面差异未满足 ${options.mode === 'decrease' ? '<' : '>'} ${options.threshold}：${aligned.changedRatio}` });
      if (satisfied) return { elapsedMs: Date.now() - options.startedAt, changedRatio: aligned.changedRatio, attempts };
    } else {
      record(attempt);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(options.intervalMs, remaining));
  }
  const tail = attempts.slice(-4).map((item) => ({
    at: item.at, ok: item.ok, reason: item.reason, changedRatio: item.changedRatio,
    window: item.window ? {
      size: item.window.size, start: item.window.start, end: item.window.end, visibleHeight: item.window.visibleHeight,
      previewRect: item.window.previewRect, studioRect: item.window.studioRect, frameRect: item.window.frameRect,
      previewRows: item.window.previewRows, studioRows: item.window.studioRows, backing: item.window.backing,
    } : null,
    gate: item.gate,
  }));
  throw new Error(`等待画面变化超时（预算 ${options.timeoutMs}ms，阈值 ${options.threshold}）：${JSON.stringify(tail)}`);
}

/** 把尝试记录裁剪成可写入证据的形状（含几何/backing/UI 状态，不写 Buffer）。 */
export function summarizeAttempts(attempts: CaptureAttempt[], limit = 12) {
  return attempts.slice(-limit).map((item) => ({
    at: item.at, ok: item.ok, reason: item.reason, changedRatio: item.changedRatio,
    window: item.window ? {
      size: item.window.size, start: item.window.start, end: item.window.end, visibleHeight: item.window.visibleHeight,
      previewRect: item.window.previewRect, studioRect: item.window.studioRect, frameRect: item.window.frameRect,
      previewRows: item.window.previewRows, studioRows: item.window.studioRows, backing: item.window.backing,
    } : null,
    gate: item.gate,
  }));
}
