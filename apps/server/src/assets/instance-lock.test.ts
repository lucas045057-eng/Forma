import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireInstanceLock } from './instance-lock.ts';
import { AssetService } from './service.ts';
import { Lux3DClient } from './lux3d.ts';

const temporary = 'index.json.12345678-1234-1234-1234-123456789abc.tmp';
it('refuses a second instance before it can clean the temporary files of the first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-lock-'));
  const client = new Lux3DClient({ base: 'http://127.0.0.1:9', key: 'mock-only' });
  const first = new AssetService({ directory, client });
  try {
    await first.init();
    await writeFile(join(directory, temporary), 'in-flight write of the first instance');
    const second = new AssetService({ directory, client });
    await expect(second.init()).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(await readdir(directory)).toContain(temporary);
    await second.close();
    // Closing the refused instance must not release the lock of the first.
    await expect(acquireInstanceLock(directory)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    await first.close();
    const third = new AssetService({ directory, client });
    await third.init();
    expect(await readdir(directory)).not.toContain(temporary);
    await third.close();
    expect(await readdir(directory)).not.toContain('.instance.lock');
  } finally { await first.close(); await rm(directory, { recursive: true, force: true }); }
});

it('replaces locks left by dead or unreadable owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'asset-lock-'));
  try {
    await writeFile(join(directory, '.instance.lock'), JSON.stringify({ pid: 2 ** 30, token: 'dead' }));
    await (await acquireInstanceLock(directory))();
    await writeFile(join(directory, '.instance.lock'), '{half');
    await (await acquireInstanceLock(directory))();
    await writeFile(join(directory, '.instance.lock'), JSON.stringify({ pid: process.pid, token: 'crashed-earlier-run' }));
    const release = await acquireInstanceLock(directory);
    await expect(acquireInstanceLock(directory)).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    await release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
