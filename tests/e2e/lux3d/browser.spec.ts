import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { api, control, counters, resetFake, restoreWorkRoot, writeEvidence } from './support/api';
import { WORK_ROOT } from './env';
import { createTaskFromWorkbench, uploadAndRevealImage, type WorkbenchTask } from './support/workbench';

/** 真实浏览器：面板、拖图不云上传、点一次创建一次、跨 iframe 放置、外部文件与伪造消息被拦。 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

async function openWorkbench(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('asset-open').click();
  await expect(page.getByTestId('lux-workbench')).toBeVisible({ timeout: 60_000 });
}

async function uploadAndSelectImage(page: import('@playwright/test').Page) {
  const image = await uploadAndRevealImage(page);
  await image.check();
}

async function createAndWait(page: Page, request: APIRequestContext): Promise<WorkbenchTask> {
  return createTaskFromWorkbench(page, request, {
    label: 'browser-create',
    click: async () => {
      const create = page.getByTestId('lux-create');
      await expect(create).toBeEnabled({ timeout: 30_000 });
      await create.click();
    },
  });
}

test('面板打开：计费与公开链接说明可见，未发生任何云端调用', async ({ page }) => {
  await openWorkbench(page);
  await expect(page.getByText(/计费/).first()).toBeVisible();
  await expect(page.getByText(/公开/).first()).toBeVisible();
  const stats = await counters();
  expect(stats.token).toBe(0);
  expect(stats.creates).toBe(0);
  writeEvidence('browser-open.json', stats);
});

test('拖入图片只本地暂存：不上传云端、不创建', async ({ page }) => {
  await openWorkbench(page);
  await uploadAndRevealImage(page);
  const stats = await counters();
  expect(stats.token).toBe(0);
  expect(stats.ous.single + stats.ous.init + stats.ous.part).toBe(0);
  expect(stats.creates).toBe(0);
  writeEvidence('browser-drop-local.json', stats);
});

test('点一次创建一次：连点不产生第二次创建，任务可查看并给出原件下载', async ({ page, request }) => {
  await openWorkbench(page);
  await uploadAndSelectImage(page);
  // 连点保留：第二次点击不得产生第二次 create（helper 只捕获首个 POST 并绑定其 localId）。
  const binding = await createTaskFromWorkbench(page, request, {
    label: 'one-click-one-create',
    click: async () => {
      const create = page.getByTestId('lux-create');
      await expect(create).toBeEnabled({ timeout: 30_000 });
      await create.click();
      await create.click({ force: true }).catch(() => undefined);
    },
  });
  const stats = await counters();
  expect(stats.creates).toBe(1);
  const statsBeforeSessionRegression = stats;
  const assetId = binding.artifact.assetId;
  expect(typeof assetId).toBe('string');
  await expect(binding.card).toHaveCount(1);
  const routeLog = {
    requests: [] as Array<{ at: number; assetId: string | null; method: string }>,
    responses: [] as Array<{ at: number; sessionId: string | null; assetId: string | null; baseVersion: string | null; expiresAt: number | null; modified: boolean }>,
    errors: [] as string[],
  };
  let requestCount = 0;
  let secondExpiresAt = 0;
  let failure: unknown = null;
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    let body: { assetId?: unknown } | null = null;
    try { body = request.postDataJSON() as { assetId?: unknown }; } catch { return route.continue(); }
    if (!body || body.assetId !== assetId) return route.continue();
    requestCount += 1;
    const current = requestCount;
    routeLog.requests.push({ at: Date.now(), assetId: typeof body.assetId === 'string' ? body.assetId : null, method: request.method() });
    try {
      const real = await route.fetch();
      const json = await real.json() as { sessionId?: unknown; assetId?: unknown; baseVersion?: unknown; expiresAt?: unknown };
      let modified = false;
      let responseBody: { sessionId?: unknown; assetId?: unknown; baseVersion?: unknown; expiresAt?: unknown } = json;
      if (current === 1) {
        modified = true;
        responseBody = { ...json, expiresAt: Date.now() - 1 };
      } else if (current === 2) {
        modified = true;
        secondExpiresAt = Date.now() + 5_000;
        responseBody = { ...json, expiresAt: secondExpiresAt };
      }
      routeLog.responses.push({
        at: Date.now(), sessionId: typeof json.sessionId === 'string' ? json.sessionId : null,
        assetId: typeof json.assetId === 'string' ? json.assetId : null,
        baseVersion: typeof json.baseVersion === 'string' ? json.baseVersion : null,
        expiresAt: typeof responseBody.expiresAt === 'number' ? responseBody.expiresAt : null, modified,
      });
      const headers = { ...real.headers() };
      delete (headers as Record<string, string>)['content-length'];
      await route.fulfill({ status: real.status(), headers, body: JSON.stringify(responseBody) });
    } catch (error) {
      routeLog.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await route.abort('failed').catch(() => undefined);
    }
  };
  await page.route('**/assets/placements/sessions', handler);
  let finalStats = statsBeforeSessionRegression;
  try {
    // 第一次真实 hover：App 发现首响应已过期后，必须在同一次交互内重新请求；
    // 不允许额外第二次 hover 掩盖 App 缓存缺陷。
    await binding.card.hover();
    await expect.poll(() => requestCount, { timeout: 10_000 }).toBe(2);
    await expect.poll(() => routeLog.responses.length, { timeout: 10_000 }).toBe(2);
    await expect(binding.card, 'first hover must end with a live session').toHaveAttribute('draggable', 'true', { timeout: 10_000 });
    expect(routeLog.responses[0]?.expiresAt).toBeLessThanOrEqual(Date.now());
    expect(routeLog.responses[1]?.expiresAt).toBeGreaterThan(Date.now());
    expect(routeLog.responses[1]?.sessionId).toBeTruthy();
    expect(routeLog.responses[1]?.sessionId).not.toBe(routeLog.responses[0]?.sessionId);

    // 第二次响应用约 5s 短未来，等其自然过期；只做一次离开/回来 hover。
    const observedSecondExpiresAt = routeLog.responses[1]?.expiresAt;
    if (typeof observedSecondExpiresAt !== 'number') throw new Error('second session expiry missing');
    await expect.poll(() => Date.now() >= observedSecondExpiresAt, { timeout: 10_000, intervals: [25, 50, 100] }).toBe(true);
    await page.getByTestId('asset-open').hover();
    await binding.card.hover();
    await expect.poll(() => requestCount, { timeout: 10_000 }).toBe(3);
    await expect.poll(() => routeLog.responses.length, { timeout: 10_000 }).toBe(3);
    await expect(binding.card, 'one post-expiry hover must refresh the session').toHaveAttribute('draggable', 'true', { timeout: 10_000 });
    const sessionIds = routeLog.responses.map((item) => item.sessionId).filter((value): value is string => typeof value === 'string');
    expect(sessionIds.length).toBe(3);
    expect(new Set(sessionIds).size).toBe(3);
    expect(routeLog.responses[2]?.expiresAt).toBeGreaterThan(Date.now());

    finalStats = await counters();
    expect(finalStats.creates).toBe(1);
    await expect(binding.link).toHaveAttribute('href', binding.artifact.downloadUrl);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await page.unroute('**/assets/placements/sessions', handler).catch(() => undefined);
    try { finalStats = await counters(); } catch { /* keep last known stats */ }
    writeEvidence('browser-session-refresh-ui.json', { stats: finalStats, localId: binding.localId, assetId, routeLog, requestCount, failure: failure instanceof Error ? `${failure.name}: ${failure.message}` : failure === null ? null : String(failure) });
    writeEvidence('browser-one-click-one-create.json', { stats: finalStats, localId: binding.localId, failure: failure instanceof Error ? `${failure.name}: ${failure.message}` : failure === null ? null : String(failure) });
  }
});

