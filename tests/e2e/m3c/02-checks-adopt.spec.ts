import { expect, test, type Page } from '@playwright/test';
import * as api from '../m2a/api';
import { writeArtifact } from './artifact';
import { BACKEND_BASE } from './env';
import { checkRun } from './support';
import {
  cleanup, countRequests, dropSockets, ensurePicked, gateReason, mainFrame, openStudio,
  overlayTotal, pendingCandidates, selectionText, waitCandidate, waitChecksPassed, waitEvidenceReady,
} from './support';

/**
 * M3-C real UI · 真实检查、证据与采用门禁（C2 + C3）
 *
 * 全部走真实四检查运行器（build/smoke/occlusion 真的跑）、真实六份产物读取与 hash 校验、
 * 真实采用/回退（后端在锁内终裁）。模型仍是 loopback mock。
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => { expect(api.restoreTemplate().clean).toBe(true); });
test.afterEach(async () => { await cleanup(); });
test.afterAll(() => { expect(api.restoreTemplate().clean).toBe(true); });

/** 用“局部文案改动”造一个待定候选（不触发请示，候选直接出现）。 */
async function localCandidate(page: Page, instruction = '把首屏文案改掉', old = '一份给自己，也给生活的温柔礼物。', next = '给自己一份安静的礼物。') {
  await api.resetMock();
  await api.setScript([[{ name: 'replace_in_file', args: { path: 'src/App.tsx', old, new: next } }], [{ name: 'finish', args: { summary: '局部文案已修改' } }]] as never);
  // 必须先选一个 App.tsx 内的元素：无选取的提交算整页/越范围，会先请示，拿不到“无请示的局部改动”。
  await ensurePicked(page);
  const taskId = await (async () => {
    const [response] = await Promise.all([
      page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/tasks', { timeout: 30_000 }),
      (async () => {
        await page.getByTestId('instruction-input').fill(instruction);
        await page.getByTestId('generate-candidate').click();
      })(),
    ]);
    expect(response.status()).toBe(202);
    return (await response.json() as { id: string }).id;
  })();
  await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 180_000 });
  await waitCandidate(page);
  const candidate = (await api.listCandidates()).body.find((item) => item.taskId === taskId);
  expect(candidate, '任务没有产出候选').toBeTruthy();
  return { taskId, candidate: candidate!, instruction };
}

test('真实四检查：只发一次 POST body={}，四项通过，六份证据可读，候选 iframe 不参与选取', async ({ page }) => {
  await openStudio(page);
  const { candidate } = await localCandidate(page);

  await expect(page.getByTestId('check-run-status')).toContainText('未检查');
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(true);
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('尚未运行检查');

  const posts = countRequests(page, 'POST', (path) => path.endsWith('/checks'));
  const bodies: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/checks')) bodies.push(request.postData() ?? '');
  });
  await page.getByTestId('check-run').click();

  const runId = await expect.poll(async () => (await page.getByTestId('check-run-status').getAttribute('data-run-id')) ?? '', { timeout: 60_000 }).not.toBe('');
  void runId;
  const started = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;
  expect(posts.count(), '首次检查发了不止一次 POST').toBe(1);
  expect(JSON.parse(bodies[0] ?? 'null'), '首次检查的请求体不是 {}').toEqual({});

  await waitChecksPassed(page);
  const items = await page.getByTestId('check-item').evaluateAll((nodes) => nodes.map((node) => ({
    name: node.getAttribute('data-check-name'), status: node.getAttribute('data-status'),
  })));
  expect(items.map((item) => item.name)).toEqual(['schema', 'build', 'smoke', 'occlusion']);
  expect(items.every((item) => item.status === 'passed'), `四项没有全部通过：${JSON.stringify(items)}`).toBe(true);

  await waitEvidenceReady(page);
  const links = await page.getByTestId('check-evidence').evaluateAll((nodes) => nodes.map((node) => ({
    runId: node.getAttribute('data-run-id'), name: node.getAttribute('data-artifact-name'),
    hash: node.getAttribute('data-hash'), href: node.getAttribute('href'), download: node.getAttribute('download'),
  })));
  expect(links).toHaveLength(6);
  expect(new Set(links.map((link) => link.name)).size, `六份证据名不唯一：${JSON.stringify(links.map((l) => l.name))}`).toBe(6);
  for (const link of links) {
    expect(link.runId).toBe(started);
    expect(link.href, `证据链接不是受限 API：${JSON.stringify(link)}`).toBe(`/checks/${started}/artifacts/${link.name}`);
    expect(link.hash, '证据 hash 未展示').toMatch(/^[a-f0-9]{64}$/);
    expect(link.download).toBe(link.name);
  }

  // 文本/JSON 在 <pre> 里，PNG 在 <img> 里；不执行、不内嵌 HTML
  await page.locator('details', { hasText: '查看 build.log' }).first().click();
  await expect(page.locator('pre', { hasText: 'vite' }).first(), '构建日志没有按文本渲染').toBeVisible({ timeout: 30_000 });

  const run = (await checkRun(started)).body;
  expect(run.outcome).toBe('passed');
  expect(run.checks.map((check: { status: string }) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);

  // 候选 iframe：不进入选取、不画 overlay、点击不改主 iframe 的 Selection
  const selectionBeforeCandidate = await selectionText(page);
  await page.getByTestId('preview-candidate').click();
  const candidateFrameElement = page.locator('[data-testid="candidate-frame"]');
  await expect(candidateFrameElement).toBeVisible({ timeout: 60_000 });
  const candidateFrame = await candidateFrameElement.elementHandle().then((handle) => handle?.contentFrame());
  expect(candidateFrame).toBeTruthy();
  await expect.poll(async () => overlayTotal(candidateFrame!), { timeout: 30_000 }).toBe(0);
  await candidateFrame!.locator('[data-testid="buy-button"]').first().click();
  await page.waitForTimeout(500);
  expect(await overlayTotal(candidateFrame!), '候选 iframe 被拖进了选取/高亮').toBe(0);
  expect(await selectionText(page), '候选 iframe 的点击改了主 iframe 的 Selection').toBe(selectionBeforeCandidate);

  writeArtifact('m3c-checks-passed.json', {
    candidateId: candidate.id, runId: started, requestBody: JSON.parse(bodies[0] ?? 'null'),
    postCount: posts.count(), checks: items, evidence: links,
    backendOutcome: run.outcome, backendStatuses: run.checks.map((check: { status: string }) => check.status),
  });
});

