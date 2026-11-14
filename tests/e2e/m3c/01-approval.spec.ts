import { expect, test, type Page } from '@playwright/test';
import * as api from '../m2a/api';
import { writeArtifact } from './artifact';
import {
  SHARED_BUTTON, cardByTask, cleanup, countRequests, createAwaitingCard, decide, dropSockets, mainFrame, openStudio,
  overlayTotal, pickSharedButton, selectionText, submitInstruction, waitCard,
} from './support';

/**
 * M3-C real UI · 请示（C1）
 *
 * 全部走真实 Studio + 后端 + 持久文件 + 单 WS + Chromium；模型是本机 loopback mock。
 * 每个用例自己建请示卡，afterEach 拒掉遗留请示以释放“最多 3 张”的名额。
 */

const REPO_INSTRUCTIONS = '把共享按钮圆角改大';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { expect(api.restoreTemplate().clean).toBe(true); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(() => { expect(api.restoreTemplate().clean).toBe(true); });

test('请示卡持久显示：刷新页面与手动刷新状态后仍是同 id 单卡，且公开候选为空', async ({ page }) => {
  await openStudio(page);
  const selection = await pickSharedButton(page);
  expect(selection.instances, `共享 Button 的实例数不是 3：${JSON.stringify(selection)}`).toBe(3);
  expect(selection.src).toContain('src/components/Button.tsx');

  await api.resetMock();
  await api.setScript(SHARED_BUTTON as never);
  const taskId = await submitInstruction(page, REPO_INSTRUCTIONS);
  const card = await waitCard(page, taskId);
  const approvalId = await card.getAttribute('data-approval-id');

  expect(await card.innerText()).toContain('共享组件');
  await expect(card.getByTestId('approval-status')).toContainText('等待批准');
  expect((await api.listCandidates()).body.filter((item) => item.taskId === taskId), '批准前不应该有公开候选').toHaveLength(0);
  expect((await api.listApprovals()).body.filter((item) => item.taskId === taskId && item.status === 'pending')).toHaveLength(1);

  // 刷新页面：按持久状态恢复，不是靠内存里的事件
  await page.reload();
  await openStudio(page);
  await expect(page.getByTestId('approval-card')).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-approval-id', approvalId!);
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-status', 'pending');

  // 只读刷新同样不改变卡片身份
  await page.getByTestId('state-refresh').click();
  await expect(page.getByTestId('approval-card')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('approval-card')).toHaveAttribute('data-approval-id', approvalId!);

  writeArtifact('m3c-approval-persistence.json', {
    approvalId, taskId, selectionSrc: selection.src, instances: selection.instances,
    pendingCardsAfterReload: await page.getByTestId('approval-card').count(),
    publicCandidates: (await api.listCandidates()).body.length,
  });
});

test('影响模式：共享 Button 三处青色高亮，点击页面不改写高亮，退出后清理且不替换 Selection', async ({ page }) => {
  await openStudio(page);
  const { card, selection } = await createAwaitingCard(page);
  const beforeSelection = await selectionText(page);
  const file = selection.src.split(':')[0]; // src/components/Button.tsx

  const affectedOf = (value: string) => card.locator(`[data-testid="approval-affected"][data-affected="${value}"]`);

  // 先记录一个已知限制（不作为通过条件）：affected 里的“使用点”（App.tsx:27:14 这类）会提供定位按钮，
  // 但页面元素的 data-src 指向的是组件定义（Button.tsx:5:5），所以定位结果为空——这是 bridge
  // “只支持精确 src”的合同面限，实现在报告里如实记为观察项。
  const usage = card.getByTestId('approval-affected').filter({ has: page.locator('button') }).first();
  const usagePoint = await usage.getAttribute('data-affected');
  await usage.getByRole('button').click();
  await expect(page.getByTestId('approval-highlight-exit')).toBeVisible({ timeout: 30_000 });
  const usageFrame = await mainFrame(page);
  const usageBoxes = await usageFrame.locator('[data-highlight-src]').count();
  await page.getByTestId('approval-highlight-exit').click();

  // 设计的主路径：共享组件的文件级条目（去行列后的文件出现在 affected 中）→ 应当框出三处实例。
  const item = affectedOf(file);
  await expect(item, `没找到共享组件条目 ${file}`).toBeVisible({ timeout: 30_000 });
  await item.getByRole('button').click();
  await expect(page.getByTestId('approval-highlight-exit')).toBeVisible({ timeout: 30_000 });

  const frame = await mainFrame(page);
  const boxes = async () => frame.locator('[data-highlight-src]').evaluateAll((nodes) => nodes.map((node) => ({
    src: node.getAttribute('data-highlight-src') ?? '',
    color: getComputedStyle(node).borderTopColor.replace(/\s+/g, ''),
  })));
  const cyan = (await boxes()).filter((box) => box.color === 'rgb(34,211,238)');
  void cyan;
  // overlay 由 bridge 的 requestAnimationFrame 重画：轮询等它落定，而不是读一次就断言（读一次会偶发 0）。
  try {
    await expect.poll(async () => (await boxes()).filter((box) => box.color === 'rgb(34,211,238)').length, { timeout: 30_000 }).toBe(3);
  } catch (error) {
    const diagnostic = {
      boxes: await boxes(),
      affected: await card.getByTestId('approval-affected').evaluateAll((nodes) => nodes.map((node) => ({
        affected: node.getAttribute('data-affected'), hasButton: !!node.querySelector('button'), text: node.textContent ?? '',
      }))),
      selection: await selectionText(page),
      frameDataSrcCount: await frame.locator('[data-src]').count(),
      buttonDataSrc: await frame.locator('[data-testid="buy-button"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-src'))),
    };
    throw new Error(`${(error as Error).message}\n影响模式诊断：${JSON.stringify(diagnostic)}`);
  }
  const cyanNow = (await boxes()).filter((box) => box.color === 'rgb(34,211,238)');
  expect(cyanNow.length).toBe(3);
  expect(new Set(cyanNow.map((box) => box.src)).size, '三处高亮的 src 不一致').toBe(1);
  expect(cyanNow[0].src).toContain('src/components/Button.tsx');
  void cyan;

  // 影响模式下点页面另一处：bridge 会先把框换成被点元素，Studio 必须把高亮拉回卡片 src（C1-1）
  await frame.locator('[data-testid="benefit-item"]').first().click();
  await expect.poll(async () => (await boxes()).filter((box) => box.color === 'rgb(34,211,238)').length, { timeout: 30_000 }).toBe(3);
  const after = (await boxes()).filter((box) => box.color === 'rgb(34,211,238)');
  expect(after.map((box) => box.src)).toEqual(cyanNow.map((box) => box.src));

  // 影响模式不创建/替换可提交的 Selection
  expect(await selectionText(page), '影响模式替换了 Selection').toBe(beforeSelection);

  await page.getByTestId('approval-highlight-exit').click();
  await expect.poll(async () => overlayTotal(await mainFrame(page)), { timeout: 30_000 }).toBe(0);
  await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready');

  writeArtifact('m3c-approval-impact-highlight.json', {
    cyanBoxes: cyanNow.length, distinctSrc: [...new Set(cyanNow.map((box) => box.src))],
    boxesAfterClick: after.length, selectionPreserved: beforeSelection !== '' && beforeSelection === await selectionText(page),
    // 记实：使用点（如 App.tsx:27:14）的定位按钮存在，但页面无同 src 的 data-src，框数为 0。
    usagePoint, usagePointBoxes: usageBoxes,
  });
});

