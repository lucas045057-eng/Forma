import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { getVersion, listTasks, mockStats, resetMock, restoreTemplate, setScript, submitTask } from './api';
import { TEMPLATE_APP } from './env';
import { writeArtifactFrom } from './artifact';

/**
 * 选中对象校验：非法 src、文件不存在、行号越界、不存在的 baseVersion、选中文件在
 * baseVersion 之后被改过（STALE_SELECTION 409）——全部在入队前拒绝，且不调用上游。
 */

const OK_VERSION = async () => (await getVersion()).body.version;

test.describe('选中对象校验', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('非法 src / 行号 / baseVersion 全部 400，且不调用上游', async ({ page }) => {
    await resetMock();
    void page;
    const version = await OK_VERSION();
    const before = { calls: (await mockStats()).body.calls, tasks: (await listTasks()).body.length };
    const cases: Array<{ name: string; selection: Record<string, unknown> }> = [
      { name: '缺 src/ 前缀', selection: { src: 'App.tsx:1:1', baseVersion: version } },
      { name: '含 ../', selection: { src: 'src/../App.tsx:1:1', baseVersion: version } },
      { name: '缺行号列号', selection: { src: 'src/App.tsx', baseVersion: version } },
      { name: '行号为 0', selection: { src: 'src/App.tsx:0:1', baseVersion: version } },
      { name: '行号越界', selection: { src: 'src/App.tsx:99999:1', baseVersion: version } },
      { name: '文件不存在', selection: { src: 'src/nope-here.tsx:1:1', baseVersion: version } },
      { name: '反斜杠路径', selection: { src: 'src\\App.tsx:1:1', baseVersion: version } },
      { name: 'baseVersion 不是提交', selection: { src: 'src/App.tsx:1:1', baseVersion: 'f'.repeat(40) } },
      { name: 'baseVersion 格式错', selection: { src: 'src/App.tsx:1:1', baseVersion: 'not-a-commit' } },
    ];
    const results: Array<Record<string, unknown>> = [];
    for (const entry of cases) {
      const response = await submitTask('随便改点什么', entry.selection as never);
      results.push({ name: entry.name, status: response.status, code: (response.body as any)?.error?.code });
      expect([400, 409].includes(response.status), `「${entry.name}」应被拒：${JSON.stringify(response.body)}`).toBe(true);
    }
    const after = { calls: (await mockStats()).body.calls, tasks: (await listTasks()).body.length };
    expect(after.calls, '非法选中对象触发了上游调用').toBe(before.calls);
    expect(after.tasks, '被拒的任务进入了队列').toBe(before.tasks);

    writeArtifactFrom('selection-invalid.json', { version, results, before, after });
  });

  test('选中文件在 baseVersion 之后被改过 → 409 STALE_SELECTION', async () => {
    await resetMock();
    const version = await OK_VERSION();
    // 直接改作品文件：下一次提交任务时的快照会把它提交成新版本
    appendFileSync(TEMPLATE_APP, '\n// stale-selection-probe\n', 'utf8');
    const callsBefore = (await mockStats()).body.calls;
    const tasksBefore = (await listTasks()).body.length;
    const response = await submitTask('改按钮', { src: 'src/App.tsx:14:5', baseVersion: version } as never);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect((response.body as any).error.code).toBe('STALE_SELECTION');
    expect((await mockStats()).body.calls, '过期选中对象仍然调用了上游').toBe(callsBefore);
    expect((await listTasks()).body.length).toBe(tasksBefore);
    writeArtifactFrom('selection-stale.json', { version, status: response.status, code: (response.body as any).error.code });
    // 还原文件（afterAll 也会兜底）
    expect(restoreTemplate().clean).toBe(true);
  });

  test('合法 baseVersion 可以继续提交（正向对照）', async () => {
    // 先取得最新版本（上一步的快照已提交改动），再用它提交一个正常任务
    const latest = await OK_VERSION();
    const response = await submitTask('只是校验，不进队列执行', { src: 'src/App.tsx:14:5', baseVersion: latest } as never);
    expect([202]).toContain(response.status);
    // 该任务会真的执行；等它结束并撤回，避免影响后续用例
    const { waitForTask, discardCandidate } = await import('./api');
    const task = await waitForTask((response.body as any).id);
    if (task.status === 'done' && task.candidateId) await discardCandidate(task.candidateId);
    writeArtifactFrom('selection-valid.json', { latest, status: response.status, taskStatus: task.status });
  });
});
