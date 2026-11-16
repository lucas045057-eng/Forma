import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { LuxUploadStore } from './lux3d-upload.ts';
import { LuxTaskService } from './lux3d-task-service.ts';
import { ProviderUploader } from './lux3d-provider-upload.ts';
import { Lux3DClient, AssetError } from './lux3d.ts';
import type { AssetService } from './service.ts';
import type { LuxOperation } from '@spatial/shared';

export async function registerLuxWorkbench(app: FastifyInstance, options: {
  directory: string;
  assets: AssetService;
  client: Lux3DClient;
  uploadHosts?: string[];
  close: (operation: () => Promise<void>) => void;
}) {
  const uploads = new LuxUploadStore(options.directory);
  options.close(() => uploads.close());
  await uploads.init();
  const tasks = new LuxTaskService(path.join(options.directory, 'lux-tasks'), {
    uploads, client: options.client, uploader: new ProviderUploader(options.client, options.uploadHosts), assets: options.assets,
    artifactsDirectory: path.join(options.directory, 'lux-artifacts'),
  });
  options.close(() => tasks.close());
  await tasks.init();
  let activeUploads = 0;
  // Encapsulated scope: only the upload route receives raw octet-stream bodies; all other
  // JSON APIs keep Fastify's normal parser and 16 KiB limit.
  await app.register(async uploadScope => {
    uploadScope.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));
    uploadScope.post<{ Querystring: { kind?: string; filename?: string } }>('/assets/uploads', { bodyLimit: 100 * 1024 * 1024 }, async (request, reply) => {
      if (request.headers['content-type']?.split(';')[0] !== 'application/octet-stream') throw new AssetError('INVALID_UPLOAD_MEDIA', '文件上传必须使用二进制流');
      if (activeUploads >= 2) throw new AssetError('UPLOAD_BUSY', '同时最多上传两个文件，请稍后重试', 429);
      activeUploads++;
      const length = request.headers['content-length'];
      const abort = new AbortController();
      const timer = setTimeout(() => { abort.abort(); (request.body as import('node:stream').Readable)?.destroy(); }, 30_000);
      try {
        const upload = await uploads.receive({ kind: request.query.kind, filename: request.query.filename, stream: request.body as import('node:stream').Readable, contentLength: length === undefined ? undefined : Number(length), signal: abort.signal });
        const { providerUrl: _url, providerUrlExpiresAt: _expires, ...safe } = upload;
        return reply.code(201).send(safe);
      } finally { clearTimeout(timer); activeUploads--; }
    });
  });
  app.get('/assets/uploads', async () => uploads.list().map(({ providerUrl: _url, providerUrlExpiresAt: _expires, ...record }) => record));
  app.get<{ Params: { id: string } }>('/assets/uploads/:id/preview', async (request, reply) => {
    const upload = uploads.get(request.params.id);
    if (!upload || upload.kind !== 'image') throw new AssetError('UPLOAD_NOT_FOUND', '图片不存在', 404);
    const bytes = await uploads.bytes(upload.id);
    const { default: sharp } = await import('sharp');
    const metadata = await sharp(bytes, { limitInputPixels: 40_960_000 }).metadata();
    return reply.type(metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`).header('X-Content-Type-Options', 'nosniff').send(bytes);
  });
  app.get('/assets/lux3d/capabilities', async () => tasks.capabilities());
  app.post<{ Body: { operation: LuxOperation; parameters: unknown; idempotencyKey: string } }>('/assets/lux3d/operations', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || Object.keys(request.body).some(key => !['operation', 'parameters', 'idempotencyKey'].includes(key))) throw new AssetError('INVALID_OPERATION_INPUT', '创建请求字段不符合约定');
    return reply.code(202).send(tasks.public(await tasks.create(request.body)));
  });
  app.get<{ Querystring: { page?: string; status?: string; starttime?: string; endtime?: string } }>('/assets/lux3d/remote-history', async request => {
    const page = request.query.page === undefined ? 1 : Number(request.query.page);
    const status = request.query.status === undefined ? undefined : Number(request.query.status);
    return tasks.remoteHistory(page, { ...(status === undefined ? {} : { status }), ...(request.query.starttime === undefined ? {} : { starttime: request.query.starttime }), ...(request.query.endtime === undefined ? {} : { endtime: request.query.endtime }) });
  });
  app.post<{ Body: { operation: LuxOperation; providerTaskId: string } }>('/assets/lux3d/import-operation', async request => {
    if (!request.body || Object.keys(request.body).some(key => !['operation', 'providerTaskId'].includes(key))) throw new AssetError('INVALID_TASK', '导入请求字段不符合约定');
    return tasks.public(await tasks.importExisting(request.body.operation, request.body.providerTaskId));
  });
  app.get('/assets/lux3d/tasks', async () => tasks.list());
  app.get<{ Params: { id: string } }>('/assets/lux3d/tasks/:id', async request => {
    const task = tasks.get(request.params.id);
    if (!task) throw new AssetError('TASK_NOT_FOUND', '任务不存在', 404);
    return tasks.public(task);
  });
  app.post<{ Params: { id: string } }>('/assets/lux3d/tasks/:id/stop', async request => tasks.public(await tasks.stopWaiting(request.params.id)));
  app.post<{ Params: { id: string } }>('/assets/lux3d/tasks/:id/resume', async request => tasks.public(await tasks.resume(request.params.id)));
  app.post<{ Params: { id: string } }>('/assets/lux3d/tasks/:id/refresh', async request => tasks.public(await tasks.refresh(request.params.id)));
  app.post<{ Params: { id: string }; Body: { providerTaskId: string; confirmed: boolean } }>('/assets/lux3d/tasks/:id/link', async request => {
    const body = request.body;
    if (!body || Object.keys(body).some(key => !['providerTaskId', 'confirmed'].includes(key)) || body.confirmed !== true) throw new AssetError('CONFIRMATION_REQUIRED', '关联已有任务必须由用户明确确认', 400);
    return tasks.public(await tasks.link(request.params.id, body.providerTaskId));
  });
  for (const variant of ['preview', 'download'] as const) {
    app.get<{ Params: { id: string; artifactId: string } }>(`/assets/lux3d/tasks/:id/artifacts/:artifactId/${variant}`, async (request, reply) => {
      const { bytes, artifact } = await tasks.artifact(request.params.id, request.params.artifactId);
      reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
      if (variant === 'download') reply.header('Content-Disposition', `attachment; filename="lux3d-${artifact.id}.${artifact.format}"`);
      return reply.type(artifact.kind === 'image' ? artifact.format === 'jpg' || artifact.format === 'jpeg' ? 'image/jpeg' : `image/${artifact.format}` : artifact.format === 'glb' ? 'model/gltf-binary' : 'application/octet-stream').send(bytes);
    });
  }
  app.post<{ Params: { id: string; artifactId: string } }>('/assets/lux3d/tasks/:id/artifacts/:artifactId/use-input', async request => {
    const { bytes, artifact } = await tasks.artifact(request.params.id, request.params.artifactId);
    if (artifact.variant !== 'original') throw new AssetError('OPTIMIZED_NOT_INPUT', '下一步云操作必须使用原始产物；网页优化件只用于预览', 409);
    if (artifact.kind !== 'image' && artifact.format !== 'glb' && artifact.format !== 'zip') throw new AssetError('INVALID_INPUT_KIND', '该格式不能用作图片或GLB输入', 400);
    const { providerUrl: _url, providerUrlExpiresAt: _expires, ...record } = await uploads.addLocalArtifact({ bytes, filename: `lux3d-${artifact.id}.${artifact.format}`, kind: artifact.format === 'glb' ? 'glb' : artifact.format === 'zip' ? 'lux-zip' : 'image' });
    return record;
  });
  return { tasks, uploads };
}
