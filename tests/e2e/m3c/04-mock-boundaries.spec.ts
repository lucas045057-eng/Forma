import { expect, test, type Page } from '@playwright/test';
import * as api from '../m2a/api';
import { writeArtifact } from './artifact';
import {
  BACKEND_BASE, cleanup, createAwaitingCard, ensurePicked, openStudio, runChecksViaApi, waitCandidate,
} from './support';

/**
 * M3-C · mock 边界（**不是**后端真实故障证据）
 *
 * 这里用 Playwright 的 request 拦截伪造：截断/乱序历史、迟到响应、写请求响应丢失、
 * 缺失或损坏的证据、409 CHECKS_NOT_PASSED / STALE_CANDIDATE、恶意文本。
 * 每例标题都带 “mock：”，报告里也按 mock 单列，不冒充运行器真实失败。
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { expect(api.restoreTemplate().clean).toBe(true); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(() => { expect(api.restoreTemplate().clean).toBe(true); });

/** 造一个“局部改动”的待定候选（不触发请示）。 */
async function localCandidate(page: Page, instruction: string, old: string, next: string) {
  await api.resetMock();
  await api.setScript([
    [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old, new: next } }],
    [{ name: 'finish', args: { summary: '局部文案已修改' } }],
  ] as never);
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
  await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
  await waitCandidate(page);
  return (await api.listCandidates()).body.find((item) => item.taskId === taskId)!;
}

test('mock：事件历史被截断时重新取锚点，不跳过触发事件（终态仍按权威状态恢复）', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);
  const approvalId = (await card.getAttribute('data-approval-id'))!;

  let poisoned = 0;
  await page.route('**/events/history**', async (route) => {
    if (poisoned === 0) {
      poisoned += 1;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ events: [], current: 999_999, oldest: 999_999, truncated: true }),
      });
    }
    return route.continue();
  });

  // 真实回答（服务端已改成 approved），再用“刷新状态”触发一次会先撞上截断响应的同步
  expect((await api.answerApproval(approvalId, 0)).status).toBe(200);
  await page.getByTestId('state-refresh').click();
  await expect(card).toHaveAttribute('data-status', 'approved', { timeout: 120_000 });
  await expect(page.getByText('状态待同步', { exact: true })).toHaveCount(0, { timeout: 60_000 });
  // 游标不能被 999999 这种假锚点污染：后续事件仍能正常推进
  const seqText = await page.getByTestId('events-seq').innerText();
  expect(Number(seqText), `事件序号被截断响应污染：${seqText}`).toBeLessThan(999_999);
  writeArtifact('m3c-mock-truncated.json', { poisonedCalls: poisoned, seqAfter: seqText, status: await card.getAttribute('data-status') });
});

test('mock：迟到的旧快照不会把已批准的回滚成待批准', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);
  const approvalId = (await card.getAttribute('data-approval-id'))!;
  const stale = await api.listApprovals().then((result) => JSON.stringify(result.body));

  expect((await api.answerApproval(approvalId, 0)).status).toBe(200);
  await expect(card).toHaveAttribute('data-status', 'approved', { timeout: 120_000 });

  let served = 0;
  await page.route('**/approvals', async (route) => {
    if (route.request().method() === 'GET') {
      served += 1;
      // 把“旧的 pending 快照”当成这次 GET 的响应（模拟迟到/乱序）
      return route.fulfill({ status: 200, contentType: 'application/json', body: stale });
    }
    return route.continue();
  });
  await page.getByTestId('state-refresh').click();
  await page.waitForTimeout(2_000);
  await expect(card, '旧快照把终态回滚了').toHaveAttribute('data-status', 'approved');
  await expect(card.getByTestId('approval-approve')).toBeDisabled();
  writeArtifact('m3c-mock-late-snapshot.json', { staleServes: served, finalStatus: await card.getAttribute('data-status') });
});

test('mock：写请求响应丢失时显示“无法确认服务器状态”，不自动重发；刷新后按服务器状态显示', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);
  const approvalId = (await card.getAttribute('data-approval-id'))!;

  let posts = 0;
  await page.route('**/approvals/**', async (route) => {
    if (route.request().method() === 'POST') { posts += 1; return route.abort('failed'); }
    return route.continue();
  });
  await card.getByTestId('approval-approve').click();
  await expect(card.getByTestId('approval-error')).toContainText('无法确认服务器状态', { timeout: 60_000 });
  await page.waitForTimeout(1_500);
  expect(posts, '写请求失败后被自动重发了').toBe(1);

  // 服务器侧另一次真实回答（模拟“其实已经成功”），再刷新：按权威状态显示，不误报为失败
  expect((await api.answerApproval(approvalId, 0)).status).toBe(200);
  await page.getByTestId('state-refresh').click();
  await expect(card).toHaveAttribute('data-status', 'approved', { timeout: 120_000 });
  expect(posts, '刷新导致了额外 POST').toBe(1);
  writeArtifact('m3c-mock-write-response-lost.json', { posts, status: await card.getAttribute('data-status') });
});

