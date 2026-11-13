import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createApp } from './app.ts';

it('keeps the event log inside the work-data lock and continues seq after a graceful restart (review F4)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'events-lock-'));
  const shared = { workRoot: path.resolve(import.meta.dirname, '../../../templates/product-page'), workDataDirectory: path.join(root, 'm2'),
    historyDirectory: path.join(root, 'history'), base: 'http://127.0.0.1:9', key: 'mock-only' };
  const log = path.join(root, 'm2', 'events.jsonl');
  try {
    const first = await createApp({ ...shared, dataDirectory: path.join(root, 'assets-1') });
    first.events.publish({ type: 'test.marker', n: 1 });
    first.events.publish({ type: 'test.marker', n: 2 });
    await first.events.idle();
    const before = await readFile(log, 'utf8');
    const last = first.events.last;
    // A second backend on the same work data must fail before reading or repairing the log.
    await expect(createApp({ ...shared, dataDirectory: path.join(root, 'assets-2') })).rejects.toMatchObject({ code: 'INSTANCE_LOCKED' });
    expect(await readFile(log, 'utf8')).toBe(before);
    await first.app.close();
    const second = await createApp({ ...shared, dataDirectory: path.join(root, 'assets-3') });
    try {
      expect(second.events.last).toBe(last);
      expect(second.events.publish({ type: 'test.marker', n: 3 }).seq).toBe(last + 1);
    } finally { await second.app.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