test('采用门禁与采用：证据未就绪前 disabled，六证据就绪后可采用并切换作品', async ({ page }) => {
  await openStudio(page);
  const before = (await api.getVersion()).body.version;
  const { candidate } = await localCandidate(page, '把首屏文案改成“给自己的一份礼物”', '一份给自己，也给生活的温柔礼物。', '给自己的一份礼物');

  await page.getByTestId('check-run').click();
  await waitChecksPassed(page);
  await waitEvidenceReady(page);

  const reason = await gateReason(page);
  expect(reason, `门禁原因不该再是禁用：${reason}`).toContain('服务器最终核对');
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '六证据就绪后采用仍被禁用').toBe(false);

  // 采用前先记录：证据链接只在受限 API 上，hash 与后端一致
  const link = page.getByTestId('check-evidence').first();
  const hash = await link.getAttribute('data-hash');
  const artifactName = await link.getAttribute('data-artifact-name');
  const runId = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;

  await page.getByTestId('candidate-adopt').click();
  await expect.poll(async () => (await api.getVersion()).body.version, { timeout: 120_000 }).not.toBe(before);
  const frame = await mainFrame(page);
  await expect(frame.locator('.fine-print')).toContainText('给自己的一份礼物', { timeout: 60_000 });
  await expect(page.getByTestId('candidate-select')).toHaveCount(0, { timeout: 60_000 });

  const after = (await api.getVersion()).body.version;
  const candidateAfter = (await api.getCandidate(candidate.id)).body;
  writeArtifact('m3c-adopt.json', {
    candidateId: candidate.id, runId, versionBefore: before, versionAfter: after,
    decision: candidateAfter.decision, evidenceSample: { name: artifactName, hash },
  });
  expect(candidateAfter.decision).toBe('adopted');
  expect((await api.revertVersion()).status, '回退失败').toBe(200);
});

test('显式重新检查：body 为 {rerun:true}，旧绿灯立即关闭，新 run 通过后才恢复', async ({ page }) => {
  await openStudio(page);
  await localCandidate(page, '把首屏文案改成“安静的礼物”');

  await page.getByTestId('check-run').click();
  await waitChecksPassed(page);
  await waitEvidenceReady(page);
  const firstRun = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(false);

  const bodies: string[] = [];
  const posts = countRequests(page, 'POST', (path) => path.endsWith('/checks'));
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/checks')) bodies.push(request.postData() ?? '');
  });
  await page.getByTestId('check-rerun').click();
  // 旧证明立刻不可用于采用（不能靠上一个 run 的绿灯）
  await expect(page.getByTestId('candidate-adopt')).toBeDisabled({ timeout: 30_000 });
  await expect.poll(async () => posts.count(), { timeout: 60_000 }).toBe(1);
  expect(JSON.parse(bodies[0] ?? 'null'), '重新检查的请求体不是 {rerun:true}').toEqual({ rerun: true });

  await waitChecksPassed(page);
  await waitEvidenceReady(page);
  const secondRun = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;
  expect(secondRun, '重新检查没有产生新的 run').not.toBe(firstRun);
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(false);
  writeArtifact('m3c-checks-rerun.json', { firstRun, secondRun, requestBody: JSON.parse(bodies[0] ?? 'null'), postCount: posts.count() });
});

