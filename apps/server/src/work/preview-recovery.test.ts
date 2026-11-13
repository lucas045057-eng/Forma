import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PreviewManager } from './preview.ts';

it('handles spawn failure and closes a preview when its owning parent is killed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'preview-ipc-'));
  await mkdir(path.join(root, 'node_modules/vite/bin'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'node_modules/vite/package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'node_modules/vite/bin/vite.js'), 'import {createServer} from "node:http";createServer((q,s)=>s.end("ok")).listen(Number(process.env.PREVIEW_PORT),"127.0.0.1");');
  const manager = new PreviewManager({ workRoot: root, cacheDirectory: path.join(root, 'cache'), startTimeoutMs: 3000 });
  const runner = path.join(root, 'runner.mjs');
  await writeFile(runner, `import {PreviewManager} from ${JSON.stringify(new URL('./preview.ts', import.meta.url).href)};const m=new PreviewManager({workRoot:${JSON.stringify(root)},cacheDirectory:${JSON.stringify(path.join(root, 'cache'))}});await m.start('example1',${JSON.stringify(root)});console.log('PORT='+m.port('example1'));`);
  const parent = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<void>(resolve => parent.once('close', () => resolve()));
  let output = ''; parent.stdout!.on('data', chunk => { output += chunk; }); parent.stderr!.on('data', () => {});
  try {
    await expect(manager.start('missing1', path.join(root, 'missing'))).rejects.toThrow();
    await manager.stopAll();
    await vi.waitFor(() => expect(output).toMatch(/PORT=\d+/), { timeout: 10000 });
    const port = Number(/PORT=(\d+)/.exec(output)![1]);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    parent.kill('SIGKILL'); await exited;
    await vi.waitFor(async () => { await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(); }, { timeout: 10000 });
  } finally { parent.kill('SIGKILL'); await exited; await manager.stopAll(); await rm(root, { recursive: true, force: true }); }
}, 20000);