test('mock：必需证据 404 时提示无法读取并关闭采用', async ({ page }) => {
  await openStudio(page);
  const candidate = await localCandidate(page, '把首屏文案改成“证据缺失”', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。');
  await page.route('**/checks/*/artifacts/schema.json', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no such artifact' } }) }));
  await runChecksViaApi(candidate.id);
  await page.getByTestId('state-refresh').click();

  await expect(page.getByTestId('candidate-checks')).toContainText('全部检查通过', { timeout: 180_000 });
  await expect(page.getByTestId('check-error')).toContainText('证据无法读取', { timeout: 120_000 });
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '证据缺失时采用被打开了').toBe(true);
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('证据');
});

test('mock：证据字节被篡改（hash 不符）时不采用、不渲染伪造内容', async ({ page }) => {
  await openStudio(page);
  const candidate = await localCandidate(page, '把首屏文案改成“证据篡改”', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。');
  await page.route('**/checks/*/artifacts/build.log', (route) => route.fulfill({
    status: 200, contentType: 'text/plain; charset=utf-8', body: 'tampered build log\n',
  }));
  await runChecksViaApi(candidate.id);
  await page.getByTestId('state-refresh').click();

  await expect(page.getByTestId('candidate-checks')).toContainText('全部检查通过', { timeout: 180_000 });
  await expect(page.getByTestId('check-error')).toContainText('证据无法读取', { timeout: 120_000 });
  expect(await page.getByTestId('candidate-checks').innerText(), '被篡改的内容进了界面').not.toContain('tampered build log');
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(true);
});

test('mock：adopt 返回 409 CHECKS_NOT_PASSED —— 关绿灯、给准确文案、不自动再采用', async ({ page }) => {
  await openStudio(page);
  const candidate = await localCandidate(page, '把首屏文案改成“采用被拒”', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。');
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('check-run-status')).toContainText('全部检查通过', { timeout: 300_000 });
  await expect(page.getByTestId('candidate-checks').locator('[data-evidence-ready="true"]')).toHaveCount(1, { timeout: 120_000 });

  let adopts = 0;
  await page.route(`**/candidates/${candidate.id}/adopt`, async (route) => {
    adopts += 1;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'CHECKS_NOT_PASSED', message: '检查未通过或证明已失效' } }) });
  });
  await page.getByTestId('candidate-adopt').click();
  await expect(page.getByTestId('candidate-action-error')).toContainText('检查未通过或证明已失效', { timeout: 60_000 });
  expect(adopts, '采用被拒后被自动重试了').toBe(1);
  await page.waitForTimeout(1_000);
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '采用被 409 拒后按钮又亮了').toBe(true);
  writeArtifact('m3c-mock-adopt-changed-proof.json', { adopts, gateReason: await page.getByTestId('candidate-gate-reason').innerText() });
});

test('mock：startChecks 返回 409 STALE_CANDIDATE —— 提示重新生成，关掉运行/重跑与采用', async ({ page }) => {
  await openStudio(page);
  const candidate = await localCandidate(page, '把首屏文案改成“候选过期”', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。');
  await page.route(`**/candidates/${candidate.id}/checks`, (route) => route.fulfill({
    status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STALE_CANDIDATE', message: '候选内容或主作品已变化' } }),
  }));
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('candidate-action-error')).toContainText('候选内容或主作品已变化，请重新生成候选', { timeout: 60_000 });
  await expect(page.getByTestId('check-run')).toBeDisabled({ timeout: 60_000 });
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(true);
});

test('mock：恶意 reason/evidence 按文本渲染，不执行、不注入 DOM', async ({ page }) => {
  await openStudio(page);
  const { card } = await createAwaitingCard(page);
  const list = await api.listApprovals().then((result) => result.body);
  const approvalId = await card.getAttribute('data-approval-id');
  const evil = list.map((item) => item.id === approvalId
    ? { ...item, reason: '<img src=x onerror="window.__xss=1">理由', evidence: ['<script>window.__xss=2</script>', '<svg onload="window.__xss=3"/>'] }
    : item);
  await page.route('**/approvals', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(evil) })
    : route.continue());
  await page.getByTestId('state-refresh').click();

  await expect(card).toContainText('<img src=x onerror=', { timeout: 60_000 });
  await expect(card).toContainText('<script>window.__xss=2</script>');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), '恶意文本被执行了').toBeUndefined();
  expect(await card.locator('img[src="x"]').count(), '恶意 <img> 真的进了 DOM').toBe(0);
  expect(await card.locator('script').count()).toBe(0);
  // 卡片仍是可操作的真实请示（注入不改权限）
  await expect(card).toHaveAttribute('data-status', 'pending');
});
