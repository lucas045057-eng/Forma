/**
 * 独立 fake 编码 Agent（OpenAI 兼容 chat completions + 工具调用），只监听 loopback。
 *
 * 用途：让「模型候选源码」这件事真实经过产品的 agent → diff → 审计链路，
 * 用于 R1 的正例（普通动态加载应放行）与负例（/src 绝对路径、glob 应拒绝）。
 * 不依赖产品内置 mock，也不判断审计结果；审计结论由被测服务给出。
 */
import { createServer } from 'node:http';

const KEY = 'pi-fake-agent-key';
const state = { scenario: 'positive', calls: 0, sessions: [] };

const SNIPPETS = {
  positive: [
    "export function mountBadge() {",
    "  const host = document.createElement('script');",
    "  host.type = 'application/json';",
    "  return host;",
    "}",
    "export const loadSection = () => import('./components/Button.tsx');",
    "export const lazySection = () => import('react').then((mod) => mod.lazy(() => import('./components/Button.tsx')));",
    '',
  ].join('\n'),
  'negative-absolute': [
    "import { SpatialModule } from '/src/spatial-module.tsx';",
    'export const hijack = SpatialModule;',
    '',
  ].join('\n'),
  'negative-glob': [
    "const modules = import.meta.glob('./scene-modules/*.json', { eager: true });",
    'export const names = Object.keys(modules);',
    '',
  ].join('\n'),
};

const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (call, calls, content = null) => ({
  id: `chatcmpl-pi-fake-${call}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'pi-fake-coder',
  choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
});

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (status, value) => {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (url.pathname === '/__scenario') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!Object.hasOwn(SNIPPETS, body.scenario)) return send(400, { ok: false, scenarios: Object.keys(SNIPPETS) });
    state.scenario = body.scenario;
    state.calls = 0;
    return send(200, { ok: true, scenario: state.scenario });
  }
  if (url.pathname === '/__stats') {
    return send(200, { scenario: state.scenario, calls: state.calls, sessions: state.sessions.length });
  }
  if (url.pathname !== '/chat/completions') return send(404, { error: 'not found' });

  const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  const session = String(req.headers['x-opencode-session'] ?? '');
  if (session) state.sessions.push(session);
  state.calls += 1;
  const call = state.calls;
  const authorized = req.headers.authorization === `Bearer ${KEY}`;
  if (!authorized) return send(401, { error: { message: 'invalid fake agent key' } });
  if (call === 1) {
    return send(200, response(call, [tool('write-1', 'write_file', { path: 'src/panels/notes.ts', content: SNIPPETS[state.scenario] })]));
  }
  return send(200, response(call, [tool('finish-1', 'finish', { summary: `fake agent scenario ${state.scenario}` })]));
});

const port = Number(process.env.AGENT_PORT ?? 4018);
server.listen(port, '127.0.0.1', () => console.log(`lux3d fake agent on http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
