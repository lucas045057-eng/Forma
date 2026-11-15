import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Call only while holding the directory's instance lock (see instance-lock.ts): the name
// patterns identify pipeline temporaries, the lock proves no live writer still owns them.
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
      // A hard-killed parent cannot run process-isolated's finally. The instance lock proves
      // no live writer owns this precisely named staging directory; links are not directories.
      if (file.isDirectory() && file.name.startsWith('.model-stage-')) await rm(join(folder, file.name), { recursive: true, force: true });
    }
  }
}
