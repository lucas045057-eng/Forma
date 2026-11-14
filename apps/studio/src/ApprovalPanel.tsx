import { useEffect, useRef, useState } from 'react';
import type { ApprovalCard, ApprovalStatus } from '@spatial/shared';
import { api, ApiError, mutation } from './api.ts';
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
  const { state, syncReady, status, reload } = useEventCenter();
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
    for (const [id, lock] of locks.current) if (lock.phase !== 'submitting') update(id);
  }, [state, syncReady]);

  async function decide(card: ApprovalCard, option: 0 | 1 | 'cancel') {
    const task = state.tasks.find(item => item.id === card.taskId);
    if (locks.current.has(card.id) || !canAnswer(card, task, state.version, syncReady && status === 'connected')) return;
    update(card.id, { phase: 'submitting', message: '正在提交…' });
    setErrors(previous => ({ ...previous, [card.id]: '' }));
    let succeeded = false;
    let failure = '';
    try {
      if (option === 'cancel') await api(`/tasks/${encodeURIComponent(card.taskId)}/cancel`, mutation('POST'));
      else await api(`/approvals/${encodeURIComponent(card.id)}`, mutation('POST', { option }));
      succeeded = true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'STALE_APPROVAL') failure = '请示已失效，请重新生成任务';
      else if (cause instanceof ApiError && ['APPROVAL_ALREADY_ANSWERED', 'APPROVAL_NOT_PENDING'].includes(cause.code)) failure = '该请示已处理或不可继续，正在刷新状态';
      else failure = '提交结果尚未确认，正在读取服务器状态';
    }
    if (!mounted.current) return;
    update(card.id, { phase: succeeded ? 'refreshing' : 'outcomeUnknown', message: succeeded ? '操作已提交，正在刷新状态' : failure });
    try {
      // Mutation response never writes local entities: only authoritative GET + event replay does.
      await reload();
      if (mounted.current && failure) setErrors(previous => ({ ...previous, [card.id]: failure }));
    } catch {
      if (mounted.current) update(card.id, { phase: succeeded ? 'refreshing' : 'outcomeUnknown', message: succeeded ? '操作已提交，状态刷新失败，请刷新状态' : '提交结果尚未确认，请刷新状态后继续' });
    }
  }
  const cards = sortApprovals(state.approvals);
  const pending = cards.filter(waiting);
  function show(card: ApprovalCard) {
    const task = state.tasks.find(item => item.id === card.taskId);
    const lock = locks.current.get(card.id);
    const enabled = !lock && canAnswer(card, task, state.version, syncReady && status === 'connected');
    return <article key={card.id} className="approval-card" data-testid="approval-card" data-approval-id={card.id} data-task-id={card.taskId} data-status={card.status}>
      <h3>{card.question}</h3><code>{card.taskId}</code>
      <p>{card.reason}</p><p>{card.ruleCodes.map(rule => rules[rule]).join('、')}</p>
      <ul>{card.affected.map((affected, index) => {
        const src = affectedSource(card, task, affected, state.version);
        return <li key={`${affected}-${index}`} data-testid="approval-affected" data-affected={affected}><code>{affected}</code>{src ? <button type="button" disabled={!syncReady} onClick={() => onHighlight(card, src)}>查看源码对应位置</button> : <span>文件级影响；暂无可确认的页面位置</span>}</li>;
      })}</ul>
      {card.evidence.map((text, index) => <pre key={index}>{text}</pre>)}
      <ul>{card.options.map((option, index) => <li key={index}>{option.label}：{option.impact}</li>)}</ul>
      <p data-testid="approval-status" role="status">{labels[card.status]}</p>
      <p className="hint">更新时间：{card.updatedAt}</p>
      {card.baseVersion !== state.version && <p role="status">作品已变化，旧请示不可操作</p>}
      {lock && <p role="status">{lock.message}</p>}
      {errors[card.id] && <p role="alert" data-testid="approval-error">{errors[card.id]}</p>}
      <div className="approval-actions">
        <button type="button" data-testid="approval-approve" disabled={!enabled} onClick={() => void decide(card, 0)}>批准本次修改</button>
        <button type="button" data-testid="approval-reject" disabled={!enabled} onClick={() => void decide(card, 1)}>拒绝并丢弃</button>
        {waiting(card) && <button type="button" disabled={!enabled} onClick={() => void decide(card, 'cancel')}>取消任务</button>}
        {highlightId === card.id && <button type="button" data-testid="approval-highlight-exit" onClick={onExit}>退出影响模式</button>}
      </div>
    </article>;
  }
  return <section className="approval-panel" data-testid="approval-panel" aria-label="修改请示">
    <h2>修改请示 · 待处理 {pending.length}</h2>
    {!syncReady && <p role="status">状态待同步，暂不可回答</p>}
    {pending.map(show)}
    <details><summary>历史请示（{cards.length - pending.length}）</summary>{cards.filter(card => !waiting(card)).map(show)}</details>
  </section>;
}