test('取消检查：running 时取消只作用于该 run，未运行项不变绿，不能采用', async ({ page }) => {
  await openStudio(page);
  await localCandidate(page, '把首屏文案改成“取消检查用”');
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('check-run-status')).not.toHaveAttribute('data-run-id', '', { timeout: 60_000 });
  const runId = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;

  const cancels = countRequests(page, 'POST', (path) => path.endsWith('/cancel'));
  await expect(page.getByTestId('check-cancel')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('check-cancel').click();
  await expect.poll(async () => (await checkRun(runId)).body.status, { timeout: 120_000 }).toBe('cancelled');
  await expect(page.getByTestId('check-run-status')).toContainText('检查已取消', { timeout: 60_000 });

  const statuses = await page.getByTestId('check-item').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
  // 设计语义：取消后保留已完成项（可能已有 passed），但**不能因此变成可采用**。
  expect(statuses.some((status) => status === 'not_run') || statuses.every((status) => status === 'passed'), `取消后的四项状态异常：${JSON.stringify(statuses)}`).toBe(true);
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '取消后采用被放开了').toBe(true);
  expect(cancels.count(), '取消请求发了不止一次').toBe(1);
});

test('三候选与多 run 切换：状态与证据按候选隔离，迟到的旧 run 不覆盖当前候选', async ({ page }) => {
  await openStudio(page);
  const one = await localCandidate(page, '把首屏文案改成“候选一”', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。');
  const two = await localCandidate(page, '把首屏文案改成“候选二”', '立即购买', '马上购买');
  const three = await localCandidate(page, '把首屏文案改成“候选三”', '收藏香气', '先收藏');

  const select = page.getByTestId('candidate-select');
  await expect(select.locator('option')).toHaveCount(3, { timeout: 60_000 });
  const ids = [one.candidate.id, two.candidate.id, three.candidate.id];

  // 在候选一上跑真实检查
  await select.selectOption(one.candidate.id);
  await page.getByTestId('check-run').click();
  // 先等本次 run 真的落到 UI（data-run-id 非空），再读 id，否则会拿到空串去拼 URL。
  await expect.poll(async () => (await page.getByTestId('check-run-status').getAttribute('data-run-id')) ?? '', { timeout: 60_000 }).not.toBe('');
  await expect.poll(async () => (await page.getByTestId('check-run-status').getAttribute('data-candidate-id')), { timeout: 30_000 }).toBe(one.candidate.id);
  const runId = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;

  // 切到候选二：必须显示它自己的“未检查”，不能串候选一的 run/证据
  await select.selectOption(two.candidate.id);
  await expect.poll(async () => (await page.getByTestId('check-run-status').getAttribute('data-candidate-id')), { timeout: 30_000 }).toBe(two.candidate.id);
  await expect(page.getByTestId('check-run-status')).toContainText('未检查');
  await expect(page.getByTestId('check-evidence')).toHaveCount(0);
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(true);

  // 等候选一的 run 完成（后端），再切回去：应当显示真实通过 + 证据就绪
  await expect.poll(async () => (await checkRun(runId)).body.status, { timeout: 300_000 }).toBe('completed');
  await select.selectOption(one.candidate.id);
  await waitChecksPassed(page);
  await waitEvidenceReady(page);
  const shownRun = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;
  expect(shownRun, '切回后显示的 run 不是候选一刚才那次').toBe(runId);

  // 候选三始终没有 run
  await select.selectOption(three.candidate.id);
  await expect(page.getByTestId('check-run-status')).toContainText('未检查');
  await expect(page.getByTestId('check-evidence')).toHaveCount(0);

  const pending = await pendingCandidates();
  writeArtifact('m3c-multi-candidate.json', {
    ids, runId, pending: pending.map((item: { id: string; latestCheckRunId?: string }) => ({ id: item.id, latestCheckRunId: item.latestCheckRunId ?? null })),
  });
});

test('断线跨检查完成：重连补拉后四项与证据就绪，不需要手动刷新', async ({ page }) => {
  await openStudio(page, { instrumentSockets: true });
  await localCandidate(page, '把首屏文案改成“断线检查”');

  await page.getByTestId('check-run').click();
  await expect.poll(async () => (await page.getByTestId('check-run-status').getAttribute('data-run-id')) ?? '', { timeout: 60_000 }).not.toBe('');
  const runId = (await page.getByTestId('check-run-status').getAttribute('data-run-id'))!;

  await dropSockets(page);
  await expect(page.getByTestId('events-status')).not.toHaveAttribute('data-status', 'connected', { timeout: 60_000 });

  await expect.poll(async () => (await checkRun(runId)).body.status, { timeout: 300_000 }).toBe('completed');
  await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 120_000 });
  await waitChecksPassed(page);
  await waitEvidenceReady(page);
});

