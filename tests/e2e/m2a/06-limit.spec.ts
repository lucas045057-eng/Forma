import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  candidateDir, collectEvents, listCandidates, pickSelection, previewFetch, resetMock, restoreTemplate, setScript, submitTask,
  waitFor, waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/** 候选上限：连续产生 4 个候选，最早的自动撤回、预览退出。 */

const CHANGE = (from: string, to: string) => [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: from, new: to } }],
  [{ name: 'finish', args: { summary: `${from} → ${to}` } }],
];

test.describe('候选上限', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => {
    const restored = restoreTemplate();
    expect(restored.clean, `作品目录没有还原：${restored.status}`).toBe(true);
  });

  test('第 4 个候选产生时最早的被自动撤回', async ({ page }) => {
    await resetMock();
    // 先把之前用例留下的待定候选清掉，让“最早”就是本用例的第一个
    for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
      await (await import('./api')).discardCandidate(candidate.id);
    }
    const events = await collectEvents();
    const ids: string[] = [];
    try {
      const selection = await pickSelection(page);
      const texts: Array<[string, string]> = [
        ['立即购买', '马上购买'],
        ['收藏香气', '收藏这缕香'],
        ['关于这缕香气', '关于这香气'],
        ['一份给自己', '一份送自己'],
      ];
      for (const [from, to] of texts) {
        await setScript(CHANGE(from, to));
        const task = await waitForTask((await submitTask(`把「${from}」改成「${to}」`, selection)).body.id);
        expect(task.status, JSON.stringify(task.error)).toBe('done');
        ids.push(task.candidateId!);
      }
      expect(ids.length).toBe(4);
      expect(new Set(ids).size, '候选 id 重复').toBe(4);

      const candidates = (await listCandidates()).body;
      // 裁剪在任务状态变 done 之后异步发生，这里给一点时间
      await waitFor(async () => {
        const current = (await listCandidates()).body.find((candidate) => candidate.id === ids[0]);
        return current?.decision === 'discarded';
      }, 20_000, 300).catch(() => {});
      const first = (await listCandidates()).body.find((candidate) => candidate.id === ids[0])!;
      writeArtifactFrom('candidate-limit.json', {
        ids,
        decisions: candidates.map((candidate) => ({ id: candidate.id, decision: candidate.decision })),
        finalDecisions: (await listCandidates()).body.map((candidate) => ({ id: candidate.id, decision: candidate.decision })),
      });
      expect(first.decision, '最早的候选没有被自动撤回').toBe('discarded');
      await waitFor(() => !existsSync(candidateDir(ids[0])), 20_000, 300).catch(() => {});
      expect(existsSync(candidateDir(ids[0])), '被挤掉的候选目录还在').toBe(false);
      expect((await previewFetch(`/preview/c/${ids[0]}/`)).status, '被挤掉的候选预览还在').toBe(404);
      for (const id of ids.slice(1)) {
        const current = (await listCandidates()).body.find((candidate) => candidate.id === id);
        expect(current?.decision).toBe('pending');
        expect((await previewFetch(`/preview/c/${id}/`)).status, `候选 ${id} 的预览不可用`).toBe(200);
      }
      await waitFor(() => events.events.some((event) => event.type === 'candidate.closed' && (event as any).candidate?.id === ids[0]), 20_000, 200);
      const closed = events.events.find((event) => event.type === 'candidate.closed' && (event as any).candidate?.id === ids[0])!;
      expect(String((closed as any).reason)).toContain('3');
      writeArtifactFrom('candidate-limit-closed.json', { reason: (closed as any).reason });
    } finally {
      events.close();
    }
  });
});
