import { describe, expect, it } from 'vitest';
import type { ApprovalCard, Task } from '@spatial/shared';
import { affectedSource, canAnswer, impactHighlightMessages, isApproval, mergeApproval, restorePicking, sortApprovals } from './approval-state.ts';
import { contiguousReplay, emptyM2State, reduceM2Event } from './m2-state.ts';

const card: ApprovalCard = { id: 'a', taskId: 't', question: '修改？', reason: '<script>text</script>', options: [{ label: '批准', impact: '发布' }, { label: '拒绝', impact: '丢弃' }], affected: ['src/Button.tsx'], evidence: [], status: 'pending', ruleCodes: ['shared_component'], ruleVersion: '1', baseVersion: 'v1', contentDigest: 'digest', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const task: Task = { id: 't', instruction: '修改', status: 'awaiting_approval', events: [] };
describe('approval state and conservative gates', () => {
  it('restores the card source after a pick result and clears the hover before highlighting', () => {
    const messages = impactHighlightMessages('src/Button.tsx:3:4');
    expect(messages).toEqual([{ type: 'pick:stop' }, { type: 'pick:start' }, { type: 'highlight', payload: { src: 'src/Button.tsx:3:4' } }]);
    let selected = 'src/Other.tsx:8:1';
    let hover: string | null = selected;
    for (const message of messages) {
      if (message.type === 'pick:stop') { selected = ''; hover = null; }
      if (message.type === 'highlight') selected = message.payload.src;
    }
    expect(selected).toBe('src/Button.tsx:3:4');
    expect(hover).toBeNull();
  });
  it('sorts waiting first and uses creation/id for deterministic ordering', () => {
    expect(sortApprovals([{ ...card, id: 'z' }, { ...card, id: 'history', status: 'approved' }, card]).map(item => item.id)).toEqual(['a', 'z', 'history']);
  });
  it('deduplicates and prevents snapshot replay from reopening terminal cards', () => {
    const approved = { ...card, status: 'approved' as const };
    expect(mergeApproval([approved], card)).toEqual([approved]);
    expect(mergeApproval([card], approved)).toEqual([approved]);
    let state = reduceM2Event(emptyM2State, { type: 'approval.requested', seq: 1, approval: card });
    state = reduceM2Event(state, { type: 'approval.resolved', seq: 2, approval: approved });
    state = reduceM2Event(state, { type: 'approval.requested', seq: 1, approval: card });
    expect(state.approvals).toEqual([approved]);
  });
  it('unknown payloads cannot grant permission', () => {
    expect(isApproval({ ...card, ruleCodes: ['unknown'] })).toBe(false);
    expect(isApproval({ ...card, affected: [null] })).toBe(false);
    expect(isApproval({ ...card, options: [{}] })).toBe(false);
    expect(reduceM2Event(emptyM2State, { type: 'approval.requested', seq: 1, approval: {} })).toBe(emptyM2State);
  });
  it('requires synchronized matching task and baseline, not merely pending', () => {
    expect(canAnswer(card, task, 'v1', true)).toBe(true);
    expect(canAnswer(card, task, 'v2', true)).toBe(false);
    expect(canAnswer(card, task, 'v1', false)).toBe(false);
    expect(canAnswer(card, { ...task, status: 'done' }, 'v1', true)).toBe(false);
    expect(canAnswer({ ...card, status: 'approving' }, task, 'v1', true)).toBe(false);
  });
  it('only locates exact source coordinates with a matching baseline and affected file', () => {
    const selected = { ...task, selection: { src: 'src/Button.tsx:3:4', baseVersion: 'v1' } as NonNullable<Task['selection']> };
    expect(affectedSource(card, selected, 'src/Button.tsx', 'v1')).toBe('src/Button.tsx:3:4');
    expect(affectedSource(card, task, 'src/Button.tsx', 'v1')).toBeUndefined();
    expect(affectedSource(card, selected, 'src/Button.tsx', 'v2')).toBeUndefined();
    const exact = { ...card, affected: ['src/Button.tsx:5:6', 'src/style.css:1:1', '../secret:1:1'] };
    expect(affectedSource(exact, task, exact.affected[0], 'v1')).toBe(exact.affected[0]);
    expect(affectedSource(exact, task, exact.affected[1], 'v1')).toBeUndefined();
    expect(affectedSource(exact, task, exact.affected[2], 'v1')).toBeUndefined();
    expect(restorePicking(true, selected.selection!, 'v1')).toBe(true);
    expect(restorePicking(true, selected.selection!, 'v2')).toBe(false);
    expect(restorePicking(false, selected.selection!, 'v1')).toBe(false);
  });
  it('merges buffered gap-trigger events without skipping missing sequences', () => {
    const event = (seq: number) => ({ type: 'other', seq });
    expect(contiguousReplay([event(4), event(2), event(3), event(2)], 1, 3)).toEqual({ events: [event(2), event(3), event(4)], cursor: 4 });
    expect(contiguousReplay([event(4), event(2)], 1, 4)).toBeNull();
    expect(contiguousReplay([event(2)], 1, 3)).toBeNull();
  });
});
