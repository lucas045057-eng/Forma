import { mkdir } from 'node:fs/promises';
import { acquireInstanceLock } from './assets/instance-lock.ts';
import Fastify, { type FastifyServerOptions } from 'fastify';
import websocket from '@fastify/websocket';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Selection, WorkStarter } from '@spatial/shared';
import { SceneError } from './scene/service.ts';
import { SceneModuleError } from '@spatial/shared/scene-module';
import { AssetService, type ServiceOptions as AssetServiceOptions } from './assets/service.ts';
import { AssetError, Lux3DClient, type GenerationInput } from './assets/lux3d.ts';
import { EventLog } from './events.ts';
import { type WorkServiceOptions } from './work/service.ts';
import { WorkspaceManager } from './work/workspace.ts';
import { WorkError } from './work/repo.ts';
import { registerCheckRoutes } from './checks/routes.ts';
import { ArtifactError } from './checks/artifacts.ts';
import { SnapshotBudgetError, SnapshotError } from './checks/snapshot.ts';
import { SpeechClient, type SpeechClientOptions } from './speech/client.ts';
import { SpeechService } from './speech/service.ts';
import { registerSpeechRoutes } from './speech/routes.ts';
import { registerLuxWorkbench } from './assets/lux3d-routes.ts';
import { registerPlacementRoutes } from './assets/placement.ts';

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

