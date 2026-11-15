import type { Frame, Page } from '@playwright/test';
import { canvasRect, resetEditorScroll, type CanvasPair, type CaptureWindow } from './editor';
import { captureRegion, compareAligned } from '../m1a/visual';

/**
 * 同窗口前后比较（M1-B 专项最小测试侧修正）。
 *
 * 背景：三条 M1-B 失败都是 `compareAligned(baseline.preview.png, current.preview.png)` 抛
 * `尺寸不一致：378x378 vs 378x341` —— 是**同一作品预览在写入前后两个时刻**的截图，
 * 而 `captureCanvases()` 每次都会按**当下**的预览 iframe 可见区重新计算坐标窗口，
 * 所以"写回过渡期里提示行出现/消失 → iframe 可见高度变化"就会让两次 PNG 尺寸不同。
 *
 * 这里只做一件事：**在调用方原有预算内**等到"本次保存真的完成 + 提示消失 + 几何窗口与基线一致"，
 * 再用**基线的坐标窗口**截图，然后调用**原来的** `compareAligned`（阈值、算法都不变）。
 *
 * 明确不做：不缩小 baseline、不改尺寸/不 resize、不延长预算、不主动刷新页面、不伪造状态、
 * 不吞 compareAligned/DOM 异常；瞬态尺寸变化只作为证据记录并继续观察。
 */

/** 只读几何：不重置滚动、不截图；仅按当前布局算出"如果现在截图会用的窗口"。 */
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
  return { size, start, end, visibleHeight: end - start, previewRect, studioRect, frameRect, viewport };
}

/** 几何是否与基线一致（容许 1px 抖动）。 */
export function sameWindow(a: CaptureWindow, b: CaptureWindow): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= 1;
  return a.size === b.size && a.start === b.start && a.end === b.end
    && near(a.previewRect.x, b.previewRect.x) && near(a.previewRect.y, b.previewRect.y)
    && near(a.studioRect.x, b.studioRect.x) && near(a.studioRect.y, b.studioRect.y)
    && near(a.frameRect.y, b.frameRect.y) && near(a.frameRect.height, b.frameRect.height);
}

/** 真实 UI 状态：`scene-undo` 可用（= 不在 busy / 未持作品锁 / syncReady 且已连接）+ 是否还显示"状态待同步"。 */
export async function readGate(page: Page): Promise<{ undoEnabled: boolean; hints: string[] }> {
  const undoEnabled = await page.getByTestId('scene-undo').isEnabled().catch(() => false);
  const hints = (await page.locator('[role="status"]').allInnerTexts().catch(() => []))
    .map((text) => text.trim())
    .filter((text) => text.includes('状态待同步'));
  return { undoEnabled, hints };
}

/** 用**指定窗口**截两边（坐标与基线完全一致）；不做任何尺寸调整。 */
export async function captureWithWindow(page: Page, frame: Frame, captureWindow: CaptureWindow): Promise<CanvasPair> {
  const size = captureWindow.size;
  const visibleHeight = captureWindow.visibleHeight;
  const preview = await captureRegion(page, {
    x: Math.round(captureWindow.previewRect.x), y: Math.round(captureWindow.previewRect.y) + captureWindow.start, width: size, height: visibleHeight,
  });
  const studio = await captureRegion(page, {
    x: Math.round(captureWindow.studioRect.x), y: Math.round(captureWindow.studioRect.y) + captureWindow.start, width: size, height: visibleHeight,
  });
  const backing = await frame.evaluate(() => {
    const previewCanvas = document.querySelector('[data-testid="product-scene"] canvas') as HTMLCanvasElement | null;
    return { preview: previewCanvas?.width ?? -1, dpr: window.devicePixelRatio };
  });
  const studioBacking = await page.evaluate(() => {
    const studioCanvas = document.querySelector('[data-testid="scene-canvas"]') as HTMLCanvasElement;
    return { studio: studioCanvas.width, dpr: window.devicePixelRatio };
  });
  return {
    window: captureWindow, size,
    preview: { rect: captureWindow.previewRect, png: preview, offsetY: captureWindow.start, visibleHeight },
    studio: { rect: captureWindow.studioRect, png: studio },
    backing: { preview: backing.preview, studio: studioBacking.studio, dpr: backing.dpr },
  };
}

