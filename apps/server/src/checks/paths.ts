import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Check every existing component before an operation can follow a junction. */
export async function assertPlainPath(target: string, denied: () => Error, allowMissing = false): Promise<void> {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || path.relative(current, await realpath(current)) !== '') throw denied();
  }
}

/** Read a regular file through one bounded handle, checking its path again afterwards. */
export async function readPlainFile(file: string, maxBytes: number, denied: () => Error, tooLarge: () => Error, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  await assertPlainPath(file, denied);
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw denied();
    if (opened.size > maxBytes) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await assertPlainPath(file, denied);
    signal?.throwIfAborted();
    const linked = await lstat(file);
    if (!linked.isFile() || linked.dev !== opened.dev || linked.ino !== opened.ino) throw denied();
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}
