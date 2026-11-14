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
