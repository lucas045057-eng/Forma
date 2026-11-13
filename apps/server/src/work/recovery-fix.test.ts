import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkRepo } from './repo.ts';
import { WorkService } from './service.ts';

it('only snapshots permitted work files and serializes concurrent snapshots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'repo-safe-'));
  await mkdir(path.join(root, 'work/src'), { recursive: true });
  const workRoot = path.join(root, 'work');
  await writeFile(path.join(workRoot, 'src/App.tsx'), '<div/>');
  for (const name of ['.env', '.env.local', 'private.key', 'backup.txt', 'src/App.tsx.bak', 'src/.env']) await writeFile(path.join(workRoot, name), 'FAKE-SENTINEL');
  const repo = new WorkRepo({ workRoot, dataDirectory: path.join(root, 'data') });
  try {
    await repo.init();
    const first = await repo.head();
    for (const name of ['.env', '.env.local', 'private.key', 'backup.txt', 'src/App.tsx.bak', 'src/.env']) expect(await repo.fileAt(first, name)).toBeUndefined();
    await writeFile(path.join(workRoot, 'src/App.tsx'), '<button/>');
    const heads = await Promise.all(Array.from({ length: 5 }, () => repo.snapshot()));
    expect(new Set(heads).size).toBe(1);
    expect(heads[0]).not.toBe(first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('recovers a committed adoption from durable intent without merging twice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'intent-'));
  const workRoot = path.join(root, 'work'), directory = path.join(root, 'data');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), 'before');
  const repo = new WorkRepo({ workRoot, dataDirectory: directory });
  await repo.init();
  const before = await repo.head();
  await repo.createCandidate('example1', before);
  await writeFile(path.join(repo.candidatePath('example1'), 'src/App.tsx'), 'after');
  await repo.commitCandidate('example1', 'edit');
  await writeFile(path.join(directory, 'tasks.json'), JSON.stringify({ tasks: [], adoptions: [], candidates: [{ id: 'example1', decision: 'pending' }], intent: { kind: 'adopt', id: 'example1', before } }));
  const committed = await repo.adopt('example1');
  const service = new WorkService({ workRoot, directory, agent: {}, emit: event => ({ ...event, seq: 1, ts: 'now' }) });
  try {
    await service.init();
    expect(service.getCandidate('example1').decision).toBe('adopted');
    expect((await service.version()).version).toBe(committed);
    await service.revert();
    expect(await readFile(path.join(workRoot, 'src/App.tsx'), 'utf8')).toBe('before');
    await expect(service.revert()).rejects.toMatchObject({ code: 'NO_ADOPTION' });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
