import { describe, expect, it } from 'vitest';
import { emptyM2State, historyTruncated, newEventsInOrder, reduceM2Event, type IncomingEvent } from './m2-state.ts';

const event = (seq: number, value: Record<string, unknown>): IncomingEvent => ({ type: 'task.updated', seq, ...value });
const task = { id: 't1', instruction: '改按钮', status: 'queued', events: [] };

describe('M2 state reduction', () => {
  it('upserts tasks and candidates by id and tracks the work version', () => {
    let state = reduceM2Event(emptyM2State, event(1, { task }));
    expect(state.tasks).toHaveLength(1);
    state = reduceM2Event(state, event(2, { task: { ...task, status: 'done', candidateId: 'c1' } }));
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].status).toBe('done');
    state = reduceM2Event(state, { type: 'candidate.ready', seq: 3, candidate: { id: 'c1', decision: 'pending', baseVersion: 'v', branch: 'c1', previewUrl: '/preview/c1/', diff: [], outOfScope: [], checks: [] } });
    state = reduceM2Event(state, { type: 'version.changed', seq: 4, version: 'abc' });
    expect(state.candidates[0].id).toBe('c1');
    expect(state.version).toBe('abc');
  });
  it('ignores malformed and unrelated events', () => {
    expect(reduceM2Event(emptyM2State, event(1, { task: { id: 'broken' } }))).toBe(emptyM2State);
    expect(reduceM2Event(emptyM2State, { type: 'scene.changed', seq: 1 })).toBe(emptyM2State);
    expect(reduceM2Event(emptyM2State, { type: 'candidate.ready', seq: 1, candidate: { id: 'bad', decision: 'pending', diff: [null] } })).toBe(emptyM2State);
    expect(reduceM2Event(emptyM2State, event(2, { task: { ...task, events: [{ sequence: 1, message: {} }] } }))).toBe(emptyM2State);
  });
});

describe('event replay', () => {
  it('detects a truncated replay window only after an initial snapshot', () => {
    expect(historyTruncated(10, 8)).toBe(true);
    expect(historyTruncated(9, 8)).toBe(false);
    expect(historyTruncated(10, 0)).toBe(false);
  });
  it('drops already-seen events and sorts replay by sequence', () => {
    const list = [event(3, {}), event(1, {}), event(2, {}), event(2, {})];
    expect(newEventsInOrder(list, 1).map(item => item.seq)).toEqual([2, 3]);
  });
});
