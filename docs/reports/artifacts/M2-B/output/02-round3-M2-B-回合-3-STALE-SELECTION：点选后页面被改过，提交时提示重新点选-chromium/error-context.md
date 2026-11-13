# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-round3.spec.ts >> M2-B 回合 3 >> STALE_SELECTION：点选后页面被改过，提交时提示重新点选
- Location: tests\e2e\m2b\02-round3.spec.ts:89:3

# Error details

```
Error: 页面变化后没有任何提示

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  13  |   [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  14  |   [{ name: 'finish', args: { summary: 'ok' } }],
  15  | ];
  16  | 
  17  | async function openStudio(page: import('@playwright/test').Page): Promise<import('@playwright/test').Frame> {
  18  |   await page.goto('/');
  19  |   await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  20  |   const handle = await page.locator('[data-testid="preview-frame"]').elementHandle();
  21  |   const frame = await handle?.contentFrame();
  22  |   if (!frame) throw new Error('没有取到预览 iframe');
  23  |   return frame;
  24  | }
  25  | 
  26  | async function pick(page: import('@playwright/test').Page, frame: import('@playwright/test').Frame, testId: string): Promise<void> {
  27  |   await page.getByTestId('pick-toggle').click();
  28  |   const target = frame.locator(`[data-testid="${testId}"]`).first();
  29  |   await target.scrollIntoViewIfNeeded();
  30  |   const box = await target.boundingBox();
  31  |   if (!box) throw new Error(`找不到元素 ${testId}`);
  32  |   await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  33  |   await page.locator('[data-testid="selection-json"]').waitFor({ state: 'visible', timeout: 30_000 });
  34  |   await page.getByTestId('pick-toggle').click();
  35  | }
  36  | 
  37  | test.describe('M2-B 回合 3', () => {
  38  |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  39  |   test.afterAll(() => {
  40  |     for (const task of []) void task;
  41  |     const restored = restoreTemplate();
  42  |     expect(restored.clean, restored.status).toBe(true);
  43  |   });
  44  | 
  45  |   test('R1：点 A 后再点 B，B 的版本号未回来前不能提交 A', async ({ page }) => {
  46  |     await resetMock();
  47  |     await setScript(SUCCESS);
  48  |     const frame = await openStudio(page);
  49  |     await pick(page, frame, 'buy-button');
  50  |     await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
  51  | 
  52  |     // 拦下 /version，让 B 的版本号拿不到
  53  |     let release: (() => void) | null = null;
  54  |     const held = new Promise<void>((resolve) => { release = resolve; });
  55  |     await page.route('**/version', async (route) => { await held; await route.continue(); });
  56  |     const tasksBefore = (await listTasks()).body.length;
  57  | 
  58  |     await pick(page, frame, 'benefits');
  59  |     await page.waitForTimeout(400);
  60  |     const kindDuring = await page.getByTestId('pick-state').getAttribute('data-kind');
  61  |     const disabledDuring = await page.getByTestId('generate-candidate').isDisabled();
  62  |     await page.getByTestId('instruction-input').fill('把卖点文字改一下');
  63  |     await page.getByTestId('instruction-input').press('Control+Enter');
  64  |     await page.waitForTimeout(800);
  65  |     const tasksWhilePending = (await listTasks()).body.length;
  66  |     const pendingSelectionJson = (await page.locator('[data-testid="selection-json"]').innerText().catch(() => '')).slice(0, 120);
  67  | 
  68  |     release!();
  69  |     await page.waitForTimeout(1200);
  70  |     const kindAfter = await page.getByTestId('pick-state').getAttribute('data-kind');
  71  |     const disabledAfter = await page.getByTestId('generate-candidate').isDisabled();
  72  |     await page.getByTestId('generate-candidate').click();
  73  |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  74  |     const task = (await listTasks()).body.at(-1)!;
  75  | 
  76  |     writeArtifactFrom('round3-r1-pick-state.json', {
  77  |       kindDuring, disabledDuring, kindAfter, disabledAfter,
  78  |       tasksBefore, tasksWhilePending, submittedSelection: task.selection?.src, pendingSelectionJson,
  79  |     });
  80  | 
  81  |     expect(kindDuring, '等待版本号期间应为 pending').toMatch(/pending|failed/);
  82  |     expect(disabledDuring, 'pending 期间按钮应禁用').toBe(true);
  83  |     expect(tasksWhilePending, 'pending 期间 Ctrl+Enter 不应提交').toBe(tasksBefore);
  84  |     expect(kindAfter).toBe('ready');
  85  |     expect(disabledAfter).toBe(false);
  86  |     expect(task.selection?.src, '恢复后提交的应是 B').toContain('src/App.tsx');
  87  |   });
  88  | 
  89  |   test('STALE_SELECTION：点选后页面被改过，提交时提示重新点选', async ({ page }) => {
  90  |     await resetMock();
  91  |     await setScript(SUCCESS);
  92  |     const frame = await openStudio(page);
  93  |     await pick(page, frame, 'buy-button');
  94  |     await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
  95  | 
  96  |     // 点选之后让作品文件变化（下一次提交会先快照，从而判定为 STALE）
  97  |     appendFileSync(TEMPLATE_APP, '\n// stale-round3-probe\n', 'utf8');
  98  | 
  99  |     await page.getByTestId('instruction-input').fill('把按钮改成马上购买');
  100 |     await page.getByTestId('generate-candidate').click();
  101 |     const noticed = await waitFor(async () => {
  102 |       const error = await page.getByTestId('task-action-error').count();
  103 |       const taskError = await page.getByTestId('task-error').count();
  104 |       return error > 0 || taskError > 0;
  105 |     }, 30_000, 300).then(() => true).catch(() => false);
  106 |     const text = noticed
  107 |       ? `${await page.getByTestId('task-action-error').innerText().catch(() => '')}${await page.getByTestId('task-error').innerText().catch(() => '')}`
  108 |       : '';
  109 |     const tasks = (await listTasks()).body.length;
  110 | 
  111 |     writeArtifactFrom('round3-stale-hint.json', { noticed, text, tasks, bodyText: (await page.locator('main').innerText()).slice(0, 400) });
  112 |     expect(restoreTemplate().clean).toBe(true);
> 113 |     expect(noticed, '页面变化后没有任何提示').toBe(true);
      |                                    ^ Error: 页面变化后没有任何提示
  114 |     expect(text).toContain('重新点选');
  115 |   });
  116 | });
  117 | 
```