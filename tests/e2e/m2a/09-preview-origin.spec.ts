import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  candidateDir, discardCandidate, getCandidate, openCandidatePreview, pickSelection, previewFetch, previewFetchFrom, resetMock,
  restoreTemplate, setScript, submitTask, waitForTask,
} from './api';
import { PREVIEW_ORIGIN } from './api';
import { BACKEND_BASE, MOCK_BASE } from './env';
import { writeArtifactFrom } from './artifact';

/**
 * 预览源（5175）边界：只服务 GET/HEAD 的 /preview/main/* 与 /preview/c/<id>/*；
 * 没有任何 API 路由；跨源来源被 CORS 限制；候选预览在真实浏览器里能渲染（D1 回归）。
 */

test.describe('预览源与 D1', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('GET/HEAD 放行，POST 与未知候选被拒，API 路径 404', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'ok' } }],
    ]);
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('改按钮', selection)).body.id);
    expect(task.status, JSON.stringify(task.error)).toBe('done');
    const id = task.candidateId!;
    expect((await getCandidate(id)).body.previewUrl).toBe(`/preview/c/${id}/`);

    const get = await previewFetch(`/preview/c/${id}/`);
    expect(get.status).toBe(200);
    expect(get.text).toContain('<div id="root">');
    expect(get.headers['access-control-allow-origin'], 'CORS 只允许 Studio 来源').toBe('http://127.0.0.1:5173');

    const head = await previewFetch(`/preview/c/${id}/`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');

    const post = await previewFetch(`/preview/c/${id}/`, 'POST');
    expect(post.status, '预览源不该接受 POST').toBe(404);

    const missing = await previewFetch('/preview/c/doesnotexist/');
    expect(missing.status).toBe(404);

    // 预览源上没有任何 API
    for (const pathname of ['/scene', '/assets', '/tasks', '/candidates', '/version', '/events/history?since=0', '/health']) {
      const response = await previewFetch(pathname);
      expect(response.status, `预览源暴露了 API：${pathname}`).toBe(404);
    }
    // 主作品预览 200 且不泄露上游 key
    const mainGet = await previewFetch('/preview/main/');
    expect(mainGet.status).toBe(200);
    expect(mainGet.text).not.toContain('mock-only');

    // 外部来源（伪造 Origin/Referer）也拿不到内容
    const foreign = await previewFetchFrom(`/preview/c/${id}/`, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(200); // 静态资源本身可读，但 CORS 头只给 Studio，浏览器会拦住跨源读取
    expect(foreign.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');

    writeArtifactFrom('preview-origin.json', {
      candidateId: id,
      statuses: { get: get.status, head: head.status, post: post.status, missing: missing.status, main: mainGet.status },
      cors: get.headers['access-control-allow-origin'],
      apiPaths: 'all 404',
      origin: PREVIEW_ORIGIN,
      backend: BACKEND_BASE,
      mock: MOCK_BASE,
    });

    expect((await discardCandidate(id)).status).toBe(200);
    expect(existsSync(candidateDir(id))).toBe(false);
  });

  test('D1 回归：候选预览在真实浏览器里直接渲染，不反复刷新，HMR 连上', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'ok' } }],
    ]);
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('改按钮', selection)).body.id);
    const id = task.candidateId!;

    const consoleLogs: string[] = [];
    const pageErrors: string[] = [];
    let navigations = 0;
    page.on('console', (message) => consoleLogs.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations += 1; });

    await openCandidatePreview(page, id);
    const buy = page.locator('[data-testid="buy-button"]');
    await buy.waitFor({ state: 'visible', timeout: 60_000 });
    await page.waitForTimeout(6_000);

    const state = await page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      text: document.querySelector('[data-testid="buy-button"]')?.textContent ?? null,
      src: document.querySelector('[data-testid="buy-button"]')?.getAttribute('data-src') ?? null,
      sceneState: document.querySelector('[data-testid="product-scene"]')?.getAttribute('data-state') ?? null,
    }));

    writeArtifactFrom('d1-candidate-preview.json', {
      candidateId: id,
      navigations,
      state,
      hmrConnected: consoleLogs.some((line) => line.includes('[vite] connected')),
      connectionLost: consoleLogs.filter((line) => line.includes('connection lost')).length,
      pageErrors,
    });

    expect(navigations, '页面发生了重复刷新').toBe(1);
    expect(state.rootChildren).toBeGreaterThan(0);
    expect(state.text).toBe('马上购买');
    expect(state.src).toBe('src/components/Button.tsx:5:5');
    expect(consoleLogs.some((line) => line.includes('[vite] connected')), 'HMR 没有连上').toBe(true);
    expect(consoleLogs.filter((line) => line.includes('connection lost')).length).toBe(0);
    expect(pageErrors).toEqual([]);

    const { discardCandidate } = await import('./api');
    await discardCandidate(id);
  });
});
