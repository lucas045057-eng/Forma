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
