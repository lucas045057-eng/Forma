import { existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { WORK_ROOT } from './env';
import {
  candidateDir, dependenciesIntact, discardCandidate, pickSelection, resetMock, restoreTemplate, setScript, submitTask, waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/** 资源：候选删除后不留目录，也不沿 junction 删掉真实依赖；关掉后端后没有残留预览进程。 */

test.describe('进程与资源', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('删除候选不会删到 junction 指向的真实依赖', async ({ page }) => {
    const before = dependenciesIntact();
    expect(before.ok, `依赖目录看起来不完整：${JSON.stringify(before)}`).toBe(true);

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

    // 候选目录里 node_modules 是逐包 junction
    const candidateModules = path.join(candidateDir(id), 'node_modules');
    expect(existsSync(candidateModules), '候选没有链上依赖，预览不可能起来').toBe(true);

    expect((await discardCandidate(id)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = dependenciesIntact();
    writeArtifactFrom('resources.json', { before, after, candidateExists: existsSync(candidateDir(id)) });

    expect(existsSync(candidateDir(id)), '候选目录没有被完整删除').toBe(false);
    expect(after.nodeModules, '作品 node_modules 条目数变了').toBe(before.nodeModules);
    expect(after.pnpm, 'pnpm store 条目数变了').toBe(before.pnpm);
    expect(existsSync(path.join(WORK_ROOT, 'node_modules', 'vite')), 'vite 包被删了').toBe(true);
  });
});
