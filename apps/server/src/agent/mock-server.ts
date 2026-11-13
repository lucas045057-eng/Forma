import Fastify, { type FastifyInstance } from 'fastify';
import { setTimeout as delay } from 'node:timers/promises';

export type MockScenario = 'success' | 'timeout' | 'error' | 'escape' | 'no-tools';
export interface CodingAgentMock extends FastifyInstance {
  sessions: string[];
  setScenario: (scenario: MockScenario) => void;
}

function tool(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function response(call: number, calls: ReturnType<typeof tool>[], content: string | null = null) {
  return { id: `chatcmpl-mock-${call}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock-coder', choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }] };
}

/** Scriptable OpenAI-compatible upstream. It never needs or contacts a real provider. */
export async function createCodingAgentMock(options: { key?: string; scenario?: MockScenario; delayMs?: number } = {}): Promise<CodingAgentMock> {
  const app = Fastify({ logger: false }) as unknown as CodingAgentMock;
  const key = options.key ?? 'mock-only';
  let scenario = options.scenario ?? 'success';
  const calls = new Map<string, number>();
  app.sessions = [];
  app.setScenario = next => { scenario = next; calls.clear(); };
  app.post<{ Body: { messages?: Array<{ content?: string }> } }>('/chat/completions', async (request, reply) => {
    if (request.headers.authorization !== `Bearer ${key}`) return reply.code(401).send({ error: { message: 'invalid mock key' } });
    const session = request.headers['x-opencode-session'];
    if (typeof session !== 'string' || !session) return reply.code(400).send({ error: { message: 'missing session' } });
    app.sessions.push(session);
    const call = (calls.get(session) ?? 0) + 1;
    calls.set(session, call);
    if (scenario === 'timeout' || options.delayMs) await delay(options.delayMs ?? 1000);
    if (scenario === 'error') return reply.code(500).send({ error: { message: 'scripted upstream failure' } });
    if (scenario === 'no-tools') return response(call, [], '我不会调用工具');
    if (scenario === 'escape') {
      if (call === 1) return response(call, [tool('escape-1', 'write_file', { path: '../outside.ts', content: 'bad' })]);
      return response(call, [tool('escape-2', 'finish', { summary: '越界写入已被沙箱拒绝' })]);
    }
    if (call === 1) return response(call, [tool('read-1', 'read_file', { path: 'src/App.tsx' })]);
    if (call === 2) return response(call, [tool('replace-1', 'replace_in_file', { path: 'src/App.tsx', old: '立即购买', new: '马上购买' })]);
    return response(call, [tool('finish-1', 'finish', { summary: '已将首屏购买按钮改为“马上购买”' })]);
  });
  app.post<{ Body: { scenario?: MockScenario } }>('/__scenario', async request => {
    const next = request.body?.scenario;
    if (!['success', 'timeout', 'error', 'escape', 'no-tools'].includes(next ?? '')) return { ok: false };
    app.setScenario(next!);
    return { ok: true };
  });
  app.get('/__stats', async () => ({ calls: [...calls.values()].reduce((sum, value) => sum + value, 0), scenario, sessions: app.sessions }));
  return app;
}
