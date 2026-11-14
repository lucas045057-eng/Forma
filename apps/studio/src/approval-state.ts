import type { ApprovalCard, Selection, StudioMessage, Task } from '@spatial/shared';

const statuses = ['pending', 'approving', 'approved', 'rejected', 'cancelled', 'stale', 'failed'];
const rules = ['shared_component', 'global_style', 'out_of_scope', 'analysis_uncertain'];
export function isApproval(value: unknown): value is ApprovalCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as Record<string, unknown>;
  return ['id', 'taskId', 'question', 'reason', 'baseVersion', 'contentDigest', 'ruleVersion', 'createdAt', 'updatedAt'].every(key => typeof card[key] === 'string') &&
    statuses.includes(String(card.status)) && ['affected', 'evidence', 'ruleCodes'].every(key => Array.isArray(card[key]) && card[key].every((item: unknown) => typeof item === 'string')) &&
    (card.ruleCodes as string[]).every(rule => rules.includes(rule)) && Array.isArray(card.options) && card.options.length === 2 &&
    card.options.every(option => option && typeof option.label === 'string' && typeof option.impact === 'string');
}
export function waiting(card: ApprovalCard) { return card.status === 'pending' || card.status === 'approving'; }
export function sortApprovals(cards: ApprovalCard[]) {
  return [...cards].sort((a, b) => Number(waiting(b)) - Number(waiting(a)) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function canAnswer(card: ApprovalCard, task: Task | undefined, version: string, ready: boolean) {
  return ready && isApproval(card) && card.status === 'pending' && card.baseVersion === version && task?.id === card.taskId && task.status === 'awaiting_approval';
}
export function sourceFile(src: string): string | undefined {
  const match = /^(src\/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?)):[1-9]\d*:[1-9]\d*$/.exec(src);
  const file = match?.[1];
  return file && !file.split('/').some(part => part === '.' || part === '..') ? file : undefined;
}
export function affectedSource(card: ApprovalCard, task: Task | undefined, affected: string, version: string): string | undefined {
  if (!waiting(card) || card.baseVersion !== version || !card.affected.includes(affected)) return;
  const selection = task?.id === card.taskId ? task.selection : undefined;
  if (selection?.baseVersion === version && sourceFile(selection.src) === affected) return selection.src;
  if (sourceFile(affected)) return affected;
}
export function isImpactPickError(message: string) { return message === '未找到带源码标记的外层容器'; }
export function impactHighlightMessages(src: string): StudioMessage[] {
  // stop clears bridge hover and its temporary selection; start restores the overlay.
  return [{ type: 'pick:stop' }, { type: 'pick:start' }, { type: 'highlight', payload: { src } }];
}
export function restorePicking(wasPicking: boolean, selection: Selection | null, version: string) {
  return wasPicking && selection?.baseVersion === version;
}

/** Replaying a snapshot's older event must not reopen a persisted terminal card. */
export function mergeApproval(cards: ApprovalCard[], card: ApprovalCard) {
  const old = cards.find(item => item.id === card.id);
  if (old && (!waiting(old) || old.status === 'approving') && card.status === 'pending') return cards;
  if (old && !waiting(old) && card.status === 'approving') return cards;
  return sortApprovals([...cards.filter(item => item.id !== card.id), card]);
}
