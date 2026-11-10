import { randomUUID } from 'node:crypto';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

export class InstanceLockedError extends Error {
  code = 'INSTANCE_LOCKED';
  constructor(directory: string, pid: number) {
    super(`资产目录已被另一个后端实例占用（pid ${pid}）：${directory}。请先停止该实例；确认没有实例在运行时可删除目录下的 .instance.lock`);
  }
}
const LOCK = '.instance.lock';
// Directories held by this process: a lock file carrying our own pid is live only if listed here.
const held = new Set<string>();
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Exclusive per-directory lock taken before any cleanup, index write or job recovery, so a
 * second backend or CLI started by mistake can never touch the first instance's files.
 * A lock left by a dead process is replaced; a live owner makes startup fail.
 */
export async function acquireInstanceLock(directory: string): Promise<() => Promise<void>> {
  const key = path.resolve(directory), file = path.join(key, LOCK), token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(file, 'wx');
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })); }
      finally { await handle.close(); }
      held.add(key);
      return async () => {
        held.delete(key);
        try { if (JSON.parse(await readFile(file, 'utf8')).token === token) await rm(file, { force: true }); }
        catch { /* Already gone or replaced: nothing of ours to remove. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let owner: { pid?: unknown } = {};
    try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { /* Unreadable or half-written lock. */ }
    const pid = typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) ? owner.pid : 0;
    const live = pid > 0 && (pid === process.pid ? held.has(key) : alive(pid));
    if (live || attempt >= 2) throw new InstanceLockedError(key, pid);
    // An unparsable lock may be another starter mid-write: wait once before treating it as stale.
    if (pid > 0 || attempt >= 1) await rm(file, { force: true });
    else await new Promise(resolve => setTimeout(resolve, 50));
  }
}
