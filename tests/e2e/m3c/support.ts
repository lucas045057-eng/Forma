import { expect, type Frame, type Locator, type Page } from '@playwright/test';
import * as api from '../m2a/api';
import { BACKEND_BASE } from './env';
import {
  REQUIRED_ARTIFACTS, getCheckRun, readArtifact, startChecks, waitCheckRun,
} from '../m3b/checks';

/**
 * M3-C real UI 用例的公共动作。
 *
 * 只走真实产品面：Studio 页面、真实 REST、真实 WS、真实检查运行器。
 * 没有测试后门，不注入 executor，不伪造 passed，也不替产品决定门禁。
 */

/* --------------------------------------------------------------- mock Agent 剧本 */

/** 修改共享 Button.tsx → 触发 shared_component 请示（3 处实例）。 */
export const SHARED_BUTTON = [
  [{ name: 'replace_in_file', args: { path: 'src/components/Button.tsx', old: '<button type="button"', new: '<button type="button" style={{ borderRadius: 12 }}' } }],
  [{ name: 'finish', args: { summary: '共享按钮圆角已修改' } }],
];

/** 只改首屏文案 → 局部改动，不请示。 */
export const LOCAL_COPY = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '一份给自己，也给生活的温柔礼物。', new: '给自己一份安静的礼物。' } }],
  [{ name: 'finish', args: { summary: '局部文案已修改' } }],
];

/** 让候选构建失败（真正的语法错误）。 */
export const BUILD_FAULT = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: 'export default function App() {', new: 'export default function App() {{' } }],
  [{ name: 'finish', args: { summary: '制造语法错误' } }],
];

/** 让候选页面在启动后抛未捕获异常（冒烟检查失败）。 */
export const RUNTIME_FAULT = [
  [{
    name: 'replace_in_file',
    args: {
      path: 'src/App.tsx',
      old: "const [action, setAction] = useState('');",
      new: "const [action, setAction] = useState('');\n  if (typeof window !== 'undefined' && !(window as any).__probeScheduled) {\n    (window as any).__probeScheduled = true;\n    setTimeout(() => { throw new Error('probe-runtime'); }, 0);\n  }",
    },
  }],
  [{ name: 'finish', args: { summary: '页面启动后抛未捕获异常' } }],
];

/** 用一个覆盖层挡住顶部交互入口（遮挡检查失败，冒烟仍通过）。 */
export const OCCLUSION_FAULT = [
  [{
    name: 'replace_in_file',
    args: {
      path: 'src/App.tsx',
      old: '    <main>\n      <header className="navigation">',
      new: '    <main>\n      <div data-testid="probe-overlay" style={{ position: \'fixed\', left: 0, top: 0, right: 0, height: 120, zIndex: 9999, background: \'rgba(0,0,0,0.01)\' }} />\n      <header className="navigation">',
    },
  }],
  [{ name: 'finish', args: { summary: '用一个覆盖层挡住顶部导航' } }],
];

/* --------------------------------------------------------------- 打开与选取 */

/** 打开 Studio 并等到：作品预览已连接、事件已连接、状态同步完成（不再显示“状态待同步”）。 */
export async function openStudio(page: Page, options: { instrumentSockets?: boolean } = {}): Promise<void> {
  if (options.instrumentSockets) await instrumentSockets(page);
  await page.goto('/');
  await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 90_000 });
  await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 90_000 });
  await expect(page.getByText('状态待同步', { exact: true })).toHaveCount(0, { timeout: 90_000 });
}

/** 让页面在启动时登记自己的 WebSocket 实例（用于“真实断线 → 重连补拉”）。必须在 goto 之前调用。 */
export async function instrumentSockets(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const list: unknown[] = [];
    (window as unknown as { __sockets: unknown[] }).__sockets = list;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof Native>) { super(...args); list.push(this); }
    };
  });
}

/** 真实断线：关掉页面里的全部 WebSocket（服务端仍在跑）。 */
export async function dropSockets(page: Page): Promise<void> {
  await page.evaluate(() => { for (const socket of ((window as unknown as { __sockets?: WebSocket[] }).__sockets ?? [])) socket.close(); });
}

export async function mainFrame(page: Page): Promise<Frame> {
  return api.previewFrameSafe(page);
}

