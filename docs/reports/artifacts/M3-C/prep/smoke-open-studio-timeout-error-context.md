# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-approval.spec.ts >> 影响模式：共享 Button 三处青色高亮，点击页面不改写高亮，退出后清理且不替换 Selection
- Location: tests\e2e\m3c\01-approval.spec.ts:60:1

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  getByTestId('events-status')
Expected: "connected"
Received: "connecting"
Timeout:  90000ms

Call log:
  - Expect "toHaveAttribute" getByTestId('events-status') with timeout 90000ms
  - waiting for getByTestId('events-status')
    180 × locator resolved to <span class="connection" data-status="connecting" data-testid="events-status">…</span>
        - unexpected value "connecting"

```

```yaml
- text: 事件连接中 ·
- status: "0"
```

# Test source

```ts
  1   | import { expect, type Frame, type Locator, type Page } from '@playwright/test';
  2   | import * as api from '../m2a/api';
  3   | import { BACKEND_BASE } from './env';
  4   | import {
  5   |   REQUIRED_ARTIFACTS, getCheckRun, readArtifact, startChecks, waitCheckRun,
  6   | } from '../m3b/checks';
  7   | 
  8   | /**
  9   |  * M3-C real UI 用例的公共动作。
  10  |  *
  11  |  * 只走真实产品面：Studio 页面、真实 REST、真实 WS、真实检查运行器。
  12  |  * 没有测试后门，不注入 executor，不伪造 passed，也不替产品决定门禁。
  13  |  */
  14  | 
  15  | /* --------------------------------------------------------------- mock Agent 剧本 */
  16  | 
  17  | /** 修改共享 Button.tsx → 触发 shared_component 请示（3 处实例）。 */
  18  | export const SHARED_BUTTON = [
  19  |   [{ name: 'replace_in_file', args: { path: 'src/components/Button.tsx', old: '<button type="button"', new: '<button type="button" style={{ borderRadius: 12 }}' } }],
  20  |   [{ name: 'finish', args: { summary: '共享按钮圆角已修改' } }],
  21  | ];
  22  | 
  23  | /** 只改首屏文案 → 局部改动，不请示。 */
  24  | export const LOCAL_COPY = [
  25  |   [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '一份给自己，也给生活的温柔礼物。', new: '给自己一份安静的礼物。' } }],
  26  |   [{ name: 'finish', args: { summary: '局部文案已修改' } }],
  27  | ];
  28  | 
  29  | /** 让候选构建失败（真正的语法错误）。 */
  30  | export const BUILD_FAULT = [
  31  |   [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: 'export default function App() {', new: 'export default function App() {{' } }],
  32  |   [{ name: 'finish', args: { summary: '制造语法错误' } }],
  33  | ];
  34  | 
  35  | /** 让候选页面在启动后抛未捕获异常（冒烟检查失败）。 */
  36  | export const RUNTIME_FAULT = [
  37  |   [{
  38  |     name: 'replace_in_file',
  39  |     args: {
  40  |       path: 'src/App.tsx',
  41  |       old: "const [action, setAction] = useState('');",
  42  |       new: "const [action, setAction] = useState('');\n  if (typeof window !== 'undefined' && !(window as any).__probeScheduled) {\n    (window as any).__probeScheduled = true;\n    setTimeout(() => { throw new Error('probe-runtime'); }, 0);\n  }",
  43  |     },
  44  |   }],
  45  |   [{ name: 'finish', args: { summary: '页面启动后抛未捕获异常' } }],
  46  | ];
  47  | 
  48  | /** 用一个覆盖层挡住顶部交互入口（遮挡检查失败，冒烟仍通过）。 */
  49  | export const OCCLUSION_FAULT = [
  50  |   [{
  51  |     name: 'replace_in_file',
  52  |     args: {
  53  |       path: 'src/App.tsx',
  54  |       old: '    <main>\n      <header className="navigation">',
  55  |       new: '    <main>\n      <div data-testid="probe-overlay" style={{ position: \'fixed\', left: 0, top: 0, right: 0, height: 120, zIndex: 9999, background: \'rgba(0,0,0,0.01)\' }} />\n      <header className="navigation">',
  56  |     },
  57  |   }],
  58  |   [{ name: 'finish', args: { summary: '用一个覆盖层挡住顶部导航' } }],
  59  | ];
  60  | 
  61  | /* --------------------------------------------------------------- 打开与选取 */
  62  | 
  63  | /** 打开 Studio 并等到：作品预览已连接、事件已连接、状态同步完成（不再显示“状态待同步”）。 */
  64  | export async function openStudio(page: Page, options: { instrumentSockets?: boolean } = {}): Promise<void> {
  65  |   if (options.instrumentSockets) await instrumentSockets(page);
  66  |   await page.goto('/');
  67  |   await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 90_000 });
