import { mkdir, readFile, truncate } from 'node:fs/promises';
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';

export type StudioEvent = { type: string; seq: number; ts: string } & Record<string, unknown>;

export class EventLog {
  private events: StudioEvent[] = [];
  private seq = 0;
  private failed = false;
  private subscribers = new Set<(event: StudioEvent) => void>();
  private file: string;
  private keep: number;
  constructor(directory: string, keep = 2000) { this.file = path.join(directory, 'events.jsonl'); this.keep = keep; }
  async init() {
    await mkdir(path.dirname(this.file), { recursive: true });
    let data: Buffer;
    try { data = await readFile(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; data = Buffer.alloc(0); }
    // Only newline-terminated records are committed. Repair an interrupted append before writing again.
    const boundary = data.lastIndexOf(10) + 1;
    if (boundary !== data.length) await truncate(this.file, boundary);
    for (const line of data.subarray(0, boundary).toString('utf8').split('\n')) {
      if (!line) continue;
      const event = JSON.parse(line) as StudioEvent;
      if (!Number.isSafeInteger(event.seq) || event.seq <= this.seq || typeof event.type !== 'string') throw new Error('Invalid event journal');
      this.seq = event.seq;
      this.events.push(event);
    }
    this.events = this.events.slice(-this.keep);
  }
  get last() { return this.seq; }
  subscribe(listener: (event: StudioEvent) => void) { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; }
  private closed = false;
  publish(event: { type: string } & Record<string, unknown>): StudioEvent {
    if (this.closed) throw new Error('事件日志已关闭，拒绝在关闭后写入事件');
    if (this.failed) throw new Error('Event journal failed; restart required');
    const stamped = structuredClone({ ...event, seq: this.seq + 1, ts: typeof event.ts === 'string' ? event.ts : new Date().toISOString() }) as StudioEvent;
    let fd: number | undefined;
    try {
      fd = openSync(this.file, 'a');
      const bytes = Buffer.from(JSON.stringify(stamped) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } catch (error) { this.failed = true; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    this.seq = stamped.seq;
    this.events.push(stamped);
    if (this.events.length > this.keep) this.events.shift();
    for (const send of this.subscribers) { try { send(stamped); } catch { /* One disconnected subscriber cannot invalidate the committed event. */ } }
    return stamped;
  }
  since(seq: number) { return structuredClone(this.events.filter(event => event.seq > seq)); }
  get oldest() { return this.events[0]?.seq ?? this.seq + 1; }
  async idle() {}
  async close() { this.closed = true; this.subscribers.clear(); await this.idle(); }
}
