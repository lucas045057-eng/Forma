import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WorkRepo } from './repo.ts';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-work-'));
  const workRoot = path.join(directory, 'work');
  const dataDirectory = path.join(directory, 'data');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(workRoot, 'src'), { recursive: true }));
  await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <button>立即购买</button>;\n');
  const repo = new WorkRepo({ workRoot, dataDirectory });
  await repo.init();
  return { directory, workRoot, repo };
}

it('snapshots disk edits, adopts a candidate and reverts the merge without rewriting history', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const initial = await repo.head();
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <button>立即购买</button>;\nexport const note = "snapshot";\n');
    const base = await repo.snapshot();
    expect(base).not.toBe(initial);
    await repo.createCandidate('candidate1', base);
    await writeFile(path.join(repo.candidatePath('candidate1'), 'src', 'App.tsx'), 'export default () => <button>马上购买</button>;\nexport const note = "snapshot";\n');
    expect(await repo.commitCandidate('candidate1', '修改按钮')).toEqual(['src/App.tsx']);
    expect(await repo.diff('candidate1', base)).toHaveLength(1);
    const adopted = await repo.adopt('candidate1');
    expect(adopted).not.toBe(base);
    expect(await readFile(path.join(workRoot, 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    const reverted = await repo.revert(adopted);
    expect(reverted).not.toBe(adopted);
    expect(await readFile(path.join(workRoot, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
    expect(await repo.head()).toBe(reverted);
    await repo.removeCandidate('candidate1');
    expect(await repo.candidateExists('candidate1')).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('includes untracked files in pendingDiff and binds exact content without committing', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    await writeFile(path.join(repo.candidatePath('candidate1'), 'src/New.ts'), 'export const value = 1;\n');
    const pending = await repo.pendingDiff('candidate1', base);
    expect(pending.changedFiles).toEqual(['src/New.ts']);
    expect(pending.diff[0].patch).toContain('export const value = 1;');
    expect(await repo.candidateCommit('candidate1')).toBe(base);
    expect((await repo.pendingDiff('candidate1', base)).contentDigest).toBe(pending.contentDigest);
    await writeFile(path.join(repo.candidatePath('candidate1'), 'src/New.ts'), 'export const value = 2;\n');
    expect((await repo.pendingDiff('candidate1', base)).contentDigest).not.toBe(pending.contentDigest);
    expect(await repo.candidateCommit('candidate1')).toBe(base);
    expect(await repo.commitCandidate('candidate1', '新增文件')).toEqual(['src/New.ts']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('aborts a conflicting adoption without changing the main worktree', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.snapshot();
    await repo.createCandidate('candidate1', base);
    await writeFile(path.join(repo.candidatePath('candidate1'), 'src', 'App.tsx'), 'export default () => <button>候选</button>;\n');
    await repo.commitCandidate('candidate1', '候选修改');
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <button>当前</button>;\n');
    await repo.snapshot();
    await expect(repo.adopt('candidate1')).rejects.toMatchObject({ code: 'MERGE_CONFLICT', status: 409 });
    expect(await readFile(path.join(workRoot, 'src', 'App.tsx'), 'utf8')).toContain('当前');
    expect((await repo.snapshot())).toBe(await repo.head());
    await repo.removeCandidate('candidate1');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('refuses snapshot, candidates, adopt and revert while the work tree contains a junction (D2)', async () => {
  const { directory, workRoot, repo } = await fixture();
  const { mkdir, readdir, rmdir, symlink } = await import('node:fs/promises');
  const outside = path.join(directory, 'outside');
  const link = path.join(workRoot, 'src', 'link-out');
  try {
    const base = await repo.snapshot();
    await repo.createCandidate('candidate2', base);
    // The candidate adds a file below a path that the work tree will later hold as a junction.
    await mkdir(path.join(repo.candidatePath('candidate2'), 'src', 'link-out'), { recursive: true });
    await writeFile(path.join(repo.candidatePath('candidate2'), 'src', 'link-out', 'escape.ts'), 'escaped\n');
    await repo.commitCandidate('candidate2', '在 link-out 下新增文件');
    await mkdir(outside, { recursive: true });
    await symlink(outside, link, 'junction');
    for (const attempt of [() => repo.snapshot(), () => repo.adopt('candidate2'), () => repo.createCandidate('candidate3', base), () => repo.revert(base)]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'UNSAFE_WORK_TREE', status: 409 });
    }
    expect(await readdir(outside)).toEqual([]);
    await rmdir(link);
    // With the link gone the same adoption lands inside the work tree.
    await repo.adopt('candidate2');
    expect(await readFile(path.join(workRoot, 'src', 'link-out', 'escape.ts'), 'utf8')).toBe('escaped\n');
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await import('node:fs/promises').then(({ rmdir }) => rmdir(link).catch(() => {}));
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses when src/ or public/ itself is a junction (review F1)', async () => {
  const { directory, workRoot, repo } = await fixture();
  const { mkdir, readdir, rename, rmdir, symlink } = await import('node:fs/promises');
  const outside = path.join(directory, 'outside-src');
  const src = path.join(workRoot, 'src');
  try {
    const base = await repo.snapshot();
    await repo.createCandidate('candidate4', base);
    await writeFile(path.join(repo.candidatePath('candidate4'), 'src', 'escape.ts'), 'escaped\n');
    await repo.commitCandidate('candidate4', '新增文件');
    // Move the real src/ away and put a junction in its place.
    await mkdir(outside, { recursive: true });
    await rename(src, path.join(directory, 'real-src'));
    await symlink(outside, src, 'junction');
    for (const attempt of [() => repo.snapshot(), () => repo.adopt('candidate4'), () => repo.createCandidate('candidate5', base), () => repo.revert(base)]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'UNSAFE_WORK_TREE', status: 409 });
    }
    expect(await readdir(outside)).toEqual([]);
    await rmdir(src);
    await rename(path.join(directory, 'real-src'), src);
  } finally {
    await import('node:fs/promises').then(({ lstat, rmdir }) => lstat(src).then(info => info.isSymbolicLink() ? rmdir(src) : undefined).catch(() => {}));
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses an existing clean repository that already tracks a forbidden file (review F3)', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const gitDir = path.join(directory, 'data', 'work.git');
    const { execFileSync } = await import('node:child_process');
    // Plant a tracked secret behind the allow-list's back, then leave the work tree clean.
    await writeFile(path.join(workRoot, 'src', 'deploy.pem'), 'fake key\n');
    execFileSync('git', ['--git-dir', gitDir, '--work-tree', workRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-f', 'src/deploy.pem'], { cwd: workRoot });
    execFileSync('git', ['--git-dir', gitDir, '--work-tree', workRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'legacy'], { cwd: workRoot });
    const base = await repo.head();
    await expect(repo.snapshot()).rejects.toMatchObject({ code: 'UNSAFE_TRACKED_FILE' });
    await expect(repo.createCandidate('candidate6', base)).rejects.toMatchObject({ code: 'UNSAFE_TRACKED_FILE' });
    const restarted = new WorkRepo({ workRoot, dataDirectory: path.join(directory, 'data') });
    await expect(restarted.init()).rejects.toMatchObject({ code: 'UNSAFE_TRACKED_FILE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('does not abort an interrupted merge through a junctioned src/ at startup (review N1)', async () => {
  const { directory, workRoot, repo } = await fixture();
  const { mkdir, readdir, rename, rmdir, symlink } = await import('node:fs/promises');
  const { execFileSync } = await import('node:child_process');
  const gitDir = path.join(directory, 'data', 'work.git');
  const g = (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', workRoot, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: workRoot, stdio: 'pipe' });
  const outside = path.join(directory, 'outside');
  const src = path.join(workRoot, 'src');
  try {
    const base = await repo.snapshot();
    await repo.createCandidate('candidate7', base);
    await writeFile(path.join(repo.candidatePath('candidate7'), 'src', 'App.tsx'), 'export default () => <button>候选</button>;\n');
    await repo.commitCandidate('candidate7', '候选改动');
    await writeFile(path.join(src, 'App.tsx'), 'export default () => <button>主线</button>;\n');
    await repo.snapshot();
    // Leave a conflicted merge behind, as if the backend crashed mid-adoption.
    try { g('merge', '--no-ff', 'candidate/candidate7'); } catch { /* conflict expected */ }
    await mkdir(outside, { recursive: true });
    await rename(src, path.join(directory, 'real-src'));
    await symlink(outside, src, 'junction');
    const restarted = new WorkRepo({ workRoot, dataDirectory: path.join(directory, 'data') });
    await expect(restarted.init()).rejects.toMatchObject({ code: 'UNSAFE_WORK_TREE' });
    expect(await readdir(outside)).toEqual([]);
    // The conflict state is kept for a human instead of being aborted through the link.
    expect(g('rev-parse', '-q', '--verify', 'MERGE_HEAD').toString().trim()).toMatch(/^[0-9a-f]{40}$/);
    await rmdir(src);
    await rename(path.join(directory, 'real-src'), src);
  } finally {
    await import('node:fs/promises').then(({ lstat, rmdir }) => lstat(src).then(info => info.isSymbolicLink() ? rmdir(src) : undefined).catch(() => {}));
    await rm(directory, { recursive: true, force: true });
  }
});

it('audits paths containing tabs, newlines and spaces as whole names (review N2)', async () => {
  const { directory, workRoot, repo } = await fixture();
  const { execFileSync } = await import('node:child_process');
  const gitDir = path.join(directory, 'data', 'work.git');
  try {
    // Build a tree entry whose name is "src/ok.ts<TAB>evil.pem" without touching the filesystem.
    const blob = execFileSync('git', ['--git-dir', gitDir, 'hash-object', '-w', '--stdin'], { input: 'x\n' }).toString().trim();
    // Git for Windows refuses such a path in the index, but a tree object can still carry it.
    const mktree = (input: string) => execFileSync('git', ['--git-dir', gitDir, 'mktree', '-z'], { input }).toString().trim();
    const sub = mktree(`100644 blob ${blob}\tok.ts\tevil.pem\0`);
    const tree = mktree(`040000 tree ${sub}\tsrc\0`);
    const commit = execFileSync('git', ['--git-dir', gitDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree, '-m', 'tab']).toString().trim();
    await expect(repo.auditTree(commit)).rejects.toMatchObject({ code: 'UNSAFE_TRACKED_FILE' });
    await expect(repo.auditTree(commit)).rejects.toThrow('evil.pem');
    await repo.auditTree('HEAD');
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('uses an explicit trusted base when legacy candidates lack .base metadata (F4)', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    await rm(path.join(repo.candidatesDir, '.base-candidate1'));
    await writeFile(path.join(repo.candidatePath('candidate1'), 'src', 'App.tsx'), 'export default () => <button>旧草稿</button>;\n');
    await expect(repo.commitCandidate('candidate1', 'legacy without base')).rejects.toMatchObject({ code: 'CANDIDATE_BASE_UNKNOWN' });
    expect(await repo.commitCandidate('candidate1', 'legacy with base', undefined, base)).toEqual(['src/App.tsx']);
    expect(await repo.candidateCommit('candidate1')).not.toBe(base);
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects a shadowed managed baseline through the validated tree listing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-work-'));
  const workRoot = path.join(directory, 'work');
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(workRoot, 'src'), { recursive: true });
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <p/>;\n');
    // A same-name non-canonical renderer must be seen by the managed audit even when the listing
    // is the one auditTree already validated for this revision.
    await writeFile(path.join(workRoot, 'src', 'spatial-module.ts'), 'export function SpatialModule() { return null; }\n');
    const repo = new WorkRepo({ workRoot, dataDirectory: path.join(directory, 'data') });
    await expect(repo.init()).rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stages additions, deletions and an empty change set through bounded add batches', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    await writeFile(path.join(root, 'src', 'First.ts'), 'export const first = 1;\n');
    await writeFile(path.join(root, 'src', 'Second.ts'), 'export const second = 2;\n');
    expect((await repo.commitCandidate('candidate1', '新增两个文件')).sort()).toEqual(['src/First.ts', 'src/Second.ts']);
    const added = await repo.candidateCommit('candidate1');
    expect(await repo.fileAt(added, 'src/First.ts')).toContain('first = 1');
    await rm(path.join(root, 'src', 'App.tsx'));
    expect(await repo.commitCandidate('candidate1', '删除旧页面')).toEqual(['src/App.tsx']);
    const deleted = await repo.candidateCommit('candidate1');
    expect(deleted).not.toBe(added);
    expect(await repo.fileAt(deleted, 'src/App.tsx')).toBeUndefined();
    expect(await repo.commitCandidate('candidate1', '无变化')).toEqual([]);
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stages new, modified, deleted and dotted paths in one commit without re-adding tracked files', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    await writeFile(path.join(workRoot, 'src', 'Old.ts'), 'export const old = 1;\n');
    const base = await repo.snapshot();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    await writeFile(path.join(root, 'src', 'New-file.v2.ts'), 'export const dotted = 1;\n');
    await writeFile(path.join(root, 'src', 'App.tsx'), 'export default () => <button>改过</button>;\n');
    await rm(path.join(root, 'src', 'Old.ts'));
    const changed = await repo.commitCandidate('candidate1', '混合改动');
    expect([...changed].sort()).toEqual(['src/App.tsx', 'src/New-file.v2.ts', 'src/Old.ts']);
    const commit = await repo.candidateCommit('candidate1');
    expect(await repo.fileAt(commit, 'src/New-file.v2.ts')).toContain('dotted = 1');
    expect(await repo.fileAt(commit, 'src/Old.ts')).toBeUndefined();
    expect(await repo.fileAt(commit, 'src/App.tsx')).toContain('改过');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a spaced path out of the staged set, as the existing allow-list requires', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    await writeFile(path.join(root, 'src', 'New file.ts'), 'export const spaced = 1;\n');
    await writeFile(path.join(root, 'src', 'App.tsx'), 'export default () => <button>改动</button>;\n');
    const changed = await repo.commitCandidate('candidate1', '忽略空格路径');
    expect(changed).toEqual(['src/App.tsx']);
    const commit = await repo.candidateCommit('candidate1');
    expect(await repo.fileAt(commit, 'src/New file.ts')).toBeUndefined();
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stages a pendingDiff intent-to-add file into the candidate commit', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    await writeFile(path.join(root, 'src', 'New.ts'), 'export const value = 42;\n');
    // Same order as the service: pendingDiff records the new file with `add -N`, then commitCandidate
    // stages it. The batch add never sees it because it is already in the index.
    const pending = await repo.pendingDiff('candidate1', base);
    expect(pending.changedFiles).toEqual(['src/New.ts']);
    expect(await repo.commitCandidate('candidate1', '新增文件')).toEqual(['src/New.ts']);
    const commit = await repo.candidateCommit('candidate1');
    expect(commit).not.toBe(base);
    expect(await repo.fileAt(commit, 'src/New.ts')).toContain('value = 42');
    expect(await repo.listTree(commit)).toContain('src/New.ts');
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('stages pendingDiff then commitCandidate for a mixed new, modified and deleted change set', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    await writeFile(path.join(workRoot, 'src', 'Old.ts'), 'export const old = 1;\n');
    const base = await repo.snapshot();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    await writeFile(path.join(root, 'src', 'New.ts'), 'export const fresh = 7;\n');
    await writeFile(path.join(root, 'src', 'App.tsx'), 'export default () => <button>再次</button>;\n');
    await rm(path.join(root, 'src', 'Old.ts'));
    const pending = await repo.pendingDiff('candidate1', base);
    expect([...pending.changedFiles].sort()).toEqual(['src/App.tsx', 'src/New.ts', 'src/Old.ts']);
    const changed = await repo.commitCandidate('candidate1', '混合改动');
    expect([...changed].sort()).toEqual(['src/App.tsx', 'src/New.ts', 'src/Old.ts']);
    const commit = await repo.candidateCommit('candidate1');
    expect(await repo.fileAt(commit, 'src/New.ts')).toContain('fresh = 7');
    expect(await repo.fileAt(commit, 'src/Old.ts')).toBeUndefined();
    expect(await repo.fileAt(commit, 'src/App.tsx')).toContain('再次');
    const tree = await repo.listTree(commit);
    expect(tree).toContain('src/New.ts');
    expect(tree).not.toContain('src/Old.ts');
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('reuses the validated snapshot listing across candidate creation, pending diff and commit', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const { version: base, listing } = await repo.snapshotWithListing();
    const originalMain = (repo as unknown as { main: (args: string[], allowFailure?: boolean) => Promise<{ code: number; stdout: string; stderr: string }> }).main.bind(repo);
    let lsTree = 0;
    (repo as unknown as { main: typeof originalMain }).main = async (args, allowFailure) => {
      if (args[0] === 'ls-tree') { lsTree += 1; throw new Error('listing was enumerated again'); }
      return originalMain(args, allowFailure);
    };
    const created = await repo.createCandidate('candidate1', base, listing);
    expect(created.directory).toBe(repo.candidatePath('candidate1'));
    await writeFile(path.join(created.directory, 'src', 'App.tsx'), 'export default () => <button>复用</button>;\n');
    const pending = await repo.pendingDiff('candidate1', base, undefined, created.listing);
    expect(pending.changedFiles).toEqual(['src/App.tsx']);
    expect(await repo.commitCandidate('candidate1', '复用清单', undefined, base, pending.baseline)).toEqual(['src/App.tsx']);
    expect(lsTree).toBe(0);
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('resolves workspace links through a junctioned node_modules and leaves the source untouched', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'spatial-deps-')));
  try {
    const modules = path.join(root, 'templates', 'product-page', 'node_modules');
    const scoped = path.join(modules, '@spatial');
    const pkg = path.join(root, 'packages', 'bridge');
    await mkdir(pkg, { recursive: true });
    await writeFile(path.join(pkg, 'index.js'), 'export const bridge = 1;\n');
    await mkdir(scoped, { recursive: true });
    // Same shape as pnpm's workspace link: a relative link four levels up from the scope.
    // Windows fix evidence: on Windows the old code resolved this through the junction's logical
    // path and failed; on POSIX relative links already resolve physically, so this case is only a
    // regression guard there.
    try {
      await symlink('../../../../packages/bridge', path.join(scoped, 'bridge'), 'dir');
    } catch (error) {
      throw new Error(`this regression needs directory symlink support (Developer Mode or SeCreateSymbolicLinkPrivilege): ${(error as Error).message}`);
    }

    const workRoot = path.join(root, 'work');
    await mkdir(path.join(workRoot, 'src'), { recursive: true });
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <main/>;\n');
    await symlink(modules, path.join(workRoot, 'node_modules'), 'junction');

    const repo = new WorkRepo({ workRoot, dataDirectory: path.join(root, 'data') });
    await repo.init();
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);

    const linked = path.join(repo.candidatePath('candidate1'), 'node_modules', '@spatial', 'bridge');
    expect(await realpath(linked)).toBe(await realpath(pkg));
    expect(await readFile(path.join(pkg, 'index.js'), 'utf8')).toContain('bridge = 1');

    await repo.removeCandidate('candidate1');
    // Removing the candidate only deletes the link it owns, never the real package.
    expect(await readFile(path.join(pkg, 'index.js'), 'utf8')).toContain('bridge = 1');
  } finally {
    const actual = await realpath(root);
    if (path.dirname(actual) !== await realpath(tmpdir())) throw new Error('refusing cleanup outside the owned temp root');
    await rm(actual, { recursive: true, force: true });
  }
});

it('keeps a plain node_modules working and still fails on an unknown broken dependency link', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'spatial-deps-plain-')));
  try {
    const workRoot = path.join(root, 'work');
    await mkdir(path.join(workRoot, 'src'), { recursive: true });
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'export default () => <main/>;\n');
    await mkdir(path.join(workRoot, 'node_modules', 'plain'), { recursive: true });
    await writeFile(path.join(workRoot, 'node_modules', 'plain', 'index.js'), 'export const plain = 1;\n');
    const repo = new WorkRepo({ workRoot, dataDirectory: path.join(root, 'data') });
    await repo.init();
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    expect(await realpath(path.join(repo.candidatePath('candidate1'), 'node_modules', 'plain')))
      .toBe(await realpath(path.join(workRoot, 'node_modules', 'plain')));
    await repo.removeCandidate('candidate1');

    // A link whose target disappeared is a real failure, not a silently skipped package.
    const brokenRoot = path.join(root, 'broken');
    await mkdir(path.join(brokenRoot, 'src'), { recursive: true });
    await writeFile(path.join(brokenRoot, 'src', 'App.tsx'), 'export default () => <main/>;\n');
    const gone = path.join(root, 'gone');
    await mkdir(gone, { recursive: true });
    await mkdir(path.join(brokenRoot, 'node_modules'), { recursive: true });
    await symlink(gone, path.join(brokenRoot, 'node_modules', 'broken'), 'junction');
    await rm(gone, { recursive: true, force: true });
    const brokenRepo = new WorkRepo({ workRoot: brokenRoot, dataDirectory: path.join(root, 'broken-data') });
    await brokenRepo.init();
    const brokenBase = await brokenRepo.head();
    await expect(brokenRepo.createCandidate('candidate1', brokenBase)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await brokenRepo.candidateExists('candidate1')).toBe(false);
  } finally {
    const actual = await realpath(root);
    if (path.dirname(actual) !== await realpath(tmpdir())) throw new Error('refusing cleanup outside the owned temp root');
    await rm(actual, { recursive: true, force: true });
  }
});

it('keeps the untruncated patch in the digest and preserves the legacy hash order', async () => {
  const { directory, workRoot, repo } = await fixture();
  try {
    const base = await repo.head();
    await repo.createCandidate('candidate1', base);
    const root = repo.candidatePath('candidate1');
    const lines = Array.from({ length: 1200 }, (_, index) => `export const value${index} = "${'x'.repeat(40)}";\n`).join('');
    await writeFile(path.join(root, 'src', 'Long.ts'), lines);
    const pending = await repo.pendingDiff('candidate1', base);
    expect(pending.changedFiles).toEqual(['src/Long.ts']);
    const diffOf = (file: string) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', 'diff', '--no-color', '--unified=3', base, '--', file], {
      cwd: root, encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    const full = diffOf('src/Long.ts');
    expect(full.length).toBeGreaterThan(60_000);
    expect(pending.diff[0].patch).toBe(`${full.slice(0, 60_000)}\n…（差异过长，已截断）`);

    // Independent restatement of the legacy order: base, then every file/length/content, then
    // every complete patch in the same file order.
    const expected = createHash('sha256').update(base);
    for (const file of pending.changedFiles) {
      const content = await readFile(path.join(root, file));
      expected.update(file).update(Buffer.from(String(content.byteLength))).update(content);
    }
    for (const file of pending.changedFiles) expected.update(diffOf(file));
    expect(pending.contentDigest).toBe(expected.digest('hex'));

    // Only the tail beyond the 60 000-character display cap changes.
    await writeFile(path.join(root, 'src', 'Long.ts'), lines.replace('value1199', 'value1199Changed'));
    expect((await repo.pendingDiff('candidate1', base)).contentDigest).not.toBe(pending.contentDigest);
    void workRoot;
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const GIT_IDENTITY = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Studio', '-c', 'user.email=studio@localhost', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false'];

function gitIn(repo: WorkRepo, args: string[], allowFailure = false): string {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  try {
    return execFileSync('git', [...GIT_IDENTITY, '--git-dir', repo.gitDir, '--work-tree', repo.workRoot, ...args], { cwd: repo.workRoot, encoding: 'utf8', env });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function countMain(repo: WorkRepo) {
  const calls: string[][] = [];
  const target = repo as unknown as { main: (args: string[], allowFailure?: boolean) => Promise<unknown> };
  const original = target.main.bind(repo);
  target.main = async (args, allowFailure) => { calls.push([...args]); return original(args, allowFailure); };
  return calls;
}

async function initFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'spatial-init-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src', 'App.tsx'), 'base\n');
  const repo = new WorkRepo({ workRoot, dataDirectory: path.join(root, 'data') });
  await repo.init();
  return { root, workRoot, repo, app: path.join(workRoot, 'src', 'App.tsx') };
}

function commitApp(repo: WorkRepo) {
  gitIn(repo, ['add', '--', 'src/App.tsx']);
  gitIn(repo, ['commit', '-q', '-m', 'change']);
}

/** Remove only the private temp root this test created, after proving its parent is tmpdir. */
async function cleanup(root: string) {
  const actual = await realpath(root);
  if (path.dirname(actual) !== await realpath(tmpdir())) throw new Error('refusing cleanup outside the owned temp root');
  await rm(actual, { recursive: true, force: true });
}

const aborted = (calls: string[][], name: 'merge' | 'revert') => calls.some(args => args[0] === name && args[1] === '--abort');

it('skips the two no-op aborts on a clean restart but keeps prune and the tree audit', async () => {
  const f = await initFixture();
  try {
    const calls = countMain(f.repo);
    await f.repo.init();
    expect(aborted(calls, 'merge')).toBe(false);
    expect(aborted(calls, 'revert')).toBe(false);
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'prune')).toBe(true);
    expect(calls.some(args => args[0] === 'ls-tree')).toBe(true);
    // The pre-existing existence probe is the free `git()` helper (one rev-parse) and is outside
    // this counter; the restart path itself must not add another one.
    expect(calls.some(args => args[0] === 'rev-parse')).toBe(false);
  } finally { await cleanup(f.root); }
});

it('aborts a real interrupted merge during init', async () => {
  const f = await initFixture();
  try {
    gitIn(f.repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(f.app, 'side\n'); commitApp(f.repo);
    gitIn(f.repo, ['checkout', '-q', 'main']);
    await writeFile(f.app, 'main\n'); commitApp(f.repo);
    gitIn(f.repo, ['merge', 'side'], true);
    expect(existsSync(path.join(f.repo.gitDir, 'MERGE_HEAD'))).toBe(true);
    await f.repo.init();
    expect(existsSync(path.join(f.repo.gitDir, 'MERGE_HEAD'))).toBe(false);
    expect(await readFile(f.app, 'utf8')).toBe('main\n');
    expect(gitIn(f.repo, ['status', '--porcelain']).trim()).toBe('');
  } finally { await cleanup(f.root); }
});

it('aborts a real interrupted single revert during init', async () => {
  const f = await initFixture();
  try {
    await writeFile(f.app, 'B\n'); commitApp(f.repo);
    await writeFile(f.app, 'C\n'); commitApp(f.repo);
    const target = gitIn(f.repo, ['rev-parse', 'HEAD~1']).trim();
    gitIn(f.repo, ['revert', '--no-edit', target], true);
    expect(existsSync(path.join(f.repo.gitDir, 'REVERT_HEAD'))).toBe(true);
    await f.repo.init();
    expect(existsSync(path.join(f.repo.gitDir, 'REVERT_HEAD'))).toBe(false);
    expect(await readFile(f.app, 'utf8')).toBe('C\n');
    expect(gitIn(f.repo, ['status', '--porcelain']).trim()).toBe('');
  } finally { await cleanup(f.root); }
});

it('aborts an interrupted multi-commit revert sequence during init', async () => {
  const f = await initFixture();
  try {
    await writeFile(f.app, 'B\n'); commitApp(f.repo);
    await writeFile(f.app, 'C\n'); commitApp(f.repo);
    const second = gitIn(f.repo, ['rev-parse', 'HEAD~1']).trim();
    const first = gitIn(f.repo, ['rev-parse', 'HEAD~2']).trim();
    gitIn(f.repo, ['revert', '--no-edit', second, first], true);
    expect(existsSync(path.join(f.repo.gitDir, 'sequencer'))).toBe(true);
    await f.repo.init();
    expect(existsSync(path.join(f.repo.gitDir, 'sequencer'))).toBe(false);
    expect(await readFile(f.app, 'utf8')).toBe('C\n');
    expect(gitIn(f.repo, ['status', '--porcelain']).trim()).toBe('');
  } finally { await cleanup(f.root); }
});

it('aborts an interrupted cherry-pick through the revert abort during init', async () => {
  const f = await initFixture();
  try {
    gitIn(f.repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(f.app, 'side\n'); commitApp(f.repo);
    gitIn(f.repo, ['checkout', '-q', 'main']);
    await writeFile(f.app, 'main\n'); commitApp(f.repo);
    gitIn(f.repo, ['cherry-pick', 'side'], true);
    expect(existsSync(path.join(f.repo.gitDir, 'CHERRY_PICK_HEAD'))).toBe(true);
    await f.repo.init();
    expect(existsSync(path.join(f.repo.gitDir, 'CHERRY_PICK_HEAD'))).toBe(false);
    expect(await readFile(f.app, 'utf8')).toBe('main\n');
    expect(gitIn(f.repo, ['status', '--porcelain']).trim()).toBe('');
  } finally { await cleanup(f.root); }
});

it('rereads the revert markers after the merge abort and skips the second abort', async () => {
  const f = await initFixture();
  try {
    gitIn(f.repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(f.app, 'side\n'); commitApp(f.repo);
    gitIn(f.repo, ['checkout', '-q', 'main']);
    await writeFile(f.app, 'main\n'); commitApp(f.repo);
    gitIn(f.repo, ['merge', 'side'], true);
    await writeFile(path.join(f.repo.gitDir, 'REVERT_HEAD'), `${gitIn(f.repo, ['rev-parse', 'HEAD']).trim()}\n`);
    expect(existsSync(path.join(f.repo.gitDir, 'MERGE_HEAD'))).toBe(true);
    expect(existsSync(path.join(f.repo.gitDir, 'REVERT_HEAD'))).toBe(true);
    const calls = countMain(f.repo);
    await f.repo.init();
    // merge --abort runs reset --merge, which removes MERGE_HEAD, REVERT_HEAD and CHERRY_PICK_HEAD.
    // The implementation reads the revert markers only after that call, so the second abort is skipped.
    expect(aborted(calls, 'merge')).toBe(true);
    expect(aborted(calls, 'revert')).toBe(false);
    expect(existsSync(path.join(f.repo.gitDir, 'MERGE_HEAD'))).toBe(false);
    expect(existsSync(path.join(f.repo.gitDir, 'REVERT_HEAD'))).toBe(false);
    expect(await readFile(f.app, 'utf8')).toBe('main\n');
    expect(gitIn(f.repo, ['status', '--porcelain']).trim()).toBe('');
  } finally { await cleanup(f.root); }
});

it('keeps the aborts when a marker cannot be read (unknown state)', async () => {
  const f = await initFixture();
  try {
    const target = f.repo as unknown as { markerState: (file: string) => Promise<string> };
    vi.spyOn(target, 'markerState').mockResolvedValue('unknown');
    const calls = countMain(f.repo);
    await f.repo.init();
    expect(aborted(calls, 'merge')).toBe(true);
    expect(aborted(calls, 'revert')).toBe(true);
  } finally { await cleanup(f.root); }
});

it('keeps the aborts when the ref backend is not proven files-based', async () => {
  const f = await initFixture();
  try {
    await mkdir(path.join(f.repo.gitDir, 'reftable'), { recursive: true });
    const calls = countMain(f.repo);
    await f.repo.init();
    expect(aborted(calls, 'merge')).toBe(true);
    expect(aborted(calls, 'revert')).toBe(true);
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'prune')).toBe(true);
  } finally { await cleanup(f.root); }
});

it('refuses before touching a conflicted work tree that contains a link', async () => {
  const f = await initFixture();
  try {
    gitIn(f.repo, ['checkout', '-q', '-b', 'side']);
    await writeFile(f.app, 'side\n'); commitApp(f.repo);
    gitIn(f.repo, ['checkout', '-q', 'main']);
    await writeFile(f.app, 'main\n'); commitApp(f.repo);
    gitIn(f.repo, ['merge', 'side'], true);
    const outside = path.join(f.root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(f.workRoot, 'src', 'link'), 'junction');
    await expect(f.repo.init()).rejects.toMatchObject({ code: 'UNSAFE_WORK_TREE' });
    expect(existsSync(path.join(f.repo.gitDir, 'MERGE_HEAD'))).toBe(true);
    expect(await readFile(f.app, 'utf8')).toContain('<<<<<<<');
  } finally { await cleanup(f.root); }
});

it('leaves a stale index.lock alone when there is nothing to abort', async () => {
  const f = await initFixture();
  try {
    const lock = path.join(f.repo.gitDir, 'index.lock');
    await writeFile(lock, '');
    const calls = countMain(f.repo);
    await f.repo.init();
    expect(aborted(calls, 'merge')).toBe(false);
    expect(aborted(calls, 'revert')).toBe(false);
    expect(calls.some(args => args[0] === 'worktree' && args[1] === 'prune')).toBe(true);
    expect(existsSync(lock)).toBe(true);
  } finally { await cleanup(f.root); }
});

it('falls back unless the config is a single plain version-0 files repository', async () => {
  const f = await initFixture();
  const config = path.join(f.repo.gitDir, 'config');
  const original = await readFile(config);
  const base = original.toString('utf8');
  const predicate = () => (f.repo as unknown as { filesBackedRefLayout: () => Promise<boolean> }).filesBackedRefLayout();
  const reset = async () => { await rm(config, { recursive: true, force: true }); await writeFile(config, original); };
  try {
    expect(await predicate()).toBe(true);

    const signals = [
      '[include]\n\tpath = ../shared\n',
      '[includeIf "gitdir:C:/x/"]\n\tpath = ../shared\n',
      '[extensions]\n\trefStorage = reftable\n',
      '[extensions]\n\tobjectFormat = sha256\n',
      '[extensions]\n\trefStorage\n',
      '[extensions] refStorage = reftable\n',
    ];
    for (const signal of signals) {
      await writeFile(config, `${base}\n${signal}`);
      expect(await predicate(), signal).toBe(false);
    }
    await reset();

    const variants = [
      base.replace(/^[ \t]*repositoryformatversion.*$/m, ''),
      `${base}\n[core]\n\trepositoryformatversion = 0\n`,
      `${base}\n[core]\n\trepositoryformatversion = 1 # duplicate with a comment\n`,
      base.replace(/^[ \t]*repositoryformatversion.*$/m, 'repositoryformatversion = 1'),
      base.replace(/^[ \t]*repositoryformatversion.*$/m, 'repositoryformatversion = 0 # note'),
    ];
    for (const variant of variants) {
      await writeFile(config, variant);
      expect(await predicate(), variant).toBe(false);
    }
    await reset();

    await rm(config, { force: true });
    expect(await predicate()).toBe(false);
    await reset();
    await rm(config, { force: true });
    await mkdir(config);
    expect(await predicate()).toBe(false);
    await reset();
    await writeFile(config, `${base}\n# ${'x'.repeat(70 * 1024)}\n`);
    expect(await predicate()).toBe(false);
    await reset();

    const copy = path.join(f.root, 'config-copy');
    await writeFile(copy, original);
    await rm(config, { force: true });
    try {
      await symlink(copy, config, 'file');
    } catch (error) {
      throw new Error(`this regression needs file symlink support (Developer Mode or SeCreateSymbolicLinkPrivilege): ${(error as Error).message}`);
    }
    expect(await predicate()).toBe(false);
    await reset();
    expect(await predicate()).toBe(true);
  } finally { await reset().catch(() => {}); await cleanup(f.root); }
});