test('采用另一个候选（version.changed）让旧候选的采用门禁立即失效', async ({ page }) => {
  await openStudio(page);
  const first = await localCandidate(page, '把首屏文案改成“第一候选”');
  const second = await localCandidate(page, '把首屏文案改成“第二候选”', '立即购买', '马上购买');
  expect(second.candidate.baseVersion).toBe(first.candidate.baseVersion);

  // 第一候选：真实检查 → 六证据 → 采用
  await page.getByTestId('candidate-select').selectOption(first.candidate.id);
  await page.getByTestId('check-run').click();
  await waitChecksPassed(page);
  await waitEvidenceReady(page);
  await page.getByTestId('candidate-adopt').click();
  await expect.poll(async () => (await api.getVersion()).body.version, { timeout: 120_000 }).not.toBe(first.candidate.baseVersion);

  // 第二候选：基线已过期 → 门禁直接说“证明已失效”，采用不可用
  expect((await api.listCandidates()).body.find((item: { id: string }) => item.id === second.candidate.id)?.decision).toBe('pending');
  await page.getByTestId('candidate-select').selectOption(second.candidate.id);
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('证明已失效', { timeout: 60_000 });
  expect(await page.getByTestId('candidate-adopt').isDisabled()).toBe(true);
  await expect(page.getByTestId('candidate-checks')).toContainText('历史检查结果 · 证明已失效');

  writeArtifact('m3c-version-changed.json', {
    first: first.candidate.id, second: second.candidate.id,
    versionAfterAdopt: (await api.getVersion()).body.version, gateReason: await gateReason(page),
  });
  expect((await api.revertVersion()).status, '回退失败').toBe(200);
});

test('M1 场景写回：写入落盘并使旧候选证明失效（采用仍关灯）', async ({ page }) => {
  await openStudio(page);
  const versionBefore = (await api.getVersion()).body.version;
  const { candidate } = await localCandidate(page, '把首屏文案改成“场景写回用”');

  const scene = (await api.getScene()).body;
  const written = structuredClone(scene);
  written.hero.lights.ambient = Number((scene.hero.lights.ambient + 0.5).toFixed(2));
  expect((await api.putScene(written)).status, 'M1 场景写回失败').toBe(200);
  const reread = (await api.getScene()).body;
  expect(reread.hero.lights.ambient, 'M1 写回没有真正落盘').toBe(written.hero.lights.ambient);

  // 实测（2026-11-15 定向自证）：场景写回会经作品快照产生新版本，旧候选的基线随即失效。
  // 之前“PUT /scene 不发 version.changed”的推断只看 scene/service.ts，漏了作品快照那一路；
  // 这里以真实界面/接口为准，不按旧推断写断言。
  const versionAfter = (await api.getVersion()).body.version;
  expect(versionAfter, '场景写回后作品版本没有变化').not.toBe(versionBefore);

  await page.getByTestId('state-refresh').click();
  await expect(page.getByTestId('candidate-gate-reason')).toContainText('证明已失效', { timeout: 60_000 });
  await expect(page.getByTestId('candidate-checks')).toContainText('历史检查结果 · 证明已失效');
  expect(await page.getByTestId('candidate-adopt').isDisabled(), '场景写回后旧候选的采用被放开了').toBe(true);
  expect((await api.listCandidates()).body.find((item: { id: string }) => item.id === candidate.id)?.decision, '候选被自动采用或关闭了').toBe('pending');

  writeArtifact('m3c-m1-scene-writeback.json', {
    versionBefore, versionAfter, gateReason: await gateReason(page),
    ambientAfter: reread.hero.lights.ambient, adoptDisabled: await page.getByTestId('candidate-adopt').isDisabled(),
  });
});
