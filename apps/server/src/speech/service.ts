import { createHash } from 'node:crypto';
import type { SpeechCancelResult, SpeechConfig, SpeechResult } from '@spatial/shared';
import { audioMime, SPEECH_TIMEOUT_MS, SpeechError, validateAudio, validateRequestId } from './client.ts';

type Outcome = { value: SpeechResult } | { error: SpeechError };
interface Terminal { digest: string; outcome: Outcome; expires: number }
interface Active {
  id: string;
  digest: string;
  controller: AbortController;
  consumers: Set<symbol>;
  result: Promise<Outcome>;
  settled: Promise<void>;
  terminal?: Outcome;
  finish: (outcome: Outcome) => void;
}
interface Client { config: SpeechConfig; transcribe(audio: Buffer, mime: string, signal: AbortSignal): Promise<string> }
export class SpeechService {
  private active?: Active;
  private readonly terminals = new Map<string, Terminal>();
  private closing = false;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly client:Client;
  constructor(client: Client, options: { timeoutMs?: number; now?: () => number } = {}) {
    this.client=client;
    this.timeoutMs = options.timeoutMs ?? SPEECH_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > SPEECH_TIMEOUT_MS) throw new Error('Invalid speech timeout');
    this.now = options.now ?? Date.now;
  }
  get config() { return this.client.config; }
  private prune() {
    for (const [id, terminal] of this.terminals) if (terminal.expires <= this.now()) this.terminals.delete(id);
  }
  join(id: string, audio: Buffer, contentType: string): { result: Promise<SpeechResult>; release: () => void } {
    if (this.closing) throw new SpeechError('SPEECH_CLOSING', 503);
    validateRequestId(id);
    const mime = audioMime(contentType);
    validateAudio(audio, mime);
    if (!this.config.enabled) throw new SpeechError('SPEECH_NOT_CONFIGURED', 503);
    const digest = createHash('sha256').update(mime).update('\0').update(audio).digest('hex');
    this.prune();
    const prior = this.terminals.get(id);
    if (prior) {
      if (prior.digest !== digest) throw new SpeechError('SPEECH_REQUEST_CONFLICT', 409);
      return { result: this.result(Promise.resolve(prior.outcome)), release: () => {} };
    }
    if (this.active && this.active.id === id && this.active.digest !== digest) throw new SpeechError('SPEECH_REQUEST_CONFLICT', 409);
    if (this.active && this.active.id !== id) throw new SpeechError('SPEECH_BUSY', 429);
    const active = this.active ?? this.start(id, digest, audio, mime);
    const token = Symbol();
    active.consumers.add(token);
    return { result: this.result(active.result), release: () => {
      if (!active.consumers.delete(token)) return;
      if (!active.terminal && active.consumers.size === 0) this.abort(active, new SpeechError('SPEECH_CANCELLED', 499));
    } };
  }
  private async result(outcome: Promise<Outcome>): Promise<SpeechResult> {
    const completed = await outcome;
    if ('error' in completed) throw completed.error;
    return completed.value;
  }
  private start(id: string, digest: string, audio: Buffer, mime: string): Active {
    let resolve!: (outcome: Outcome) => void;
    const result = new Promise<Outcome>(done => { resolve = done; });
    const active: Active = { id, digest, controller: new AbortController(), consumers: new Set(), result, settled: Promise.resolve(), finish: () => {} };
    const timer = setTimeout(() => this.abort(active, new SpeechError('SPEECH_TIMEOUT', 504)), this.timeoutMs);
    active.finish = outcome => {
      if (active.terminal) return;
      active.terminal = outcome;
      clearTimeout(timer);
      this.terminals.set(id, { digest, outcome, expires: this.now() + 300_000 });
      while (this.terminals.size > 32) this.terminals.delete(this.terminals.keys().next().value!);
      resolve(outcome);
    };
    this.active = active;
    active.settled = (async () => {
      try {
        const text = await this.client.transcribe(audio, mime, active.controller.signal);
        if (!active.controller.signal.aborted) active.finish({ value: { requestId: id, text, provider: 'aliyun', model: this.config.model } });
      } catch (error) {
        active.finish({ error: error instanceof SpeechError ? error : new SpeechError('SPEECH_UPSTREAM', 502) });
      } finally {
        clearTimeout(timer);
        if (this.active === active) this.active = undefined;
      }
    })();
    return active;
  }
  private abort(active: Active, error: SpeechError) {
    if (active.terminal) return;
    active.finish({ error });
    active.controller.abort(error);
  }
  async cancel(id: string): Promise<SpeechCancelResult> {
    validateRequestId(id);
    this.prune();
    const active = this.active?.id === id ? this.active : undefined;
    if (active) {
      this.abort(active, new SpeechError('SPEECH_CANCELLED', 499));
      await active.settled;
    }
    const terminal = this.terminals.get(id);
    if (!terminal) throw new SpeechError('SPEECH_NOT_FOUND', 404);
    return { requestId: id, status: 'error' in terminal.outcome && terminal.outcome.error.code === 'SPEECH_CANCELLED' ? 'cancelled' : 'completed' };
  }
  beginClose() {
    this.closing = true;
    if (this.active) this.abort(this.active, new SpeechError('SPEECH_CANCELLED', 499));
  }
  async idle() { await this.active?.settled; }
  async close() { await this.idle(); }
}