test('主槽替换：放入网页 → iframe 内点击 3D 槽位 → 确认采用 → 撤回恢复', async ({ page, request }) => {
  await openWorkbench(page);
  await uploadAndSelectImage(page);
  const binding = await createAndWait(page, request);

  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  await binding.card.getByRole('button', { name: '放入网页' }).click();
  await expect(page.getByTestId('asset-placement')).toBeVisible({ timeout: 30_000 });

  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator('[data-testid="product-scene"]')).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => {
    await frame.locator('[data-testid="product-scene"]').click({ timeout: 5_000 }).catch(() => undefined);
    return await page.getByTestId('placement-target').count();
  }, { timeout: 120_000, intervals: [1_000] }).toBe(1);
  await expect(page.getByTestId('placement-target')).toContainText('替换');
  await page.getByTestId('placement-confirm').click();

  await expect.poll(async () => (await api<{ model: string }>(request, 'GET', '/scene')).body.model, { timeout: 120_000 }).not.toBe(before);
  const after = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  expect(after).toMatch(/^\/assets\/.+\.glb$/);
  const undo = await api(request, 'POST', '/scene/undo');
  expect(undo.status).toBe(200);
  const restored = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  expect(restored).toBe(before);

  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('browser-replace-slot.json', { before, after, restored });
});

test('外部文件拖入被拦、伪造 iframe 消息不能改主作品', async ({ page, request }) => {
  await page.goto('/');
  // 先等预览 iframe 真正挂载并渲染出目标场景，再取 Frame（iframe 导航期间 frame 列表里还没有 /preview/main/）。
  await expect(page.frameLocator('[data-testid="preview-frame"]').locator('[data-testid="product-scene"]')).toBeVisible({ timeout: 120_000 });
  const frame = page.frames().find((item) => item.url().includes('/preview/main/'));
  expect(frame, '预览 iframe 已挂载且 URL 为目标预览页').toBeTruthy();

  const url = page.url();
  await frame!.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['fake'], 'drop.png', { type: 'image/png' }));
    const target = document.querySelector('[data-testid="product-scene"]') ?? document.body;
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  const overlay = await frame!.evaluate(() => document.querySelector('[data-placement-overlay="true"]')?.textContent ?? '');
  expect(overlay).toContain('外部文件');
  expect(page.url()).toBe(url);

  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  await frame!.evaluate(() => {
    window.parent.postMessage({
      type: 'placement:target',
      payload: { sessionId: 'forged-session', target: { kind: 'insert', src: 'src/App.tsx:1:1', cid: 'main', ancestors: [], position: 'after' } },
    }, '*');
  });
  const after = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  expect(after).toBe(before);
  expect(readFileSync(path.join(WORK_ROOT, 'src', 'App.tsx'), 'utf8')).toContain('ProductHero');
  writeEvidence('browser-drop-guard.json', { overlay, url, before, after });
});
