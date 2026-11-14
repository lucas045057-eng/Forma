import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { M2A_DATA, WORK_ROOT } from './env';
import { adoptCandidate, appText, candidateDir, ensureChecksPassed, getCandidate, mockStats, pickSelection, restoreTemplate, setScript, submitTask, waitForTask } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * Agent 沙箱：六类越界写入被拒；作品目录里出现链接（junction）时，任何写作品树的操
 * 作都拒绝（409 UNSAFE_WORK_TREE，D2 修复后的行为）。
 *
 * F1（`src/` 整个是 junction）未在 e2e 覆盖：本机执行「把 src 换成 junction + 复制/删除含
 * junction 的作品副本」这类 fs 操作时，Playwright worker 与独立 Node 进程都会以 0xC0000409
 * 直接崩溃（无输出，node_modules 未受损）。该路径由实现方 `apps/server/src/work/repo.test.ts`
 * 覆盖，详见报告。
 */

const FORBIDDEN = [
  { name: '../outside.ts', path: '../outside.ts', content: 'bad' },
  { name: 'package.json', path: 'package.json', content: '{}' },
  { name: 'vite.config.ts', path: 'vite.config.ts', content: 'export default {}' },
  { name: 'public/evil.txt', path: 'public/evil.txt', content: 'bad' },
  { name: 'src/../../x.ts', path: 'src/../../x.ts', content: 'bad' },
  { name: '非法 scene.config.json', path: 'src/scene.config.json', content: '{"model":123}' },
];

const linkPath = path.join(WORK_ROOT, 'src', 'link-out');
const targetPath = path.join(M2A_DATA, 'junction-target');

function makeJunction(): void {
  rmSync(targetPath, { recursive: true, force: true });
  mkdirSync(targetPath, { recursive: true });
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(targetPath, linkPath, 'junction');
}
function removeJunction(): void {
  rmSync(linkPath, { recursive: true, force: true });
  rmSync(targetPath, { recursive: true, force: true });
}

test.describe('Agent 沙箱边界（D2 修复后）', () => {
  test.beforeAll(() => { removeJunction(); const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => {
    removeJunction();
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
    expect(appText()).toContain('立即购买');
    expect(readdirSync(path.join(directory, 'public')).includes('evil.txt')).toBe(false);
    expect(existsSync(path.join(path.dirname(directory), 'outside.ts'))).toBe(false);
    expect((await mockStats()).body.calls).toBeGreaterThanOrEqual(FORBIDDEN.length + 3);
    await (await import('./api')).discardCandidate(candidate.id);
  });

  test('作品目录里出现 junction 时，提交任务被 409 UNSAFE_WORK_TREE 拒绝（D2-1）', async ({ page }) => {
    const selection = await pickSelection(page, 'benefits');
    makeJunction();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'finish', args: { summary: '不该跑到这里' } }],
    ]);
    const callsBefore = (await mockStats()).body.calls;
    const response = await submitTask('作品目录里有链接时应当被拒', selection);
    const versionResponse = await (await import('./api')).getVersion();
    const targetEntries = readdirSync(targetPath);
    const workEntries = existsSync(path.join(WORK_ROOT, 'src')) ? readdirSync(path.join(WORK_ROOT, 'src')) : [];

    writeArtifactFrom('sandbox-unsafe-work-tree.json', {
      status: response.status,
      code: (response.body as any)?.error?.code,
      versionStatus: versionResponse.status,
      versionCode: (versionResponse.body as any)?.error?.code,
      targetEntries,
      workEntries,
      callsBefore,
      callsAfter: (await mockStats()).body.calls,
    });

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect((response.body as any).error.code).toBe('UNSAFE_WORK_TREE');
    expect(versionResponse.status).toBe(409);
    expect(targetEntries, 'junction 目标目录被写入').toEqual([]);
    expect((await mockStats()).body.calls, '被拒的请求不该调用上游').toBe(callsBefore);
    expect(workEntries.filter((entry) => entry !== 'link-out')).not.toContain('escape.ts');

    removeJunction();
    expect(restoreTemplate().clean).toBe(true);
  });

  test('候选里新增同名路径、作品目录里该路径是 junction 时，采用被拒且目标为空（D2-2）', async ({ page }) => {
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'write_file', args: { path: 'src/link-out/escape.ts', content: 'export const x = 1;\n' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: '在候选里新建 src/link-out/escape.ts' } }],
    ]);
    const selection = await pickSelection(page, 'benefits');
    const task = await waitForTask((await submitTask('新建 src/link-out/escape.ts', selection)).body.id);
    expect(task.status, JSON.stringify(task.error)).toBe('done');
    const candidate = (await getCandidate(task.candidateId!)).body;
    expect(candidate.diff.map((entry) => entry.path)).toContain('src/link-out/escape.ts');

    // M3-B：必须先拿到一次完整的真实检查绿灯（startChecks 会在锁内审计主作品，链接注入后会被正确拒绝），
    // 再做链接注入，验证链接检查仍然先拦住采用（门禁不会放行不安全工作树）。
    const checksBeforeLink = await ensureChecksPassed(candidate.id);
    expect(checksBeforeLink.outcome).toBe('passed');

    makeJunction();
    const before = appText();
    const adopted = await adoptCandidate(candidate.id);
    const targetEntries = readdirSync(targetPath);

    writeArtifactFrom('sandbox-adopt-unsafe.json', {
      status: adopted.status,
      code: (adopted.body as any)?.error?.code,
      targetEntries,
      mainUnchanged: appText() === before,
      candidateDecision: (await getCandidate(candidate.id)).body.decision,
    });

    expect(adopted.status, JSON.stringify(adopted.body)).toBe(409);
    expect((adopted.body as any).error.code).toBe('UNSAFE_WORK_TREE');
    expect(targetEntries, 'git 顺着 junction 把文件写到作品外了').toEqual([]);
    expect(appText(), '采用被拒但主线被改了').toBe(before);
    expect((await getCandidate(candidate.id)).body.decision).toBe('pending');

    removeJunction();
    const retried = await adoptCandidate(candidate.id);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(existsSync(path.join(WORK_ROOT, 'src', 'link-out', 'escape.ts')), '采用后文件没有落在作品内').toBe(true);
    const { revertVersion } = await import('./api');
    expect((await revertVersion()).status).toBe(200);
    rmSync(path.join(WORK_ROOT, 'src', 'link-out'), { recursive: true, force: true });
    expect(restoreTemplate().clean).toBe(true);
  });
});
