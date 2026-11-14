import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdoptButton } from './CandidatePanel.tsx';
import type { Candidate, CheckRun } from '@spatial/shared';
import { adoptionReason, operationError, proofKey } from './adoption-gate.ts';
import { MutationLocks } from './mutation-locks.ts';

function allowed() {
  const hash = 'a'.repeat(64);
  const run: CheckRun = { id: 'run001', candidateId: 'c', candidateCommit: 'commit', baseVersion: 'v', mainVersion: 'v', contentDigest: 'digest', policyVersion: 'policy', toolIdentity: 'tool', createdAt: 'now', status: 'completed', outcome: 'passed', checks: ['schema', 'build', 'smoke', 'occlusion'].map(name => ({ name, status: 'passed', evidence: hash })) as CheckRun['checks'], artifacts: ['schema.json', 'build.log', 'smoke.json', 'smoke.png', 'occlusion.json', 'occlusion.png'].map(name => ({ name, hash, bytes: 8, mime: name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'text/plain' })) };
  const candidate: Candidate = { id: 'c', candidateCommit: 'commit', baseVersion: 'v', branch: 'c', previewUrl: '/preview/c/', decision: 'pending', checks: run.checks.map(check => ({ ...check, runId: run.id })), latestCheckRunId: run.id, diff: [], outOfScope: [] };
  return { candidate, run, ready: true, connected: true, busy: false, version: 'v', epoch: 1, receipt: { ready: true, key: proofKey(candidate, run, 'v', 1) }, rejectedRun: '' };
}
type Input = ReturnType<typeof allowed>;
const cases: [string, (input: Input) => void][] = [
  ['unsynchronized', x => { x.ready = false; }], ['disconnected', x => { x.connected = false; }], ['busy', x => { x.busy = true; }],
  ['closed', x => { x.candidate.decision = 'discarded'; }], ['missing commit', x => { delete x.candidate.candidateCommit; }],
  ['base changed', x => { x.candidate.baseVersion = 'new'; }], ['no latest', x => { delete x.candidate.latestCheckRunId; }],
  ['wrong run', x => { x.run.id = 'run002'; }], ['wrong candidate', x => { x.run.candidateId = 'other'; }],
  ['wrong commit', x => { x.run.candidateCommit = 'other'; }], ['wrong base', x => { x.run.baseVersion = 'other'; }], ['wrong main', x => { x.run.mainVersion = 'other'; }],
  ['queued', x => { x.run.status = 'queued'; }], ['running', x => { x.run.status = 'running'; }], ['cancelled', x => { x.run.status = 'cancelled'; }],
  ['non passed', x => { x.run.outcome = 'not_run'; }], ['error', x => { x.run.error = { code: 'ERR', message: 'failed' }; }],
  ['digest missing', x => { x.run.contentDigest = ''; }], ['policy missing', x => { x.run.policyVersion = ''; }], ['tool missing', x => { delete x.run.toolIdentity; }],
  ['failed check', x => { x.run.checks[0].status = 'failed'; }], ['not run check', x => { x.candidate.checks[0].status = 'not_run'; }],
  ['missing check', x => { x.run.checks.pop(); }], ['duplicate check', x => { x.candidate.checks[0] = x.candidate.checks[1]; }],
  ['wrong check run', x => { x.candidate.checks[0].runId = 'run000'; }], ['hash mismatch', x => { x.run.checks[0].evidence = 'b'.repeat(64); }],
  ['missing artifact', x => { x.run.artifacts!.pop(); }], ['duplicate artifact', x => { x.run.artifacts!.push(x.run.artifacts![0]); }],
  ['unreadable', x => { x.receipt.ready = false; }], ['old epoch', x => { x.epoch++; }], ['server rejected proof', x => { x.rejectedRun = x.run.id; }],
];
it('enables only the fully bound, current and readable proof', () => {
  const reason = adoptionReason(allowed());
  expect(reason).toBe('');
  const submit = vi.fn();
  const button = AdoptButton({ reason, onAdopt: submit });
  expect(renderToStaticMarkup(button)).not.toContain('disabled');
  button.props.onClick();
  expect(submit).toHaveBeenCalledOnce();
});
it.each(cases)('blocks adoption: %s', (_name, change) => {
  const input = allowed(); change(input);
  // Even a fabricated read receipt cannot bypass any structural condition.
  if (!['old epoch', 'unreadable'].includes(_name)) input.receipt.key = proofKey(input.candidate, input.run, input.version, input.epoch);
  const reason = adoptionReason(input);
  expect(reason).not.toBe('');
  const submit = vi.fn();
  const button = AdoptButton({ reason, onAdopt: submit });
  expect(renderToStaticMarkup(button)).toContain('disabled=""');
  button.props.onClick();
  button.props.onClick();
  expect(submit).not.toHaveBeenCalled();
});
it('rejects a missing run or a receipt from another candidate', () => {
  expect(adoptionReason({ ...allowed(), run: undefined })).not.toBe('');
  expect(adoptionReason({ ...allowed(), receipt: { ready: true, key: 'old' } })).not.toBe('');
});
it('scopes backend error codes to their actual operation', () => {
  expect(operationError('adopt', 'CHECKS_NOT_PASSED')).toContain('证明已失效');
  expect(operationError('run', 'STALE_CANDIDATE')).toContain('重新生成候选');
  expect(operationError('adopt', 'STALE_CANDIDATE')).toBe('无法确认服务器状态，请刷新后继续');
  expect(operationError('adopt', 'MERGE_CONFLICT')).toBe('无法确认服务器状态，请刷新后继续');
  expect(operationError('revert', 'NO_ADOPTION')).toBe('暂无可回退的采用记录');
});
it('locks synchronously across cards and work decisions until a newer authoritative sync', () => {
  const locks = new MutationLocks();
  const token = locks.acquire(['candidate:c', 'work'])!;
  expect(locks.acquire(['candidate:c'])).toBeUndefined();
  expect(locks.acquire(['work'])).toBeUndefined();
  locks.synchronized(100); // GET before the POST settles cannot release it.
  expect(locks.blocked(['work'])).toBe(true);
  locks.awaiting(token, 100);
  locks.synchronized(100);
  expect(locks.blocked(['work'])).toBe(true);
  locks.synchronized(101);
  expect(locks.blocked(['work'])).toBe(false);
  locks.acquire(['approval:a', 'task:t']);
  expect(locks.acquire(['task:t'])).toBeUndefined();
  expect(locks.acquire(['task:other'])).toBeDefined();
});
