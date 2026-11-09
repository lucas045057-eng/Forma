import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';

export async function writeAtomic(filename: string, content: string | Uint8Array, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const temporaryPath = `${filename}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, 'wx');
  try {
    await file.writeFile(content);
    signal?.throwIfAborted();
    await file.close();
    signal?.throwIfAborted();
    await rename(temporaryPath, filename);
  } finally {
    await file.close();
    await rm(temporaryPath, { force: true });
  }
}