const SECRET_PATTERNS = [
  /(\bBearer\s+)[^\s,;'"`]+/gi,
  /(\bAuthorization\s*[:=]\s*)[^\s,;'"`]+/gi,
  /(https?:\/\/)([^/\s:@]+:[^/\s@]+@)/gi,
  /(\?)[^\s#)'"`]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
];

export function redactErrorText(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[1], '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[2], '$1[REDACTED]@');
  out = out.replace(SECRET_PATTERNS[3], '?[REDACTED]');
  out = out.replace(SECRET_PATTERNS[4], '[REDACTED]');
  return out.slice(0, 2000);
}

export function sanitizeServerError(error: unknown): { name: string; code?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
    const stack = typeof error.stack === 'string'
      ? redactErrorText(error.stack.split('\n').slice(0, 8).join('\n'))
      : undefined;
    return {
      name: error.name || 'Error',
      ...(code ? { code } : {}),
      message: redactErrorText(error.message || 'Unhandled error'),
      ...(stack ? { stack } : {}),
    };
  }
  return { name: 'NonErrorThrow', message: 'Unhandled non-Error value' };
}

export interface AppOptions {
  allowedHosts?: string[];
  workRoot?: string;
  historyDirectory?: string;
  dataDirectory?: string;
  fallbackDirectory?: string;
  /** Internal synthetic-fixture hashes only; not available from HTTP or provider env. */
  presetDigests?: AssetServiceOptions['presetDigests'];
  /** Dedicated offline demo only; never set by HTTP or provider env. */
  mockAssets?: boolean;
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
  /** Internal speech configuration; the loopback exception is never read from env. */
  speech?: SpeechClientOptions & { timeoutMs?: number };
  logger?: FastifyServerOptions['logger'];
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
  const historyDirectory = options.historyDirectory ?? process.env.SCENE_HISTORY_DIR ?? fileURLToPath(new URL('../../../.data/scene-history/', import.meta.url));
  const service = new AssetService({
    directory: options.dataDirectory ?? process.env.ASSETS_DIR ?? fileURLToPath(new URL('../../../.data/assets/', import.meta.url)),
    client: new Lux3DClient({ base: options.base ?? process.env.LUX3D_BASE, key: options.key ?? process.env.LUX3D_API_KEY }),
    pollMs: options.pollMs, timeoutMs: options.timeoutMs, downloadTimeoutMs, fallbackDirectory:options.fallbackDirectory,presetDigests:options.presetDigests,mockUpstream:options.mockAssets,
    emit,
  });
  closers.push(() => service.close());
  const workspace = new WorkspaceManager({
    defaultWorkRoot: workRoot,
    workDataDirectory,
    defaultHistoryDirectory: historyDirectory,
    previewStartTimeoutMs: options.previewStartTimeoutMs,
    checks: options.checks,
    agent: {
      baseUrl: options.codingAgentBaseUrl ?? process.env.CODING_AGENT_BASE_URL,
      apiKey: options.codingAgentApiKey ?? process.env.CODING_AGENT_API_KEY,
      model: options.codingAgentModel ?? process.env.CODING_AGENT_MODEL,
      timeoutMs: options.agentTimeoutMs, maxRounds: options.agentMaxRounds,
    },
    emit,
  });
  closers.push(() => workspace.close());
  const speech = new SpeechService(new SpeechClient(options.speech ?? {
    baseUrl: process.env.SPEECH_BASE_URL, apiKey: process.env.DASHSCOPE_API_KEY, model: process.env.SPEECH_MODEL,
  }), { timeoutMs: options.speech?.timeoutMs });
  closers.push(() => speech.close());
  await workspace.init();
  await service.init();
  const activeWork = () => workspace.current().work;
  const activeScene = () => workspace.current().scene;
  // Awaited plugin registration binds route error-handler contexts. Install the shared
  // envelope before registering either the upload scope or the workbench routes.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SceneModuleError) return reply.code(400).send({ error: { code: error.code, message: error.message } });
    if (error instanceof SceneError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, fields: error.fields } });
    if (error instanceof WorkError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof ArtifactError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof SnapshotBudgetError) return reply.code(409).send({ error: { code: error.code, message: error.message, details: error.detail } });
    if (error instanceof SnapshotError) return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error instanceof AssetError) {
      return reply.code(error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : error.status).send({ error: { code: error.code, message: error.message } });
    }
    const parser = error as { code?: string; statusCode?: number };
    if (parser.code?.startsWith('FST_ERR_CTP_') && [400, 413, 415].includes(parser.statusCode ?? 0)) {
      if (parser.statusCode === 413) return reply.code(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: '请求内容超出大小限制' } });
      if (parser.statusCode === 415) return reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '不支持此请求的内容类型' } });
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: '请求参数不符合接口约定' } });
    }
    const validation = (error as { validation?: unknown }).validation;
    if (!validation) {
      request.log.error(
        { err: sanitizeServerError(error), method: request.method, url: request.url.split('?')[0] },
        'unhandled server error',
      );
    }
    return reply.code(validation ? 400 : 500).send({ error: { code: validation ? 'INVALID_INPUT' : 'SERVER_ERROR', message: validation ? '请求参数不符合接口约定' : '本地服务错误，请检查配置和文件' } });
  });
  const luxWorkbench=await registerLuxWorkbench(app,{
    directory:path.join(workDataDirectory,'lux3d-workbench'),assets:service,
    client:new Lux3DClient({base:options.base??process.env.LUX3D_WORKBENCH_BASE??process.env.LUX3D_BASE??'https://api.aholo.cn',key:options.key??process.env.LUX3D_API_KEY}),
    uploadHosts:(process.env.LUX3D_UPLOAD_HOSTS??'').split(',').map(host=>host.trim()).filter(Boolean).length?(process.env.LUX3D_UPLOAD_HOSTS??'').split(',').map(host=>host.trim()).filter(Boolean):undefined,
    close:operation=>closers.push(operation),
  });
  registerPlacementRoutes(app, service, () => workspace.current(), undefined, undefined, emit);
  app.addHook('preClose', async () => { closing = true; speech.beginClose(); luxWorkbench.tasks.beginClose(); });
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

  app.get('/works', async () => workspace.list());
  app.post<{ Body: { name?: string; starter?: WorkStarter; prompt?: string; assetId?: string } }>('/works', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 60 },
          starter: { type: 'string', enum: ['blank', 'product-page'] },
          prompt: { type: 'string', maxLength: 4000 },
          assetId: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => reply.code(201).send(await workspace.create({ ...request.body, assets: service })));
  app.post<{ Params: { id: string } }>('/works/:id/select', async request => workspace.select(request.params.id));
  app.patch<{ Params: { id: string }; Body: { name: string } }>('/works/:id', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
      },
    },
  }, async request => workspace.rename(request.params.id, request.body.name));

  app.get('/version', async () => activeWork().version());
  app.post('/version/revert', async () => activeWork().revert());
  app.post<{ Body: { instruction: string; selection?: Selection; bootstrap?: boolean } }>('/tasks', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['instruction'], properties: {
      instruction: { type: 'string', minLength: 1, maxLength: 4000 },
      bootstrap: { type: 'boolean' },
      selection: { type: 'object', required: ['src', 'baseVersion'], properties: { src: { type: 'string' }, baseVersion: { type: 'string' } } },
    } } },
  }, async (request, reply) => reply.code(202).send(await activeWork().submit(request.body.instruction, request.body.selection, { bootstrap: request.body.bootstrap })));
  app.get('/tasks', async () => activeWork().listTasks());
  app.get<{ Params: { id: string } }>('/tasks/:id', async request => activeWork().getTask(request.params.id));
  app.post<{ Params: { id: string } }>('/tasks/:id/cancel', async request => activeWork().cancel(request.params.id));
  app.get('/approvals', async () => activeWork().listApprovals());
  app.get<{ Params: { id: string } }>('/approvals/:id', async request => activeWork().getApproval(request.params.id));
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
    return activeWork().answerApproval(request.params.id, option);
  });
  app.get('/candidates', async () => activeWork().listCandidates());
  app.get<{ Params: { id: string } }>('/candidates/:id', async request => activeWork().getCandidate(request.params.id));
  app.post<{ Params: { id: string } }>('/candidates/:id/adopt', async request => activeWork().adopt(request.params.id));
  app.post<{ Params: { id: string } }>('/candidates/:id/discard', async request => activeWork().discard(request.params.id));
  registerCheckRoutes(app, activeWork);

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
  app.get('/assets/fallbacks', async request => {if(Object.keys(request.query as object).length)throw new AssetError('INVALID_FALLBACK_INPUT','备用列表不接受路径或URL参数');return service.listFallbacks();});
  app.post<{Params:{presetId:string};Body:unknown}>('/assets/fallbacks/:presetId/import',async(request,reply)=>{
    const body=request.body;
    if((body!==undefined&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))||Object.keys(request.query as object).length)throw new AssetError('INVALID_FALLBACK_INPUT','备用导入只接受固定preset编号，不接受路径、URL或来源字段');
    const asset=await service.importFallback(request.params.presetId);return reply.code(asset.status==='ready'?200:202).send(asset);
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
  app.get('/scene/model-provenance',async(request,reply)=>{if(Object.keys(request.query as object).length)throw new SceneError('INVALID_INPUT','来源查询不接受路径或URL参数');reply.header('Cache-Control','no-store');return activeWork().repo.exclusive(()=>activeScene().modelProvenance());});
  app.get('/scene', async () => activeWork().repo.exclusive(() => activeScene().get()));
  app.put('/scene', async request => activeWork().repo.exclusive(() => activeScene().put(request.body)));
  app.post('/scene/undo', async () => activeWork().repo.exclusive(() => activeScene().undo()));
  app.post<{ Params: { id: string }; Body: unknown }>('/assets/:id/adopt', async request => {
    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'force')
      || ('force' in body && typeof body.force !== 'boolean')) throw new SceneError('INVALID_INPUT', 'force 必须为布尔值');
    return activeWork().repo.exclusive(() => activeScene().adopt(service, request.params.id, 'force' in body && body.force === true));
  });
  // preClose must not wait for handlers: Fastify drains HTTP after this hook.
  // Keep admitted handlers and their nested repo operations usable until onClose.
  await registerSpeechRoutes(app, speech);
  app.addHook('onClose', closeAll);
  const currentDefault = workspace.current();
  return { app, service, scene: currentDefault.scene, work: currentDefault.work, workspace, events, speech };
  } catch (error) {
    await closeAll().catch(() => {});
    throw error;
  }
}