/** 真实点选首屏“立即购买”按钮（Button.tsx 的共享实例之一），拿到真实 Selection。 */
export async function pickSharedButton(page: Page): Promise<api.SelectionLike> {
  await page.getByTestId('pick-toggle').click();
  const frame = await mainFrame(page);
  const target = frame.locator('[data-testid="buy-button"]').first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('找不到 buy-button');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const panel = page.locator('[data-testid="selection-json"]');
  await panel.waitFor({ state: 'visible', timeout: 30_000 });
  const selection = JSON.parse(await panel.innerText()) as api.SelectionLike;
  await page.getByTestId('pick-toggle').click();
  return selection;
}

export async function selectionText(page: Page): Promise<string> {
  const panel = page.locator('[data-testid="selection-json"]');
  return (await panel.count()) ? panel.innerText() : '';
}

/** 填指令并 Ctrl+Enter 提交；返回本次真实创建的 task.id（只认这一个 POST 的响应）。 */
export async function submitInstruction(page: Page, instruction: string): Promise<string> {
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/tasks', { timeout: 30_000 }),
    (async () => {
      await page.getByTestId('instruction-input').fill(instruction);
      await page.getByTestId('instruction-input').press('Control+Enter');
    })(),
  ]);
  expect(response.status(), await response.text().catch(() => '')).toBe(202);
  return (await response.json() as { id: string }).id;
}

/* --------------------------------------------------------------- 请示卡 */

export function cardByTask(page: Page, taskId: string): Locator {
  return page.locator(`[data-testid="approval-card"][data-task-id="${taskId}"]`);
}

export async function waitCard(page: Page, taskId: string, status = 'pending'): Promise<Locator> {
  const card = cardByTask(page, taskId);
  await expect(card, `没有等到任务 ${taskId} 的请示卡`).toHaveCount(1, { timeout: 90_000 });
  await expect(card).toHaveAttribute('data-status', status, { timeout: 90_000 });
  return card;
}

/** 建一张真实的待处理请示卡（共享组件改动 → 请示）。 */
export async function createAwaitingCard(page: Page, options: { script?: unknown[][]; instruction?: string } = {}) {
  await api.resetMock();
  await api.setScript((options.script ?? SHARED_BUTTON) as never);
  const selection = await pickSharedButton(page);
  const taskId = await submitInstruction(page, options.instruction ?? '把共享按钮圆角改大');
  const card = await waitCard(page, taskId);
  return { taskId, card, selection };
}

/** 真实批准/拒绝（返回本次请求的响应体，便于核对 `{approval,task}`）。 */
export async function decide(card: Locator, kind: 'approve' | 'reject'): Promise<{ status: number; body: any; text: string }> {
  const responsePromise = card.page().waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname.startsWith('/approvals/'));
  await card.getByTestId(kind === 'approve' ? 'approval-approve' : 'approval-reject').click();
  const response = await responsePromise;
  return { status: response.status(), body: await response.json().catch(() => null), text: await response.text().catch(() => '') };
}

/* --------------------------------------------------------------- 影响模式 / overlay */

/**
 * 统计「卡片 src 的青色框」数量。
 * 影响模式下 bridge 仍处于 picking，指针悬停会多画一个橙色 hover 框（同一个 src），
 * 所以按 `data-highlight-src` + 边框颜色双重过滤，避免把 hover 框算进三处高亮。
 */
export async function cyanBoxes(frame: Frame, src: string): Promise<number> {
  return frame.locator(`[data-highlight-src="${src}"]`).evaluateAll((nodes) => nodes
    .filter((node) => getComputedStyle(node).borderTopColor.replace(/\s+/g, '') === 'rgb(34,211,238)').length);
}

export async function overlayTotal(frame: Frame): Promise<number> {
  return frame.locator('[data-highlight-src]').count();
}

/* --------------------------------------------------------------- 候选 / 检查 */

export async function waitCandidate(page: Page): Promise<Locator> {
  await expect(page.getByTestId('candidate-select')).toBeVisible({ timeout: 120_000 });
  return page.getByTestId('candidate-select');
}

export function checkItems(page: Page): Locator {
  return page.getByTestId('check-item');
}

