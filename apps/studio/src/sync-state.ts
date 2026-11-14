import type { Candidate, CheckRun } from '@spatial/shared';
import { consistentChecks, isCheckRun } from './check-state.ts';
import { contiguousReplay, reduceM2Event, type IncomingEvent, type M2State } from './m2-state.ts';

export function currentSync(generation: number, operation: number, connection: number, request: number, open: boolean, disposed: boolean) {
  return !disposed && open && generation === connection && operation === request;
}
export type EventHistory = { events: IncomingEvent[]; current: number; oldest: number; truncated: boolean };
export function pendingRunIds(candidates: Candidate[]) {
  return [...new Set(candidates.filter(candidate => candidate.decision === 'pending').map(candidate => candidate.latestCheckRunId).filter((id): id is string => !!id))];
}
export function collectRunResults(ids: string[], results: PromiseSettledResult<unknown>[]) {
  const runs: Record<string, CheckRun> = {};
  const failed: string[] = [];
  ids.forEach((id, index) => {
    const result = results[index];
    if (result?.status === 'fulfilled' && isCheckRun(result.value) && result.value.id === id) runs[id] = result.value;
    else failed.push(id);
  });
  return { runs, failed };
}
export function isolateCheckViews(state: M2State, failed: string[] = [], unresolved: string[] = []) {
  const checkIssues: Record<string, string> = {};
  for (const candidate of state.candidates) {
    if (candidate.decision !== 'pending') continue;
    const id = candidate.latestCheckRunId;
    const run = id ? state.runs[id] : undefined;
    if (unresolved.includes(candidate.id) || (id && (failed.includes(id) || !run || !consistentChecks(candidate, run) || !run.toolIdentity?.trim() || !run.policyVersion.trim()))) {
      checkIssues[candidate.id] = '检查状态不完整，请刷新检查状态';
    }
  }
  return { ...state, checkIssues };
}
export function reconcileLiveEvent(state: M2State, event: IncomingEvent) {
  const next = isolateCheckViews(reduceM2Event(state, event));
  const checkIssues = { ...state.checkIssues, ...next.checkIssues };
  if (event.type.startsWith('check.') && !isCheckRun(event.run)) {
    const value = event.run as { candidateId?: unknown } | undefined;
    if (typeof value?.candidateId === 'string') checkIssues[value.candidateId] = '检查状态不完整，请刷新检查状态';
  }
  return { ...next, checkIssues };
}
/** Only missing event history prevents global synchronization. Check faults stay local. */
export function reconcileSnapshot(snapshot: M2State, history: EventHistory, buffer: IncomingEvent[], anchor: number, overflow: boolean, failed: string[] = []) {
  if (overflow || history.truncated || history.oldest > anchor + 1 || history.current < anchor) return null;
  const replay = contiguousReplay([...history.events, ...buffer], anchor, history.current);
  if (!replay) return null;
  const state = replay.events.reduce(reduceM2Event, snapshot);
  const changed = replay.events.filter(event => {
    const run = event.run;
    return event.type === 'check.started' && isCheckRun(run) && state.candidates.some(candidate => candidate.decision === 'pending' && candidate.id === run.candidateId && candidate.latestCheckRunId !== run.id);
  });
  const unresolved = changed.map(event => (event.run as CheckRun).candidateId);
  const isolated = isolateCheckViews(state, failed, unresolved);
  const changedView = replay.events.some(event => {
    const run = event.run;
    return event.type.startsWith('check.') && isCheckRun(run) && !failed.includes(run.id) && !!isolated.checkIssues[run.candidateId];
  });
  return { ...replay, state: isolated, retryChecks: unresolved.length > 0 || changedView, syncReady: true as const };
}
