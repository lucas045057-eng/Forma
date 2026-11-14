import type { ApprovalCard, Candidate, CheckRun, Task } from '@spatial/shared';
import { isApproval, mergeApproval } from './approval-state.ts';

export interface M2State { tasks: Task[]; candidates: Candidate[]; version: string; approvals: ApprovalCard[]; runs: Record<string, CheckRun> }
export const emptyM2State: M2State = { tasks: [], candidates: [], version: '', approvals: [], runs: {} };

export type IncomingEvent = { type: string; seq: number; ts?: string } & Record<string, unknown>;

function upsert<T extends { id: string }>(list: T[], value: T) {
  const rest = list.filter(item => item.id !== value.id);
  return [value, ...rest];
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Merge one trusted backend event; malformed or unrelated payloads leave state unchanged. */
export function reduceM2Event(state: M2State, event: IncomingEvent): M2State {
  if (event.type === 'approval.requested' || event.type === 'approval.resolved') {
    if (!isApproval(event.approval)) return state;
    return { ...state, approvals: mergeApproval(state.approvals, event.approval) };
  }
  if (event.type === 'check.started' || event.type === 'check.updated' || event.type === 'check.finished') {
    const run = object(event.run);
    if (typeof run?.id !== 'string' || typeof run.candidateId !== 'string' || !Array.isArray(run.checks)) return state;
    const next = { ...state, runs: { ...state.runs, [run.id]: run as unknown as CheckRun } };
    const candidate = object(event.candidate);
    return candidate?.id === run.candidateId ? reduceM2Event(next, { ...event, type: 'candidate.ready' }) : next;
  }
  if (event.type === 'task.updated') {
    const task = object(event.task);
    if (typeof task?.id !== 'string' || typeof task.status !== 'string' || !Array.isArray(task.events)) return state;
    const old = state.tasks.find(item => item.id === task.id);
    const terminal = ['done', 'failed', 'cancelled'];
    if (old && terminal.includes(old.status) && !terminal.includes(task.status)) return state;
    return { ...state, tasks: upsert(state.tasks, task as unknown as Task) };
  }
  if (event.type === 'candidate.ready' || event.type === 'candidate.closed') {
    const candidate = object(event.candidate);
    if (typeof candidate?.id !== 'string' || typeof candidate.decision !== 'string' || !Array.isArray(candidate.diff)) return state;
    const old = state.candidates.find(item => item.id === candidate.id);
    if (old && old.decision !== 'pending' && candidate.decision === 'pending') return state;
    return { ...state, candidates: upsert(state.candidates, candidate as unknown as Candidate) };
  }
  if (event.type === 'version.changed' && typeof event.version === 'string') return { ...state, version: event.version };
  return state;
}

/** A gap before the retained history means event replay alone cannot reconstruct current state. */
export function historyTruncated(oldest: number, lastSeq: number) {
  return lastSeq > 0 && Number.isSafeInteger(oldest) && oldest > lastSeq + 1;
}

export function contiguousReplay(events: IncomingEvent[], anchor: number, current: number) {
  const ordered = newEventsInOrder(events, anchor);
  let cursor = anchor;
  for (const event of ordered) if (event.seq !== ++cursor) return null;
  return cursor < current ? null : { events: ordered, cursor };
}

export function newEventsInOrder(events: IncomingEvent[], lastSeq: number) {
  const unique = new Map<number, IncomingEvent>();
  for (const event of events) if (Number.isSafeInteger(event.seq) && event.seq > lastSeq) unique.set(event.seq, event);
  return [...unique.values()].sort((a, b) => a.seq - b.seq);
}
