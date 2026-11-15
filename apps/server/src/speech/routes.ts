import type { FastifyInstance } from 'fastify';
import { audioMime, MAX_AUDIO_BYTES, SpeechError, validateRequestId } from './client.ts';
import type { SpeechService } from './service.ts';

export async function registerSpeechRoutes(app: FastifyInstance, speech: SpeechService) {
  await app.register(async scope => {
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof SpeechError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      const ctp = error as { code?: string; statusCode?: number };
      if (ctp.code?.startsWith('FST_ERR_CTP_') && [400, 413, 415].includes(ctp.statusCode ?? 0)) {
        const safe = ctp.statusCode === 413 ? new SpeechError('SPEECH_TOO_LARGE', 413) :
          ctp.statusCode === 415 ? new SpeechError('SPEECH_UNSUPPORTED_MEDIA', 415) : new SpeechError('SPEECH_INVALID_AUDIO', 400);
        return reply.code(safe.status).send({ error: { code: safe.code, message: safe.message } });
      }
      throw error;
    });
    for (const mime of ['audio/webm', 'audio/ogg', 'audio/wav']) scope.addContentTypeParser(mime, { parseAs: 'buffer', bodyLimit: MAX_AUDIO_BYTES }, (_request, body, done) => done(null, body));
    scope.get('/speech/config', async (_request, reply) => reply.header('Cache-Control', 'no-store').send(speech.config));
    scope.post<{ Body: Buffer }>('/speech/transcribe', {
      bodyLimit: MAX_AUDIO_BYTES,
      onRequest: async request => {
        audioMime(request.headers['content-type']);
        validateRequestId(request.headers['x-speech-request-id']);
      },
    }, async (request, reply) => {
      if (!Buffer.isBuffer(request.body) || Object.keys(request.query as object).length) throw new SpeechError('SPEECH_INVALID_AUDIO', 400);
      const id = request.headers['x-speech-request-id'];
      validateRequestId(id);
      const lease = speech.join(id, request.body, audioMime(request.headers['content-type']));
      const disconnected = () => { if (!reply.raw.writableFinished) lease.release(); };
      reply.raw.once('close', disconnected);
      if (reply.raw.destroyed && !reply.raw.writableFinished) lease.release();
      try { return reply.header('Cache-Control', 'no-store').send(await lease.result); }
      finally { reply.raw.off('close', disconnected); lease.release(); }
    });
    scope.delete<{ Params: { requestId: string } }>('/speech/transcribe/:requestId', async (request, reply) => {
      const result = await speech.cancel(request.params.requestId);
      return reply.header('Cache-Control', 'no-store').send(result);
    });
  });
}
