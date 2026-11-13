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
