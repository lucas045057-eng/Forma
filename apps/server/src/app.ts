import { mkdir } from 'node:fs/promises';
import { acquireInstanceLock } from './assets/instance-lock.ts';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Selection } from '@spatial/shared';
import { SceneService, SceneError } from './scene/service.ts';
import { AssetService } from './assets/service.ts';
import { AssetError, Lux3DClient, type GenerationInput } from './assets/lux3d.ts';
import { EventLog } from './events.ts';
import { WorkService, type WorkServiceOptions } from './work/service.ts';
import { WorkError } from './work/repo.ts';
import { registerCheckRoutes } from './checks/routes.ts';
import { ArtifactError } from './checks/artifacts.ts';
import { SnapshotError } from './checks/snapshot.ts';

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export interface AppOptions {
  allowedHosts?: string[];
  workRoot?: string;
  historyDirectory?: string;
  dataDirectory?: string;
  workDataDirectory?: string;
  base?: string;
  key?: string;
  pollMs?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  codingAgentBaseUrl?: string;
  codingAgentApiKey?: string;
  codingAgentModel?: string;
  agentTimeoutMs?: number;
  agentMaxRounds?: number;
  previewStartTimeoutMs?: number;
  /** Internal construction only; no HTTP request can override the checker. */
  checks?: WorkServiceOptions['checks'];
  logger?: boolean;
}

