import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';

export type MockScenario = 'success' | 'failed' | 'cancelled' | 'expired403' | 'expired404' | 'timeout' | 'unknown' | 'response-lost' | 'truncated' | 'drip' | 'int64';

const ROUTES: Array<{ route: string; operation: string; required: string[]; allow?: string[] }> = [
  { route: 'generate/img-to-3d/task/create', operation: 'image-to-3d', required: ['version', 'outputFormat'], allow: ['img', 'imgs', 'version', 'faceCount', 'outputFormat', 'enablePbr', 'aiPredictSize'] },
  { route: 'generate/text-to-3d/task/create', operation: 'text-to-3d', required: ['prompt', 'version', 'outputFormat'], allow: ['prompt', 'style', 'img', 'version', 'faceCount', 'outputFormat', 'enablePbr', 'aiPredictSize'] },
  { route: 'generate/multimodal-to-image/task/create', operation: 'image', required: [], allow: ['img', 'prompt'] },
  { route: 'generate/image-to-four-view/task/create', operation: 'four-view', required: [], allow: ['img', 'prompt'] },
  { route: 'generate/material-transfer/task/create', operation: 'material-transfer', required: ['img', 'meshUrl', 'version'], allow: ['img', 'meshUrl', 'version', 'outputFormat', 'aiPredictSize', 'customSize'] },
  { route: 'part-split/task/create', operation: 'part-split', required: ['glbUrl'], allow: ['glbUrl'] },
  { route: 'multi-format-export/task/create', operation: 'export', required: ['modelUrl'], allow: ['modelUrl', 'outputFormat'] },
  { route: 'articulation-animation/task/create', operation: 'articulation-animation', required: ['glbUrl', 'prompt'], allow: ['glbUrl', 'prompt'] },
  { route: 'animations/rig/task/create', operation: 'humanoid-rig', required: ['modelUrl'], allow: ['modelUrl'] },
  { route: 'animations/retarget/task/create', operation: 'animation-retarget', required: ['rigModelUrl', 'animationIds'], allow: ['rigModelUrl', 'animationIds', 'animationOutputMode', 'outFormat', 'animateInPlace'] },
];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ZIP = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

function validUrl(value: unknown): boolean { return typeof value === 'string' && /^https?:\/\/\S+$/.test(value) && !/\s/.test(value); }
function nonEmpty(value: unknown): boolean { return typeof value === 'string' && value.trim().length > 0; }
function validate(operation: string, body: Record<string, unknown>): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const rule = ROUTES.find(item => item.operation === operation)!;
  if (Object.keys(body).some(key => !(rule.allow ?? []).includes(key))) return false;
  if (rule.required.some(key => body[key] === undefined)) return false;
  if (operation === 'image-to-3d') {
    if (!['G1', 'G1-Turbo'].includes(String(body.version))) return false;
    if (!Array.isArray(body.outputFormat) || !body.outputFormat.length || new Set(body.outputFormat).size !== body.outputFormat.length || body.outputFormat.some(item => !['zip', 'glb', 'ply'].includes(String(item)))) return false;
    if (!nonEmpty(body.img) && !(Array.isArray(body.imgs) && body.imgs.length > 0 && body.imgs.every(nonEmpty))) return false;
    if (body.img !== undefined && body.imgs !== undefined) return false;
    if (body.imgs !== undefined && !['G1', 'G1-Turbo'].includes(String(body.version))) return false;
  }
  if (operation === 'text-to-3d') {
    if (!nonEmpty(body.prompt)) return false;
    if (!['G1', 'G1-Turbo'].includes(String(body.version))) return false;
    if (!Array.isArray(body.outputFormat) || !body.outputFormat.length || new Set(body.outputFormat).size !== body.outputFormat.length || body.outputFormat.some(item => !['zip', 'glb', 'ply'].includes(String(item)))) return false;
    if (body.img !== undefined && !nonEmpty(body.img)) return false;
  }
  if (operation === 'image' || operation === 'four-view') {
    if (!nonEmpty(body.img) && !nonEmpty(body.prompt)) return false;
    if (body.img !== undefined && !nonEmpty(body.img)) return false;
    if (body.prompt !== undefined && !nonEmpty(body.prompt)) return false;
  }
  if (operation === 'material-transfer') {
    if (!nonEmpty(body.img) || !validUrl(body.meshUrl) || body.version !== 'v3.0-standard') return false;
    if (body.outputFormat !== undefined && (!Array.isArray(body.outputFormat) || new Set(body.outputFormat).size !== body.outputFormat.length || body.outputFormat.some(item => !['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'].includes(String(item))))) return false;
  }
  if (operation === 'part-split' && !validUrl(body.glbUrl)) return false;
  if (operation === 'articulation-animation' && (!validUrl(body.glbUrl) || !nonEmpty(body.prompt))) return false;
  if (operation === 'humanoid-rig' && !validUrl(body.modelUrl)) return false;
  if (operation === 'export') {
    if (!validUrl(body.modelUrl)) return false;
    if (body.outputFormat !== undefined && (!Array.isArray(body.outputFormat) || new Set(body.outputFormat).size !== body.outputFormat.length || body.outputFormat.some(item => !['usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'].includes(String(item))))) return false;
  }
  if (operation === 'animation-retarget') {
    if (!validUrl(body.rigModelUrl)) return false;
    if (!Array.isArray(body.animationIds) || !body.animationIds.length || body.animationIds.length > 10 || new Set(body.animationIds).size !== body.animationIds.length) return false;
    if (body.animationOutputMode !== undefined && !['separate', 'combined'].includes(String(body.animationOutputMode))) return false;
    if (body.outFormat !== undefined && !['glb', 'fbx'].includes(String(body.outFormat))) return false;
  }
  return true;
}