> 68  |   await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 90_000 });
      |                                                   ^ Error: expect(locator).toHaveAttribute(expected) failed
  69  |   await expect(page.getByText('状态待同步', { exact: true })).toHaveCount(0, { timeout: 90_000 });
  70  | }
  71  | 
  72  | /** 让页面在启动时登记自己的 WebSocket 实例（用于“真实断线 → 重连补拉”）。必须在 goto 之前调用。 */
  73  | export async function instrumentSockets(page: Page): Promise<void> {
  74  |   await page.addInitScript(() => {
  75  |     const Native = window.WebSocket;
  76  |     const list: unknown[] = [];
  77  |     (window as unknown as { __sockets: unknown[] }).__sockets = list;
  78  |     // eslint-disable-next-line @typescript-eslint/no-explicit-any
  79  |     (window as any).WebSocket = class extends Native {
  80  |       constructor(...args: ConstructorParameters<typeof Native>) { super(...args); list.push(this); }
  81  |     };
  82  |   });
  83  | }
  84  | 
  85  | /** 真实断线：关掉页面里的全部 WebSocket（服务端仍在跑）。 */
  86  | export async function dropSockets(page: Page): Promise<void> {
  87  |   await page.evaluate(() => { for (const socket of ((window as unknown as { __sockets?: WebSocket[] }).__sockets ?? [])) socket.close(); });
  88  | }
  89  | 
  90  | export async function mainFrame(page: Page): Promise<Frame> {
  91  |   return api.previewFrameSafe(page);
  92  | }
  93  | 
  94  | /** 真实点选首屏“立即购买”按钮（Button.tsx 的共享实例之一），拿到真实 Selection。 */
  95  | export async function pickSharedButton(page: Page): Promise<api.SelectionLike> {
  96  |   await page.getByTestId('pick-toggle').click();
  97  |   const frame = await mainFrame(page);
  98  |   const target = frame.locator('[data-testid="buy-button"]').first();
  99  |   await target.scrollIntoViewIfNeeded();
  100 |   const box = await target.boundingBox();
  101 |   if (!box) throw new Error('找不到 buy-button');
  102 |   await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  103 |   const panel = page.locator('[data-testid="selection-json"]');
  104 |   await panel.waitFor({ state: 'visible', timeout: 30_000 });
  105 |   const selection = JSON.parse(await panel.innerText()) as api.SelectionLike;
  106 |   await page.getByTestId('pick-toggle').click();
  107 |   return selection;
  108 | }
  109 | 
  110 | export async function selectionText(page: Page): Promise<string> {
  111 |   const panel = page.locator('[data-testid="selection-json"]');
  112 |   return (await panel.count()) ? panel.innerText() : '';
  113 | }
  114 | 
  115 | /** 填指令并 Ctrl+Enter 提交；返回本次真实创建的 task.id（只认这一个 POST 的响应）。 */
  116 | export async function submitInstruction(page: Page, instruction: string): Promise<string> {
  117 |   const [response] = await Promise.all([
  118 |     page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/tasks', { timeout: 30_000 }),
  119 |     (async () => {
  120 |       await page.getByTestId('instruction-input').fill(instruction);
  121 |       await page.getByTestId('instruction-input').press('Control+Enter');
  122 |     })(),
  123 |   ]);
  124 |   expect(response.status(), await response.text().catch(() => '')).toBe(202);
  125 |   return (await response.json() as { id: string }).id;
  126 | }
  127 | 
  128 | /* --------------------------------------------------------------- 请示卡 */
  129 | 
  130 | export function cardByTask(page: Page, taskId: string): Locator {
  131 |   return page.locator(`[data-testid="approval-card"][data-task-id="${taskId}"]`);
  132 | }
  133 | 
  134 | export async function waitCard(page: Page, taskId: string, status = 'pending'): Promise<Locator> {
  135 |   const card = cardByTask(page, taskId);
  136 |   await expect(card, `没有等到任务 ${taskId} 的请示卡`).toHaveCount(1, { timeout: 90_000 });
  137 |   await expect(card).toHaveAttribute('data-status', status, { timeout: 90_000 });
  138 |   return card;
  139 | }
  140 | 
  141 | /** 建一张真实的待处理请示卡（共享组件改动 → 请示）。 */
  142 | export async function createAwaitingCard(page: Page, options: { script?: unknown[][]; instruction?: string } = {}) {
  143 |   await api.resetMock();
  144 |   await api.setScript((options.script ?? SHARED_BUTTON) as never);
  145 |   const selection = await pickSharedButton(page);
  146 |   const taskId = await submitInstruction(page, options.instruction ?? '把共享按钮圆角改大');
  147 |   const card = await waitCard(page, taskId);
  148 |   return { taskId, card, selection };
  149 | }
  150 | 
  151 | /** 真实批准/拒绝（返回本次请求的响应体，便于核对 `{approval,task}`）。 */
  152 | export async function decide(card: Locator, kind: 'approve' | 'reject'): Promise<{ status: number; body: any; text: string }> {
  153 |   const responsePromise = card.page().waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname.startsWith('/approvals/'));
  154 |   await card.getByTestId(kind === 'approve' ? 'approval-approve' : 'approval-reject').click();
  155 |   const response = await responsePromise;
  156 |   return { status: response.status(), body: await response.json().catch(() => null), text: await response.text().catch(() => '') };
  157 | }
  158 | 
  159 | /* --------------------------------------------------------------- 影响模式 / overlay */
  160 | 
  161 | /**
  162 |  * 统计「卡片 src 的青色框」数量。
  163 |  * 影响模式下 bridge 仍处于 picking，指针悬停会多画一个橙色 hover 框（同一个 src），
  164 |  * 所以按 `data-highlight-src` + 边框颜色双重过滤，避免把 hover 框算进三处高亮。
  165 |  */
  166 | export async function cyanBoxes(frame: Frame, src: string): Promise<number> {
  167 |   return frame.locator(`[data-highlight-src="${src}"]`).evaluateAll((nodes) => nodes
  168 |     .filter((node) => getComputedStyle(node).borderTopColor.replace(/\s+/g, '') === 'rgb(34,211,238)').length);
```