export async function createApp(options: AppOptions = {}) {
  const downloadTimeoutMs = options.downloadTimeoutMs ?? Number(process.env.ASSET_DOWNLOAD_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(downloadTimeoutMs) || downloadTimeoutMs <= 0) throw new Error('Invalid ASSET_DOWNLOAD_TIMEOUT_MS');
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384, disableRequestLogging: true });
  const workDataDirectory = options.workDataDirectory ?? process.env.WORK_DATA_DIR ??
    (options.dataDirectory ? path.join(options.dataDirectory, 'm2') : fileURLToPath(new URL('../../../.data/work/', import.meta.url)));
  // Review F4: the work-data lock is taken before the shared event log is read or repaired, and
  // held until every event producer has stopped and the log is closed.
  await mkdir(workDataDirectory, { recursive: true });
  const releaseWorkLock = await acquireInstanceLock(workDataDirectory);
  // Review N3: everything created after the lock is owned here and released in reverse order,
  // on failed initialisation and on close; one failing cleanup does not skip the others.
  const closers: Array<() => Promise<unknown>> = [];
  let closeEvents: (() => Promise<void>) | undefined;
  let closing = false;
  const closeAll = async () => {
    closing = true;
    let first: unknown;
    for (const close of [...closers].reverse()) {
      try { await close(); } catch (error) { first ??= error; }
    }
    // A failed producer barrier must retain the journal and ownership, even if other
    // producers stopped successfully. Releasing here would permit a second writer.
    if (first) throw first;
    await closeEvents?.();
    await releaseWorkLock();
    closers.length = 0;
  };
  try {
  const events = new EventLog(workDataDirectory);
  closeEvents = () => events.close();
  await events.init();
  const emit = (event: { type: string }) => events.publish(event as { type: string } & Record<string, unknown>);
  const workRoot = options.workRoot ?? process.env.WORK_ROOT ?? fileURLToPath(new URL('../../../templates/product-page/', import.meta.url));
  const scene = new SceneService({
    workRoot,
    historyDirectory: options.historyDirectory ?? process.env.SCENE_HISTORY_DIR ?? fileURLToPath(new URL('../../../.data/scene-history/', import.meta.url)),
    emit,
  });
  closers.push(() => scene.idle());
  const service = new AssetService({
    directory: options.dataDirectory ?? process.env.ASSETS_DIR ?? fileURLToPath(new URL('../../../.data/assets/', import.meta.url)),
    client: new Lux3DClient({ base: options.base ?? process.env.LUX3D_BASE, key: options.key ?? process.env.LUX3D_API_KEY }),
    pollMs: options.pollMs, timeoutMs: options.timeoutMs, downloadTimeoutMs,
    emit,
  });
  closers.push(() => service.close());
  const work = new WorkService({
    workRoot, directory: workDataDirectory, emit, lockHeld: true,
    previewStartTimeoutMs: options.previewStartTimeoutMs,
    checks: options.checks,
    agent: {
      baseUrl: options.codingAgentBaseUrl ?? process.env.CODING_AGENT_BASE_URL,
      apiKey: options.codingAgentApiKey ?? process.env.CODING_AGENT_API_KEY,
      model: options.codingAgentModel ?? process.env.CODING_AGENT_MODEL,
      timeoutMs: options.agentTimeoutMs, maxRounds: options.agentMaxRounds,
    },
  });
  closers.push(() => work.close());
  await work.init();
  await service.init();
  app.addHook('preClose', async () => { closing = true; });
  await app.register(websocket);
  const allowedHosts = new Set([...loopbackHosts, ...(options.allowedHosts ?? (process.env.ALLOWED_HOSTS ?? '').split(','))]
    .map(host => host.trim().toLowerCase()).filter(Boolean));
  app.addHook('onRequest', async (request, reply) => {
    if (closing) throw new WorkError('SERVICE_CLOSING', '后端正在关闭，未接受新请求', 503);
    // DNS-rebinding defence: a page on an attacker's domain that resolves to 127.0.0.1 would
    // otherwise pass the same-origin check below and could spend credits or rewrite the work.
    const host = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) {
      return reply.code(403).send({ error: { code: 'HOST_DENIED', message: '仅允许通过本机地址访问；其他主机名需写入 ALLOWED_HOSTS' } });
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
      return reply.code(403).send({ error: { code: 'ORIGIN_DENIED', message: '仅允许通过同源工作台访问' } });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SceneError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, fields: error.fields } });
    if (error instanceof WorkError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ArtifactError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof SnapshotError) return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error instanceof AssetError) {
      return reply.code(error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400).send({ error: { code: error.code, message: error.message } });
    }
    const validation = (error as { validation?: unknown }).validation;
    return reply.code(validation ? 400 : 500).send({ error: { code: validation ? 'INVALID_INPUT' : 'SERVER_ERROR', message: validation ? '请求参数不符合接口约定' : '本地服务错误，请检查配置和文件' } });
  });
  app.get('/health', async () => ({ status: 'ok', milestone: 'M2-A' }));
  app.get('/events', { websocket: true }, socket => {
    const unsubscribe = events.subscribe(event => { if (socket.readyState === 1) socket.send(JSON.stringify(event)); });
    socket.send(JSON.stringify({ type: 'ready', seq: events.last, oldest: events.oldest }));
    socket.on('close', unsubscribe);
  });
  app.get<{ Querystring: { since?: number } }>('/events/history', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'integer', minimum: 0, default: 0 } } } },
  }, async request => {
    const since = request.query.since ?? 0;
    return { events: events.since(since), current: events.last, oldest: events.oldest, truncated: since < events.oldest - 1 };
  });

  app.get('/version', async () => work.version());
  app.post('/version/revert', async () => work.revert());
  app.post<{ Body: { instruction: string; selection?: Selection } }>('/tasks', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['instruction'], properties: {
      instruction: { type: 'string', minLength: 1, maxLength: 4000 },
      selection: { type: 'object', required: ['src', 'baseVersion'], properties: { src: { type: 'string' }, baseVersion: { type: 'string' } } },
    } } },
  }, async (request, reply) => reply.code(202).send(await work.submit(request.body.instruction, request.body.selection)));
  app.get('/tasks', async () => work.listTasks());
  app.get<{ Params: { id: string } }>('/tasks/:id', async request => work.getTask(request.params.id));
  app.post<{ Params: { id: string } }>('/tasks/:id/cancel', async request => work.cancel(request.params.id));
  app.get('/approvals', async () => work.listApprovals());
  app.get<{ Params: { id: string } }>('/approvals/:id', async request => work.getApproval(request.params.id));
  app.post<{ Params: { id: string }; Body: unknown }>('/approvals/:id', {
    preValidation: async request => {
      const body = request.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some(key => key !== 'option')) {
        throw new WorkError('INVALID_OPTION', '请求体只能包含原始 JSON 数字 option：0 或 1', 400);
      }
    },
    schema: { body: { type: 'object', additionalProperties: false, required: ['option'], properties: {
      // Keep the raw JSON value: Fastify's typed schema would coerce strings to numbers.
      option: {},
    } } },
  }, async request => {
    const option = (request.body as { option: unknown }).option;
    if (typeof option !== 'number' || !Number.isInteger(option) || (option !== 0 && option !== 1)) throw new WorkError('INVALID_OPTION', 'option 必须是原始 JSON 数字 0 或 1', 400);
    return work.answerApproval(request.params.id, option);
  });
  app.get('/candidates', async () => work.listCandidates());
  app.get<{ Params: { id: string } }>('/candidates/:id', async request => work.getCandidate(request.params.id));
  app.post<{ Params: { id: string } }>('/candidates/:id/adopt', async request => work.adopt(request.params.id));
  app.post<{ Params: { id: string } }>('/candidates/:id/discard', async request => work.discard(request.params.id));
  registerCheckRoutes(app, work);

  // Preview content is served exclusively by the separate preview-origin listener.

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
  app.get('/scene', async () => work.repo.exclusive(() => scene.get()));
  app.put('/scene', async request => work.repo.exclusive(() => scene.put(request.body)));
  app.post('/scene/undo', async () => work.repo.exclusive(() => scene.undo()));
  app.post<{ Params: { id: string }; Body: unknown }>('/assets/:id/adopt', async request => {
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'force')
      || ('force' in body && typeof body.force !== 'boolean')) throw new SceneError('INVALID_INPUT', 'force 必须为布尔值');
    return work.repo.exclusive(() => scene.adopt(service, request.params.id, 'force' in body && body.force === true));
  });
  // preClose must not wait for handlers: Fastify drains HTTP after this hook.
  // Keep admitted handlers and their nested repo operations usable until onClose.
  app.addHook('onClose', closeAll);
  return { app, service, scene, work, events };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  }
}
