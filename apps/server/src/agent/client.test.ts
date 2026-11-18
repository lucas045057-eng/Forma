import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CodingAgent, codingAgentEndpoint } from './client.ts';
import { createCodingAgentMock, type MockScenario } from './mock-server.ts';
import { listenForFetch } from '../test-support/fetch-listener.ts';

async function fixture(scenario: MockScenario = 'success', delayMs?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'spatial-agent-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.tsx'), '<button>立即购买</button>\n');
  const { mock, baseUrl } = await listenForFetch(() => createCodingAgentMock({ scenario, delayMs }));
  const agent = new CodingAgent({ baseUrl, apiKey: 'mock-only', model: 'mock-coder', timeoutMs: 1000 });
  return { root, mock, agent, baseUrl };
}

it('runs OpenAI-compatible tool calls with a stable session and writes only through the sandbox', async () => {
  const { root, mock, baseUrl } = await fixture();
  try {
    const steps: string[] = [];
    const running = new CodingAgent({ baseUrl, apiKey: 'mock-only', model: 'mock-coder', onStep: message => { steps.push(message); } });
    const result = await running.run({ taskId: 'task-session', instruction: '修改按钮', root });
    expect(result.summary).toContain('马上购买');
    expect(result.written).toEqual(['src/App.tsx']);
    expect(await readFile(path.join(root, 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    expect(mock.sessions).toEqual(['task-session', 'task-session', 'task-session']);
    expect(steps.some(step => step.includes('replace_in_file'))).toBe(true);
  } finally { await mock.close(); await rm(root, { recursive: true, force: true }); }
});

it('returns an attempted path escape to the model without creating the outside file', async () => {
  const { root, mock, agent } = await fixture('escape');
  try {
    await agent.run({ taskId: 'escape-task', instruction: '越界', root });
    expect(await readFile(path.join(root, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
  } finally { await mock.close(); await rm(root, { recursive: true, force: true }); }
});

it('enforces the total timeout and supports cancellation', async () => {
  const timeout = await fixture('success', 250);
  try {
    const agent = new CodingAgent({ baseUrl: timeout.baseUrl, apiKey: 'mock-only', model: 'mock-coder', timeoutMs: 80 });
    await expect(agent.run({ taskId: 'slow', instruction: 'test', root: timeout.root })).rejects.toMatchObject({ code: 'AGENT_TIMEOUT' });
  } finally { await timeout.mock.close(); await rm(timeout.root, { recursive: true, force: true }); }
  const cancelled = await fixture('success', 250);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    await expect(cancelled.agent.run({ taskId: 'cancel', instruction: 'test', root: cancelled.root, signal: controller.signal })).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    clearTimeout(timer);
  } finally { await cancelled.mock.close(); await rm(cancelled.root, { recursive: true, force: true }); }
});

it('fails closed on upstream errors, missing tool calls and insecure remote configuration', async () => {
  const failed = await fixture('error');
  try {
    await expect(failed.agent.run({ taskId: 'error', instruction: 'test', root: failed.root })).rejects.toMatchObject({ code: 'AGENT_UPSTREAM' });
  } finally { await failed.mock.close(); await rm(failed.root, { recursive: true, force: true }); }
  const noTools = await fixture('no-tools');
  try {
    await expect(noTools.agent.run({ taskId: 'plain', instruction: 'test', root: noTools.root })).rejects.toMatchObject({ code: 'AGENT_PROTOCOL' });
  } finally { await noTools.mock.close(); await rm(noTools.root, { recursive: true, force: true }); }
  expect(() => codingAgentEndpoint('http://example.com/v1')).toThrow('HTTPS');
  expect(codingAgentEndpoint('https://example.com/v1')).toBe('https://example.com/v1/chat/completions');
});

it('attaches distinct ancestor component sources alongside a picked child component in the initial prompt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spatial-agent-ancestors-'));
  await mkdir(path.join(root, 'src', 'components'), { recursive: true });
  await writeFile(path.join(root, 'src', 'components', 'Button.tsx'), 'export const Button = () => <button>立即购买</button>;\n');
  await writeFile(path.join(root, 'src', 'App.tsx'), 'import { Button } from "./components/Button";\nexport default () => <div className="actions"><Button/></div>;\n');

  const capturedPayloads: Array<Record<string, unknown>> = [];
  const customFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
    const userMsg = body.messages?.find(item => item.role === 'user');
    if (userMsg?.content) capturedPayloads.push(JSON.parse(userMsg.content) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'done-1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: '已读取上下文' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const agent = new CodingAgent({ baseUrl: 'http://127.0.0.1:49999', apiKey: 'mock-only', model: 'mock-coder', fetch: customFetch });
    await agent.run({
      taskId: 'ancestor-task',
      instruction: '把购买区往下挪一点',
      root,
      selection: {
        src: 'src/components/Button.tsx:1:29',
        baseVersion: 'v1',
        cid: 'Button',
        text: '立即购买',
        bbox: [0, 0, 100, 40],
        styles: {
          display: 'inline-block', position: 'static', color: '#000', backgroundColor: '#fff',
          fontSize: '16px', fontFamily: 'sans-serif', fontWeight: '400', lineHeight: '20px',
          padding: '8px', margin: '0px', borderRadius: '4px', width: '100px', height: '40px',
        },
        instances: 3,
        ancestors: ['src/components/Button.tsx:1:29', 'src/App.tsx:2:22', 'src/Missing.tsx:1:1'],
      },
    });

    expect(capturedPayloads).toHaveLength(1);
    expect(capturedPayloads[0].selectedFileWithLineNumbers).toContain('1\texport const Button');
    const related = capturedPayloads[0].relatedAncestorFilesWithLineNumbers as Record<string, string>;
    expect(Object.keys(related)).toEqual(['src/App.tsx']);
    expect(related['src/App.tsx']).toContain('2\texport default () => <div className="actions"><Button/></div>;');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('automatically attaches src/App.tsx and wrapper guidance when user picks a managed SpatialModule', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'spatial-agent-managed-pick-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'spatial-module.tsx'), 'export function SpatialModule() { return <div/>; }\n');
  await writeFile(path.join(root, 'src', 'App.tsx'), 'import SpatialModelaaaa from "./scene-modules/aaaa.tsx";\nexport default () => <main><SpatialModelaaaa/></main>;\n');

  let systemContent = '';
  let userPayload: Record<string, unknown> = {};
  const customFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
    systemContent = body.messages?.find(item => item.role === 'system')?.content ?? '';
    userPayload = JSON.parse(body.messages?.find(item => item.role === 'user')?.content ?? '{}') as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-2',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'done-2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: '完成' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  try {
    const agent = new CodingAgent({ baseUrl: 'http://127.0.0.1:49999', apiKey: 'mock-only', model: 'mock-coder', fetch: customFetch });
    await agent.run({
      taskId: 'managed-pick',
      instruction: '定格这个3D动画，别让它随滚轮滑动',
      root,
      selection: {
        src: 'src/spatial-module.tsx:1:35',
        baseVersion: 'v1',
        cid: 'SpatialModule',
        text: '',
        bbox: [0, 0, 400, 400],
        styles: {
          display: 'block', position: 'relative', color: '#000', backgroundColor: '#fff',
          fontSize: '16px', fontFamily: 'sans-serif', fontWeight: '400', lineHeight: '20px',
          padding: '0px', margin: '0px', borderRadius: '0px', width: '400px', height: '400px',
        },
        instances: 1,
        ancestors: ['src/spatial-module.tsx:1:1'],
      },
    });
    expect(systemContent).toContain('pointerEvents');
    const related = userPayload.relatedAncestorFilesWithLineNumbers as Record<string, string>;
    expect(related['src/App.tsx']).toContain('<SpatialModelaaaa/>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
