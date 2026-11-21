import type { Candidate, CheckArtifact, CheckRun, Task } from '@spatial/shared';
import { countDiff } from './diff.ts';
import { activeRun, associatedRun, checkView, evidenceRefs } from './check-state.ts';

/** The overview only ever shows a real screenshot: the smoke check's own first-screen capture. */
export const THUMBNAIL_EVIDENCE = 'smoke.png';

export type ThumbnailSource = { key: string; runId: string; ref: CheckArtifact };
export type ThumbnailPlaceholder = 'unchecked' | 'checking' | 'syncing' | 'stale' | 'incomplete' | 'unavailable';

export interface CandidateSummary {
  id: string;
  shortId: string;
  instruction?: string;
  files: number;
  /** `null` when a patch cannot be counted reliably; the UI then shows no numbers. */
  added: number | null;
  deleted: number | null;
  checkLabel: string;
  checkTone: 'ok' | 'wait' | 'bad' | 'none';
  outOfScope: number;
  staleBase: boolean;
  thumbnail?: ThumbnailSource;
  placeholder: ThumbnailPlaceholder;
}

export function diffStats(candidate: Candidate): { files: number; added: number | null; deleted: number | null } {
  let added = 0;
  let deleted = 0;
  for (const file of candidate.diff) {
    const counted = countDiff(file.patch);
    if (!counted) return { files: candidate.diff.length, added: null, deleted: null };
    added += counted.added;
    deleted += counted.deleted;
  }
  return { files: candidate.diff.length, added, deleted };
}

/** CheckPanel's staleness rule: proof is current only against the live version and while not rejected. */
export function proofStale(candidate: Candidate, run: CheckRun | undefined, version: string, proofRejected: boolean) {
  return proofRejected || candidate.baseVersion !== version || (!!run && run.mainVersion !== version);
}

/**
 * A screenshot is offered only from this candidate's own finished, associated run, while the
 * state is synchronized and that run is still current proof. The key carries the sync epoch,
 * so a reconnect/refresh re-reads and re-verifies the image instead of reusing a cached one.
 */
export function thumbnailSource(candidate: Candidate, run: CheckRun | undefined, gate: {
  ready: boolean; stale: boolean; checkIssue?: string; epoch: number;
}): ThumbnailSource | undefined {
  if (!gate.ready || gate.stale || gate.checkIssue) return undefined;
  if (!run || activeRun(run) || !associatedRun(candidate, run)) return undefined;
  const ref = evidenceRefs(candidate, run).find(item => item.name === THUMBNAIL_EVIDENCE);
  return ref ? { key: `${gate.epoch}:${candidate.id}:${run.id}:${ref.hash}`, runId: run.id, ref } : undefined;
}

export function summarizeCandidate(candidate: Candidate, input: {
  run?: CheckRun; tasks: Task[]; version: string;
  /** Synchronized, connected, and no operation on this candidate awaits confirmation. */
  ready: boolean;
  epoch: number;
  checkIssue?: string;
  proofRejected?: boolean;
}): CandidateSummary {
  const { run, tasks, version, ready, checkIssue, epoch } = input;
  const view = checkView(candidate, run);
  const stale = proofStale(candidate, run, version, !!input.proofRejected);
  const thumbnail = thumbnailSource(candidate, run, { ready, stale, checkIssue, epoch });
  const instruction = tasks.find(task => task.candidateId === candidate.id)?.instruction.trim() || undefined;
  // Same precedence as CheckPanel's `check-run-status`.
  const checkLabel = checkIssue ? '检查状态不完整' : stale ? '历史检查结果 · 证明已失效' : ready ? view.label : '状态待同步';
  const checkTone: CandidateSummary['checkTone'] = checkLabel === '检查失败' || checkLabel === '检查状态不完整' ? 'bad'
    : checkLabel === '全部检查通过' ? 'ok'
    : checkLabel === '未检查' ? 'none' : 'wait';
  const checking = !!run && activeRun(run) && associatedRun(candidate, run);
  const placeholder: ThumbnailPlaceholder = checkIssue ? 'incomplete'
    : !ready ? 'syncing'
    : !candidate.latestCheckRunId ? 'unchecked'
    : stale ? 'stale'
    : checking ? 'checking'
    : 'unavailable';
  return {
    id: candidate.id,
    shortId: candidate.id.slice(0, 8),
    instruction,
    ...diffStats(candidate),
    checkLabel,
    checkTone,
    outOfScope: candidate.outOfScope.length,
    staleBase: !!version && candidate.baseVersion !== version,
    thumbnail,
    placeholder,
  };
}
