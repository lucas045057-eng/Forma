/**
 * 极简的「剧本化」Lux3D 上游，只补 CodeBuddy 的 mock 覆盖不到的情形：
 * - 并发超限（create 返回 c = "GENERATION_CONCURRENCY_LIMIT_EXCEEDED"）
 * - create 返回 HTTP 500（提交结果不明）
 * - 任务成功但没有 GLB 输出（NO_GLB 分支）
 *
 * 用 node:http 手写，不依赖任何包。行为由 STUB_MODE 决定。
 */
import { createServer } from 'node:http';

const mode = process.env.STUB_MODE ?? 'concurrency';
const port = Number(process.env.STUB_PORT ?? 4020);
const counters = { creates: 0, gets: 0 };
const TASK_ID = '7770001';

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const pathname = url.pathname;

  if (pathname === '/__stats') return send(response, 200, counters);

  if (/^\/lux3d\/v1\/(generate\/(text|img)-to-3d|part-split)\/task\/create$/.test(pathname)) {
    counters.creates += 1;
    if (mode === 'create-500') return send(response, 500, { message: 'internal error' });
    if (mode === 'concurrency') return send(response, 200, { c: 'GENERATION_CONCURRENCY_LIMIT_EXCEEDED', d: null });
    return send(response, 200, { c: '0', d: TASK_ID });
  }

  if (pathname === '/lux3d/v1/generate/task/get') {
    counters.gets += 1;
    if (mode === 'no-glb') {
      return send(response, 200, {
        c: '0',
        d: { status: 3, outputs: [{ content: `http://${request.headers.host}/output/model.mp4` }] },
      });
    }
    return send(response, 200, { c: '0', d: { status: 0, outputs: [] } });
  }

  if (pathname === '/lux3d/v1/generate/task/list') return send(response, 200, { c: '0', d: [] });

  return send(response, 404, { message: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`pi-m0a stub upstream on ${port} (${mode})`));
