import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  candidateDir, collectEvents, discardCandidate, ensureChecksPassed, getCandidate, getVersion, listCandidates, openCandidatePreview, pickSelection,
  previewFetch, resetMock, restoreTemplate, setScript, submitTask, waitFor, waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/**
 * 撤回：候选目录、分支、预览都清掉，作品不变。
 * 候选预览的 HMR 客户端无法通过代理连 WS（见 09-known-defect），这里用桩验证内容本身。
 */

test.describe('撤回候选', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('discard 后候选目录 / 分支 / 预览都消失，作品不变', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'ok' } }],
    ]);
    const versionBefore = (await getVersion()).body.version;
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('把按钮改成马上购买', selection)).body.id);
    expect(task.status, JSON.stringify(task.error)).toBe('done');
    const candidateId = task.candidateId!;

    const events = await collectEvents();
    try {
      await openCandidatePreview(page, candidateId);
      await expect(page.locator('[data-testid="buy-button"]')).toHaveText('马上购买', { timeout: 60_000 });

      const discarded = await discardCandidate(candidateId);
      expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
      expect(discarded.body.decision).toBe('discarded');

      expect(existsSync(candidateDir(candidateId)), '候选目录没有被删除').toBe(false);
      expect((await previewFetch(`/preview/c/${candidateId}/`)).status, '撤回后预览还能访问').toBe(404);
      await waitFor(() => events.events.some((event) => event.type === 'candidate.closed' && (event as any).candidate?.id === candidateId), 20_000, 200);
      expect(events.events.find((event) => event.type === 'candidate.closed' && (event as any).candidate?.id === candidateId)!.reason).toContain('撤回');

      // 作品不变
      expect((await getVersion()).body.version).toBe(versionBefore);
      expect((await getCandidate(candidateId)).body.decision).toBe('discarded');
      // 再撤回一次：409
      expect((await discardCandidate(candidateId)).status).toBe(409);

      writeArtifactFrom('discard.json', { candidateId, versionBefore, previewStatus: 404 });
    } finally {
      events.close();
    }
  });

  test('采用后的候选不能再撤回，也不能重复采用', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'ok' } }],
    ]);
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('改成马上购买', selection)).body.id);
    const candidateId = task.candidateId!;
    const { adoptCandidate, revertVersion } = await import('./api');
    // M3-B：旧用例直接 adopt 的路径改为显式跑真实检查并等本次 run 终态
    expect((await ensureChecksPassed(candidateId)).checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect((await adoptCandidate(candidateId)).status).toBe(200);
    expect((await adoptCandidate(candidateId)).status).toBe(409);
    expect((await discardCandidate(candidateId)).status).toBe(409);
    // 回退，保持作品目录干净
    expect((await revertVersion()).status).toBe(200);
    const pending = (await listCandidates()).body.filter((candidate) => candidate.decision === 'pending');
    expect(pending.length).toBe(0);
    writeArtifactFrom('adopt-once.json', { candidateId, pendingAfter: pending.length });
  });
});
