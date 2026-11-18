import { useEffect, useRef, useState } from 'react';
import type { ApprovalCard, ApprovalStatus } from '@spatial/shared';
import { api, ApiError, mutation } from './api.ts';
import { operationError, refreshError } from './adoption-gate.ts';
import { useEventCenter } from './EventCenter.tsx';
import { affectedSource, canAnswer, sortApprovals, waiting } from './approval-state.ts';

const labels: Record<ApprovalStatus, string> = {
  pending: '等待批准', approving: '正在发布已批准草稿', approved: '已批准；候选发布后请运行检查，采用后才更新作品',
  rejected: '已拒绝并丢弃草稿，主作品未改变', cancelled: '任务已取消，请示不可继续', stale: '草稿或作品已变化，请重新生成任务', failed: '请示处理失败，请查看任务原因',
};
const rules = { shared_component: '共享组件', global_style: '全局样式或场景配置', out_of_scope: '超出选中范围', analysis_uncertain: '影响范围无法完整分析' };
type Operation = { phase: 'submitting' | 'outcomeUnknown' | 'refreshing'; message: string };
export default function ApprovalPanel({ highlightId, onHighlight, onExit }: {
  highlightId: string | null; onHighlight: (card: ApprovalCard, src: string) => void; onExit: () => void;
}) {
  const { state, syncReady, status, reload, acquire, awaiting, locked } = useEventCenter();
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  const locks = useRef(new Map<string, Operation>());
  const [, render] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const update = (id: string, operation?: Operation) => {
    if (operation) locks.current.set(id, operation); else locks.current.delete(id);
    if (mounted.current) render(value => value + 1);
  };
  useEffect(() => {
    if (!syncReady) return;
    for (const [id, lock] of locks.current) if (lock.phase !== 'submitting' && !locked([`approval:${id}`])) update(id);
  }, [state, syncReady]);

  async function decide(card: ApprovalCard, option: 0 | 1 | 'cancel') {
    const task = state.tasks.find(item => item.id === card.taskId);
    if (blockedIds.has(card.id) || locks.current.has(card.id) || !canAnswer(card, task, state.version, syncReady && status === 'connected')) return;
    const token = acquire([`approval:${card.id}`, `task:${card.taskId}`]);
    if (!token) return;
    update(card.id, { phase: 'submitting', message: '正在提交…' });
    setErrors(previous => ({ ...previous, [card.id]: '' }));
    let succeeded = false;
    let failure = '';
    try {
      if (option === 'cancel') await api(`/tasks/${encodeURIComponent(card.taskId)}/cancel`, mutation('POST'));
      else await api(`/approvals/${encodeURIComponent(card.id)}`, mutation('POST', { option }));
      succeeded = true;
    } catch (cause) {
      if (mounted.current && cause instanceof ApiError && ['STALE_APPROVAL', 'APPROVAL_ALREADY_ANSWERED', 'APPROVAL_NOT_PENDING'].includes(cause.code)) setBlockedIds(previous => new Set([...previous, card.id]));
      if (cause instanceof ApiError && cause.code === 'STALE_APPROVAL') failure = '请示已失效，请重新生成任务';
      else if (cause instanceof ApiError && ['APPROVAL_ALREADY_ANSWERED', 'APPROVAL_NOT_PENDING'].includes(cause.code)) failure = '该请示已处理或不可继续，正在刷新状态';
      else failure = operationError('approval', cause instanceof ApiError ? cause.code : undefined, cause instanceof ApiError ? cause.status : undefined, cause instanceof Error ? cause.message : undefined);
    }
    awaiting(token);
    if (mounted.current) update(card.id, { phase: succeeded ? 'refreshing' : 'outcomeUnknown', message: succeeded ? '操作已提交，正在刷新状态' : failure });
    try {
      // Mutation response never writes local entities: only authoritative GET + event replay does.
      await reload();
      if (mounted.current && failure) setErrors(previous => ({ ...previous, [card.id]: failure }));
    } catch {
      if (mounted.current) update(card.id, { phase: succeeded ? 'refreshing' : 'outcomeUnknown', message: refreshError(succeeded, failure) });
    }
  }
  const cards = sortApprovals(state.approvals);
  const pending = cards.filter(waiting);
  const history = cards.filter(card => !waiting(card));
  function show(card: ApprovalCard) {
    const task = state.tasks.find(item => item.id === card.taskId);
    const lock = locks.current.get(card.id);
    const enabled = !lock && !blockedIds.has(card.id) && !locked([`approval:${card.id}`, `task:${card.taskId}`]) && canAnswer(card, task, state.version, syncReady && status === 'connected');
    return <article key={card.id} className="approval-card" data-testid="approval-card" data-approval-id={card.id} data-task-id={card.taskId} data-status={card.status}>
      <div className="approval-card-head">
        <h3>{card.question}</h3>
        <code>{card.taskId.slice(0, 8)}</code>
      </div>
      <div className="approval-tags">{card.ruleCodes.map(rule => <span key={rule} className="meta-tag is-warn">{rules[rule]}</span>)}</div>
      <p className="approval-reason">{card.reason}</p>
      <ul className="approval-affected-list">{card.affected.map((affected, index) => {
        const src = affectedSource(card, task, affected, state.version);
        return <li key={`${affected}-${index}`} data-testid="approval-affected" data-affected={affected}><code>{affected}</code>{src ? <button type="button" className="ghost-btn compact-btn" disabled={!syncReady} onClick={() => onHighlight(card, src)}>定位元素</button> : <span className="muted-note">文件级影响；暂无可确认的页面位置</span>}</li>;
      })}</ul>
      {card.evidence.length > 0 && <details className="compact-details"><summary>影响依据与选项说明</summary>
        {card.evidence.map((text, index) => <pre key={index}>{text}</pre>)}
        <ul>{card.options.map((option, index) => <li key={index}>{option.label}：{option.impact}</li>)}</ul>
        <p className="hint">更新时间：{card.updatedAt}</p>
      </details>}
      <p className="approval-status-line" data-testid="approval-status" role="status">{labels[card.status]}</p>
      {card.baseVersion !== state.version && <p className="muted-note" role="status">作品已变化，旧请示不可操作</p>}
      {lock && <p role={lock.phase === 'outcomeUnknown' || lock.message.includes('失败') ? 'alert' : 'status'} data-testid={lock.phase === 'outcomeUnknown' || lock.message.includes('失败') ? 'approval-error' : undefined}>{lock.message}</p>}
      {errors[card.id] && <p className="error" role="alert" data-testid="approval-error">{errors[card.id]}</p>}
      <div className="approval-actions">
        <button type="button" className="primary-btn compact-btn" data-testid="approval-approve" disabled={!enabled} onClick={() => void decide(card, 0)}>批准本次修改</button>
        <button type="button" className="ghost-btn compact-btn" data-testid="approval-reject" disabled={!enabled} onClick={() => void decide(card, 1)}>拒绝并丢弃</button>
        {waiting(card) && <button type="button" className="ghost-btn compact-btn" disabled={!enabled} onClick={() => void decide(card, 'cancel')}>取消任务</button>}
        {highlightId === card.id && <button type="button" className="ghost-btn compact-btn" data-testid="approval-highlight-exit" onClick={onExit}>退出影响模式</button>}
      </div>
    </article>;
  }
  const empty = cards.length === 0 && syncReady;
  return <section id="approval-panel" className={`approval-panel${pending.length > 0 ? ' has-pending' : ''}`} data-testid="approval-panel" aria-label="修改请示" hidden={empty}>
    {pending.length > 0 && <div className="approval-header"><span className="section-label is-warn">APPROVAL REQUIRED</span><h2>修改请示 · 待处理 {pending.length}</h2></div>}
    {!syncReady && <p role="status">状态待同步，暂不可回答</p>}
    {pending.map(show)}
    {history.length > 0 && <details className="compact-details"><summary>历史请示（{history.length}）</summary>{history.map(show)}</details>}
  </section>;
}
