import type { Candidate, CheckRun } from '@spatial/shared';
import { associatedRun, consistentChecks, evidenceRefs, requiredEvidence } from './check-state.ts';

export type EvidenceReceipt = { key: string; ready: boolean } | null;
export function proofKey(candidate: Candidate, run: CheckRun | undefined, version: string, epoch: number) {
  return JSON.stringify([version, epoch, candidate, run]);
}
export function adoptionReason(input: { candidate?: Candidate; run?: CheckRun; version: string; epoch: number; ready: boolean; connected: boolean; busy: boolean; rejectedRun?: string; receipt: EvidenceReceipt }) {
  const { candidate, run, version, epoch, ready, connected, busy, rejectedRun, receipt } = input;
  if (!ready || !connected) return '状态待同步，请刷新状态后继续';
  if (busy) return '操作结果待确认，请刷新状态后继续';
  if (!candidate || candidate.decision !== 'pending') return '候选已关闭或不存在';
  if (!candidate.candidateCommit?.trim()) return '候选缺少记录，请重新生成';
  if (candidate.baseVersion !== version) return '证明已失效，作品已变化，请重新生成候选';
  if (!candidate.latestCheckRunId) return '尚未运行检查，请先运行检查';
  if (!run || !associatedRun(candidate, run) || run.mainVersion !== version) return '检查状态不完整或基线不一致';
  if (run.id === rejectedRun) return '检查未通过或证明已失效，请重新检查；候选过期时需重新生成';
  if (run.status !== 'completed' || run.outcome !== 'passed' || run.error) return '检查未全部通过';
  if (![run.contentDigest, run.policyVersion, run.toolIdentity].every(value => typeof value === 'string' && !!value.trim())) return '检查证明缺少身份信息';
  if (!consistentChecks(candidate, run) || !run.checks.every(check => check.status === 'passed')) return '四项检查缺失、不一致或未全部通过';
  const refs = evidenceRefs(candidate, run);
  if (!requiredEvidence.every(name => refs.filter(ref => ref.name === name).length === 1)) return '必需证据缺失或 hash 不一致';
  if (!receipt?.ready || receipt.key !== proofKey(candidate, run, version, epoch)) return '证据尚未全部可读，请刷新检查状态';
  return '';
}
export function refreshError(succeeded: boolean, prior = '') {
  if (succeeded) return '操作已提交，状态刷新失败，请刷新状态';
  return prior && prior !== '无法确认服务器状态，请刷新后继续' ? `${prior}；状态刷新失败，请刷新状态` : '无法确认服务器状态，请刷新后继续';
}
export function operationError(kind: string, code?: string, status?: number, message?: string) {
  if (kind === 'adopt' && code === 'CHECKS_NOT_PASSED') return '检查未通过或证明已失效，请刷新检查状态；候选过期时需重新生成';
  if ((kind === 'run' || kind === 'rerun') && code === 'STALE_CANDIDATE') return '候选内容或主作品已变化，请重新生成候选';
  if (kind === 'revert' && code === 'NO_ADOPTION') return '暂无可回退的采用记录';
  if (code === 'STALE_APPROVAL') return '请示已失效，请重新生成任务';
  if (code === 'APPROVAL_ALREADY_ANSWERED' || code === 'APPROVAL_NOT_PENDING') return '该请示已处理或不可继续，正在刷新状态';
  if (code === 'APPROVAL_LIMIT') return '最多保留 3 张待处理请示，请先处理现有卡片';
  if (code === 'LEGACY_CANDIDATE') return '候选缺少记录，请重新生成';
  if (code === 'NOT_FOUND') return '对象已不存在';
  if (code === 'INVALID_STATE') return '对象已关闭或正在处理';
  if (code === 'STALE_SELECTION') return '页面已变化，请重新点选';
  if (status !== undefined && status >= 400 && status < 500) return `操作被拒绝：${message || code || '请求不被接受'}`;
  return '无法确认服务器状态，请刷新后继续';
}