export async function checkStatuses(page: Page): Promise<Record<string, string>> {
  const pairs = await checkItems(page).evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-check-name'), node.getAttribute('data-status')]));
  return Object.fromEntries(pairs as [string, string][]);
}

export async function currentRunId(page: Page): Promise<string> {
  return (await page.getByTestId('check-run-status').getAttribute('data-run-id')) ?? '';
}

/** 等 UI 显示“全部检查通过”（四项真 passed + 证据就绪由调用方另断言）。 */
export async function waitChecksPassed(page: Page, timeoutMs = 300_000): Promise<void> {
  await expect(page.getByTestId('check-run-status')).toContainText('全部检查通过', { timeout: timeoutMs });
  await expect(page.getByTestId('check-run-status')).not.toHaveAttribute('data-run-id', '', { timeout: 30_000 });
}

/** 等六份必需证据在 UI 里读完并通过 MIME/字节/SHA-256 校验（采用门禁的可见前提）。 */
export async function waitEvidenceReady(page: Page, timeoutMs = 120_000): Promise<void> {
  await expect(page.getByTestId('candidate-checks').locator('[data-evidence-ready="true"]')).toHaveCount(1, { timeout: timeoutMs });
  await expect(page.getByTestId('candidate-checks')).toContainText('六份必需证据已读取并核对 hash', { timeout: timeoutMs });
}

export async function gateReason(page: Page): Promise<string> {
  return page.getByTestId('candidate-gate-reason').innerText();
}

export async function adoptDisabled(page: Page): Promise<boolean> {
  return page.getByTestId('candidate-adopt').isDisabled();
}

/* --------------------------------------------------------------- 服务端辅助 */

export const candidateOf = (taskId: string) => api.listCandidates().then((result) => result.body.find((item) => item.taskId === taskId));
export const pendingCandidates = () => api.listCandidates().then((result) => result.body.filter((item) => item.decision === 'pending'));

/** 直接走产品 HTTP 跑一次真实检查并等它进终态（mock 用例的前置：让 UI 有真实的 run/证据可读）。 */
export async function runChecksViaApi(candidateId: string) {
  const started = await startChecks(BACKEND_BASE, candidateId);
  expect(started.status, started.text.slice(0, 300)).toBe(202);
  return waitCheckRun(BACKEND_BASE, started.body.id, { timeoutMs: 300_000 });
}

/** 直接走产品 HTTP 跑一次真实检查（用于测试前置，不替代 UI 断言）。 */
export async function serverChecksPassed(candidateId: string): Promise<void> {
  const started = await startChecks(BACKEND_BASE, candidateId);
  expect(started.status, started.text.slice(0, 300)).toBe(202);
  const run = await waitCheckRun(BACKEND_BASE, started.body.id, { timeoutMs: 300_000 });
  expect(run.outcome, JSON.stringify(run.checks)).toBe('passed');
}

export async function readEvidence(runId: string, name: string) {
  return readArtifact(BACKEND_BASE, runId, name);
}

export const requiredEvidence = REQUIRED_ARTIFACTS;
export const checkRun = (id: string) => getCheckRun(BACKEND_BASE, id);

/** 统计页面发出的某个方法+路径的请求次数（用于“只发一次 POST”类断言）。 */
export function countRequests(page: Page, method: string, pathname: (path: string) => boolean): { count: () => number } {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === method && pathname(new URL(request.url()).pathname)) count += 1;
  });
  return { count: () => count };
}

/* --------------------------------------------------------------- 收尾 */

/**
 * 收尾：拒掉遗留待处理请示（释放名额）、取消未终态任务、撤回待定候选、还原作品目录。
 * 只动测试自己的数据；不删任何证据文件。
 */
export async function cleanup(): Promise<void> {
  for (const card of (await api.listApprovals()).body) {
    if (card.status === 'pending') await api.answerApproval(card.id, 1);
  }
  for (const task of (await api.listTasks()).body) {
    if (['queued', 'running', 'awaiting_approval'].includes(task.status)) await api.cancelTask(task.id);
  }
  for (const candidate of (await api.listCandidates()).body) {
    if (candidate.decision === 'pending') await api.discardCandidate(candidate.id);
  }
  api.restoreTemplate();
}
