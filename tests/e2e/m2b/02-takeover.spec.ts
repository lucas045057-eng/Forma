import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route, type WebSocketRoute } from '@playwright/test';
import {
  adoptCandidate, discardCandidate, ensureChecksPassed, getCandidate, getScene, getVersion, history, http, listCandidates, listTasks,
  previewFrameSafe, putScene, resetMock, restoreTemplate, revertVersion, setScript, submitTask, wait, waitFor, waitForTask,
} from '../m2a/api';
import { BACKEND_BASE, STUDIO_PORT, TEMPLATE_APP, WORK_ROOT } from '../m2a/env';
import { writeArtifactFrom } from './artifact';

/**
 * 接管后专项（M2 收口，最终冻结 HEAD b167907）：
 * 1) 先核实 STALE_SELECTION 的实际 selection.src/baseVersion 与文件 hash，再判定是否有实现缺陷；
 * 2) 断线补拉、历史截断重载、三个待定候选切换、多面板共用一条事件连接；
 * 3) R1 版本请求延迟/失败期间的按钮、快捷键与 retry（retry 的 submittable 门禁已在 b167907 合入，按普通断言验收）。
 */

const BUTTON = path.join(WORK_ROOT, 'src', 'components', 'Button.tsx');
const STUDIO_ORIGIN = `http://127.0.0.1:${STUDIO_PORT}`;
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

const SUCCESS = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: '已把首屏购买按钮改成“马上购买”' } }],
];

async function gotoStudio(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
}

function trackTaskPosts(page: Page) {
  const bodies: string[] = [];
  const responses: Array<{ status: number; body: string }> = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') bodies.push(request.postData() ?? '');
  });
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/tasks') {
      void response.text().then((body) => responses.push({ status: response.status(), body })).catch(() => {});
    }
  });
  return { bodies, responses };
}

