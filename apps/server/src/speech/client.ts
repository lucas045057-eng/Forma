import type { SpeechConfig, SpeechErrorCode } from '@spatial/shared';

export const SPEECH_MODEL = 'qwen3-asr-flash';
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const SPEECH_TIMEOUT_MS = 35_000;
const messages: Record<SpeechErrorCode, string> = {
  SPEECH_NOT_CONFIGURED: '尚未配置语音识别服务',
  SPEECH_INVALID_AUDIO: '音频或请求编号无效',
  SPEECH_TOO_LARGE: '录音超过大小上限',
  SPEECH_UNSUPPORTED_MEDIA: '不支持此录音格式',
  SPEECH_UPSTREAM: '语音识别服务暂不可用',
  SPEECH_TIMEOUT: '语音识别超时',
  SPEECH_CANCELLED: '语音识别已取消',
  SPEECH_BUSY: '另一个语音识别请求正在处理',
  SPEECH_REQUEST_CONFLICT: '请求编号已用于不同的录音',
  SPEECH_NOT_FOUND: '语音识别请求不存在',
  SPEECH_CLOSING: '语音服务正在关闭',
};
export class SpeechError extends Error {
  constructor(public readonly code: SpeechErrorCode, public readonly status: number) { super(messages[code]); }
}
export interface SpeechClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Internal constructor option, never derived from environment or a request. */
  testLoopback?: boolean;
}
function endpoint(base: string, testLoopback: boolean) {
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('Invalid speech configuration'); }
  const productionHost = ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'].includes(url.hostname) ||
    /^[a-z0-9][a-z0-9-]{0,62}\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname);
  const local = testLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || /[?#]/.test(base) || url.pathname.replace(/\/$/, '') !== '/compatible-mode/v1' ||
    (!local && !(url.protocol === 'https:' && !url.port && productionHost))) throw new Error('Invalid speech configuration');
  url.pathname = '/compatible-mode/v1/chat/completions';
  return url.href;
}
export function audioMime(value: unknown): string {
  if (typeof value !== 'string') throw new SpeechError('SPEECH_UNSUPPORTED_MEDIA', 415);
  const [mime, ...parameters] = value.toLowerCase().split(';').map(part => part.trim());
  if (!['audio/webm', 'audio/ogg', 'audio/wav'].includes(mime) || parameters.some(part => !/^codecs\s*=\s*(?:opus|"opus")$/.test(part)) || (mime === 'audio/wav' && parameters.length)) {
    throw new SpeechError('SPEECH_UNSUPPORTED_MEDIA', 415);
  }
  return mime;
}
export function validateAudio(bytes: Buffer, mime: string) {
  if (bytes.length > MAX_AUDIO_BYTES) throw new SpeechError('SPEECH_TOO_LARGE', 413);
  const valid = mime === 'audio/webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) :
    mime === 'audio/ogg' ? bytes.subarray(0, 4).toString('ascii') === 'OggS' :
    mime === 'audio/wav' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
  if (!valid) throw new SpeechError('SPEECH_INVALID_AUDIO', 400);
}
export function validateRequestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new SpeechError('SPEECH_INVALID_AUDIO', 400);
}
export class SpeechClient {
  readonly config: SpeechConfig;
  private readonly url?: string;
  private readonly apiKey?: string;
  constructor(options: SpeechClientOptions = {}) {
    if (options.model !== undefined && options.model !== SPEECH_MODEL) throw new Error('Invalid speech configuration');
    this.url = options.baseUrl ? endpoint(options.baseUrl, options.testLoopback === true) : undefined;
    if (options.apiKey && /[\r\n]/.test(options.apiKey)) throw new Error('Invalid speech configuration');
    this.apiKey = options.apiKey?.trim() || undefined;
    this.config = { enabled: !!(this.url && this.apiKey), provider: 'aliyun', model: SPEECH_MODEL,
      supportedMimeTypes: ['audio/webm', 'audio/ogg', 'audio/wav'], maxBytes: MAX_AUDIO_BYTES, maxDurationMs: 60_000,
      notice: '录音会发送到阿里云百炼识别；取消或断网不保证未计费。' };
  }
  async transcribe(audio: Buffer, mime: string, signal: AbortSignal): Promise<string> {
    if (!this.url || !this.apiKey) throw new SpeechError('SPEECH_NOT_CONFIGURED', 503);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal.throwIfAborted();
      const response = await fetch(this.url, { method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: SPEECH_MODEL, stream: false,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audio.toString('base64')}` } }] }] }) });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new SpeechError('SPEECH_UPSTREAM', 502); }
      reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new SpeechError('SPEECH_UPSTREAM', 502); }
        chunks.push(value);
      }
      signal.throwIfAborted();
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text: unknown = parsed?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new SpeechError('SPEECH_UPSTREAM', 502);
      return text;
    } catch (error) {
      if (signal.aborted && signal.reason instanceof SpeechError) throw signal.reason;
      if (error instanceof SpeechError) throw error;
      throw new SpeechError('SPEECH_UPSTREAM', 502);
    } finally { reader?.releaseLock(); }
  }
}
