import type { Candidate, Check, CheckArtifact, CheckName, CheckRun } from '@spatial/shared';

export const checkNames = { schema: '场景配置', build: '构建', smoke: '页面冒烟', occlusion: '交互遮挡' } as const;
export const primaryEvidence: Record<CheckName, string> = { schema: 'schema.json', build: 'build.log', smoke: 'smoke.json', occlusion: 'occlusion.json' };
export const requiredEvidence = ['schema.json', 'build.log', 'smoke.json', 'smoke.png', 'occlusion.json', 'occlusion.png'];
const safeNames = [...requiredEvidence, 'runner.log', 'summary.json'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isCheckRun(value: unknown): value is CheckRun {
  return record(value) && ['id', 'candidateId', 'candidateCommit', 'baseVersion', 'mainVersion', 'contentDigest', 'policyVersion', 'createdAt'].every(key => typeof value[key] === 'string') &&
    ['queued', 'running', 'completed', 'cancelled'].includes(String(value.status)) && Array.isArray(value.checks) &&
    value.checks.every(check => record(check) && typeof check.name === 'string' && typeof check.status === 'string' && (check.message === undefined || typeof check.message === 'string')) &&
    (value.error === undefined || (record(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string')) &&
    (value.artifacts === undefined || Array.isArray(value.artifacts));
}
export function activeRun(run: CheckRun | undefined) { return run?.status === 'queued' || run?.status === 'running'; }
export function associatedRun(candidate: Candidate, run: CheckRun | undefined) {
  return !!run && isCheckRun(run) && run.id === candidate.latestCheckRunId && run.candidateId === candidate.id &&
    run.candidateCommit === candidate.candidateCommit && run.baseVersion === candidate.baseVersion;
}
function validChecks(checks: Check[]) {
  return Array.isArray(checks) && checks.length === 4 && Object.keys(checkNames).every(name => checks.filter(check => check?.name === name && ['passed', 'failed', 'not_run'].includes(check.status)).length === 1);
}
export function consistentChecks(candidate: Candidate, run: CheckRun) {
  return associatedRun(candidate, run) && validChecks(candidate.checks) && validChecks(run.checks) && candidate.checks.every(check => {
    const other = run.checks.find(item => item.name === check.name);
    return other?.status === check.status && other.evidence === check.evidence && check.runId === run.id;
  });
}
export function checkView(candidate: Candidate, run: CheckRun | undefined) {
  const associated = associatedRun(candidate, run);
  const complete = !!run && consistentChecks(candidate, run);
  const rows = (Object.keys(checkNames) as CheckName[]).map(name => {
    const items = associated ? run!.checks.filter(check => check.name === name) : [];
    const item = items.length === 1 && ['passed', 'failed', 'not_run'].includes(items[0].status) ? items[0] : undefined;
    return { name, label: checkNames[name], status: item?.status ?? 'not_run', missing: !item, message: item?.message, durationMs: item?.durationMs };
  });
  let label = '未检查';
  if (candidate.latestCheckRunId && !associated) label = '检查状态不完整';
  else if (run && associated) {
    if (run.status === 'queued') label = '排队中';
    else if (run.status === 'running') label = '检查中';
    else if (run.status === 'cancelled') label = '检查已取消';
    else label = run.outcome === 'failed' ? '检查失败' : run.outcome === 'passed' && complete && rows.every(row => row.status === 'passed') && !run.error ? '全部检查通过' : '未完成检查';
  }
  return { rows, label, complete, associated };
}
export function mergeRun(previous: CheckRun | undefined, incoming: CheckRun) {
  if (!previous) return incoming;
  if (!activeRun(previous) && activeRun(incoming)) return previous;
  if (previous.status === 'running' && incoming.status === 'queued') return previous;
  const done = (run: CheckRun) => run.checks.filter(check => check.status !== 'not_run').length;
  if (previous.status === incoming.status && done(previous) > done(incoming)) return previous;
  return incoming;
}
export function evidenceUrl(runId: string, name: string) {
  if (!/^[a-z0-9]{6,32}$/.test(runId) || !safeNames.includes(name)) return undefined;
  return `/checks/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`;
}
export function safeArtifact(value: unknown): value is CheckArtifact {
  if (!record(value) || typeof value.name !== 'string' || !safeNames.includes(value.name) || typeof value.mime !== 'string') return false;
  const expected = value.name.endsWith('.png') ? 'image/png' : value.name.endsWith('.json') ? 'application/json' : 'text/plain';
  return value.mime.split(';')[0].trim().toLowerCase() === expected && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0 && Number(value.bytes) <= 2 * 1024 * 1024 && typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
}
export function evidenceRefs(candidate: Candidate, run: CheckRun | undefined) {
  if (!associatedRun(candidate, run) || !Array.isArray(run!.artifacts)) return [];
  return run!.artifacts!.filter(safeArtifact).filter(ref => {
    if (run!.artifacts!.filter(other => other?.name === ref.name).length !== 1) return false;
    const name = (Object.keys(primaryEvidence) as CheckName[]).find(name => primaryEvidence[name] === ref.name);
    if (!name) return true;
    const checks = run!.checks.filter(check => check.name === name);
    const candidates = candidate.checks.filter(check => check.name === name);
    return checks.length === 1 && candidates.length === 1 && checks[0].evidence === ref.hash && candidates[0].evidence === ref.hash && candidates[0].runId === run!.id;
  });
}
