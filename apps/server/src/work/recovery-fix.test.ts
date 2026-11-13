import { expect, it, vi } from 'vitest';
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
    const links = vi.spyOn(repo as unknown as { linkDependencies: () => Promise<void> }, 'linkDependencies').mockRejectedValueOnce(new Error('link failure'));
    await expect(repo.createCandidate('broken1', heads[0])).rejects.toThrow('link failure');
    expect(await repo.candidateExists('broken1')).toBe(false);
    links.mockRestore();
    await repo.createCandidate('broken1', heads[0]);
    expect(await repo.candidateExists('broken1')).toBe(true);
    await repo.removeCandidate('broken1');
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
    const concurrent = await Promise.allSettled([service.revert(), service.revert(), service.version()]);
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    expect(concurrent.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await readFile(path.join(workRoot, 'src/App.tsx'), 'utf8')).toBe('before');
    await expect(service.revert()).rejects.toMatchObject({ code: 'NO_ADOPTION' });
    const nextBase = (await service.version()).version;
    await repo.createCandidate('example2', nextBase);
    await writeFile(path.join(repo.candidatePath('example2'), 'src/App.tsx'), 'second');
    await repo.commitCandidate('example2', 'second edit');
    await service.close();
    const saved = JSON.parse(await readFile(path.join(directory, 'tasks.json'), 'utf8'));
    saved.candidates.push({ id: 'example2', decision: 'pending' });
    await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(saved));
    const resumed = new WorkService({ workRoot, directory, agent: {}, emit: event => ({ ...event, seq: 2, ts: 'now' }) });
    try {
      await resumed.init();
      const operations = await Promise.allSettled([resumed.adopt('example2'), resumed.discard('example2'), resumed.version()]);
      expect(operations.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
      expect(resumed.getCandidate('example2').decision).toBe('adopted');
      expect(await readFile(path.join(workRoot, 'src/App.tsx'), 'utf8')).toBe('second');
    } finally { await resumed.close(); }
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
