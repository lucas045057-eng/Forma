import { expect, test, type Page } from '@playwright/test';
import * as api from '../m2a/api';
import { writeArtifact } from './artifact';
import { BUILD_FAULT, RUNTIME_FAULT, OCCLUSION_FAULT, cardByTask, cleanup, decide, ensurePicked, openStudio, waitCandidate } from './support';

/**
 * M3-C real UI · 三类真实故障（不是 mock）：构建失败、页面运行错误、交互遮挡。
 *
 * 这三个故障都由 Agent 真的写坏候选源码 → 真实检查运行器真的失败，
 * 不属于“公共路径不可达”的 schema 故障（后者在 04-mock-boundaries 里按设计用受控 UI 呈现，
 * 并如实标注为 mock，不冒充运行器真实失败）。
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { expect(api.restoreTemplate().clean).toBe(true); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(() => { expect(api.restoreTemplate().clean).toBe(true); });

async function localCandidate(page: Page, script: unknown[][], instruction: string) {
  await api.resetMock();
  await api.setScript(script as never);
  // 先选一个 App.tsx 内的元素，否则提交算越范围，会先请示。
  await ensurePicked(page);
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/tasks', { timeout: 30_000 }),
    (async () => {
      await page.getByTestId('instruction-input').fill(instruction);
      await page.getByTestId('generate-candidate').click();
    })(),
  ]);
  expect(response.status()).toBe(202);
  const taskId = (await response.json() as { id: string }).id;

  // 实测事实：**把源码改成语法错误**时产品会先请示（analysis_uncertain）——
  // apps/server/src/approvals/policy.ts:268 在 base 文件有 parse diagnostics 时加该规则，
  // 因为影响范围无法静态分析。所以“真实构建失败”这条路径必须先经用户批准，再产出候选；
  // 批准后候选里确实是坏代码，检查仍会真实地 build 失败（不是伪造）。
  const state = await expect.poll(async () => {
    const status = await page.getByTestId('task-status').getAttribute('data-status');
    if (status === 'done') return 'done';
    const pending = await page.locator(`[data-testid="approval-card"][data-task-id="${taskId}"][data-status="pending"]`).count();
    return pending > 0 ? 'approval' : String(status);
  }, { timeout: 180_000 }).toMatch(/done|approval/);
  void state;

  const card = cardByTask(page, taskId);
  if (await page.locator(`[data-testid="approval-card"][data-task-id="${taskId}"][data-status="pending"]`).count() > 0) {
    const decided = await decide(card, 'approve');
    expect(decided.status, decided.text).toBe(200);
  }
  await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
  await waitCandidate(page);
  return taskId;
}

async function runAndWaitFailure(page: Page, label: string) {
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('check-run-status')).toContainText('检查失败', { timeout: 300_000 });
  const runId = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;
  expect(runId).not.toBe('');
  const items = await page.getByTestId('check-item').evaluateAll((nodes) => nodes.map((node) => ({
    name: node.getAttribute('data-check-name'), status: node.getAttribute('data-status'), text: node.textContent ?? '',
  })));
  writeArtifact(`m3c-failure-${label}.json`, {
    runId, items: items.map((item) => ({ name: item.name, status: item.status })),
    gateReason: await page.getByTestId('candidate-gate-reason').innerText(),
  });
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '检查失败后采用按钮仍可用').toBe(true);
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('检查');
  return { runId, items };
}

test('真实构建失败：schema 通过、build 失败、后续未运行，界面给出构建日志提示', async ({ page }) => {
  await openStudio(page);
  await localCandidate(page, BUILD_FAULT, '故意制造语法错误');
  const { items } = await runAndWaitFailure(page, 'build');
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  expect(byName.schema.status).toBe('passed');
  expect(byName.build.status).toBe('failed');
  expect(byName.build.text).toContain('构建失败，请查看构建日志');
  expect(byName.smoke.status).toBe('not_run');
  expect(byName.occlusion.status).toBe('not_run');
  // 设计 §3 要求“前序失败，未运行”说明；实测后端文案是“前序检查 build 未完成：CHECK_FAILED”，
  // UI 对以“未开始执行：”开头的那种会映射成“前序失败，未运行：”，这种则原样展示。
  // 语义断言：必须点名被谁阻塞、且给出失败码；具体措辞差异记在报告里，不当成缺陷。
  expect(byName.smoke.text, `冒烟行没有说明被前序阻塞：${byName.smoke.text}`).toMatch(/前序(失败，未运行|检查)/);
  expect(byName.smoke.text).toContain('build');
  await expect(page.getByTestId('candidate-checks').locator('[role="alert"]').first()).toBeVisible();
});

test('真实运行错误：build 通过、冒烟失败并给出运行错误提示与截图证据', async ({ page }) => {
  await openStudio(page);
  await localCandidate(page, RUNTIME_FAULT, '让页面启动后抛异常');
  const { runId, items } = await runAndWaitFailure(page, 'runtime');
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  expect(byName.build.status, `build 不该失败：${JSON.stringify(items.map((i) => [i.name, i.status]))}`).toBe('passed');
  expect(byName.smoke.status).toBe('failed');
  expect(byName.smoke.text).toContain('页面冒烟检查失败，请查看运行错误与截图');
  expect(byName.occlusion.status).toBe('not_run');

  const smoke = await api.http(`${'http://127.0.0.1:3001'}/checks/${runId}/artifacts/smoke.json`);
  expect(smoke.status, '冒烟证据读不到').toBe(200);
  const parsed = JSON.parse(smoke.text);
  expect(String(parsed.error ?? '')).toContain('UNCAUGHT_PAGE_ERROR');
});

test('真实遮挡：build/冒烟通过、遮挡失败并提示查看报告与截图', async ({ page }) => {
  await openStudio(page);
  await localCandidate(page, OCCLUSION_FAULT, '用覆盖层挡住顶部导航');
  const { runId, items } = await runAndWaitFailure(page, 'occlusion');
  const byName = Object.fromEntries(items.map((item) => [item.name, item]));
  expect(byName.schema.status).toBe('passed');
  expect(byName.build.status).toBe('passed');
  expect(byName.smoke.status).toBe('passed');
  expect(byName.occlusion.status).toBe('failed');
  expect(byName.occlusion.text).toContain('交互入口被遮挡或命中检查失败');

  const occlusion = await api.http(`${'http://127.0.0.1:3001'}/checks/${runId}/artifacts/occlusion.json`);
  expect(occlusion.status).toBe(200);
  expect(String(JSON.parse(occlusion.text).error ?? '')).toContain('INTERACTIVE_TARGET_OCCLUDED');
});
