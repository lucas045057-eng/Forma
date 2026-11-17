/**
 * 独立 fake 云：Lux3D 10 个创建路由 + task get/list + Asset token + OUS 单文件/分片/status + 产物下载。
 *
 * 只监听 127.0.0.1，不接受真实外网；用于证明「我方契约」而不是证明云端真实行为。
 * 记录：每个 create 的请求体、token/OUS 请求头（用于断言密钥与上传凭证分离）、creates/gets 计数。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATA = path.join(ROOT, '.data', 'pi-lux3d');
const FIXTURES = path.join(DATA, 'fixtures');
const KEY = 'pi-fake-lux3d-key';
const OUS_TOKEN = 'pi-fake-ous-token';

const ROUTES = {
  'lux3d/v1/generate/img-to-3d/task/create': 'image-to-3d',
  'lux3d/v1/generate/text-to-3d/task/create': 'text-to-3d',
  'lux3d/v1/generate/multimodal-to-image/task/create': 'image',
  'lux3d/v1/generate/image-to-four-view/task/create': 'four-view',
  'lux3d/v1/generate/material-transfer/task/create': 'material-transfer',
  'lux3d/v1/part-split/task/create': 'part-split',
  'lux3d/v1/multi-format-export/task/create': 'export',
  'lux3d/v1/articulation-animation/task/create': 'articulation-animation',
  'lux3d/v1/animations/rig/task/create': 'humanoid-rig',
  'lux3d/v1/animations/retarget/task/create': 'animation-retarget',
};

const state = {
  scenario: 'success',
  blockSize: 4,
  creates: 0,
  createAttempts: 0,
  gets: 0,
  token: 0,
  ous: { single: 0, init: 0, part: 0, status: 0 },
  headers: { token: null, ous: null },
  createsLog: [],
  listQueries: [],
  tasks: new Map(),
  ousTasks: new Map(),
  order: 0,
};

const fixture = (name) => readFileSync(path.join(FIXTURES, name));
const json = (res, status, value) => {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};
const binary = (res, name, type = 'application/octet-stream') => {
  const bytes = fixture(name);
  res.writeHead(200, { 'content-type': type, 'content-length': bytes.length });
  res.end(bytes);
};

function modelFixture() {
  if (state.scenario === 'animated') return 'animated.glb';
  if (state.scenario === 'skinned') return 'skinned.glb';
  return 'triangle.glb';
}

function outputsFor(operation, body, host) {
  const base = `http://${host}`;
  const requested = Array.isArray(body.outputFormat) ? body.outputFormat.map(String) : [];
  const model = `${base}/output/${modelFixture()}`;
  const glb = { content: model };
  if (operation === 'image') return [{ content: `${base}/output/result.png` }];
  if (operation === 'four-view') return [{ content: JSON.stringify(['front', 'opposite', 'side', 'back'].map((view) => `${base}/output/result.png?view=${view}`)) }];
  if (operation === 'humanoid-rig') {
    if (state.scenario === 'rig-error') return [{ content: JSON.stringify({ error: { code: 'RIG_FAILED', message: 'mock rig failed' } }) }];
    return [glb];
  }
  if (operation === 'part-split' || operation === 'articulation-animation') return [glb];
  if (operation === 'animation-retarget') {
    const ids = Array.isArray(body.animationIds) ? body.animationIds.map(String) : ['Idle_Loop'];
    if (body.animationOutputMode === 'combined') return [{ content: JSON.stringify({ actions: [{ animation_ids: ids, status: 'success', animationGlbUrl: model }] }) }];
    return [{ content: JSON.stringify({ actions: ids.map((id, index) => (index === 0 && ids.length > 1
      ? { animation_id: id, status: 'failed', error: { code: 'MOCK_ACTION_FAILED', message: 'mock action failure' } }
      : { animation_id: id, status: 'success', animationGlbUrl: model })) }) }];
  }
  if (operation === 'material-transfer') {
    return ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'].map((format) => ({
      content: requested.includes(format) || (format === 'zip' && !requested.length) ? `${base}/output/model.${format === 'glb' ? 'glb' : 'zip'}` : 'NOT_REQUESTED',
    }));
  }
  if (operation === 'export') {
    return ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'].map((format) => ({
      content: requested.includes(format) ? `${base}/output/model.${format === 'stl' ? 'stl' : 'zip'}` : 'NOT_REQUESTED',
    }));
  }
  const formats = requested.length ? requested : ['zip'];
  return formats.map((format) => ({ content: `${base}/output/model.${format === 'glb' ? 'glb' : format === 'ply' ? 'ply' : 'zip'}` }));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname.replace(/^\//, '');

  if (route === '__counters') {
    return json(res, 200, {
      scenario: state.scenario, blockSize: state.blockSize,
      creates: state.creates, createAttempts: state.createAttempts, gets: state.gets, token: state.token, ous: state.ous,
      headers: state.headers, createsLog: state.createsLog, listQueries: state.listQueries,
    });
  }
  if (route === '__control') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (typeof body.scenario === 'string') state.scenario = body.scenario;
    if (Number.isFinite(body.blockSize)) state.blockSize = Number(body.blockSize);
    return json(res, 200, { ok: true, scenario: state.scenario, blockSize: state.blockSize });
  }
  if (route === '__reset') {
    state.creates = 0; state.createAttempts = 0; state.gets = 0; state.token = 0;
    state.ous = { single: 0, init: 0, part: 0, status: 0 };
    state.headers = { token: null, ous: null }; state.createsLog = []; state.listQueries = [];
    state.tasks.clear(); state.ousTasks.clear(); state.order = 0; state.scenario = 'success'; state.blockSize = 4;
    return json(res, 200, { ok: true });
  }

  if (route === 'asset/v1/token') {
    state.token += 1;
    state.headers.token = { authorization: req.headers.authorization ?? null, ousToken: req.headers['ous-token-v2'] ?? null };
    if (req.headers.authorization !== KEY) return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { ousToken: OUS_TOKEN, globalDomain: `http://${req.headers.host}`, blockSize: state.blockSize });
  }

  if (route.startsWith('ous/')) {
    const kind = route.endsWith('single/upload') ? 'single' : route.endsWith('block/upload/init') ? 'init'
      : route.endsWith('block/upload/part') ? 'part' : route.endsWith('upload/status') ? 'status' : null;
    if (!kind) return json(res, 404, { error: 'not found' });
    state.ous[kind] += 1;
    state.headers.ous = { ousToken: req.headers['ous-token-v2'] ?? null, authorization: req.headers.authorization ?? null };
    if (req.headers['ous-token-v2'] !== OUS_TOKEN) return json(res, 401, { error: 'bad ous token' });
    const body = await readBody(req);
    if (kind === 'single') {
      const id = `ous-single-${state.ous.single}`;
      state.ousTasks.set(id, { url: `http://${req.headers.host}/published/${id}`, status: 5 });
      return json(res, 200, { c: '0', d: { taskId: id } });
    }
    if (kind === 'init') {
      const id = state.ous.single + state.ous.init;
      state.ousTasks.set(String(id), { url: `http://${req.headers.host}/published/block-${id}`, status: 5, reads: 0 });
      return json(res, 200, { c: '0', d: { taskId: id, lackBlocks: null, progress: null, deduplicated: false } });
    }
    if (kind === 'part') return json(res, 200, { c: '0', d: null });
    const id = url.searchParams.get('taskId') ?? url.searchParams.get('taskid') ?? '';
    const record = state.ousTasks.get(String(id)) ?? { url: `http://${req.headers.host}/published/block-upload`, status: 5 };
    record.reads = (record.reads ?? 0) + 1;
    return json(res, 200, { c: '0', d: { status: 5, url: record.url, md5: '0'.repeat(32), uploadKey: 'mock/key', obsTaskId: String(id) } });
  }

  if (route.startsWith('published/')) {
    const body = Buffer.from('published-bytes');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    return res.end(body);
  }

  if (route.startsWith('output/')) {
    const name = route.slice('output/'.length);
    if (name === 'result.png') return binary(res, 'image.png', 'image/png');
    if (name === 'model.glb') return binary(res, modelFixture(), 'model/gltf-binary');
    if (name === 'model.zip') {
      if (state.scenario === 'zip-fail') return json(res, 403, { error: 'zip expired' });
      const bytes = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': bytes.length });
      return res.end(bytes);
    }
    if (name === 'model.stl') return res.end(Buffer.from('solid mock\nendsolid mock\n'));
    if (name === 'model.ply') return res.end(Buffer.from('ply\nformat ascii 1.0\nend_header\n'));
    const bytes = fixture(modelFixture());
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
    return res.end(bytes);
  }

  if (route === 'lux3d/v1/generate/task/list') {
    state.listQueries.push(Object.fromEntries(url.searchParams.entries()));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pagesize') ?? 20)));
    const status = url.searchParams.get('status');
    const items = [...state.tasks.entries()].map(([taskId, task]) => ({ taskId, status: task.status, created: task.created }))
      .filter((item) => status === null || item.status === Number(status))
      .sort((a, b) => b.created - a.created);
    return json(res, 200, { c: '0', d: { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize } });
  }

  if (route === 'lux3d/v1/generate/task/get') {
    state.gets += 1;
    if (req.headers.authorization !== KEY) return json(res, 401, { error: 'unauthorized' });
    const id = url.searchParams.get('taskid') ?? '';
    // fake 合同：未知/已被 reset 清除的 id 一律 404（与真实云的“任务不存在”同义），
    // 不能再返回 status 0，否则客户端会永远按“初始化中”轮询，占满槽位。
    if (!/^\d{1,20}$/.test(id) || !state.tasks.has(id)) return json(res, 404, { error: 'task not found' });
    const task = state.tasks.get(id);
    const reads = (task?.reads ?? 0) + 1;
    if (task) task.reads = reads;
    if (state.scenario === 'hold') return json(res, 200, { c: '0', d: { taskId: id, status: 1, outputs: [] } });
    const status = state.scenario === 'reject-status' ? 4 : reads === 1 ? 0 : reads === 2 ? 1 : 3;
    task.status = status;
    const outputs = status === 3 ? outputsFor(task.operation, task.body, req.headers.host) : [];
    return json(res, 200, { c: '0', d: { taskId: id, status, outputs } });
  }

  const createRoute = ROUTES[route];
  if (createRoute) {
    state.createAttempts += 1;
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    state.createsLog.push({ operation: createRoute, body });
    if (req.headers.authorization !== (route === 'asset/v1/token' ? KEY : KEY)) return json(res, 401, { error: 'unauthorized' });
    if (state.scenario === 'reject') return json(res, 400, { c: '-1', m: 'mock rejected', f: { message: 'mock rejected' } });
    if (state.scenario === 'forbid') return json(res, 403, { c: '-1', m: 'mock forbidden', f: { message: 'mock forbidden' } });
    const taskId = state.scenario === 'int64' ? '9223372036854775807' : String(9100000 + ++state.creates);
    state.order += 1;
    state.tasks.set(taskId, { operation: createRoute, body, status: 0, reads: 0, created: Date.now() - state.order });
    if (state.scenario === 'response-lost') {
      req.socket.destroy();
      return;
    }
    if (state.scenario === 'int64') return json(res, 200, '{"c":"0","d":9223372036854775807}');
    return json(res, 200, { c: '0', d: taskId });
  }

  return json(res, 404, { error: 'not found' });
});

const port = Number(process.env.FAKE_PORT ?? 4019);
mkdirSync(FIXTURES, { recursive: true });
const { writeFixtures } = await import('../fixtures/build.mjs');
if (!existsSync(path.join(FIXTURES, 'fixtures.json'))) {
  await writeFixtures(ROOT, FIXTURES);
  console.log('fixtures generated for the fake provider');
}
server.listen(port, '127.0.0.1', () => {
  console.log(`lux3d fake provider on http://127.0.0.1:${port} (loopback only)`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
