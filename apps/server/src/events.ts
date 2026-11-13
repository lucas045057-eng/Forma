import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type StudioEvent = { type: string; seq: number; ts: string } & Record<string, unknown>;

/**
 * One ordered, durable stream for every event the Studio can receive. `seq` survives restarts
 * so a client can resume with GET /events/history?since=<last seq> after a dropped connection.
 */
export class EventLog {
  private events: StudioEvent[] = [];
  private seq = 0;
  private writes: Promise<void> = Promise.resolve();
  private subscribers = new Set<(event: StudioEvent) => void>();
  private file: string;
  private keep: number;
  constructor(directory: string, keep = 2000) { this.file = path.join(directory, 'events.jsonl'); this.keep = keep; }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    let text = '';
    try { text = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // A torn final line from an interrupted append is skipped rather than failing startup.
      try { const event = JSON.parse(line) as StudioEvent; if (Number.isSafeInteger(event.seq)) this.events.push(event); } catch { /* skip */ }
    }
    this.seq = this.events.reduce((max, event) => Math.max(max, event.seq), 0);
    this.events = this.events.slice(-this.keep);
  }
  get last() { return this.seq; }
  subscribe(listener: (event: StudioEvent) => void) { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; }
  publish(event: { type: string } & Record<string, unknown>): StudioEvent {
    const stamped = { ...event, seq: ++this.seq, ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString() } as StudioEvent;
    this.events.push(stamped);
    if (this.events.length > this.keep) this.events.splice(0, this.events.length - this.keep);
    const line = JSON.stringify(stamped) + '\n';
    this.writes = this.writes.then(() => appendFile(this.file, line)).catch(() => { /* Delivery continues; history may miss this line. */ });
    for (const send of this.subscribers) send(stamped);
    return stamped;
  }
  since(seq: number) { return this.events.filter(event => event.seq > seq); }
  /** The oldest sequence still replayable; a client further behind must reload full state. */
  get oldest() { return this.events[0]?.seq ?? this.seq + 1; }
  async idle() { await this.writes; }
  close() { this.subscribers.clear(); return this.idle(); }
}
