import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechClient } from './client.ts';
import { SpeechService } from './service.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';

const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
const reply = (text: unknown = '修改标题') => JSON.stringify({ choices: [{ message: { content: text } }] });
const options = { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'speech-fake-only' };
afterEach(() => vi.restoreAllMocks());
async function stop(mock: Awaited<ReturnType<typeof listenHttpForFetch>>) {
  const errors:unknown[]=[];
  try {mock.server.closeAllConnections();}catch(error){errors.push(error);}
  try {if (mock.server.listening) await new Promise<void>((resolve,reject)=>mock.server.close(error=>error?reject(error):resolve()));expect(mock.server.listening).toBe(false);}
  catch(error){errors.push(error);}
  if(process.env.D1_RUN_DIR)await writeFile(path.join(process.env.D1_RUN_DIR,`speech-mock-${randomUUID()}-cleanup.json`),JSON.stringify({pid:process.pid,base:mock.baseUrl,listening:mock.server.listening,errors:errors.map(String)},null,2));
  if(errors.length)throw new AggregateError(errors,'Speech upstream mock cleanup failed');
}

describe('speech endpoint validation', () => {
  it.each([
    'https://evil.oss-cn-hangzhou.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com.evil.example/compatible-mode/v1',
    'http://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://user@dashscope.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/compatible-mode/v1?key=fake',
    'https://dashscope.aliyuncs.com/compatible-mode/v1#fake',
    'https://dashscope.aliyuncs.com:444/compatible-mode/v1',
    'https://dashscope.aliyuncs.com/wrong',
    'http://127.0.0.1:29001/compatible-mode/v1',
  ])('refuses an untrusted production base before any request: %s', baseUrl => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(() => new SpeechClient({ ...options, baseUrl })).toThrow('Invalid speech configuration');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'workspace-1.cn-beijing.maas.aliyuncs.com', 'workspace-1.ap-southeast-1.maas.aliyuncs.com'])('accepts only precise documented host forms: %s', host => {
    expect(new SpeechClient({ ...options, baseUrl: `https://${host}/compatible-mode/v1/` }).config.enabled).toBe(true);
  });
  it('does not accept a remote host even through the internal loopback option', () => {
    expect(() => new SpeechClient({ ...options, baseUrl: 'http://192.0.2.1:29001/compatible-mode/v1', testLoopback: true })).toThrow();
    expect(() => new SpeechClient({ ...options, model: 'other-model' })).toThrow();
  });
});

