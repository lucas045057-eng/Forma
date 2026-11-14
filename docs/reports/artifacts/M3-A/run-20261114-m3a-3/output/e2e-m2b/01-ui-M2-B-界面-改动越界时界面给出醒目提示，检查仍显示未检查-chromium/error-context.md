# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-ui.spec.ts >> M2-B 界面 >> 改动越界时界面给出醒目提示，检查仍显示未检查
- Location: tests\e2e\m2b\01-ui.spec.ts:129:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByTestId('candidate-select')
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" getByTestId('candidate-select') with timeout 30000ms
  - waiting for getByTestId('candidate-select')

```

```yaml
- main:
  - text: ORBIT / STUDIO
  - heading "空间化 AI 创作工作台" [level=1]
  - button "3D 场景编辑"
  - button "3D 资产"
  - text: 预览已连接 事件已连接 ·
  - status: "28"
  - button "开启选取"
  - region "作品预览":
    - text: 作品 / 木间香薰 浏览模式 · 100% 作品版本
    - code: 04443bc1c4
    - button "回退上一次采用"
    - iframe
  - complementary:
    - paragraph: SOURCE INSPECTOR
    - heading "选中对象" [level=2]
    - paragraph: 开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。
    - strong: App
    - code: src/App.tsx:41:15
    - paragraph: 同源码实例：3 处；修改将影响全部实例（共享组件或列表项）。
    - text: "{ \"src\": \"src/App.tsx:41:15\", \"cid\": \"App\", \"text\": \"让角落有温度\", \"bbox\": [ 373.265625, 376.609375, 283.46875, 21 ], \"styles\": { \"display\": \"block\", \"position\": \"static\", \"color\": \"rgb(72, 58, 45)\", \"backgroundColor\": \"rgba(0, 0, 0, 0)\", \"fontSize\": \"16px\", \"fontFamily\": \"\\\"Microsoft YaHei\\\", sans-serif\", \"fontWeight\": \"500\", \"lineHeight\": \"normal\", \"padding\": \"0px\", \"margin\": \"16px 0px\", \"borderRadius\": \"0px\", \"width\": \"283.469px\", \"height\": \"21px\" }, \"instances\": 3, \"ancestors\": [ \"src/App.tsx:39:13\", \"src/App.tsx:37:9\", \"src/App.tsx:34:7\" ], \"baseVersion\": \"04443bc1c46e1fa8ac2c0d1607759cb8a36bb615\" }"
    - region "指着说":
      - paragraph: POINT & SPEAK
      - heading "指着说" [level=2]
      - text: 修改指令
      - textbox "修改指令":
        - /placeholder: 例如：把这个按钮改成“马上购买”
        - text: 新增一个样式文件
      - paragraph: 将携带 src/App.tsx:41:15 作为选中对象。 Ctrl/⌘ + Enter 提交。
      - button "生成候选版本"
      - strong: 等待请示
      - code: 45ec215e
      - combobox "查看任务":
        - option "45ec215e · 等待请示" [selected]
        - option "8cb84293 · 候选已就绪"
      - paragraph: 新增一个样式文件
      - list:
        - listitem: 任务已排队
        - listitem: 开始校验选中对象并创建候选版本
        - listitem: 候选目录已创建，编码 Agent 开始工作
        - listitem: 请求编码模型（第 1/16 轮）
        - listitem: 执行工具 read_file
        - listitem: 请求编码模型（第 2/16 轮）
        - listitem: 执行工具 write_file
        - listitem: 请求编码模型（第 3/16 轮）
        - listitem: 执行工具 finish
        - listitem: 编码 Agent 已完成修改
        - listitem: 模型已生成私有草稿，需批准后才能发布；规则：out_of_scope、global_style
