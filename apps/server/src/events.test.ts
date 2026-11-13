import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { EventLog } from './events.ts';

it('continues sequence numbers across restarts and replays only newer events', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-events-'));
  try {
    const first = new EventLog(directory);
    await first.init();
    first.publish({ type: 'task.updated', taskId: 'one' });
    first.publish({ type: 'scene.changed', value: 2 });
    await first.close();

    const second = new EventLog(directory);
    await second.init();
    expect(second.last).toBe(2);
    expect(second.since(0).map(event => event.type)).toEqual(['task.updated', 'scene.changed']);
    expect(second.since(1).map(event => event.seq)).toEqual([2]);
    const latest = second.publish({ type: 'version.changed', version: 'abc' });
    expect(latest.seq).toBe(3);
    expect(latest.ts).toMatch(/^\d{4}-/);
    await second.close();
    const lines = (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map(line => JSON.parse(line).seq)).toEqual([1, 2, 3]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('skips a torn final line and reports when history has been truncated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-events-'));
  try {
    const first = new EventLog(directory, 2);
    await first.init();
    for (let index = 0; index < 3; index += 1) first.publish({ type: 'task.updated', index });
    await first.close();
    const second = new EventLog(directory, 2);
    await second.init();
    expect(second.last).toBe(3);
    expect(second.oldest).toBe(2);
    expect(second.since(0).map(event => event.seq)).toEqual([2, 3]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
