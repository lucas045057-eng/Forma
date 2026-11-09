import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Run only during single-process service startup, before jobs or index writes begin.
export async function cleanupAssetTemporaries(directory: string) {
  const suffix = '(?:\\.[0-9a-f-]{36})?\\.tmp';
  const index = new RegExp(`^index\\.json${suffix}$`);
  const asset = new RegExp(`^(?:raw\\.glb|model\\.glb|parts\\.json)${suffix}$`);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && index.test(entry.name)) await rm(join(directory, entry.name));
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.name)) continue;
    const folder = join(directory, entry.name);
    for (const file of await readdir(folder, { withFileTypes: true })) {
      if (file.isFile() && asset.test(file.name)) await rm(join(folder, file.name));
    }
  }
}
