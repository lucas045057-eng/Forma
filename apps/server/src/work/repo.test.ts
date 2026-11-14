import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
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
