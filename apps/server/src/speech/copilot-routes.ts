import type { FastifyInstance } from 'fastify';
import type { VoiceCopilotContextPayload, VoiceCopilotVendor } from '@spatial/shared';
import { AgoraCopilotError } from './copilot-agora.ts';
import type { UpdateVoiceCopilotConfigInput, VoiceCopilotService } from './copilot-service.ts';

const CONFIG_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    vendor: { type: 'string', enum: ['gemini_live', 'openai_realtime'] },
    model: { type: 'string', maxLength: 160 },
    voice: { type: 'string', maxLength: 80 },
    url: { type: 'string', maxLength: 512 },
    agoraAppId: { type: 'string', maxLength: 128 },
    agoraAppCertificate: { type: 'string', maxLength: 256 },
    clearAppCertificate: { type: 'boolean' },
    agoraCustomerId: { type: 'string', maxLength: 256 },
    clearCustomerId: { type: 'boolean' },
    agoraCustomerSecret: { type: 'string', maxLength: 256 },
    clearCustomerSecret: { type: 'boolean' },
    mllmApiKey: { type: 'string', maxLength: 512 },
    clearMllmApiKey: { type: 'boolean' },
    persist: { type: 'boolean' },
  },
};

export async function registerVoiceCopilotRoutes(app: FastifyInstance, copilot: VoiceCopilotService) {
  await app.register(async scope => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof AgoraCopilotError) {
        return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    });

    scope.get('/speech/copilot/config', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return copilot.getConfigView();
    });

    scope.put<{ Body: UpdateVoiceCopilotConfigInput }>(
      '/speech/copilot/config',
      { schema: { body: CONFIG_BODY_SCHEMA } },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return { ok: true, config: copilot.updateConfig(request.body) };
      },
    );

    scope.post<{ Body: UpdateVoiceCopilotConfigInput & { vendor?: VoiceCopilotVendor } }>(
      '/speech/copilot/test',
      { schema: { body: CONFIG_BODY_SCHEMA } },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return copilot.testConfig(request.body ?? {});
      },
    );

    scope.post<{ Body: { workName?: string; preferMock?: boolean } }>(
      '/speech/copilot/sessions',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workName: { type: 'string', maxLength: 80 },
              preferMock: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const session = await copilot.startSession(request.body ?? {});
        return reply.code(201).send(session);
      },
    );

    scope.post<{ Params: { id: string }; Body: VoiceCopilotContextPayload }>(
      '/speech/copilot/sessions/:id/think',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'text'],
            properties: {
              kind: { type: 'string', enum: ['user_text', 'selection', 'candidate_ready', 'checks_done', 'work_switched'] },
              text: { type: 'string', minLength: 1, maxLength: 4000 },
              workName: { type: 'string', maxLength: 80 },
              selection: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['src', 'cid', 'instances'],
                    properties: {
                      src: { type: 'string', maxLength: 512 },
                      cid: { type: 'string', maxLength: 160 },
                      instances: { type: 'integer', minimum: 1 },
                      text: { type: 'string', maxLength: 1000 },
                    },
                  },
                ],
              },
              candidateSummary: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'decision', 'passedChecks', 'totalChecks'],
                properties: {
                  id: { type: 'string', maxLength: 128 },
                  decision: { type: 'string', enum: ['pending', 'adopted', 'discarded'] },
                  passedChecks: { type: 'integer', minimum: 0 },
                  totalChecks: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return copilot.think(request.params.id, request.body);
      },
    );

    scope.post<{ Params: { id: string } }>(
      '/speech/copilot/sessions/:id/interrupt',
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return copilot.interrupt(request.params.id);
      },
    );

    scope.delete<{ Params: { id: string } }>(
      '/speech/copilot/sessions/:id',
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        return copilot.stopSession(request.params.id);
      },
    );
  });
}