```

# Test source

```ts
  43  |     if (latest.status === 'awaiting_approval') {
  44  |       for (const card of (await listApprovals()).body.filter((item) => item.taskId === latest.id && item.status === 'pending')) {
  45  |         await answerApproval(card.id, 0);
  46  |       }
  47  |       return true;
  48  |     }
  49  |     return ['done', 'failed', 'cancelled'].includes(latest.status);
  50  |   }, 30_000, 200);
  51  | }
  52  | 
  53  | test.describe('M2-B 界面', () => {
  54  |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  55  |   test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  56  | 
  57  |   test('点选 → Ctrl+Enter 提交 → 步骤 → 候选/并排对比 → diff/未检查 → 采用', async ({ page }) => {
  58  |     await resetMock();
  59  |     await setScript(SUCCESS);
  60  |     await page.goto('/');
  61  |     await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  62  | 
  63  |     await pickElement(page, 'buy-button');
  64  |     const selection = JSON.parse(await page.locator('[data-testid="selection-json"]').innerText());
  65  |     expect(selection.baseVersion).toBe((await getVersion()).body.version);
  66  | 
  67  |     await page.getByTestId('instruction-input').fill('把首屏购买按钮改成“马上购买”');
  68  |     await page.getByTestId('instruction-input').press('Control+Enter');
  69  |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  70  |     const steps = await page.getByTestId('task-steps').innerText();
  71  |     expect(steps).toContain('候选目录已创建');
  72  | 
  73  |     // 候选视图
  74  |     await page.getByTestId('preview-candidate').click();
  75  |     const candidateFrame = page.frameLocator('[data-testid="candidate-frame"]');
  76  |     await expect(candidateFrame.locator('[data-testid="buy-button"]')).toHaveText('马上购买', { timeout: 60_000 });
  77  | 
  78  |     // 并排对比：两个 iframe 同尺寸
  79  |     await page.getByTestId('preview-compare').click();
  80  |     const mainFrameElement = page.locator('[data-testid="preview-frame"]');
  81  |     const candidateElement = page.locator('[data-testid="candidate-frame"]');
  82  |     await expect(mainFrameElement).toBeVisible();
  83  |     await expect(candidateElement).toBeVisible();
  84  |     let widths = { main: 0, candidate: 0 };
  85  |     await waitFor(async () => {
  86  |       const left = await mainFrameElement.boundingBox();
  87  |       const right = await candidateElement.boundingBox();
  88  |       widths = { main: left?.width ?? 0, candidate: right?.width ?? 0 };
  89  |       return Boolean(left && right && Math.abs(left.width - right.width) <= 1 && left.width > 200);
  90  |     }, 20_000, 300).catch(() => {});
  91  | 
  92  |     // 同步滚动：滚主预览，候选预览应跟到相近位置
  93  |     const mainInner = await previewFrameSafe(page);
  94  |     await mainInner.evaluate(() => window.scrollTo(0, 200));
  95  |     await page.waitForTimeout(1000);
  96  |     const candidateScroll = await page.frameLocator('[data-testid="candidate-frame"]').locator('body')
  97  |       .evaluate(() => window.scrollY).catch(() => -1);
  98  | 
  99  |     // diff / 检查 / 越界
  100 |     const diff = await page.getByTestId('candidate-diff').innerText();
  101 |     expect(diff).toContain('src/App.tsx');
  102 |     const statuses = await page.getByTestId('candidate-checks').locator('[data-status]')
  103 |       .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
  104 |     const checksText = await page.getByTestId('candidate-checks').innerText();
  105 |     expect(statuses.every((status) => status === 'not_run'), `检查状态不是未检查：${JSON.stringify(statuses)}`).toBe(true);
  106 |     expect(checksText).not.toContain('通过');
  107 |     expect(await page.getByTestId('candidate-out-of-scope').count(), '选中的是 Button.tsx，改的是祖先文件 App.tsx，不该算越界').toBe(0);
  108 | 
  109 |     // 采用
  110 |     await page.getByTestId('candidate-adopt').click();
  111 |     await waitFor(async () => {
  112 |       const frame = await previewFrameSafe(page);
  113 |       return (await frame.locator('[data-testid="buy-button"]').textContent()) === '马上购买';
  114 |     }, 60_000, 500);
  115 | 
  116 |     writeArtifactFrom('m2b-ui-flow.json', {
  117 |       steps: steps.split('\n').filter(Boolean).slice(0, 8),
  118 |       widths, candidateScroll,
  119 |       diff: diff.slice(0, 200),
  120 |       checkStatuses: statuses,
  121 |       versionAfterAdopt: (await getVersion()).body.version,
  122 |       decisions: (await listCandidates()).body.map((candidate) => ({ id: candidate.id, decision: candidate.decision })),
  123 |     });
  124 | 
  125 |     expect((await revertVersion()).status).toBe(200);
  126 |     await clearPending();
  127 |   });
  128 | 
  129 |   test('改动越界时界面给出醒目提示，检查仍显示未检查', async ({ page }) => {
  130 |     await resetMock();
  131 |     await setScript([
  132 |       [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  133 |       [{ name: 'write_file', args: { path: 'src/tmp-scope.css', content: '.tmp { display: block; }\n' } }],
  134 |       [{ name: 'finish', args: { summary: '新建样式文件' } }],
  135 |     ]);
  136 |     await page.goto('/');
  137 |     await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  138 |     await pickElement(page, 'benefits');
  139 |     await page.getByTestId('instruction-input').fill('新增一个样式文件');
  140 |     await page.getByTestId('generate-candidate').click();
  141 |     await resolveAwaiting();
  142 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
> 143 |     await expect(page.getByTestId('candidate-select')).toBeVisible({ timeout: 30_000 });
      |                                                        ^ Error: expect(locator).toBeVisible() failed
  144 |     await page.getByTestId('preview-candidate').click();
  145 |     await page.waitForTimeout(800);
  146 | 
  147 |     const warning = page.getByTestId('candidate-out-of-scope');
  148 |     await expect(warning, '越界改动没有提示').toBeVisible({ timeout: 20_000 });
  149 |     const text = await warning.innerText();
  150 |     const statuses = await page.getByTestId('candidate-checks').locator('[data-status]')
  151 |       .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
  152 |     writeArtifactFrom('m2b-ui-out-of-scope.json', { text, checkStatuses: statuses });
  153 |     expect(text).toContain('src/tmp-scope.css');
  154 |     expect(statuses.every((status) => status === 'not_run')).toBe(true);
  155 |     await clearPending();
  156 |   });
  157 | 
  158 |   test('取消与重试：任务可以中途取消，重试后能产出候选', async ({ page }) => {
  159 |     await resetMock();
  160 |     await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 3000);
  161 |     await page.goto('/');
  162 |     await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  163 |     await page.getByTestId('instruction-input').fill('一个会被取消的任务');
  164 |     await page.getByTestId('generate-candidate').click();
  165 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  166 |     await page.getByTestId('task-cancel').click();
  167 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'cancelled', { timeout: 30_000 });
  168 |     await expect(page.getByTestId('task-retry')).toBeVisible();
  169 | 
  170 |     await setScript(SUCCESS);
  171 |     await page.getByTestId('task-retry').click();
  172 |     await resolveAwaiting();
  173 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  174 |     writeArtifactFrom('m2b-ui-cancel-retry.json', { status: 'done' });
  175 |     await clearPending();
  176 |   });
  177 | });
  178 | 
```