async function pickElement(page: Page, testId: string): Promise<void> {
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

/** 与 pickElement 相同，但版本请求被 gate 挂住：只等到 pending，不要求 selection-json。 */
async function pickWhileHeld(page: Page, testId: string): Promise<void> {
  await page.getByTestId('pick-toggle').click();
  const frame = await previewFrameSafe(page);
  const target = frame.locator(`[data-testid="${testId}"]`).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`找不到元素 ${testId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'pending', { timeout: 20_000 });
  await page.getByTestId('pick-toggle').click();
}

/** 只拦 Studio 自己（5173）的 GET /version，初始加载稳定后再 arm；命中一次后挂起。 */
async function versionGate(page: Page) {
  const held: Route[] = [];
  const seen: string[] = [];
  let armed = false;
  const predicate = (url: URL) => url.port === String(STUDIO_PORT) && url.pathname === '/version';
  const handler = async (route: Route) => {
    seen.push(route.request().url());
    if (armed && held.length === 0) { armed = false; held.push(route); return; }
    await route.continue().catch(() => {});
  };
  await page.route(predicate, handler);
  return {
    seen,
    held,
    arm() { armed = true; },
    async release(version: string) {
      const route = held.shift();
      if (!route) throw new Error('没有挂起的版本请求可释放');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version }) });
    },
    async fail(code: 'failed' | 'aborted' = 'failed') {
      const route = held.shift();
      if (!route) throw new Error('没有挂起的版本请求可失败');
      await route.abort(code);
    },
    dispose: () => page.unroute(predicate, handler),
  };
}

/** 事件 WebSocket 用 Playwright 的 WS 路由完全接管：不发 ready 就不会补拉，用来制造确定性的断线窗口。 */
async function mockEventsSocket(page: Page) {
  const sockets: WebSocketRoute[] = [];
  const predicate = (url: URL) => url.port === String(STUDIO_PORT) && url.pathname === '/events';
  await page.routeWebSocket(predicate, (socket) => { sockets.push(socket); });
  return {
    sockets,
    sendReady(seq: number) {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('还没有可用的 /events WS 连接');
      socket.send(JSON.stringify({ type: 'ready', seq, oldest: 1 }));
    },
    /** page 关闭时路由自带清理；这里只把当前客户端 socket 关掉，避免测试尾部继续重连。 */
    async dispose() {
      for (const socket of sockets) await socket.close({ code: 1000, reason: 'test done' }).catch(() => {});
    },
  };
}

test.describe('M2-B 接管后专项', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('STALE 事实：选中文件自身变化 → 409 + 界面提示重新点选；重新点选后可提交', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const { bodies, responses } = trackTaskPosts(page);
    await gotoStudio(page);

    const versionAtPick = (await getVersion()).body.version;
    const before = { button: sha(BUTTON), app: sha(TEMPLATE_APP) };
    await pickElement(page, 'buy-button');
    const selection = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
    const facts: Record<string, unknown> = {
      head: versionAtPick,
      selectionRaw: selection,
      versionAtPick,
      hashesBefore: before,
    };
    expect(String(selection.src), '选中对象必须是 Button.tsx，而不是 App.tsx').toMatch(/^src\/components\/Button\.tsx:\d+:\d+$/);
    expect(selection.baseVersion).toBe(versionAtPick);

    // 只改被选中的那个文件（不是祖先 App.tsx）
    appendFileSync(BUTTON, '\n// stale-probe: same selected file edited after pick\n', 'utf8');
    facts.hashesAfter = { button: sha(BUTTON), app: sha(TEMPLATE_APP) };
    expect((facts.hashesAfter as Record<string, string>).button).not.toBe(before.button);
    expect((facts.hashesAfter as Record<string, string>).app).toBe(before.app);
    await expect(page.getByTestId('pick-state'), '改文件后界面不应把选中对象丢掉').toHaveAttribute('data-kind', 'ready');
    facts.pickStateAfterEdit = await page.getByTestId('pick-state').getAttribute('data-kind');

    await page.getByTestId('instruction-input').fill('把按钮文字改一下');
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-action-error')).toContainText('重新点选', { timeout: 30_000 });
    await waitFor(() => responses.length > 0, 15_000, 100);
    const submitted = bodies.at(-1) ? JSON.parse(bodies.at(-1)!) : null;
    facts.sameFile = {
      postedSelection: submitted?.selection,
      status: responses[0].status,
      code: JSON.parse(responses[0].body || '{}')?.error?.code,
      uiPrompt: await page.getByTestId('task-action-error').innerText(),
      versionAfterSnapshot: (await getVersion()).body.version,
    };
    expect(submitted?.selection?.src).toBe(selection.src);
    expect(submitted?.selection?.baseVersion, '客户端携带的旧 baseVersion 不应被快照改写').toBe(selection.baseVersion);
    expect(responses[0].status).toBe(409);
    expect(JSON.parse(responses[0].body).error.code).toBe('STALE_SELECTION');
    expect((facts.sameFile as Record<string, unknown>).versionAfterSnapshot).not.toBe(versionAtPick);

    // 重新点选后应拿到新版本并可正常提交
    await pickElement(page, 'buy-button');
    const repicked = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
    expect(repicked.baseVersion).not.toBe(versionAtPick);
    await page.getByTestId('instruction-input').fill('把首屏按钮改成“马上购买”');
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    facts.repick = { baseVersion: repicked.baseVersion, status: 'done' };

    writeArtifactFrom('takeover-stale-same-file.json', facts);
    for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
      await discardCandidate(candidate.id);
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('STALE 事实：只改其他文件（App.tsx，选中仍是 Button.tsx）→ 允许提交并产出候选', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    await gotoStudio(page);

    const versionAtPick = (await getVersion()).body.version;
    const before = { button: sha(BUTTON), app: sha(TEMPLATE_APP) };
    await pickElement(page, 'buy-button');
    const selection = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
    expect(String(selection.src)).toMatch(/^src\/components\/Button\.tsx:\d+:\d+$/);
    expect(selection.baseVersion).toBe(versionAtPick);

    appendFileSync(TEMPLATE_APP, '\n// stale-probe: different file edited after pick\n', 'utf8');
    const after = { button: sha(BUTTON), app: sha(TEMPLATE_APP) };
    expect(after.app).not.toBe(before.app);
    expect(after.button).toBe(before.button);

    const raw = {
      instruction: '把首屏按钮改成“马上购买”（选中后只改了 App.tsx）',
      selection,
    };
    const submitted = await http(`${BACKEND_BASE}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(raw),
    });
    const facts: Record<string, unknown> = {
      head: versionAtPick,
      selectionRaw: selection,
      postedSelection: JSON.parse(JSON.stringify(raw.selection)),
      hashesBefore: before,
      hashesAfter: after,
      status: submitted.status,
      taskStatus: null,
      versionAfter: null,
      candidate: null,
    };
    expect(submitted.status, `不同文件变化不应 409：${submitted.text}`).toBe(202);
    const task = await waitForTask(submitted.body.id);
    const versionAfter = (await getVersion()).body.version;
    const candidate = (await listCandidates()).body.find((item) => item.id === task.candidateId);
    facts.taskStatus = task.status;
    facts.versionAfter = versionAfter;
    facts.candidate = candidate ? { id: candidate.id, baseVersion: candidate.baseVersion, diff: candidate.diff.map((file) => file.path) } : null;

    expect(task.status).toBe('done');
    expect(versionAfter, '快照应把被改的 App.tsx 收进新版本').not.toBe(versionAtPick);
    expect((raw.selection as Record<string, unknown>).baseVersion, '快照不应改写客户端携带的 baseVersion').toBe(versionAtPick);
    expect(candidate?.baseVersion).toBe(versionAfter);
    expect(candidate?.diff.map((file) => file.path)).toContain('src/App.tsx');

    writeArtifactFrom('takeover-stale-different-file.json', facts);
    if (candidate) await discardCandidate(candidate.id);
    expect(restoreTemplate().clean).toBe(true);
  });

  test('R1：第二次点选的版本请求未返回期间，按钮与快捷键都不能提交', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const { bodies } = trackTaskPosts(page);
    await gotoStudio(page);

    await pickElement(page, 'buy-button');
    const first = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
    const version = (await getVersion()).body.version;
    const tasksBefore = (await listTasks()).body.length;

    const gate = await versionGate(page);
    gate.arm();
    try {
      await pickWhileHeld(page, 'save-button');
      await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'pending');
      expect(await page.getByTestId('selection-json').count(), '等待版本期间旧选中对象必须立刻失效').toBe(0);
      await expect(page.getByTestId('generate-candidate')).toBeDisabled();

      await page.getByTestId('instruction-input').fill('快捷键不应该把旧对象提交出去');
      await page.getByTestId('instruction-input').press('Control+Enter');
      await wait(1200);
      expect(bodies.length, '等待版本期间快捷键提交了任务').toBe(0);
      expect((await listTasks()).body.length).toBe(tasksBefore);
      expect(gate.held.length).toBe(1);

      await gate.release(version);
      await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
      const second = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
      expect(second.baseVersion).toBe(version);
      await expect(page.getByTestId('generate-candidate')).toBeEnabled();

      writeArtifactFrom('takeover-r1-pending.json', {
        first: { src: first.src, cid: first.cid, baseVersion: first.baseVersion },
        second: { src: second.src, cid: second.cid, baseVersion: second.baseVersion },
        version, pendingTasksPosted: bodies.length, tasksBefore, tasksAfter: (await listTasks()).body.length,
        versionRequestsSeen: gate.seen.length,
      });
    } finally {
      if (gate.held.length) await gate.release(version).catch(() => {});
      await gate.dispose();
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('R1：第二次点选的版本请求失败期间同样禁止提交，重新点选可恢复', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const { bodies } = trackTaskPosts(page);
    await gotoStudio(page);

    await pickElement(page, 'buy-button');
    const first = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
    const tasksBefore = (await listTasks()).body.length;

    const gate = await versionGate(page);
    gate.arm();
    try {
      await pickWhileHeld(page, 'buy-button');
      await gate.fail('failed');
      await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'failed', { timeout: 20_000 });
      const failedPrompt = await page.getByTestId('pick-state').innerText();
      expect(failedPrompt, '失败提示没有要求重新点选').toContain('重新点选');
      expect(await page.getByTestId('selection-json').count()).toBe(0);
      await expect(page.getByTestId('generate-candidate')).toBeDisabled();

      await page.getByTestId('instruction-input').fill('读取版本失败时不该提交');
      await page.getByTestId('instruction-input').press('Control+Enter');
      await wait(1200);
      expect(bodies.length, '读取版本失败期间快捷键提交了任务').toBe(0);
      expect((await listTasks()).body.length).toBe(tasksBefore);

      await gate.dispose();
      await pickElement(page, 'buy-button');
      await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
      const repicked = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
      await expect(page.getByTestId('generate-candidate')).toBeEnabled();

      writeArtifactFrom('takeover-r1-failed.json', {
        first: { src: first.src, cid: first.cid },
        failedPrompt,
        prompt: await page.getByTestId('pick-state').innerText(),
        repicked: { src: repicked.src, cid: repicked.cid, baseVersion: repicked.baseVersion },
        failedTasksPosted: bodies.length, tasksBefore, tasksAfter: (await listTasks()).body.length,
      });
    } finally {
      await gate.dispose();
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('R1：retry 在 pending/failed 期间也不得提交', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 0, 'error');
    await gotoStudio(page);

    await page.getByTestId('instruction-input').fill('一个会失败的任务');
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'failed', { timeout: 90_000 });
    await expect(page.getByTestId('task-retry')).toBeVisible();

    await pickElement(page, 'buy-button');
    const version = (await getVersion()).body.version;
    const gate = await versionGate(page);
    gate.arm();
    const facts: Record<string, unknown> = {};
    try {
      await pickWhileHeld(page, 'buy-button');
      facts.retryDisabledWhilePending = await page.getByTestId('task-retry').isDisabled();
      expect.soft(facts.retryDisabledWhilePending, 'pending 期间 retry 仍可点击').toBe(true);

      await gate.fail('failed');
      await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'failed', { timeout: 20_000 });
      facts.retryDisabledWhileFailed = await page.getByTestId('task-retry').isDisabled();
      expect.soft(facts.retryDisabledWhileFailed, 'failed 期间 retry 仍可点击').toBe(true);
    } finally {
      writeArtifactFrom('takeover-r1-retry.json', facts);
      if (gate.held.length) await gate.release(version).catch(() => {});
      await gate.dispose();
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('断线重连：断开期间采用候选，重连后补拉历史并更新界面', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const task = await waitForTask((await submitTask('先生成一个候选，供断线期间采用')).body.id);
    expect(task.status).toBe('done');
    const candidateId = task.candidateId!;
    const socketMock = await mockEventsSocket(page);
    try {
      await page.goto('/');
      await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
      const opened = (await history(0)).body;
      socketMock.sendReady(opened.current);
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(page.getByTestId('events-seq')).toHaveText(String(opened.current), { timeout: 20_000 });

      const historyRequests: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.port === String(STUDIO_PORT) && url.pathname === '/events/history') historyRequests.push(request.url());
      });

      await socketMock.sockets.at(-1)!.close();
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });

      // M3-B：采用前先跑真实检查并等本次 run 终态（断线补拉仍由真实事件驱动）
      expect((await ensureChecksPassed(candidateId)).outcome).toBe('passed');
      const adopted = await adoptCandidate(candidateId);
      expect(adopted.status, adopted.text).toBe(200);
      const versionAfterAdopt = adopted.body.version as string;
      const caught = (await history(0)).body;
      expect(caught.current).toBeGreaterThan(opened.current);

      await waitFor(() => socketMock.sockets.length >= 2, 20_000, 200);
      socketMock.sendReady(caught.current);
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
      await expect(page.getByTestId('events-seq')).toHaveText(String(caught.current), { timeout: 20_000 });
      await expect(page.getByTestId('work-version')).toContainText(versionAfterAdopt.slice(0, 10), { timeout: 20_000 });
      expect(historyRequests.some((url) => url.includes(`since=${opened.current}`)), '没有从断线前序号补拉').toBe(true);

      writeArtifactFrom('takeover-events-reconnect.json', {
        startSeq: opened.current,
        currentAfterAdopt: caught.current,
        versionAfterAdopt,
        historyRequests: historyRequests.slice(-4),
        eventsSeqText: await page.getByTestId('events-seq').innerText(),
        workVersionText: await page.getByTestId('work-version').innerText(),
        candidateStillPending: (await listCandidates()).body.some((item) => item.id === candidateId && item.decision === 'pending'),
      });
    } finally {
      await socketMock.dispose();
      await revertVersion().catch(() => {});
      for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
        await discardCandidate(candidate.id).catch(() => {});
      }
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('历史截断：补拉返回 truncated 时整体重载任务/候选/版本', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const first = await waitForTask((await submitTask('候选 A')).body.id);
    expect(first.status).toBe('done');
    const socketMock = await mockEventsSocket(page);
    try {
      await page.goto('/');
      await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
      const opened = (await history(0)).body;
      socketMock.sendReady(opened.current);
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
      await expect(page.getByTestId('candidate-select').locator('option')).toHaveCount(1, { timeout: 30_000 });

      await socketMock.sockets.at(-1)!.close();
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });

      const second = await waitForTask((await submitTask('候选 B')).body.id);
      expect(second.status).toBe('done');
      const caught = (await history(0)).body;
      expect(caught.current).toBeGreaterThan(opened.current);

      const reloadRequests: string[] = [];
      const track = (request: { url(): string }) => {
        const url = new URL(request.url());
        if (url.port === String(STUDIO_PORT) && ['/tasks', '/candidates', '/version'].includes(url.pathname)) reloadRequests.push(url.pathname);
      };
      page.on('request', track);
      const historySeen: string[] = [];
      const routePredicate = (url: URL) => url.port === String(STUDIO_PORT) && url.pathname === '/events/history';
      const routeHandler = async (route: Route) => {
        historySeen.push(route.request().url());
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ events: [], current: caught.current, oldest: caught.current + 50, truncated: true }),
        });
      };
      await page.route(routePredicate, routeHandler);
      try {
        await waitFor(() => socketMock.sockets.length >= 2, 20_000, 200);
        socketMock.sendReady(caught.current);
        await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
        await expect(page.getByTestId('events-seq')).toHaveText(String(caught.current), { timeout: 20_000 });
        await expect(page.getByTestId('candidate-select').locator('option')).toHaveCount(2, { timeout: 30_000 });
        const options = await page.getByTestId('candidate-select').locator('option').allInnerTexts();
        expect(options.join('\n')).toContain(second.candidateId!.slice(0, 8));
        expect(reloadRequests, 'truncated 后没有整体重载').toEqual(expect.arrayContaining(['/tasks', '/candidates', '/version']));

        writeArtifactFrom('takeover-events-truncated.json', {
          startSeq: opened.current,
          currentAfterSecond: caught.current,
          truncatedHistoryRequests: historySeen,
          reloadRequests,
          candidateOptions: options,
          eventsSeqText: await page.getByTestId('events-seq').innerText(),
        });
      } finally {
        await page.unroute(routePredicate, routeHandler);
      }
    } finally {
      await socketMock.dispose();
      for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
        await discardCandidate(candidate.id).catch(() => {});
      }
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('三个待定候选在界面切换，标识与预览内容一一对应', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    const specs = [
      { text: '马上购买甲', script: '甲' },
      { text: '马上购买乙', script: '乙' },
      { text: '马上购买丙', script: '丙' },
    ];
    const created: Array<{ id: string; text: string; previewUrl: string; baseVersion: string }> = [];
    for (const spec of specs) {
      await setScript([
        [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
        [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: spec.text } }],
        [{ name: 'finish', args: { summary: `候选${spec.script}` } }],
      ]);
      const task = await waitForTask((await submitTask(`生成候选${spec.script}`)).body.id);
      expect(task.status, JSON.stringify(task.error)).toBe('done');
      const candidate = (await getCandidate(task.candidateId!)).body;
      created.push({ id: candidate.id, text: spec.text, previewUrl: candidate.previewUrl, baseVersion: candidate.baseVersion });
    }
    try {
      await gotoStudio(page);
      const select = page.getByTestId('candidate-select');
      await expect(select.locator('option')).toHaveCount(3, { timeout: 30_000 });
      const switched: Array<{ id: string; text: string; frameSrc: string | null }> = [];
      for (const candidate of created) {
        await select.selectOption(candidate.id);
        const frame = page.frameLocator('[data-testid="candidate-frame"]');
        await expect(frame.locator('[data-testid="buy-button"]')).toHaveText(candidate.text, { timeout: 90_000 });
        const frameSrc = await page.locator('[data-testid="candidate-frame"]').getAttribute('src');
        expect(frameSrc, '候选 iframe 地址与所选候选不一致').toContain(candidate.previewUrl);
        const title = await page.locator('[data-testid="candidate-frame"]').getAttribute('title');
        expect(title).toContain(candidate.id.slice(0, 8));
        switched.push({ id: candidate.id, text: await frame.locator('[data-testid="buy-button"]').innerText(), frameSrc });
      }
      await expect(page.getByTestId('candidate-details')).toContainText('待定候选 3/3');
      writeArtifactFrom('takeover-candidates-switch.json', { created, switched });
    } finally {
      for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
        await discardCandidate(candidate.id).catch(() => {});
      }
    }
    expect(restoreTemplate().clean).toBe(true);
  });

  test('多面板共用一条事件连接：3D 场景与 3D 资产同时打开仍只有一个 WS', async ({ page }) => {
    expect(restoreTemplate().clean).toBe(true);
    await resetMock();
    await setScript(SUCCESS);
    const sockets: string[] = [];
    page.on('websocket', (socket) => sockets.push(socket.url()));
    await gotoStudio(page);
    const eventSockets = () => sockets.filter((url) => new URL(url.replace(/^ws/, 'http')).pathname === '/events').length;
    expect(eventSockets(), '初始事件连接数不是 1').toBe(1);
    const beforeSeq = Number(await page.getByTestId('events-seq').innerText());

    await page.getByTestId('scene-open').click();
    await expect(page.getByTestId('scene-panel')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('asset-open').click();
    await expect(page.getByTestId('asset-close')).toBeVisible({ timeout: 60_000 });
    await wait(800);
    expect(eventSockets(), '打开面板后新建了事件连接').toBe(1);

    const scene = (await getScene()).body;
    const next = structuredClone(scene);
    next.hero.camera.fov = Math.min(60, Number(scene.hero.camera.fov) + 2);
    expect((await putScene(next)).status).toBe(200);
    await waitFor(async () => Number(await page.getByTestId('events-seq').innerText()) > beforeSeq, 20_000, 200);
    await expect(page.getByTestId('scene-config')).toContainText(String(next.hero.camera.fov), { timeout: 20_000 });
    const sceneConfigText = (await page.getByTestId('scene-config').textContent()) ?? '';
    const sceneConfigMirrored = sceneConfigText.includes(String(next.hero.camera.fov));
    const seqAfter = Number(await page.getByTestId('events-seq').innerText());

    await page.getByTestId('asset-close').click();
    await page.getByTestId('scene-close').click();
    await wait(500);
    expect(eventSockets(), '关闭面板后事件连接数变了').toBe(1);

    writeArtifactFrom('takeover-single-connection.json', {
      sockets,
      eventSockets: eventSockets(),
      seqBefore: beforeSeq,
      seqAfter,
      sceneFov: next.hero.camera.fov,
      sceneConfigMirrored,
    });
    expect(restoreTemplate().clean).toBe(true);
  });
});
