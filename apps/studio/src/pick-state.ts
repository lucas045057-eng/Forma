import type { Selection } from '@spatial/shared';

/**
 * What the instruction box may submit. A new pick invalidates the previous object at once:
 * while its version is being read, or after that read failed, nothing may be submitted —
 * neither the old object nor an object-less "whole page" task.
 */
export type PickState =
  | { kind: 'none' }
  | { kind: 'pending'; src: string }
  | { kind: 'failed'; src: string }
  | { kind: 'ready'; selection: Selection };

export function retrySelection(original: Selection | undefined, pick: PickState, version: string): { allowed: boolean; selection: Selection | null; reason: string } {
  if (pick.kind === 'pending' || pick.kind === 'failed') return { allowed: false, selection: null, reason: '请完成重新点选后再重试' };
  if (!original) return { allowed: true, selection: null, reason: '' };
  if (original.baseVersion === version) return { allowed: true, selection: original, reason: '' };
  if (pick.kind === 'ready' && pick.selection.baseVersion === version && pick.selection.src === original.src) return { allowed: true, selection: pick.selection, reason: '' };
  return { allowed: false, selection: null, reason: `页面已变化，请重新点选 ${original.src} 后再重试` };
}

export function canSubmit(pick: PickState) { return pick.kind === 'none' || pick.kind === 'ready'; }
export function submittedSelection(pick: PickState): Selection | null { return pick.kind === 'ready' ? pick.selection : null; }
export function pickHint(pick: PickState) {
  switch (pick.kind) {
    case 'none': return '当前没有选中对象，也可以提交整体修改。';
    case 'pending': return `正在读取 ${pick.src} 所在的作品版本，请稍候再提交。`;
    case 'failed': return `读取 ${pick.src} 的作品版本失败，请重新点选后再提交。`;
    case 'ready': return `将携带 ${pick.selection.src} 作为选中对象。`;
  }
}
