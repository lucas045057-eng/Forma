import { expect, it } from 'vitest';
import type { Candidate, CheckRun } from '@spatial/shared';
import { emptyM2State } from './m2-state.ts';
import { currentSync, collectRunResults, pendingRunIds, reconcileLiveEvent, reconcileSnapshot } from './sync-state.ts';

function fixture(id: string) {
  const run: CheckRun = { id: `run00${id}`, candidateId: id, candidateCommit: 'commit', baseVersion: 'v', mainVersion: 'v', contentDigest: 'digest', policyVersion: 'policy', toolIdentity: 'tool', createdAt: 'now', status: 'running', checks: ['schema', 'build', 'smoke', 'occlusion'].map(name => ({ name, status: 'not_run' })) as CheckRun['checks'] };
  const candidate: Candidate = { id, candidateCommit: 'commit', baseVersion: 'v', branch: id, previewUrl: '/preview/main/', decision: 'pending', latestCheckRunId: run.id, checks: run.checks.map(check => ({ ...check, runId: run.id })), diff: [], outOfScope: [] };
  return { candidate, run };
}
it('drops late operations and old connections without publishing their snapshot', () => {
  expect(currentSync(2, 3, 2, 3, true, false)).toBe(true);
  expect(currentSync(2, 2, 2, 3, true, false)).toBe(false);
  expect(currentSync(1, 3, 2, 3, true, false)).toBe(false);
  expect(currentSync(2, 3, 2, 3, false, false)).toBe(false);
  expect(currentSync(2, 3, 2, 3, true, true)).toBe(false);
});
const history = { events: [], current: 10, oldest: 1, truncated: false };
it('a run GET failure isolates one candidate while global sync and the other candidate succeed', () => {
  const a = fixture('a'), b = fixture('b');
  const ids = pendingRunIds([a.candidate, b.candidate]);
  const results = collectRunResults(ids, [{ status: 'rejected', reason: new Error('404') }, { status: 'fulfilled', value: b.run }]);
  const result = reconcileSnapshot({ ...emptyM2State, candidates: [a.candidate, b.candidate], runs: results.runs }, history, [], 10, false, results.failed)!;
  expect(result.syncReady).toBe(true);
  expect(result.retryChecks).toBe(false);
  expect(result.state.checkIssues.a).toContain('检查状态不完整');
  expect(result.state.checkIssues.b).toBeUndefined();
  expect(result.state.runs[b.run.id]).toEqual(b.run);
});
it('unhealthy views without runId and legacy empty toolIdentity stay local', () => {
  const a = fixture('a'), b = fixture('b');
  a.candidate.checks = a.run.checks;
  b.run.toolIdentity = '';
  const result = reconcileSnapshot({ ...emptyM2State, candidates: [a.candidate, b.candidate], runs: { [a.run.id]: a.run, [b.run.id]: b.run } }, history, [], 10, false)!;
  expect(result.syncReady).toBe(true);
  expect(Object.keys(result.state.checkIssues)).toEqual(['a', 'b']);
  expect(result.retryChecks).toBe(false);
});
it('does not plan run GETs for adopted or discarded candidates', () => {
  const a = fixture('a'), b = fixture('b'), c = fixture('c');
  b.candidate.decision = 'adopted'; c.candidate.decision = 'discarded';
  expect(pendingRunIds([a.candidate, b.candidate, c.candidate])).toEqual([a.run.id]);
  const result = reconcileSnapshot({ ...emptyM2State, candidates: [b.candidate, c.candidate] }, history, [], 10, false)!;
  expect(result.syncReady).toBe(true);
  expect(result.state.checkIssues).toEqual({});
});
it('old candidate.ready cannot clear a newer latest pointer during snapshot replay', () => {
  const { candidate, run } = fixture('a');
  const event = { type: 'candidate.ready', seq: 11, candidate: { ...candidate, latestCheckRunId: undefined, checks: [] } };
  const result = reconcileSnapshot({ ...emptyM2State, candidates: [candidate], runs: { [run.id]: run } }, { ...history, current: 11, events: [event] }, [event], 10, false)!;
  expect(result.state.candidates[0].latestCheckRunId).toBe(run.id);
  expect(result.state.candidates[0].checks).toEqual(candidate.checks);
  expect(result.state.checkIssues).toEqual({});
  expect(result.events).toHaveLength(1);
});
it('a faulty live check.updated does not taint another candidate or request global resync', () => {
  const a = fixture('a'), b = fixture('b');
  const state = { ...emptyM2State, candidates: [a.candidate, b.candidate], runs: { [a.run.id]: a.run, [b.run.id]: b.run } };
  const next = reconcileLiveEvent(state, { type: 'check.updated', seq: 11, run: a.run, candidate: { ...a.candidate, checks: a.run.checks } });
  expect(next.checkIssues.a).toBeTruthy();
  expect(next.checkIssues.b).toBeUndefined();
  expect(next.candidates.find(item => item.id === 'b')).toEqual(b.candidate);
});
it('snapshot-window events are replayed, while history gaps and overflow require reanchoring', () => {
  const event = { type: 'version.changed', seq: 11, version: 'new' };
  const result = reconcileSnapshot(emptyM2State, history, [event], 10, false)!;
  expect(result.state.version).toBe('new');
  expect(result.cursor).toBe(11);
  expect(reconcileSnapshot(emptyM2State, history, [], 10, true)).toBeNull();
  expect(reconcileSnapshot(emptyM2State, { ...history, current: 12 }, [{ ...event, seq: 12 }], 10, false)).toBeNull();
  expect(reconcileSnapshot(emptyM2State, { ...history, truncated: true }, [], 10, false)).toBeNull();
});
it('a new run in the snapshot window requests a bounded reread but keeps failure candidate-local', () => {
  const a = fixture('a');
  const newer = { ...a.run, id: 'newrun' };
  const event = { type: 'check.started', seq: 11, run: newer, candidate: { ...a.candidate, latestCheckRunId: newer.id } };
  const result = reconcileSnapshot({ ...emptyM2State, candidates: [a.candidate], runs: { [a.run.id]: a.run } }, history, [event], 10, false)!;
  expect(result.retryChecks).toBe(true);
  expect(result.syncReady).toBe(true);
  expect(result.state.checkIssues.a).toBeTruthy();
});