export interface CaptureAttempt {
  ok: boolean;
  at: number;
  reason?: string;
  window?: CaptureWindow;
  gate?: { undoEnabled: boolean; hints: string[] };
  changedRatio?: number;
}

/**
 * 取"同一窗口"的当前画面：先做与基线相同的滚动归零，再要求
 * (a) 写回控件已可用、(b) 页面不再显示"状态待同步"、(c) 几何窗口与基线一致，三者同时成立才截图；
 * 任一不满足返回 ok=false + 具体原因（调用方在预算内继续观察，不静默对齐）。
 */
export async function captureWhenStable(page: Page, frame: Frame, baseline: CanvasPair): Promise<{ attempt: CaptureAttempt; pair?: CanvasPair }> {
  await resetEditorScroll(page);
  const captureWindow = await readCaptureWindow(page, frame);
  const gate = await readGate(page);
  const at = Date.now();
  if (!gate.undoEnabled) return { attempt: { ok: false, at, reason: '写回控件仍不可用（busy/作品锁/未同步）', window: captureWindow, gate } };
  if (gate.hints.length) return { attempt: { ok: false, at, reason: '仍显示状态待同步提示', window: captureWindow, gate } };
  if (captureWindow.visibleHeight < 120) return { attempt: { ok: false, at, reason: `公共可见高度不足：${captureWindow.visibleHeight}`, window: captureWindow, gate } };
  if (!sameWindow(captureWindow, baseline.window)) {
    return {
      attempt: {
        ok: false, at, window: captureWindow, gate,
        reason: `几何窗口与基线不同：now ${captureWindow.size}x${captureWindow.visibleHeight} start=${captureWindow.start} vs baseline ${baseline.window.size}x${baseline.window.visibleHeight} start=${baseline.window.start}`,
      },
    };
  }
  const pair = await captureWithWindow(page, frame, baseline.window);
  return { attempt: { ok: true, at, window: captureWindow, gate }, pair };
}

export interface PairChangeResult { elapsedMs: number; changedRatio: number; attempts: CaptureAttempt[] }

/**
 * 在**调用方给定的预算**内等待"同一窗口下的画面确实变化"。
 * - 预算、阈值、轮询间隔都由调用方传入；内部不额外 sleep、不放宽阈值、不重试掩盖失败；
 * - "还没稳定 / 画面变化不足"视为继续观察；`compareAligned` 的真实异常（含尺寸不一致）**原样抛出**；
 * - 超时抛错时附带最近几次几何/UI 诊断，避免空白或 pending 式的失败。
 */
export async function waitForPairChange(
  page: Page, frame: Frame, baseline: CanvasPair,
  options: { threshold: number; timeoutMs: number; intervalMs: number; mode?: 'increase' | 'decrease' },
): Promise<PairChangeResult> {
  const started = Date.now();
  const attempts: CaptureAttempt[] = [];
  while (Date.now() - started <= options.timeoutMs) {
    const { attempt, pair } = await captureWhenStable(page, frame, baseline);
    if (attempt.ok && pair) {
      const aligned = await compareAligned(baseline.preview.png, pair.preview.png, 3);
      const satisfied = options.mode === 'decrease' ? aligned.changedRatio < options.threshold : aligned.changedRatio > options.threshold;
      if (satisfied) {
        attempts.push({ ...attempt, changedRatio: aligned.changedRatio });
        return { elapsedMs: Date.now() - started, changedRatio: aligned.changedRatio, attempts };
      }
      attempts.push({ ...attempt, ok: false, reason: `画面差异未满足 ${options.mode === 'decrease' ? '<' : '>'} ${options.threshold}：${aligned.changedRatio}`, changedRatio: aligned.changedRatio });
    } else {
      attempts.push(attempt);
    }
    await page.waitForTimeout(options.intervalMs);
  }
  const tail = attempts.slice(-4).map((item) => ({
    at: item.at - started, ok: item.ok, reason: item.reason,
    size: item.window?.size, visibleHeight: item.window?.visibleHeight, start: item.window?.start,
    undoEnabled: item.gate?.undoEnabled, hints: item.gate?.hints,
  }));
  throw new Error(`等待画面变化超时（${options.timeoutMs}ms，阈值 ${options.threshold}）：${JSON.stringify(tail)}`);
}
