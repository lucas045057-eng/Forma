# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-ui.spec.ts >> M2-B 界面 >> 取消与重试：任务可以中途取消，重试后能产出候选
- Location: tests\e2e\m2b\01-ui.spec.ts:158:3

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  getByTestId('task-status')
Expected: "done"
Received: "awaiting_approval"
Timeout:  150000ms

Call log:
  - Expect "toHaveAttribute" getByTestId('task-status') with timeout 150000ms
  - waiting for getByTestId('task-status')
    2 × locator resolved to <strong data-status="cancelled" data-testid="task-status">已取消</strong>
      - unexpected value "cancelled"
    4 × locator resolved to <strong data-status="running" data-testid="task-status">执行中</strong>
      - unexpected value "running"
    292 × locator resolved to <strong data-testid="task-status" data-status="awaiting_approval">等待请示</strong>
        - unexpected value "awaiting_approval"

```

```yaml
- strong: 等待请示
```

# Test source

```ts
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
  143 |     await expect(page.getByTestId('candidate-select')).toBeVisible({ timeout: 30_000 });
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
> 173 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
      |                                                   ^ Error: expect(locator).toHaveAttribute(expected) failed
  174 |     writeArtifactFrom('m2b-ui-cancel-retry.json', { status: 'done' });
  175 |     await clearPending();
  176 |   });
  177 | });
  178 | 
```