import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  candidateDir, getCandidate, openCandidatePreview, pickSelection, previewFetch, resetMock, restoreTemplate, setScript, submitTask,
  waitForTask,
} from './api';
import { BACKEND_PORT } from './env';
import { rawRequest } from '../m1b/api';
import { writeArtifactFrom } from './artifact';

/** 候选预览代理：只允许 GET/HEAD、未知 id 404、Host 白名单仍生效、不泄露上游 key。 */

test.describe('候选预览代理', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('GET/HEAD 放行，POST 405，未知 id 404，Host 白名单生效', async ({ page }) => {
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

    const head = await previewFetch(`/preview/c/${id}/`, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.text).toBe('');

    // 路由只注册了 GET/HEAD，POST 在路由层就不匹配（404）；即使进到代理也是 405。两者都算“不转发”。
    const post = await previewFetch(`/preview/c/${id}/`, 'POST');
    expect([404, 405].includes(post.status), `POST 被转发了：${post.status}`).toBe(true);

    const missing = await previewFetch('/preview/c/does-not-exist/');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('PREVIEW_NOT_RUNNING');

    // Host 白名单：恶意域名 + 伪造 Origin 都被拒
    const evil = await rawRequest({ host: 'evil.example:3001', pathname: `/preview/c/${id}/`, origin: 'http://evil.example:3001', port: BACKEND_PORT });
    expect(evil.status).toBe(403);
    expect(evil.text).toContain('HOST_DENIED');

    // 代理响应里不能出现上游 key
    expect(get.text).not.toContain('mock-only');
    const headers = JSON.stringify(get.headers);
    expect(headers.toLowerCase()).not.toContain('authorization');

    await openCandidatePreview(page, id);
    await expect(page.locator('[data-testid="buy-button"]')).toHaveText('马上购买', { timeout: 60_000 });

    writeArtifactFrom('proxy.json', {
      candidateId: id,
      statuses: { get: get.status, head: head.status, post: post.status, missing: missing.status, evil: evil.status },
      leakedKey: get.text.includes('mock-only'),
    });

    const { discardCandidate } = await import('./api');
    expect((await discardCandidate(id)).status).toBe(200);
    expect(existsSync(candidateDir(id)), '撤回后候选目录还在').toBe(false);
  });
});
