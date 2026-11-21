import type { Candidate, CheckArtifact, CheckRun, Task } from '@spatial/shared';
import { parseDiff } from './diff.ts';
import { activeRun, associatedRun, checkView, evidenceRefs } from './check-state.ts';

/** The overview only ever shows a real screenshot: the smoke check's own first-screen capture. */
export const THUMBNAIL_EVIDENCE = 'smoke.png';

export type ThumbnailSource = { key: string; runId: string; ref: CheckArtifact };
export type ThumbnailPlaceholder = 'unchecked' | 'checking' | 'unavailable';

export interface CandidateSummary {
  id: string;
  shortId: string;
  instruction?: string;
  files: number;
  added: number;
  deleted: number;
  checkLabel: string;
  checkTone: 'ok' | 'wait' | 'bad' | 'none';
  outOfScope: number;
  staleBase: boolean;
  thumbnail?: ThumbnailSource;
  placeholder: ThumbnailPlaceholder;
}

export function diffStats(candidate: Candidate) {
  let added = 0;
  let deleted = 0;
  for (const file of candidate.diff) {
    for (const line of parseDiff(file.patch)) {
      if (line.kind === 'add') added++;
      else if (line.kind === 'delete') deleted++;
    }
  }
  return { files: candidate.diff.length, added, deleted };
}

/** A screenshot is offered only when it comes from this candidate's own, finished, associated run. */
export function thumbnailSource(candidate: Candidate, run: CheckRun | undefined): ThumbnailSource | undefined {
  if (!run || activeRun(run) || !associatedRun(candidate, run)) return undefined;
  const ref = evidenceRefs(candidate, run).find(item => item.name === THUMBNAIL_EVIDENCE);
  return ref ? { key: `${run.id}:${ref.hash}`, runId: run.id, ref } : undefined;
}

export function summarizeCandidate(candidate: Candidate, input: {
  run?: CheckRun; tasks: Task[]; version: string; ready: boolean; checkIssue?: string;
}): CandidateSummary {
  const { run, tasks, version, ready, checkIssue } = input;
  const view = checkView(candidate, run);
  const thumbnail = thumbnailSource(candidate, run);
  const instruction = tasks.find(task => task.candidateId === candidate.id)?.instruction.trim() || undefined;
  let checkLabel = ready ? view.label : '状态待同步';
  if (checkIssue) checkLabel = '检查状态不完整';
  const checkTone: CandidateSummary['checkTone'] = !ready || checkIssue ? 'wait'
    : checkLabel === '全部检查通过' ? 'ok'
    : checkLabel === '检查失败' || checkLabel === '检查状态不完整' ? 'bad'
    : checkLabel === '未检查' ? 'none' : 'wait';
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
    placeholder: thumbnail ? 'unavailable' : run && activeRun(run) && associatedRun(candidate, run) ? 'checking' : candidate.latestCheckRunId ? 'unavailable' : 'unchecked',
  };
}
