import Fastify from 'fastify';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';

export type MockScenario = 'success' | 'failed' | 'cancelled' | 'expired403' | 'expired404' | 'timeout' | 'unknown' | 'response-lost' | 'truncated' | 'drip';
export async function createMockServer(options: { scenario?: MockScenario; fixture?: string; key?: string } = {}) {
  const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/lux3d/') && request.headers.authorization !== (options.key ?? 'mock-only')) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  });
  let creates = 0;
  let gets = 0;
  const reads = new Map<string, number>();
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setArray(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', position));
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const triangle = await new NodeIO().writeBinary(document);
  for (const [route, input] of [
    ['generate/text-to-3d/task/create', 'prompt'],
    ['generate/img-to-3d/task/create', 'img'],
    ['part-split/task/create', 'glbUrl'],
  ] as const) {
    const body = input === 'glbUrl' ? {
      type: 'object', additionalProperties: false, required: ['glbUrl'],
      properties: { glbUrl: { type: 'string', minLength: 1, pattern: '^https?://\\S+$' } },
    } : {
      type: 'object', additionalProperties: false, required: [input, 'version', 'outputFormat'],
      properties: {
        [input]: { type: 'string', minLength: 1, pattern: '\\S' },
        version: { type: 'string', enum: ['G1', 'G1-Turbo'] },
        outputFormat: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', const: 'glb' } },
        enablePbr: { type: 'boolean' },
      },
    };
    app.post(`/lux3d/v1/${route}`, { schema: { body } }, async (request, reply) => {
      const taskId = String(9000000 + ++creates);
      if (options.scenario === 'response-lost') {
        reply.hijack();
        request.raw.socket.destroy();
        return;
      }
      return { c: '0', d: taskId };
    });
  }
  app.get('/lux3d/v1/generate/task/list', async () => ({ c: '0', d: [] }));
  app.get<{ Querystring: { taskid: string } }>('/lux3d/v1/generate/task/get', async request => {
    gets++;
    const count = (reads.get(request.query.taskid) ?? 0) + 1;
    reads.set(request.query.taskid, count);
    const scenario = options.scenario ?? 'success';
    const status = scenario === 'failed' ? 4 : scenario === 'cancelled' ? 6 : scenario === 'timeout' ? 1 : scenario === 'unknown' ? 99 : count === 1 ? 0 : count === 2 ? 1 : 3;
    return { c: '0', d: { status, outputs: status === 3 ? [{ content: `http://${request.headers.host}/output/model.glb` }] : [] } };
  });
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
  app.get('/__stats', async () => ({ creates, gets }));
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scenario = process.env.MOCK_SCENARIO ?? 'success';
  if (!['success', 'failed', 'cancelled', 'expired403', 'expired404', 'timeout', 'unknown', 'response-lost', 'truncated', 'drip'].includes(scenario)) throw new Error('Invalid MOCK_SCENARIO');
  const app = await createMockServer({ scenario: scenario as MockScenario, fixture: process.env.MOCK_GLB });
  const address = await app.listen({ port: Number(process.env.MOCK_PORT ?? 4010), host: '127.0.0.1' });
  console.log(`Lux3D mock: ${address} (${scenario})`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
