import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Sandbox } from './tools.ts';
import { CodingAgent } from './client.ts';

it('rejects Windows device/ambiguous paths and case variants of invalid scene configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sandbox-r5-'));
  await mkdir(path.join(root, 'src'));
  try {
    const sandbox = new Sandbox(root);
    for (const filename of ['src/CON.ts', 'src/LPT1.txt', 'src/folder./x.ts', 'src/a.ts:stream', 'src/scene.CONFIG.json']) {
      await expect(sandbox.write(filename, '{}')).rejects.toThrow();
    }
    await rm(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, 'src'), 'junction');
    await expect(sandbox.list()).rejects.toThrow('符号链接');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects oversized responses and overlong tool batches before writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-limits-'));
  try {
    for (const payload of ['x'.repeat(1_000_001), JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: Array.from({ length: 17 }, (_, i) => ({ id: String(i), function: { name: 'finish', arguments: '{"summary":"done"}' } })) } }] })]) {
      const agent = new CodingAgent({ baseUrl: 'http://127.0.0.1:1', apiKey: 'fake', model: 'mock', fetch: async () => new Response(payload) });
      await expect(agent.run({ taskId: 'test', root, instruction: 'test' })).rejects.toMatchObject({ code: 'AGENT_LIMIT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('does not finish a tool batch after its overall deadline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-timeout-'));
  try {
    const agent = new CodingAgent({ baseUrl: 'http://127.0.0.1:1', apiKey: 'fake', model: 'mock', timeoutMs: 30,
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'finish', arguments: '{"summary":"done"}' } }] } }] })),
      onStep: async message => { if (message.includes('finish')) await new Promise(resolve => setTimeout(resolve, 50)); },
    });
    await expect(agent.run({ taskId: 'test', root, instruction: 'test' })).rejects.toMatchObject({ code: 'AGENT_TIMEOUT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
