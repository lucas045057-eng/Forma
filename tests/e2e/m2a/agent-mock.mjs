/**
 * 可脚本化的 OpenAI 兼容 mock 上游（M2-A 测试专用，无第三方依赖）。
 *
 * - `POST /chat/completions`：按 session 的调用轮次返回脚本里预置的工具调用；
 *   脚本用完之后返回 finish。校验假 Bearer key 与 `x-opencode-session`。
 * - `POST /__script {steps, delayMs}`：设置脚本并重置计数。steps 是「每轮的 tool_calls」数组。
 * - `POST /__reset`：清空 session 记录与计数（不改脚本）。
 * - `GET /__stats`：{calls, sessions, keys, steps}。
 *
 * 默认脚本 = success：读 src/App.tsx → 把「立即购买」换成「马上购买」→ finish。
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4011);
const KEY = process.env.MOCK_KEY ?? 'mock-only';

const SUCCESS = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: '已把首屏购买按钮改为「马上购买」' } }],
];

let steps = SUCCESS;
let delayMs = 0;
let mode = 'normal';
let counters = new Map();
let sessions = [];
let keys = [];

const call = (index, calls, summary) => ({
  id: `chatcmpl-mock-${index}`,
  object: 'chat.completion',
  created: Math.floor(Date.now() / 1000),
  model: 'mock-coder',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: calls.length ? null : `脚本结束：${summary}`,
      tool_calls: calls.map((entry, position) => ({
        id: `call-${index}-${position}`,
        type: 'function',
        function: { name: entry.name, arguments: JSON.stringify(entry.args ?? {}) },
      })),
    },
    finish_reason: calls.length ? 'tool_calls' : 'stop',
  }],
});

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch { resolve({}); } });
  });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

  if (url.pathname === '/__script' && request.method === 'POST') {
    const body = await readBody(request);
    if (Array.isArray(body.steps)) steps = body.steps;
    if (Number.isFinite(body.delayMs)) delayMs = Number(body.delayMs);
    if (typeof body.mode === 'string') mode = body.mode;
    counters = new Map();
    sessions = [];
    keys = [];
    return send(response, 200, { ok: true, steps: steps.length, delayMs, mode });
  }
  if (url.pathname === '/__reset' && request.method === 'POST') {
    counters = new Map();
    sessions = [];
    keys = [];
    return send(response, 200, { ok: true });
  }
  if (url.pathname === '/__stats') {
    const total = [...counters.values()].reduce((sum, value) => sum + value, 0);
    return send(response, 200, { calls: total, sessions, keys, steps: steps.length, delayMs, mode });
  }

  if (url.pathname === '/chat/completions' && request.method === 'POST') {
    const authorization = request.headers.authorization;
    keys.push(authorization ?? null);
    if (authorization !== `Bearer ${KEY}`) return send(response, 401, { error: { message: 'invalid mock key' } });
    const session = request.headers['x-opencode-session'];
    if (typeof session !== 'string' || !session) return send(response, 400, { error: { message: 'missing session' } });
    sessions.push(session);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (mode === 'error') return send(response, 500, { error: { message: 'scripted upstream failure' } });
    const index = (counters.get(session) ?? 0) + 1;
    counters.set(session, index);
    if (mode === 'text') {
      return send(response, 200, {
        id: `chatcmpl-mock-${index}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'mock-coder',
        choices: [{ index: 0, message: { role: 'assistant', content: '我不会调用工具' }, finish_reason: 'stop' }],
      });
    }
    const step = steps[index - 1];
    if (!step || step.length === 0) return send(response, 200, call(index, [], '脚本已完成'));
    return send(response, 200, call(index, step));
  }

  return send(response, 404, { error: { message: 'not found' } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`m2a agent mock on ${PORT} (key=${KEY})`));