test('批准：body 为 {option:0}，不增加 mock 调用，不自动创建候选、不自动运行检查', async ({ page }) => {
  await openStudio(page);
  const calls = (await api.mockStats()).body.calls;
  const { card, taskId } = await createAwaitingCard(page);

  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/approvals\/[^/]+$/.test(new URL(request.url()).pathname)) posts.push(request.postData() ?? '');
  });
  const checkPosts = countRequests(page, 'POST', (path) => path.endsWith('/checks'));

  const response = await decide(card, 'approve');
  expect(response.status, response.text).toBe(200);
  expect(JSON.parse(posts[0] ?? 'null'), '批准请求体不是 {option:0}').toEqual({ option: 0 });

  await expect(page.getByTestId('candidate-select')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('check-run-status')).toContainText('未检查', { timeout: 60_000 });

  const candidate = (await api.listCandidates()).body.find((item) => item.taskId === taskId);
  expect(candidate, '批准后没有产出候选').toBeTruthy();
  expect(candidate!.latestCheckRunId ?? null, '批准后自动开始了检查').toBeNull();

  const statuses = await page.getByTestId('candidate-checks').locator('[data-check-name]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
  expect(statuses, `四项应为未检查：${JSON.stringify(statuses)}`).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '未检查时采用按钮不该可用').toBe(true);
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('尚未运行检查');

  expect(checkPosts.count(), '批准不应触发检查 POST').toBe(0);
  expect((await api.mockStats()).body.calls, '批准增加了模型调用').toBe(calls);

  writeArtifact('m3c-approval-approve.json', {
    requestBody: JSON.parse(posts[0] ?? 'null'), mockCallsBefore: calls, mockCallsAfter: (await api.mockStats()).body.calls,
    candidateId: candidate!.id, latestCheckRunId: candidate!.latestCheckRunId ?? null, checkStatuses: statuses,
    checkPosts: checkPosts.count(),
  });
});

