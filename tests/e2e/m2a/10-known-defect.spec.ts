import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  candidateDir, countNavigations, discardCandidate, mockStats, pickSelection, resetMock, restoreTemplate, setScript, submitTask,
  waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/**
 * 已知缺陷（待修）：候选预览在真实浏览器里无法渲染。
 *
 * 现象：`/preview/c/<id>/` 里 Vite 仍然注入 `@vite/client`，它通过 WebSocket 连 HMR，
 * 而后端代理只转发 GET/HEAD、不升级 WS；客户端连不上后会反复 `location.reload()`，
 * 正在加载的模块被 abort，`#root` 永远为空。
 *
 * 这一条按“应该怎样”写（页面正常渲染、不重复刷新），当前用 `test.fail` 标成预期失败；
 * 修好后会变成“意外通过”并让套件失败，提醒去掉标记。
 */

test.describe('已知缺陷', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => {
    const restored = restoreTemplate();
    expect(restored.clean, restored.status).toBe(true);
  });

  test('候选预览应当能直接渲染且不反复刷新', async ({ page }) => {
    test.fail(true, 'M2-A 缺陷：/preview/c/<id>/ 的 Vite HMR 客户端连不上 WS，页面反复 reload，首屏空白。修复后删掉这个标记。');

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

    // 记录证据：不装桩，直接在真实浏览器里打开候选预览
    const failedRequests: string[] = [];
    page.on('requestfailed', (request) => failedRequests.push(`${request.url().slice(-70)} ${request.failure()?.errorText}`));
    const navigations = await countNavigations(page, 0);
    await page.goto(`http://127.0.0.1:3001/preview/c/${id}/`);
    const observed = await countNavigations(page, 8000);
    const state = await page.evaluate(() => ({
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      buyText: document.querySelector('[data-testid="buy-button"]')?.textContent ?? null,
    }));
    writeArtifactFrom('known-defect-preview-reload.json', {
      defect: 'HMR 客户端无法通过后端代理建立 WS → 反复 location.reload() → 首屏空白',
      navigations: navigations + observed,
      rootChildren: state.rootChildren,
      buyText: state.buyText,
      failedRequests: failedRequests.slice(0, 10),
      candidateId: id,
    });

    // 期望的正确行为
    expect(observed, `页面在 8 秒内导航了 ${observed} 次（应为 1 次）`).toBe(1);
    expect(state.rootChildren).toBeGreaterThan(0);
    expect(state.buyText).toBe('马上购买');

    // 清理
    if (existsSync(candidateDir(id))) await discardCandidate(id);
  });
});
