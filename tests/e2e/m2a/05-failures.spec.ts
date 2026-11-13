import { existsSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import {
  cancelTask, candidateDir, getCandidate, getTask, listCandidates, pickSelection, previewFetch, resetMock, restoreTemplate,
  setScript, submitTask, wait, waitFor, waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/** 失败与取消：上游超时/500/无工具调用、任务中途取消 → 终态清晰，不留候选目录和预览。 */

test.describe('失败与取消', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  async function expectCleanFailure(taskId: string, candidateId: string | undefined) {
    // 取消/失败时任务状态先变，清理（停预览、删候选）在 execute 的 catch 里随后发生，这里轮询等待
    await waitFor(() => !existsSync(candidateDir(taskId)), 30_000, 300).catch(() => {});
    expect(existsSync(candidateDir(taskId)), '失败任务留下了候选目录').toBe(false);
    if (candidateId) expect(existsSync(candidateDir(candidateId))).toBe(false);
    await waitFor(async () => (await previewFetch(`/preview/c/${taskId}/`)).status === 404, 20_000, 300).catch(() => {});
    expect((await previewFetch(`/preview/c/${taskId}/`)).status, '失败任务的预览还能访问').toBe(404);
  }

  test('上游 500 → 任务失败且不留候选', async ({ page }) => {
    await resetMock();
    await setScript([], 0, 'error');
    const selection = await pickSelection(page);
    const candidatesBefore = (await listCandidates()).body.length;
    const task = await waitForTask((await submitTask('上游会挂', selection)).body.id);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('AGENT_UPSTREAM');
    await expectCleanFailure(task.id, task.candidateId);
    expect((await listCandidates()).body.length).toBe(candidatesBefore);
    writeArtifactFrom('failure-upstream.json', { status: task.status, error: task.error });
  });

  test('上游只回文本（没有工具调用）→ AGENT_PROTOCOL', async ({ page }) => {
    await resetMock();
    await setScript([], 0, 'text');
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('上游不调工具', selection)).body.id);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('AGENT_PROTOCOL');
    await expectCleanFailure(task.id, task.candidateId);
    writeArtifactFrom('failure-protocol.json', { status: task.status, error: task.error });
  });

  test('上游超时 → AGENT_TIMEOUT，且不留下候选与预览', async ({ page }) => {
    await resetMock();
    // 后端 AGENT_TIMEOUT_MS = 4000，这里每次调用延迟 5s
    await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 5000);
    const selection = await pickSelection(page);
    const started = Date.now();
    const task = await waitForTask((await submitTask('上游很慢', selection)).body.id, 60_000);
    const elapsed = Date.now() - started;
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('AGENT_TIMEOUT');
    expect(elapsed, '超时没有在总时限附近结束').toBeLessThan(30_000);
    await expectCleanFailure(task.id, task.candidateId);
    writeArtifactFrom('failure-timeout.json', { status: task.status, error: task.error, elapsed });
  });

  test('任务中途取消 → cancelled，不留候选与预览', async ({ page }) => {
    await resetMock();
    await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 3000);
    const selection = await pickSelection(page);
    const submitted = await submitTask('上游很慢，稍后取消', selection);
    expect(submitted.status).toBe(202);
    await wait(600);
    const cancelled = await cancelTask(submitted.body.id);
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const task = await waitForTask(submitted.body.id, 60_000);
    expect(task.status).toBe('cancelled');
    expect(task.error?.code).toBe('TASK_CANCELLED');
    expect(await getTask(submitted.body.id).then((response) => response.body.status)).toBe('cancelled');
    await expectCleanFailure(task.id, task.candidateId);
    // 已结束的任务不能再取消
    expect((await cancelTask(submitted.body.id)).status).toBe(409);
    writeArtifactFrom('failure-cancel.json', { status: task.status, error: task.error });
  });

  test('没有改动就结束 → NO_CHANGES，不留候选', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'finish', args: { summary: '什么都没改' } }],
    ]);
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('什么都不改', selection)).body.id);
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('NO_CHANGES');
    await expectCleanFailure(task.id, task.candidateId);
    expect((await getCandidate('not-a-real-candidate')).status).toBe(404);
    writeArtifactFrom('failure-no-changes.json', { status: task.status, error: task.error });
  });
});
