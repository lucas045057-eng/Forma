import type { FastifyInstance } from 'fastify';
import type { WorkService } from '../work/service.ts';
import { WorkError } from '../work/repo.ts';

/** Raw bodies are checked before any schema coercion or additional-field removal. */
function checkBody(body: unknown, allowRerun: boolean): { rerun?: boolean } {
  if (body === undefined) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkError('INVALID_INPUT', '检查请求体必须是对象', 400);
  const keys = Object.keys(body);
  if (keys.some(key => !allowRerun || key !== 'rerun')) throw new WorkError('INVALID_INPUT', '检查请求包含不允许的字段', 400);
  if ('rerun' in body) {
    const rerun = body.rerun;
    if (typeof rerun !== 'boolean') throw new WorkError('INVALID_INPUT', 'rerun 必须是原始 JSON 布尔值', 400);
    return { rerun };
  }
  return {};
}

export function registerCheckRoutes(app: FastifyInstance, work: WorkService) {
  app.post<{ Params: { id: string }; Body: unknown }>('/candidates/:id/checks', {
    preValidation: async request => { checkBody(request.body, true); },
  }, async (request, reply) => reply.code(202).send(await work.startChecks(request.params.id, checkBody(request.body, true))));

  app.get<{ Params: { id: string } }>('/checks/:id', async request => work.getCheckRun(request.params.id));

  app.post<{ Params: { id: string }; Body: unknown }>('/checks/:id/cancel', {
    preValidation: async request => { checkBody(request.body, false); },
  }, async request => work.cancelCheckRun(request.params.id));

  app.get<{ Params: { id: string; name: string } }>('/checks/:id/artifacts/:name', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    const { buffer, ref } = await work.readCheckArtifact(request.params.id, request.params.name);
    return reply.type(ref.mime).header('ETag', '"' + ref.hash + '"').send(buffer);
  });
}