test('拒绝：body 为 {option:1}，不产生候选，主作品不变', async ({ page }) => {
  await openStudio(page);
  const frameBefore = await mainFrame(page);
  await expect(frameBefore.locator('[data-testid="buy-button"]')).toHaveText('立即购买');

  const { card, taskId } = await createAwaitingCard(page);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /^\/approvals\/[^/]+$/.test(new URL(request.url()).pathname)) posts.push(request.postData() ?? '');
  });

  const response = await decide(card, 'reject');
  expect(response.status, response.text).toBe(200);
  expect(JSON.parse(posts[0] ?? 'null'), '拒绝请求体不是 {option:1}').toEqual({ option: 1 });

  await expect(card).toHaveAttribute('data-status', 'rejected', { timeout: 60_000 });
  await expect(card.getByTestId('approval-status')).toContainText('已拒绝并丢弃草稿，主作品未改变');
  await expect(card.getByTestId('approval-approve')).toBeDisabled();
  await expect(card.getByTestId('approval-reject')).toBeDisabled();

  expect((await api.listCandidates()).body.filter((item) => item.taskId === taskId), '拒绝后仍产出了候选').toHaveLength(0);
  const frameAfter = await mainFrame(page);
  await expect(frameAfter.locator('[data-testid="buy-button"]')).toHaveText('立即购买');
});

test('重复点击与键盘：同一张卡只发一次 POST，另一个回答立即 disabled', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);

  const posts = countRequests(page, 'POST', (path) => /^\/approvals\/[^/]+$/.test(path));
  // 绕过 Playwright 的可操作性等待，直接连点两次：检验的是应用内的同步锁，不是按钮动画
  await card.getByTestId('approval-approve').evaluate((node) => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
  await expect(card).toHaveAttribute('data-status', 'approved', { timeout: 120_000 });
  expect(posts.count(), `同一张卡发了 ${posts.count()} 次 POST`).toBe(1);
  await expect(card.getByTestId('approval-reject')).toBeDisabled();
  await expect(card.getByTestId('approval-approve')).toBeDisabled();
});

test('取消任务：待请示卡变为不可继续，回答按钮禁用', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);
  await card.getByRole('button', { name: '取消任务' }).click();
  await expect(card).toHaveAttribute('data-status', 'cancelled', { timeout: 90_000 });
  await expect(card.getByTestId('approval-status')).toContainText('任务已取消，请示不可继续');
  await expect(card.getByTestId('approval-approve')).toBeDisabled();
  await expect(card.getByTestId('approval-reject')).toBeDisabled();
});

test('断线期间完成回答：重连后按服务器持久状态恢复，不需要手动刷新', async ({ page }) => {
  await openStudio(page, { instrumentSockets: true });
  const { card, taskId } = await createAwaitingCard(page);

  await dropSockets(page);
  await expect(page.getByTestId('events-status')).not.toHaveAttribute('data-status', 'connected', { timeout: 60_000 });

  // 断线期间由外部（测试）真实回答该请示
  const approvalId = await card.getAttribute('data-approval-id');
  expect((await api.answerApproval(approvalId!, 0)).status).toBe(200);

  // 重连 + 权威补拉后，卡片必须自己变成 approved
  await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 90_000 });
  await expect(card).toHaveAttribute('data-status', 'approved', { timeout: 90_000 });
  await expect(card.getByTestId('approval-status')).toContainText('已批准');
  await expect(card.getByTestId('approval-approve')).toBeDisabled();

  const task = (await api.getTask(taskId)).body;
  writeArtifact('m3c-approval-reconnect.json', { approvalId, taskStatus: task.status, taskCandidateId: task.candidateId ?? null });
});

test('请示卡在页面重载后不重复：同 id 单卡（反复刷新比一次更严格）', async ({ page }) => {
  await openStudio(page);
  const { card, taskId } = await createAwaitingCard(page);
  const approvalId = await card.getAttribute('data-approval-id');
  for (let round = 0; round < 2; round += 1) {
    await page.reload();
    await openStudio(page);
    await expect(page.getByTestId('approval-card')).toHaveCount(1, { timeout: 90_000 });
    await expect(cardByTask(page, taskId)).toHaveAttribute('data-approval-id', approvalId!);
    await expect(cardByTask(page, taskId)).toHaveAttribute('data-status', 'pending');
  }
});