export async function createMockServer(options: { scenario?: MockScenario; fixture?: string; key?: string } = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  app.addContentTypeParser(/^multipart\/form-data/, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.addHook('onRequest', async (request, reply) => {
    if ((request.url.startsWith('/lux3d/') || request.url.startsWith('/asset/')) && request.headers.authorization !== (options.key ?? 'mock-only')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (request.url.startsWith('/ous/') && request.headers['ous-token-v2'] !== 'mock-ous-token') return reply.code(401).send({ error: 'Unauthorized' });
  });
  let creates = 0;
  let gets = 0;
  let ousTasks = 0;
  let order = 0;
  const tasks = new Map<string, { operation: string; body: Record<string, unknown>; status: number; reads: number; created: number }>();
  const reads = new Map<string, number>();
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', position));
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const triangle = await new NodeIO().writeBinary(document);

  for (const rule of ROUTES) {
    app.post(`/lux3d/v1/${rule.route}`, async (request, reply) => {
      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      if (!validate(rule.operation, body)) return reply.code(400).send({ c: '-1', f: { message: 'invalid request' }, m: 'invalid request', d: null });
      const taskId = String(9000000 + ++creates);
      if (options.scenario === 'response-lost') { reply.hijack(); request.raw.socket.destroy(); return; }
      tasks.set(taskId, { operation: rule.operation, body, status: 0, reads: 0, created: Date.now() - order++ });
      if (options.scenario === 'int64') {
        return reply.type('application/json').send('{"c":"0","d":9223372036854775807}');
      }
      return { c: '0', d: taskId };
    });
  }
  app.get('/lux3d/v1/generate/task/list', async request => {
    const query = request.query as { page?: string; pagesize?: string; status?: string };
    const page = Math.max(1, Number(query.page ?? 1));
    const pagesize = Math.min(100, Math.max(1, Number(query.pagesize ?? 20)));
    const all = [...tasks.entries()].map(([taskId, task]) => ({ taskId, status: task.status, created: task.created, lastModified: task.created }))
      .filter(item => query.status === undefined || item.status === Number(query.status))
      .sort((a, b) => b.created - a.created);
    return { c: '0', d: { items: all.slice((page - 1) * pagesize, page * pagesize), total: all.length, page, pageSize: pagesize } };
  });
  app.get<{ Querystring: { taskid: string } }>('/lux3d/v1/generate/task/get', async (request, reply) => {
    gets++;
    const id = request.query.taskid;
    const task = tasks.get(id);
    const count = (reads.get(id) ?? 0) + 1;
    reads.set(id, count);
    const scenario = options.scenario ?? 'success';
    const status = scenario === 'failed' ? 4 : scenario === 'cancelled' ? 6 : scenario === 'timeout' ? 1 : scenario === 'unknown' ? 99 : count === 1 ? 0 : count === 2 ? 1 : 3;
    if (![0, 1, 3, 4, 6].includes(status)) return { c: '0', d: { taskId: id, status, outputs: [] } };
    if (!task) return { c: '0', d: { taskId: id, status, ...(status === 3 ? { outputs: [{ content: `http://${request.headers.host ?? '127.0.0.1'}/output/model.glb` }] } : { outputs: [] }) } };
    task.status = status;
    return { c: '0', d: { taskId: id, status, ...(status === 3 ? { outputs: outputsFor(task.operation, task.body, request.headers.host ?? '127.0.0.1') } : {}) } };
  });

  app.get('/asset/v1/token', async request => ({
    ousToken: 'mock-ous-token',
    globalDomain: `http://${request.headers.host}`,
    blockSize: 4,
  }));
  app.post('/ous/api/v2/single/upload', async () => ({ c: '0', d: { taskId: `up${++ousTasks}` } }));
  app.post('/ous/api/v2/block/upload/init', async request => {
    const query = request.query as { blocks?: string };
    const blocks = Number(query.blocks ?? 1);
    return { c: '0', d: { taskId: ++ousTasks, blocks, lackBlocks: blocks > 2 ? ['2-3'] : null, progress: null, deduplicated: false } };
  });
  app.post('/ous/api/v2/block/upload/part', async () => ({ c: '0', d: null }));
  app.get('/ous/api/v2/upload/status', async request => ({ c: '0', d: { status: 5, url: `http://${request.headers.host}/output/model.glb`, md5: '0'.repeat(32) } }));

  app.get('/output/model.glb', async (_request, reply) => {
    if (options.scenario === 'expired403') return reply.code(403).send('expired');
    if (options.scenario === 'expired404') return reply.code(404).send('expired');
    reply.type('model/gltf-binary');
    if (options.scenario === 'truncated' || options.scenario === 'drip') {
      const data = options.fixture ? await readFile(options.fixture) : Buffer.from(triangle);
      if (options.scenario === 'truncated') return reply.send(data.subarray(0, Math.floor(data.length / 2)));
      let offset = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new Readable({
        read() {
          if (timer) return;
          timer = setInterval(() => {
            if (offset === data.length) { clearInterval(timer); this.push(null); }
            else this.push(data.subarray(offset, ++offset));
          }, 100);
        },
        destroy(error, done) { clearInterval(timer); done(error); },
      });
      reply.raw.once('close', () => stream.destroy());
      return reply.send(stream);
    }
    return reply.send(options.fixture ? createReadStream(options.fixture) : Buffer.from(triangle));
  });
  app.get('/output/model.zip', async (_request, reply) => reply.type('application/zip').send(ZIP));
  app.get('/output/model.ply', async (_request, reply) => reply.type('application/octet-stream').send(Buffer.from('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n')));
  app.get('/output/model.fbx', async (_request, reply) => reply.type('application/octet-stream').send(Buffer.from('Kaydara FBX Binary  \u0000')));
  app.get('/output/model.stl', async (_request, reply) => reply.type('application/octet-stream').send(Buffer.from('solid mock\nendsolid mock\n')));
  app.get('/output/result.png', async (_request, reply) => reply.type('image/png').send(PNG));
  app.get('/__stats', async () => ({ creates, gets, ...(ousTasks ? { ous: ousTasks } : {}) }));
  return app;
}

function outputsFor(operation: string, body: Record<string, unknown>, host: string): Array<{ content: string }> {
  const base = `http://${host}/output`;
  const requested = Array.isArray(body.outputFormat) ? body.outputFormat.map(String) : [];
  const glb = { content: `${base}/model.glb` };
  if (operation === 'image') return [{ content: `${base}/result.png` }];
  if (operation === 'four-view') return [{ content: JSON.stringify(['a', 'b', 'c', 'd'].map(name => `${base}/result.png?view=${name}`)) }];
  if (operation === 'humanoid-rig') return [glb];
  if (operation === 'part-split') return [glb];
  if (operation === 'articulation-animation') return [glb];
  if (operation === 'animation-retarget') {
    const ids = Array.isArray(body.animationIds) ? body.animationIds.map(String) : ['Idle_Loop'];
    if (body.animationOutputMode === 'combined') return [{ content: JSON.stringify({ actions: [{ animation_ids: ids, status: 'success', animationGlbUrl: `${base}/model.glb` }] }) }];
    return [{ content: JSON.stringify({ actions: ids.map((id, index) => index === 0 && ids.length > 1 ? { animation_id: id, status: 'failed', error: { code: 'MOCK_FAILURE', message: 'mock action failure' } } : { animation_id: id, status: 'success', animationGlbUrl: `${base}/model.glb` }) }) }];
  }
  if (operation === 'material-transfer') {
    return ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'].map(format => ({ content: requested.includes(format) || format === 'zip' || format === 'glb' ? `${base}/model.${format === 'zip' ? 'zip' : format === 'glb' ? 'glb' : 'zip'}` : 'NOT_REQUESTED' }));
  }
  if (operation === 'export') {
    return ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'].map(format => ({ content: format === 'zip' || format === 'glb' || requested.includes(format) ? `${base}/model.${format === 'stl' ? 'stl' : format === '3mf' || format === 'usdz' || format.endsWith('_zip') ? 'zip' : format}` : 'NOT_REQUESTED' }));
  }
  const formats = requested.length ? requested : ['zip'];
  return formats.map(format => ({ content: `${base}/model.${format === 'zip' ? 'zip' : format === 'glb' ? 'glb' : 'ply'}` }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = process.env.MOCK_SCENARIO ?? 'success';
  if (!['success', 'failed', 'cancelled', 'expired403', 'expired404', 'timeout', 'unknown', 'response-lost', 'truncated', 'drip', 'int64'].includes(scenario)) throw new Error('Invalid MOCK_SCENARIO');
  const app = await createMockServer({ scenario: scenario as MockScenario, fixture: process.env.MOCK_GLB });
  const address = await app.listen({ port: Number(process.env.MOCK_PORT ?? 4010), host: '127.0.0.1' });
  console.log(`Lux3D mock: ${address} (${scenario})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
