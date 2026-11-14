import { expect, test } from '@playwright/test';
import {
  discardCandidate, getVersion, listCandidates, previewFrameSafe, resetMock, restoreTemplate, revertVersion,
  setScript, waitFor, listTasks, listApprovals, answerApproval,
} from '../m2a/api';
import { writeArtifactFrom } from './artifact';

/**
 * M2-B 工作台界面（mock 模型）：点选 → 指令（Ctrl+Enter）→ 步骤 → 候选/并排 →
 * diff/越界/未检查 → 采用；另外覆盖取消与重试、越界提示。
 */

const SUCCESS = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: '已把首屏购买按钮改成“马上购买”' } }],
];

async function pickElement(page: import('@playwright/test').Page, testId: string): Promise<void> {
  await page.getByTestId('pick-toggle').click();
  const frame = await previewFrameSafe(page);
  const target = frame.locator(`[data-testid="${testId}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`找不到元素 ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('[data-testid="selection-json"]').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('pick-toggle').click();
}

async function clearPending(): Promise<void> {
  for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
    await discardCandidate(candidate.id);
  }
}

/** M3-A 合同变化：越界/共享任务会先进入 awaiting；M2 旧用例通过 API 真实回答批准后继续原断言。 */
async function resolveAwaiting(): Promise<void> {
  await waitFor(async () => {
    const tasks = (await listTasks()).body;
    const latest = tasks[tasks.length - 1];
    if (!latest) return false;
    if (latest.status === 'awaiting_approval') {
      for (const card of (await listApprovals()).body.filter((item) => item.taskId === latest.id && item.status === 'pending')) {
        await answerApproval(card.id, 0);
      }
      return true;
    }
    return ['done', 'failed', 'cancelled'].includes(latest.status);
  }, 30_000, 200);
}

test.describe('M2-B 界面', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('点选 → Ctrl+Enter 提交 → 步骤 → 候选/并排对比 → diff/未检查 → 采用', async ({ page }) => {
    await resetMock();
    await setScript(SUCCESS);
    await page.goto('/');
    await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });

    await pickElement(page, 'buy-button');
    const selection = JSON.parse(await page.locator('[data-testid="selection-json"]').innerText());
    expect(selection.baseVersion).toBe((await getVersion()).body.version);

    await page.getByTestId('instruction-input').fill('把首屏购买按钮改成“马上购买”');
    await page.getByTestId('instruction-input').press('Control+Enter');
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    const steps = await page.getByTestId('task-steps').innerText();
    expect(steps).toContain('候选目录已创建');

    // 候选视图
    await page.getByTestId('preview-candidate').click();
    const candidateFrame = page.frameLocator('[data-testid="candidate-frame"]');
    await expect(candidateFrame.locator('[data-testid="buy-button"]')).toHaveText('马上购买', { timeout: 60_000 });

    // 并排对比：两个 iframe 同尺寸
    await page.getByTestId('preview-compare').click();
    const mainFrameElement = page.locator('[data-testid="preview-frame"]');
    const candidateElement = page.locator('[data-testid="candidate-frame"]');
    await expect(mainFrameElement).toBeVisible();
    await expect(candidateElement).toBeVisible();
    let widths = { main: 0, candidate: 0 };
    await waitFor(async () => {
      const left = await mainFrameElement.boundingBox();
      const right = await candidateElement.boundingBox();
      widths = { main: left?.width ?? 0, candidate: right?.width ?? 0 };
      return Boolean(left && right && Math.abs(left.width - right.width) <= 1 && left.width > 200);
    }, 20_000, 300).catch(() => {});

    // 同步滚动：滚主预览，候选预览应跟到相近位置
    const mainInner = await previewFrameSafe(page);
    await mainInner.evaluate(() => window.scrollTo(0, 200));
    await page.waitForTimeout(1000);
    const candidateScroll = await page.frameLocator('[data-testid="candidate-frame"]').locator('body')
      .evaluate(() => window.scrollY).catch(() => -1);

    // diff / 检查 / 越界
    const diff = await page.getByTestId('candidate-diff').innerText();
    expect(diff).toContain('src/App.tsx');
    const statuses = await page.getByTestId('candidate-checks').locator('[data-status]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
    const checksText = await page.getByTestId('candidate-checks').innerText();
    expect(statuses.every((status) => status === 'not_run'), `检查状态不是未检查：${JSON.stringify(statuses)}`).toBe(true);
    expect(checksText).not.toContain('通过');
    expect(await page.getByTestId('candidate-out-of-scope').count(), '选中的是 Button.tsx，改的是祖先文件 App.tsx，不该算越界').toBe(0);

    // 采用
    await page.getByTestId('candidate-adopt').click();
    await waitFor(async () => {
      const frame = await previewFrameSafe(page);
      return (await frame.locator('[data-testid="buy-button"]').textContent()) === '马上购买';
    }, 60_000, 500);

    writeArtifactFrom('m2b-ui-flow.json', {
      steps: steps.split('\n').filter(Boolean).slice(0, 8),
      widths, candidateScroll,
      diff: diff.slice(0, 200),
      checkStatuses: statuses,
      versionAfterAdopt: (await getVersion()).body.version,
      decisions: (await listCandidates()).body.map((candidate) => ({ id: candidate.id, decision: candidate.decision })),
    });

    expect((await revertVersion()).status).toBe(200);
    await clearPending();
  });

  test('改动越界时界面给出醒目提示，检查仍显示未检查', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'write_file', args: { path: 'src/tmp-scope.css', content: '.tmp { display: block; }\n' } }],
      [{ name: 'finish', args: { summary: '新建样式文件' } }],
    ]);
    await page.goto('/');
    await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
    await pickElement(page, 'benefits');
    await page.getByTestId('instruction-input').fill('新增一个样式文件');
    await page.getByTestId('generate-candidate').click();
    await resolveAwaiting();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    await expect(page.getByTestId('candidate-select')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('preview-candidate').click();
    await page.waitForTimeout(800);

    const warning = page.getByTestId('candidate-out-of-scope');
    await expect(warning, '越界改动没有提示').toBeVisible({ timeout: 20_000 });
    const text = await warning.innerText();
    const statuses = await page.getByTestId('candidate-checks').locator('[data-status]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
    writeArtifactFrom('m2b-ui-out-of-scope.json', { text, checkStatuses: statuses });
    expect(text).toContain('src/tmp-scope.css');
    expect(statuses.every((status) => status === 'not_run')).toBe(true);
    await clearPending();
  });

  test('取消与重试：任务可以中途取消，重试后能产出候选', async ({ page }) => {
    await resetMock();
    await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 3000);
    await page.goto('/');
    await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
    await page.getByTestId('instruction-input').fill('一个会被取消的任务');
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
    await page.getByTestId('task-cancel').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'cancelled', { timeout: 30_000 });
    await expect(page.getByTestId('task-retry')).toBeVisible();

    await setScript(SUCCESS);
    await page.getByTestId('task-retry').click();
    await resolveAwaiting();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    writeArtifactFrom('m2b-ui-cancel-retry.json', { status: 'done' });
    await clearPending();
  });
});