describe('upstream streaming and protocol boundaries', () => {
  it.each([401, 429, 500])('redacts upstream status %i without retry', async status => {
    const mock = await listenHttpForFetch((_request, response) => { response.writeHead(status); response.end('fake-secret-upstream-body'); });
    try {
      const client = new SpeechClient({ baseUrl: `${mock.baseUrl}/compatible-mode/v1`, apiKey: 'speech-fake-only', testLoopback: true });
      await expect(client.transcribe(audio, 'audio/webm', new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_UPSTREAM', message: '语音识别服务暂不可用' });
    } finally { await stop(mock); }
  });
  it.each(['{broken', reply(''), reply('x'.repeat(4001)), reply(null)])('rejects malformed or unbounded text safely', async body => {
    const mock = await listenHttpForFetch((_request, response) => { response.writeHead(200); response.end(body); });
    try {
      const client = new SpeechClient({ baseUrl: `${mock.baseUrl}/compatible-mode/v1`, apiKey: 'speech-fake-only', testLoopback: true });
      await expect(client.transcribe(audio, 'audio/webm', new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_UPSTREAM' });
    } finally { await stop(mock); }
  });
  it('does not follow redirects or forward credentials to another listener', async () => {
    let leaked = 0;
    const sink = await listenHttpForFetch((_request, response) => { ++leaked; response.end(reply()); });
    const mock = await listenHttpForFetch((_request, response) => { response.writeHead(307, { location: sink.baseUrl }); response.end(); });
    try {
      const client = new SpeechClient({ baseUrl: `${mock.baseUrl}/compatible-mode/v1`, apiKey: 'speech-fake-only', testLoopback: true });
      await expect(client.transcribe(audio, 'audio/webm', new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_UPSTREAM' });
      expect(leaked).toBe(0);
    } finally { try { await stop(mock); } finally { await stop(sink); } }
  });
  it('aborts an actual unfinished response stream within the total budget', async () => {
    let started = false;
    let interrupted!: () => void;
    const closed = new Promise<void>(resolve => { interrupted = resolve; });
    const mock = await listenHttpForFetch((request, response) => {
      request.resume(); request.once('end', () => {
        started = true; response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"choices":[');
        response.once('close', () => { if (!response.writableFinished) interrupted(); });
      });
    });
    const service = new SpeechService(new SpeechClient({ baseUrl: `${mock.baseUrl}/compatible-mode/v1`, apiKey: 'speech-fake-only', testLoopback: true }), { timeoutMs: 500 });
    try {
      await expect(service.join(randomUUID(), audio, 'audio/webm').result).rejects.toMatchObject({ code: 'SPEECH_TIMEOUT' });
      await closed; expect(started).toBe(true);
    } finally { try { service.beginClose(); await service.close(); } finally { await stop(mock); } }
  });
  it('cancels an excessive stream while reading, before a second read', async () => {
    let cancelled = false;
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({
      pull(controller) { ++reads; if (reads === 1) controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 })));
    await expect(new SpeechClient(options).transcribe(audio, 'audio/webm', new AbortController().signal)).rejects.toMatchObject({ code: 'SPEECH_UPSTREAM' });
    expect(cancelled).toBe(true);
    expect(reads).toBe(1);
  });
});

function controlled() {
  let calls = 0;
  let signal!: AbortSignal;
  let release!: (text: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const client = { config: new SpeechClient(options).config,
    async transcribe(_bytes: Buffer, _mime: string, nextSignal: AbortSignal) { ++calls; signal = nextSignal; return gate; } };
  const service = new SpeechService(client);
  return { service, release, get signal() { return signal; }, get calls() { return calls; } };
}

describe('one upstream, terminal identity, cancellation and cache', () => {
  it('detaches only the departing consumer; conflicts and busy requests cannot send upstream', async () => {
    const fixture = controlled(); const id = randomUUID();
    try {
      const a = fixture.service.join(id, audio, 'audio/webm');
      const b = fixture.service.join(id, audio, 'audio/webm');
      expect(() => fixture.service.join(id, Buffer.concat([audio, Buffer.from([2])]), 'audio/webm')).toThrowError(expect.objectContaining({ code: 'SPEECH_REQUEST_CONFLICT' }));
      expect(() => fixture.service.join(randomUUID(), audio, 'audio/webm')).toThrowError(expect.objectContaining({ code: 'SPEECH_BUSY' }));
      a.release(); expect(fixture.signal.aborted).toBe(false);
      fixture.release('成功');
      expect((await b.result).text).toBe('成功'); b.release();
      expect(fixture.calls).toBe(1);
      expect((await fixture.service.join(id, audio, 'audio/webm').result).text).toBe('成功');
    } finally { fixture.release('finally'); fixture.service.beginClose(); await fixture.service.close(); }
  });
  it('last disconnect cancels and late upstream success cannot overwrite the cached terminal', async () => {
    const fixture = controlled(); const id = randomUUID();
    const a = fixture.service.join(id, audio, 'audio/webm');
    const b = fixture.service.join(id, audio, 'audio/webm');
    const results = Promise.allSettled([a.result, b.result]);
    a.release(); b.release();
    expect(fixture.signal.aborted).toBe(true);
    fixture.release('too late');
    try {
      const settled = await results;
      expect(settled.every(result => result.status === 'rejected' && result.reason.code === 'SPEECH_CANCELLED')).toBe(true);
      await expect(fixture.service.join(id, audio, 'audio/webm').result).rejects.toMatchObject({ code: 'SPEECH_CANCELLED' });
    } finally { fixture.service.beginClose(); await fixture.service.close(); }
  });
  it('explicit cancellation cancels both consumers and waits for real settlement', async () => {
    const fixture = controlled(); const id = randomUUID();
    const a = fixture.service.join(id, audio, 'audio/webm'); const b = fixture.service.join(id, audio, 'audio/webm');
    const results = Promise.allSettled([a.result,b.result]);
    let returned = false;
    const cancelled = fixture.service.cancel(id).then(value => { returned = true; return value; });
    expect(fixture.signal.aborted).toBe(true); expect(returned).toBe(false);
    fixture.release('late');
    try {
      expect(await cancelled).toEqual({requestId:id,status:'cancelled'});
      expect((await results).every(result=>result.status==='rejected')).toBe(true);
      expect(await fixture.service.cancel(id)).toEqual({requestId:id,status:'cancelled'});
    } finally { fixture.service.beginClose(); await fixture.service.close(); }
  });
  it('expires cache after five minutes and caps it at 32 without keeping audio', async () => {
    let calls = 0; let now = 0;
    const service = new SpeechService({ config:new SpeechClient(options).config, transcribe:async()=>{++calls;return 'ok';} }, { now:()=>now });
    const ids = Array.from({length:33},()=>randomUUID());
    try {
      for (const id of ids) { const lease=service.join(id,audio,'audio/webm'); await lease.result; lease.release(); await service.idle(); }
      expect(calls).toBe(33);
      await service.join(ids[32],audio,'audio/webm').result; expect(calls).toBe(33);
      await service.join(ids[0],audio,'audio/webm').result; await service.idle(); expect(calls).toBe(34);
      now=300_001;
      await service.join(ids[32],audio,'audio/webm').result; expect(calls).toBe(35);
    } finally { service.beginClose(); await service.close(); }
  });
  it('times out even while the response body never finishes, and aborts the reader transport', async () => {
    let aborted = false;
    const client = { config:new SpeechClient(options).config, transcribe:(_bytes:Buffer,_mime:string,signal:AbortSignal)=>new Promise<string>((_resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
    }) };
    const service = new SpeechService(client,{timeoutMs:25});
    try { await expect(service.join(randomUUID(),audio,'audio/webm').result).rejects.toMatchObject({code:'SPEECH_TIMEOUT'}); expect(aborted).toBe(true); }
    finally { service.beginClose(); await service.close(); }
  });
  it('preClose synchronously aborts and seals admission; onClose only awaits settlement', async () => {
    const fixture=controlled();
    const lease=fixture.service.join(randomUUID(),audio,'audio/webm');
    const result=Promise.allSettled([lease.result]);
    fixture.service.beginClose();
    expect(fixture.signal.aborted).toBe(true);
    expect(()=>fixture.service.join(randomUUID(),audio,'audio/webm')).toThrowError(expect.objectContaining({code:'SPEECH_CLOSING'}));
    fixture.release('late');await fixture.service.close();
    expect((await result)[0].status).toBe('rejected');
  });
});
