import { describe, expect, it } from 'vitest';
import type { Candidate, CheckRun } from '@spatial/shared';
import { associatedRun, checkView, consistentChecks, evidenceRefs, evidenceUrl, mergeRun, safeArtifact } from './check-state.ts';
import { emptyM2State, reduceM2Event } from './m2-state.ts';

function fixture() {
  const hash = 'a'.repeat(64);
  const run: CheckRun = { id: 'run001', candidateId: 'c', candidateCommit: 'commit', baseVersion: 'v1', mainVersion: 'v1', contentDigest: 'digest', policyVersion: 'policy', toolIdentity: 'tool', createdAt: 'now', status: 'completed', outcome: 'passed', checks: ['schema', 'build', 'smoke', 'occlusion'].map(name => ({ name, status: 'passed', evidence: hash })) as CheckRun['checks'], artifacts: ['schema.json', 'build.log', 'smoke.json', 'smoke.png', 'occlusion.json', 'occlusion.png'].map(name => ({ name, mime: name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/plain', hash, bytes: 3 })) };
  const candidate: Candidate = { id: 'c', candidateCommit: 'commit', baseVersion: 'v1', branch: 'c', previewUrl: '/preview/c/', diff: [], outOfScope: [], decision: 'pending', latestCheckRunId: run.id, checks: run.checks.map(check => ({ ...check, runId: run.id })) };
  return { candidate, run };
}
describe('real check presentation', () => {
  it('requires actual four results; completed alone never implies passing', () => {
    const { candidate, run } = fixture();
    expect(checkView(candidate, run).label).toBe('全部检查通过');
    run.checks = run.checks.map(check => ({ ...check, status: 'not_run' }));
    expect(checkView(candidate, run).label).toBe('未完成检查');
    expect(checkView(candidate, run).rows.map(row => row.status)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
    expect(checkView({ ...candidate, latestCheckRunId: undefined }, undefined).label).toBe('未检查');
    expect(checkView(candidate, { ...run, candidateId: 'other' }).label).toBe('检查状态不完整');
  });
  it('retains failures and blocked messages and flags duplicates/missing checks', () => {
    const { candidate, run } = fixture();
    run.status = 'running';
    run.checks[0] = { name: 'schema', status: 'failed', message: '<script>error</script>' };
    run.checks[1] = { name: 'build', status: 'not_run', message: 'blocked_by:schema' };
    expect(checkView(candidate, run).rows[1].message).toBe('blocked_by:schema');
    run.checks.push(run.checks[0]);
    expect(consistentChecks(candidate, run)).toBe(false);
    expect(checkView(candidate, run).rows[0].missing).toBe(true);
    run.checks = run.checks.filter(check => check.name !== 'smoke');
    expect(checkView(candidate, run).rows[2].missing).toBe(true);
  });
  it('keeps older run events in their bucket and does not revert current terminal progress', () => {
    const { candidate, run } = fixture();
    const state = { ...emptyM2State, candidates: [candidate], runs: { [run.id]: run } };
    const older = { ...run, id: 'run000', status: 'running' as const };
    const next = reduceM2Event(state, { type: 'check.updated', seq: 10, run: older, candidate: { ...candidate, latestCheckRunId: older.id } });
    expect(next.candidates[0].latestCheckRunId).toBe(run.id);
    const replayedReady = reduceM2Event(next, { type: 'candidate.ready', seq: 11, candidate: { ...candidate, latestCheckRunId: undefined, checks: [] } });
    expect(replayedReady.candidates[0].latestCheckRunId).toBe(run.id);
    expect(replayedReady.candidates[0].checks).toEqual(candidate.checks);
    expect(associatedRun(candidate, older)).toBe(false);
    expect(mergeRun(run, { ...run, status: 'running' })).toBe(run);
    expect(mergeRun({ ...run, status: 'running' }, { ...run, status: 'running', checks: run.checks.map(check => ({ ...check, status: 'not_run' })) }).checks).toEqual(run.checks);
  });
  it('accepts check.updated progress only for the associated latest run', () => {
    const { candidate, run } = fixture();
    const pending = { ...run, status: 'running' as const, checks: run.checks.map(check => ({ ...check, status: 'not_run' as const })) };
    const next = reduceM2Event({ ...emptyM2State, candidates: [candidate], runs: { [run.id]: pending } }, { type: 'check.updated', seq: 1, run, candidate });
    expect(next.runs[run.id].checks[0].status).toBe('passed');
  });
});
describe('evidence references', () => {
  it('uses only fixed names and matching hashes, never evidence as URL', () => {
    const { candidate, run } = fixture();
    expect(evidenceRefs(candidate, run)).toHaveLength(6);
    expect(evidenceUrl(run.id, 'schema.json')).toBe('/checks/run001/artifacts/schema.json');
    expect(evidenceUrl(run.id, '../../secret')).toBeUndefined();
    expect(evidenceUrl('../run', 'schema.json')).toBeUndefined();
    candidate.checks[0].evidence = 'https://invalid.example/';
    expect(evidenceRefs(candidate, run).some(ref => ref.name === 'schema.json')).toBe(false);
  });
  it('rejects duplicate artifacts, unsupported MIME, malformed bytes/hash and cross-run evidence', () => {
    const { candidate, run } = fixture();
    run.artifacts!.push(run.artifacts![0]);
    expect(evidenceRefs(candidate, run).some(ref => ref.name === 'schema.json')).toBe(false);
    expect(safeArtifact({ ...run.artifacts![1], mime: 'text/html' })).toBe(false);
    expect(safeArtifact({ ...run.artifacts![1], hash: 'script' })).toBe(false);
    expect(safeArtifact({ ...run.artifacts![1], bytes: -1 })).toBe(false);
    expect(evidenceRefs(candidate, { ...run, id: 'old001' })).toEqual([]);
  });
});
