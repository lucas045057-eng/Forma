import { expect, test } from '@playwright/test';
import {
  adoptCandidate, appText, candidateDir, collectEvents, discardCandidate, ensureChecksPassed, getCandidate, getVersion, history, listCandidates, listTasks, openCandidatePreview, openMainPreview, pickSelection,
  previewFetch, resetMock, restoreTemplate, revertVersion, setScript, submitTask, waitFor, waitForTask,
} from './api';
import { existsSync } from 'node:fs';
import { writeArtifactFrom } from './artifact';

/**
 * 主链路（M2 过关路径的后端部分）：
 * 点选 → POST /tasks → 事件 → candidate.ready → 候选预览看到改动且源码标记仍正确 →
 * adopt → /version 与作品页变化 → revert → 文件与页面完全恢复。
 */

const SUCCESS = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: '已把首屏购买按钮改为「马上购买」' } }],
];

test.describe('指着说闭环（后端）', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, `作品目录不干净：${restored.status}`).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, `测试后作品目录没有还原：${restored.status}`).toBe(true); });

  test('点选 → 任务 → 候选预览 → 采用 → 回退', async ({ page }) => {
    await resetMock();
    await setScript(SUCCESS);
    const events = await collectEvents();
    try {
      const selection = await pickSelection(page);
      expect(selection.src).toMatch(/^src\/.*:\d+:\d+$/);
      expect(selection.baseVersion).toMatch(/^[0-9a-f]{40}$/);

      const versionBefore = (await getVersion()).body.version;
      const submitted = await submitTask('把首屏购买按钮的文字改成「马上购买」', selection);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
      const taskId = submitted.body.id;

      const task = await waitForTask(taskId);
      expect(task.status, JSON.stringify(task.error)).toBe('done');
      expect(task.candidateId, '任务没有产出候选').toBeTruthy();
      const candidateId = task.candidateId!;
      // 步骤文本里有编码 Agent 的轮次记录
      const steps = task.events.map((event) => event.message ?? '').join('\n');
      expect(steps).toContain('候选目录已创建');

      await waitFor(() => events.events.some((event) => event.type === 'candidate.ready' && (event as any).candidate?.id === candidateId), 30_000, 200);
      const readyEvent = events.events.find((event) => event.type === 'candidate.ready' && (event as any).candidate?.id === candidateId)!;
      const taskUpdates = events.events.filter((event) => event.type === 'task.updated');
      expect(taskUpdates.length).toBeGreaterThanOrEqual(2);
      expect(readyEvent.seq).toBeGreaterThan(taskUpdates.at(-1)!.seq);

      const candidate = (await getCandidate(candidateId)).body;
      expect(candidate.decision).toBe('pending');
      expect(candidate.previewUrl).toBe(`/preview/c/${candidateId}/`);
      expect(candidate.checks.map((check) => check.status)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
      expect(candidate.diff.map((entry) => entry.path)).toEqual(['src/App.tsx']);
      expect(candidate.diff[0].patch).toContain('马上购买');
      // 选中的是 Button.tsx，但 App.tsx 是它的祖先文件（ancestors 里包含）→ 不算越界
      expect(candidate.outOfScope).toEqual([]);
      expect(existsSync(candidateDir(candidateId)), '候选目录不存在').toBe(true);

      // 候选预览：通过后端同源代理访问（HMR 客户端用桩，见 09-known-defect）
      expect((await previewFetch(`/preview/c/${candidateId}/`)).status).toBe(200);
      await openCandidatePreview(page, candidateId);
      const buy = page.locator('[data-testid="buy-button"]');
      await buy.waitFor({ state: 'visible', timeout: 90_000 });
      await expect(buy).toHaveText('马上购买');
      // 候选里的源码标记仍然正确
      expect(await buy.getAttribute('data-src')).toBe('src/components/Button.tsx:5:5');
      await page.screenshot({ path: `${process.cwd()}/.data/pi-m2a-candidate.png` });

      // 采用
      // M3-B：先跑真实四项检查并等本次 run 终态；没通过就不能采用（不是 mock passed 标签）
      const checkRun = await ensureChecksPassed(candidateId);
      expect(checkRun.checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
      expect((await getCandidate(candidateId)).body.latestCheckRunId).toBe(checkRun.id);
      const adopted = await adoptCandidate(candidateId);
      expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
      const versionAfter = (await getVersion()).body.version;
      expect(versionAfter).not.toBe(versionBefore);
      expect(appText(), '采用后作品源码没有变化').toContain('马上购买');
      expect((await getCandidate(candidateId)).body.decision).toBe('adopted');
      expect((await previewFetch(`/preview/c/${candidateId}/`)).status, '采用后候选预览应已关闭').toBe(404);

      // 作品页显示改动
      await openMainPreview(page, '马上购买');
      const mainBuy = page.locator('[data-testid="buy-button"]');
      await expect(mainBuy).toHaveText('马上购买');

      // 回退
      const reverted = await revertVersion();
      expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
      expect((await getVersion()).body.version).not.toBe(versionAfter);
      expect(appText(), '回退后源码没有恢复').toContain('立即购买');
      expect(appText()).not.toContain('马上购买');
      await openMainPreview(page, '立即购买');
      const restoredBuy = page.locator('[data-testid="buy-button"]');
      await expect(restoredBuy).toHaveText('立即购买');

      // 事件里有 version.changed 与 candidate.closed
      await waitFor(() => events.events.some((event) => event.type === 'version.changed' && (event as any).reason === 'revert'), 20_000, 200);
      const types = events.events.map((event) => event.type);
      expect(types).toContain('version.changed');
      expect(types).toContain('candidate.closed');

      const replay = (await history(0)).body;
      writeArtifactFrom('flow-main.json', {
        selection,
        versionBefore,
        versionAfter,
        candidate: { id: candidateId, diff: candidate.diff.map((entry) => entry.path), outOfScope: candidate.outOfScope, checks: candidate.checks },
        eventTypes: [...new Set(types)],
        seqRange: { oldest: replay.oldest, current: replay.current, count: replay.events.length },
      });
    } finally {
      events.close();
    }
  });

  test('改了选中范围以外的文件时 outOfScope 记录下来（不拦截）', async ({ page }) => {
    await resetMock();
    // 选中 App.tsx 里的 ul.benefits，但让 Agent 新建一个 src/ 下的样式文件
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'write_file', args: { path: 'src/tmp-scope.css', content: '.tmp-scope { display: block; }\n' } }],
      [{ name: 'finish', args: { summary: '新建了一个样式文件' } }],
    ]);
    const selection = await pickSelection(page, 'benefits');
    const submitted = await submitTask('新增一个样式文件', selection);
    expect(submitted.status).toBe(202);
    const task = await waitForTask(submitted.body.id);
    expect(task.status, JSON.stringify(task.error)).toBe('done');
    const candidate = (await getCandidate(task.candidateId!)).body;
    expect(candidate.diff.map((entry) => entry.path)).toEqual(['src/tmp-scope.css']);
    expect(candidate.outOfScope, '越界文件没有被记录').toEqual(['src/tmp-scope.css']);
    // 越界只记录不拦截：候选仍然可以采用
    expect(candidate.decision).toBe('pending');
    const discarded = await (await import('./api')).discardCandidate(candidate.id);
    expect(discarded.status).toBe(200);
    writeArtifactFrom('flow-out-of-scope.json', { selectionSrc: selection.src, outOfScope: candidate.outOfScope, diff: candidate.diff.map((entry) => entry.path) });
  });

  test('候选列表与任务列表包含刚才的记录', async () => {
    const tasks = (await listTasks()).body;
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const candidates = (await listCandidates()).body;
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates.every((candidate) => ['pending', 'adopted', 'discarded'].includes(candidate.decision))).toBe(true);
  });
});
