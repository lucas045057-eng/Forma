import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../app.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';

const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00, 0x01, 0x02]);
const calls: Array<{ path: string | undefined; authorization: string | undefined; body: unknown }> = [];
let upstream: Awaited<ReturnType<typeof listenHttpForFetch>>;
let configured: Awaited<ReturnType<typeof createApp>>;
let disabled: Awaited<ReturnType<typeof createApp>>;
let directory: string;

// This construction-only option cannot be selected through HTTP or production environment.
type SpeechFixtureOptions = AppOptions & { speech: { baseUrl: string; apiKey: string; model: string; testLoopback: true } };
function post(payload: Buffer, contentType = 'audio/webm;codecs=opus', requestId: string = randomUUID()) {
  return configured.app.inject({ method: 'POST', url: '/speech/transcribe',
    headers: { 'content-type': contentType, 'x-speech-request-id': requestId }, payload });
}

describe('D1 speech HTTP boundary', () => {
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'speech-http-'));
    upstream = await listenHttpForFetch((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        calls.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '把按钮改成圆角' } }] }));
      });
    });
    const make = async (name: string, speech?: SpeechFixtureOptions['speech']) => {
      const workRoot = path.join(directory, name, 'work');
      await mkdir(path.join(workRoot, 'src'), { recursive: true });
      await writeFile(path.join(workRoot, 'src/app.ts'), 'export const value = 1;\n');
      const options = { workRoot, workDataDirectory: path.join(directory, name, 'data'),
        dataDirectory: path.join(directory, name, 'assets'), historyDirectory: path.join(directory, name, 'history'),
        base: 'http://127.0.0.1:9', key: 'mock-only', codingAgentBaseUrl: 'http://127.0.0.1:9', codingAgentApiKey: 'mock-only', codingAgentModel: 'mock-only',
        ...(speech ? { speech } : {}) };
      return createApp(options);
    };
    configured = await make('configured', { baseUrl: `${upstream.baseUrl}/compatible-mode/v1`, apiKey: 'speech-fake-only', model: 'qwen3-asr-flash', testLoopback: true });
    disabled = await make('disabled');
  });
  afterAll(async () => {
    const errors: unknown[] = [];
    const cleanup: Record<string, unknown> = { pid: process.pid, at: new Date().toISOString(), directory, upstream: upstream?.baseUrl };
    for (const [name, app] of [['configured', configured?.app], ['disabled', disabled?.app]] as const) {
      try { await app?.close(); cleanup[name] = 'closed'; }
      catch (error) { errors.push(error); cleanup[name] = String(error); }
    }
    try {
      if (upstream) {
        const server = upstream.server;
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        cleanup.serverListening = server.listening;
        expect(server.listening).toBe(false);
        const port = Number(new URL(upstream.baseUrl).port);
        cleanup.port = port;
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port });
          socket.once('connect', () => { socket.destroy(); reject(new Error(`Owned mock port ${port} still accepts connections`)); });
          socket.once('error', (error: NodeJS.ErrnoException) => {
            socket.destroy();
            if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
          });
          socket.setTimeout(1_000, () => { socket.destroy(); reject(new Error('Owned mock port shutdown probe timed out')); });
        });
        cleanup.portClosed = true;
      }
    } catch (error) { errors.push(error); cleanup.upstreamError = String(error); }
    if (!errors.length && directory) {
      try { await rm(directory, { recursive: true, force: true }); cleanup.directoryRemoved = true; }
      catch (error) { errors.push(error); cleanup.directoryError = String(error); }
    }
    cleanup.errors = errors.map(String);
    const output = process.env.D1_RUN_DIR;
    if (output) await writeFile(path.join(output, `speech-cleanup-${process.pid}.json`), JSON.stringify(cleanup, null, 2));
    if (errors.length) throw new AggregateError(errors, 'Speech fixture cleanup failed; diagnostics and fixture retained');
  });

  it('reports missing speech configuration honestly without borrowing coding credentials', async () => {
    const before = calls.length;
    const config = await disabled.app.inject('/speech/config');
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ enabled: false, provider: 'aliyun', model: 'qwen3-asr-flash', maxBytes: 4 * 1024 * 1024, maxDurationMs: 60_000 });
    const result = await disabled.app.inject({ method: 'POST', url: '/speech/transcribe', headers: { 'content-type': 'audio/webm', 'x-speech-request-id': randomUUID() }, payload: audio });
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('SPEECH_NOT_CONFIGURED');
    expect(calls).toHaveLength(before);
  });

  it('returns only safe public configuration', async () => {
    const response = await configured.app.inject('/speech/config');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, provider: 'aliyun', model: 'qwen3-asr-flash', maxBytes: 4 * 1024 * 1024, maxDurationMs: 60_000 });
    expect(response.body).not.toContain('speech-fake-only');
    expect(response.body).not.toContain(upstream.baseUrl);
  });

  it('sends one Data URI with the fixed model and fake Authorization; codecs MIME succeeds', async () => {
    const requestId = randomUUID();
    const before = calls.length;
    const response = await post(audio, 'audio/webm;codecs=opus', requestId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requestId, text: '把按钮改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' });
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toEqual({ path: '/compatible-mode/v1/chat/completions', authorization: 'Bearer speech-fake-only',
      body: { model: 'qwen3-asr-flash', stream: false, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/webm;base64,${audio.toString('base64')}` } }] }] } });
    expect(response.body).not.toContain('data:audio');
    expect(response.body).not.toContain('speech-fake-only');
  });

  it.each([
    ['oversized', Buffer.alloc(4 * 1024 * 1024 + 1), 'audio/webm', 413, 'SPEECH_TOO_LARGE'],
    ['unsupported', audio, 'text/plain', 415, 'SPEECH_UNSUPPORTED_MEDIA'],
    ['empty', Buffer.alloc(0), 'audio/webm', 400, 'SPEECH_INVALID_AUDIO'],
    ['JSON masquerading as audio', Buffer.from('{"baseUrl":"https://invalid.example"}'), 'application/json', 415, 'SPEECH_UNSUPPORTED_MEDIA'],
  ] as const)('rejects %s safely before upstream', async (_name, bytes, mime, status, code) => {
    const before = calls.length;
    const response = await post(bytes, mime);
    expect(response.statusCode).toBe(status);
    expect(response.json().error.code).toBe(code);
    expect(response.body).not.toMatch(/FST_ERR|speech-fake-only|data:audio|invalid\.example/);
    expect(calls).toHaveLength(before);
  });

  it('requires a UUID before issuing any upstream request', async () => {
    const before = calls.length;
    for (const requestId of ['', 'not-a-uuid']) expect((await post(audio, 'audio/webm', requestId)).statusCode).toBe(400);
    expect(calls).toHaveLength(before);
  });

  it('unknown cancellation returns 404 and never creates a call', async () => {
    const before = calls.length;
    const response = await configured.app.inject({ method: 'DELETE', url: `/speech/transcribe/${randomUUID()}` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('SPEECH_NOT_FOUND');
    expect(calls).toHaveLength(before);
  });

  it('normal completed response is cached and DELETE cannot rewrite it as cancelled', async () => {
    const requestId = randomUUID();
    const before = calls.length;
    const first = await post(audio, 'audio/webm', requestId);
    expect(first.statusCode).toBe(200);
    const cancelled = await configured.app.inject({ method: 'DELETE', url: `/speech/transcribe/${requestId}` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ requestId, status: 'completed' });
    const cached = await post(audio, 'audio/webm', requestId);
    expect(cached.json()).toEqual(first.json());
    expect(calls).toHaveLength(before + 1);
    expect((await post(Buffer.concat([audio, Buffer.from([3])]), 'audio/webm', requestId)).statusCode).toBe(409);
  });

  it('keeps Host and Origin rejection ahead of speech processing', async () => {
    const before = calls.length;
    for (const headers of [{host:'foreign.example'}, {host:'localhost',origin:'http://foreign.example'}]) {
      const response = await configured.app.inject({method:'POST',url:'/speech/transcribe',headers:{...headers,'content-type':'audio/webm','x-speech-request-id':randomUUID()},payload:audio});
      expect(response.statusCode).toBe(403);
    }
    expect(calls).toHaveLength(before);
  });

  it('does not expand binary or body limits on existing JSON routes', async () => {
    const before = calls.length;
    const binary = await configured.app.inject({method:'POST',url:'/tasks',headers:{'content-type':'audio/webm'},payload:audio});
    const large = await configured.app.inject({method:'POST',url:'/tasks',headers:{'content-type':'application/json'},payload:JSON.stringify({instruction:'x'.repeat(20_000)})});
    expect(binary.statusCode).not.toBe(202);
    expect(large.statusCode).not.toBe(202);
    expect(calls).toHaveLength(before);
  });
});
