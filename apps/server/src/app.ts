import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AssetEvent } from '@spatial/shared';
import type { SceneChanged } from '@spatial/shared/scene-edit';
import { SceneService, SceneError } from './scene/service.ts';
import { AssetService } from './assets/service.ts';
import { AssetError, Lux3DClient, type GenerationInput } from './assets/lux3d.ts';

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export async function createApp(options: { allowedHosts?: string[]; workRoot?: string; historyDirectory?: string; dataDirectory?: string; base?: string; key?: string; pollMs?: number; timeoutMs?: number; downloadTimeoutMs?: number; logger?: boolean } = {}) {
  const downloadTimeoutMs = options.downloadTimeoutMs ?? Number(process.env.ASSET_DOWNLOAD_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(downloadTimeoutMs) || downloadTimeoutMs <= 0) throw new Error('Invalid ASSET_DOWNLOAD_TIMEOUT_MS');
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384, disableRequestLogging: true });
  const subscribers = new Set<(event: AssetEvent | SceneChanged) => void>();
  const scene = new SceneService({
    workRoot: options.workRoot ?? process.env.WORK_ROOT ?? fileURLToPath(new URL('../../../templates/product-page/', import.meta.url)),
    historyDirectory: options.historyDirectory ?? process.env.SCENE_HISTORY_DIR ?? fileURLToPath(new URL('../../../.data/scene-history/', import.meta.url)),
    emit: event => subscribers.forEach(send => send(event)),
  });
  const service = new AssetService({
    directory: options.dataDirectory ?? process.env.ASSETS_DIR ?? fileURLToPath(new URL('../../../.data/assets/', import.meta.url)),
    client: new Lux3DClient({ base: options.base ?? process.env.LUX3D_BASE, key: options.key ?? process.env.LUX3D_API_KEY }),
    pollMs: options.pollMs, timeoutMs: options.timeoutMs, downloadTimeoutMs,
    emit: event => subscribers.forEach(send => send(event)),
  });
  await service.init();
  await app.register(websocket);
  const allowedHosts = new Set([...loopbackHosts, ...(options.allowedHosts ?? (process.env.ALLOWED_HOSTS ?? '').split(','))]
    .map(host => host.trim().toLowerCase()).filter(Boolean));
  app.addHook('onRequest', async (request, reply) => {
    // DNS-rebinding defence: a page on an attacker's domain that resolves to 127.0.0.1 would
    // otherwise pass the same-origin check below and could spend Lux3D credits or rewrite the work.
    const host = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) {
      return reply.code(403).send({ error: { code: 'HOST_DENIED', message: '仅允许通过本机地址访问；其他主机名需写入 ALLOWED_HOSTS' } });
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
      return reply.code(403).send({ error: { code: 'ORIGIN_DENIED', message: '仅允许同源工作台访问' } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SceneError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, fields: error.fields } });
    if (error instanceof AssetError) {
      return reply.code(error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400).send({ error: { code: error.code, message: error.message } });
    }
    const validation = (error as { validation?: unknown }).validation;
    return reply.code(validation ? 400 : 500).send({ error: { code: validation ? 'INVALID_INPUT' : 'SERVER_ERROR', message: validation ? '请求参数不符合资产接口约定' : '资产服务错误，请检查本地配置和文件' } });
  });
  app.get('/health', async () => ({ status: 'ok', milestone: 'M0-A' }));
  app.get('/events', { websocket: true }, socket => {
    const send = (event: AssetEvent | SceneChanged) => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); };
    subscribers.add(send);
    socket.send(JSON.stringify({ type: 'ready' }));
    socket.on('close', () => subscribers.delete(send));
  });
  const version = { type: 'string', enum: ['G1', 'G1-Turbo'] };
  app.post<{ Body: GenerationInput & { idempotencyKey: string } }>('/assets/lux3d', {
    schema: { body: {
      type: 'object', additionalProperties: false, required: ['version', 'idempotencyKey'],
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 4000 }, img: { type: 'string', minLength: 1, maxLength: 2048 }, version, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 } },
      oneOf: [{ required: ['prompt'], not: { required: ['img'] } }, { required: ['img'], not: { required: ['prompt'] } }],
    } },
  }, async (request, reply) => {
    const { prompt, img, version, idempotencyKey } = request.body;
    if (img) {
      let url: URL;
      try { url = new URL(img); } catch { throw new AssetError('INVALID_IMAGE_URL', 'img 必须为公网 HTTPS 图片 URL'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new AssetError('INVALID_IMAGE_URL', 'img 必须为公网 HTTPS 图片 URL');
    }
    const asset = await service.submit({ prompt, img, version }, idempotencyKey);
    return reply.code(asset.status === 'ready' ? 200 : 202).send(asset);
  });
  app.post<{ Body: { taskId: unknown } }>('/assets/lux3d/import', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['taskId'], properties: {
      // Keep the original JSON value: a typed anyOf would coerce it before the handler.
      taskId: {},
    } } },
  }, async (request, reply) => {
    const taskId = request.body.taskId;
    if (!((typeof taskId === 'string' && /^[1-9][0-9]{0,18}$/.exec(taskId)?.[0] === taskId) ||
        (typeof taskId === 'number' && Number.isSafeInteger(taskId) && taskId > 0))) {
      throw new AssetError('INVALID_TASK', '任务编号必须是安全正整数，或不含前导零的十进制数字字符串');
    }
    return reply.code(202).send(await service.importTask(String(taskId)));
  });
  app.get('/assets', async () => service.list());
  app.get<{ Params: { id: string } }>('/assets/:id', async (request, reply) => {
    const asset = service.get(request.params.id);
    return asset ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: '资产不存在' } });
  });
  app.get<{ Params: { id: string } }>('/assets/:id/model.glb', async (request, reply) => {
    const filename = service.modelPath(request.params.id);
    if (!filename) return reply.code(404).send({ error: { code: 'NOT_READY', message: '模型尚未就绪' } });
    try { await stat(filename); } catch { return reply.code(404).send({ error: { code: 'MODEL_MISSING', message: '模型文件已丢失，请重新导入资产' } }); }
    return reply.type('model/gltf-binary').header('Cache-Control', 'no-cache').send(createReadStream(filename));
  });
  app.get('/scene', async () => scene.get());
  app.put('/scene', async request => scene.put(request.body));
  app.post('/scene/undo', async () => scene.undo());
  app.post<{ Params: { id: string }; Body: unknown }>('/assets/:id/adopt', async request => {
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'force')
      || ('force' in body && typeof body.force !== 'boolean')) throw new SceneError('INVALID_INPUT', 'force 必须为布尔值');
    return scene.adopt(service, request.params.id, 'force' in body && body.force === true);
  });
  app.addHook('preClose', async () => { subscribers.clear(); await service.close(); await scene.idle(); });
  return { app, service, scene };
}
