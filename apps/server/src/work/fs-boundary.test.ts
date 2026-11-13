import { expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkRepo } from './repo.ts';
import { PreviewManager } from './preview.ts';

it('serves work and candidate modules but denies workspace sentinel files via @fs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vite-boundary-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  const template = fileURLToPath(new URL('../../../../templates/product-page/', import.meta.url));
  await writeFile(path.join(workRoot, 'vite.config.ts'), await readFile(path.join(template, 'vite.config.ts')));
  await writeFile(path.join(workRoot, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(workRoot, 'index.html'), '<div id="root"></div><script type="module" src="/src/main.tsx"></script>');
  await writeFile(path.join(workRoot, 'src/main.tsx'), 'document.getElementById("root").textContent="safe";');
  async function links(source: string, dest: string) {
    await mkdir(dest, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) await links(path.join(source, entry), path.join(dest, entry));
      else await symlink(await realpath(path.join(source, entry)), path.join(dest, entry), 'junction');
    }
  }
  await links(path.join(template, 'node_modules'), path.join(workRoot, 'node_modules'));
  const files: string[] = [];
  for (const area of ['docs', 'orbital', '.data', 'apps/server']) {
    await mkdir(path.join(root, area), { recursive: true });
    const filename = path.join(root, area, 'sentinel.txt'); files.push(filename);
    await writeFile(filename, 'PRIVATE-SENTINEL');
  }
  const repo = new WorkRepo({ workRoot, dataDirectory: path.join(root, 'data') });
  const previews = new PreviewManager({ workRoot, cacheDirectory: path.join(root, 'cache'), startTimeoutMs: 15000 });
  try {
    await repo.init(); await repo.createCandidate('candidate1', await repo.head());
    for (const [id, directory] of [['current1', workRoot], ['candidate1', repo.candidatePath('candidate1')]]) {
      const base = await previews.start(id, directory);
      const origin = `http://127.0.0.1:${previews.port(id)}`;
      expect((await fetch(origin + base + 'src/main.tsx')).status).toBe(200);
      for (const filename of files) {
        const response = await fetch(origin + base + '@fs/' + encodeURI(filename.replaceAll('\\', '/')));
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain('PRIVATE-SENTINEL');
      }
    }
  } finally { await previews.stopAll(); await repo.removeCandidate('candidate1'); await rm(root, { recursive: true, force: true }); }
}, 45000);
