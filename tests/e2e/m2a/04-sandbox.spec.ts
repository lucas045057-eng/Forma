import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { M2A_DATA, WORK_ROOT } from './env';
import { appText, candidateDir, getCandidate, mockStats, pickSelection, restoreTemplate, setScript, submitTask, waitForTask } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * Agent 沙箱：写 ../、package.json、vite.config.ts、public/、src/../..、非法 scene.config.json
 * 全被拒；经 junction 逃逸那一类单独一条（当前会逃出去，记为缺陷）。
 */

const FORBIDDEN = [
  { name: '../outside.ts', path: '../outside.ts', content: 'bad' },
  { name: 'package.json', path: 'package.json', content: '{}' },
  { name: 'vite.config.ts', path: 'vite.config.ts', content: 'export default {}' },
  { name: 'public/evil.txt', path: 'public/evil.txt', content: 'bad' },
  { name: 'src/../../x.ts', path: 'src/../../x.ts', content: 'bad' },
  { name: '非法 scene.config.json', path: 'src/scene.config.json', content: '{"model":123}' },
];

test.describe('Agent 沙箱边界', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => {
    rmSync(path.join(WORK_ROOT, 'src', 'link-out'), { recursive: true, force: true });
    rmSync(path.join(M2A_DATA, 'junction-target'), { recursive: true, force: true });
    const restored = restoreTemplate();
    expect(restored.clean, `作品目录没有还原：${restored.status}`).toBe(true);
  });

  test('六类越界写入被拒，候选里没有越界文件；正常改动仍然生效', async ({ page }) => {
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      ...FORBIDDEN.map((entry) => [{ name: 'write_file', args: { path: entry.path, content: entry.content } }]),
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: '越界写入被沙箱拒绝，正常改动已提交' } }],
    ]);
    const selection = await pickSelection(page, 'benefits');
    const task = await waitForTask((await submitTask('试着越界写入，然后正常改按钮', selection)).body.id);
    expect(task.status, JSON.stringify(task.error)).toBe('done');
    const candidate = (await getCandidate(task.candidateId!)).body;
    const directory = candidateDir(candidate.id);

    writeArtifactFrom('sandbox.json', {
      diff: candidate.diff.map((entry) => entry.path),
      outOfScope: candidate.outOfScope,
      attempted: FORBIDDEN.map((entry) => entry.name),
      calls: (await mockStats()).body.calls,
      candidateDirEntries: readdirSync(directory),
    });

    expect(candidate.diff.map((entry) => entry.path), '候选里出现了越界文件').toEqual(['src/App.tsx']);
    expect(appText()).toContain('立即购买'); // 作品本身还没被采用
    expect(readdirSync(path.join(directory, 'public')).includes('evil.txt')).toBe(false);
    expect(existsSync(path.join(directory, 'outside.ts'))).toBe(false);
    expect(existsSync(path.join(path.dirname(directory), 'outside.ts'))).toBe(false);
    // 被拒之后 Agent 仍然完成了正常改动：read + 6 次越界写入 + replace + finish = 9 轮
    expect((await mockStats()).body.calls).toBeGreaterThanOrEqual(FORBIDDEN.length + 3);
  });

  test('经 junction 逃逸的写入也应当被拒（当前可逃出去）', async ({ page }) => {
    test.fail(true, 'M2-A 缺陷：Windows 上 lstat 不把 junction 当符号链接，沙箱可经 src/ 下的 junction 写到作品目录之外。修复后删掉这个标记。');
    const target = path.join(M2A_DATA, 'junction-target');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    const link = path.join(WORK_ROOT, 'src', 'link-out');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, 'junction');

    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'write_file', args: { path: 'src/link-out/escape.ts', content: 'escaped' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: '尝试经 junction 逃逸' } }],
    ]);
    const selection = await pickSelection(page, 'benefits');
    const task = await waitForTask((await submitTask('尝试经 junction 逃逸', selection)).body.id);
    const candidate = task.candidateId ? (await getCandidate(task.candidateId)).body : null;
    const targetEntries = readdirSync(target);

    writeArtifactFrom('sandbox-junction.json', {
      taskStatus: task.status,
      diff: candidate?.diff.map((entry) => entry.path) ?? null,
      targetEntries,
      escaped: targetEntries.length > 0,
    });

    expect(targetEntries, 'junction 目标目录被写入了文件（沙箱逃逸）').toEqual([]);
    expect(candidate?.diff.map((entry) => entry.path) ?? []).toEqual(['src/App.tsx']);

    rmSync(link, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    restoreTemplate();
  });
});
