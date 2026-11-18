import { useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import SpeechInput from './SpeechInput.tsx';
import {nativeSpeechPorts,SpeechController,speechBusy,type SpeechReview} from './speech-input.ts';
import {bindingMatches,identityLabel,reviewDecision,type ReviewMode,type SpeechContext} from './speech-review.ts';
import type { Selection, Task } from '@spatial/shared';
import { api, ApiError, mutation } from './api.ts';
import { operationError, refreshError } from './adoption-gate.ts';
import { useEventCenter } from './EventCenter.tsx';
import { canSubmit, pickHint, retrySelection, submittedSelection, type PickState } from './pick-state.ts';

const statusLabels: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', awaiting_approval: '等待请示', done: '候选已就绪', failed: '失败', cancelled: '已取消',
};

export default function PointSpeak({ pick, blocked = false, blankBootstrap = false }: { pick: PickState; blocked?: boolean; blankBootstrap?: boolean }) {
  const selection = submittedSelection(pick);
  const { state, reload, syncReady, status, acquire, awaiting, locked } = useEventCenter();
  const writable = !blocked && syncReady && status === 'connected' && !locked(['task:create']);
  const submittable = canSubmit(pick) && writable && (!selection || selection.baseVersion === state.version);
  const [instruction, setInstruction] = useState('');
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [speech] = useState(() => new SpeechController(nativeSpeechPorts()));
  const speechState = useSyncExternalStore(speech.subscribe, speech.getSnapshot, speech.getSnapshot);
  const revision = useRef(0);
  const identity = selection ? {src:selection.src,cid:selection.cid,baseVersion:selection.baseVersion} : null;
  const pickKey = JSON.stringify({identity,kind:pick.kind,version:state.version});
  const selectionHistory = useRef({key:pickKey,epoch:0});
  if (selectionHistory.current.key !== pickKey) selectionHistory.current = {key:pickKey,epoch:selectionHistory.current.epoch+1};
  const context: SpeechContext = {selection:identity,version:state.version,revision:revision.current,selectionEpoch:selectionHistory.current.epoch};
  const latestContext = useRef(context); latestContext.current = context;
  const [binding,setBinding] = useState<SpeechContext | null>(null);
  const latestBinding = useRef(binding); latestBinding.current = binding;
  const boundText = useRef('');
  const voiceGate = !speechBusy(speechState) && (!binding || bindingMatches(binding,context));
  function changeInstruction(text:string,clearBinding=false) {
    ++revision.current; latestContext.current = {...latestContext.current,revision:revision.current};
    setInstruction(text);
    if (clearBinding || !text) {latestBinding.current=null;setBinding(null);}
  }
  function useReview(review:SpeechReview,mode:ReviewMode) {
    if (speech.getSnapshot().review !== review) return;
    const decision=reviewDecision(review.context,latestContext.current,submittable&&!busy,review.text);
    if (!decision[mode]) return;
    changeInstruction(review.text);
    const confirmed={...latestContext.current}; boundText.current=review.text;latestBinding.current=confirmed;setBinding(confirmed);speech.accept();
  }
  const active = state.tasks.find(task => task.id === activeId) ?? state.tasks[0];

  const retryPlan = retrySelection(active?.selection, pick, state.version);
  async function submit(text: string, picked: Selection | null, retry = false) {
    if (!text.trim() || busy || !(retry ? writable && retryPlan.allowed : submittable)) return;
    if (speechBusy(speech.getSnapshot()) || (!retry && latestBinding.current && !bindingMatches(latestBinding.current,latestContext.current))) {
      setError('请先确认语音文字与当前对象，或放弃本次语音指令'); return;
    }
    if (picked && picked.baseVersion !== state.version) { setError('页面已变化，请重新点选'); return; }
    const token = acquire(['task:create']);
    if (!token) return;
    setBusy(true); setError('');
    let succeeded = false;
    try {
      const useBootstrap = blankBootstrap && !picked;
      const task = await api<Task>('/tasks', mutation('POST', { instruction: text.trim(), ...(picked ? { selection: picked } : {}), ...(useBootstrap ? { bootstrap: true } : {}) }));
      setActiveId(task.id);
      latestBinding.current=null;setBinding(null);
      succeeded = true;
    } catch (cause) { setError(operationError('task', cause instanceof ApiError ? cause.code : undefined, cause instanceof ApiError ? cause.status : undefined, cause instanceof Error ? cause.message : undefined)); }
    awaiting(token);
    try { await reload(); }
    catch { setError(previous => refreshError(succeeded, previous)); }
    finally { setBusy(false); }
  }
  function keyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (submittable) void submit(instruction, selection);
    }
  }
  async function cancel(task: Task) {
    if (!syncReady || busy || !['queued', 'running', 'awaiting_approval'].includes(task.status)) return;
    const token = acquire([`task:${task.id}`]);
    if (!token) return;
    setBusy(true); setError('');
    let succeeded = false;
    try { await api(`/tasks/${encodeURIComponent(task.id)}/cancel`, mutation('POST')); succeeded = true; }
    catch (cause) { setError(operationError('cancel', cause instanceof ApiError ? cause.code : undefined, cause instanceof ApiError ? cause.status : undefined, cause instanceof Error ? cause.message : undefined)); }
    awaiting(token);
    try { await reload(); }
    catch { setError(previous => refreshError(succeeded, previous)); }
    finally { setBusy(false); }
  }

  return <section className="point-speak" aria-label="指着说">
    <div className="composer-shell">
      <div className="composer-header">
        <span className="section-label">{blankBootstrap && !selection ? 'FIRST-EDITION 3D PAGE' : 'PROMPT & VOICE'}</span>
        <span className="composer-pick-hint" data-testid="pick-state" data-kind={pick.kind}>{pickHint(pick)}</span>
      </div>
      {blankBootstrap && !selection && <div className="composer-quick-chips">
        <button type="button" className="chip-btn" onClick={() => changeInstruction('做一个黑钛旗舰无线降噪耳机的深空科技感 3D 新品发布页')}>✦ 黑钛耳机发布页</button>
        <button type="button" className="chip-btn" onClick={() => changeInstruction('做一个北欧极简月球氛围灯的温润家居 3D 互动展厅')}>✦ 月球灯互动展厅</button>
      </div>}
      <label className="instruction-label">
        <span className="sr-only">修改指令</span>
        <textarea data-testid="instruction-input" value={instruction} onChange={event => changeInstruction(event.target.value)} onKeyDown={keyboard}
          placeholder={blankBootstrap && !selection ? '输入一句话直接从零生成首版完整 3D 网页（Ctrl/⌘ + Enter 提交）…' : '描述想调整的文案、排版或交互，例如：把标题改成“山野清风，落入日常。”（Ctrl/⌘ + Enter 提交）'} rows={3}/>
      </label>
      <SpeechInput controller={speech} snapshot={speechState} context={context} allowed={submittable&&!busy} connected={status==='connected'} onUse={useReview}/>
      {binding&&!bindingMatches(binding,context)&&<div className="conflict-banner" data-testid="speech-binding-conflict" role="alert">
        <p>语音确认后选中对象已变化，生成前需再次确认。</p>
        <p className="muted-note">上次：{identityLabel(binding.selection)} · 当前：{identityLabel(context.selection)}</p>
        <div className="conflict-actions">
          {binding.version!==context.version?<p>页面版本已变化，请放弃此语音指令并重新点选。</p>:<button type="button" className="secondary-btn compact-btn" data-testid="speech-reconfirm" disabled={!submittable||busy} onClick={()=>{if(!submittable||busy||speechBusy(speech.getSnapshot())||latestBinding.current?.version!==latestContext.current.version)return;const next={...latestContext.current};latestBinding.current=next;setBinding(next);}}>确认用于当前对象{context.selection?.cid??'（整体修改）'}</button>}
          <button type="button" className="ghost-btn compact-btn" data-testid="speech-clear-binding" onClick={()=>changeInstruction(instruction===boundText.current?'':instruction,true)}>放弃语音绑定</button>
        </div>
      </div>}
      <div className="composer-footer">
        <span className="composer-caption">{blankBootstrap && !selection ? '直接生成完整首版页面候选' : '发送选中源码上下文生成候选草稿'}</span>
        <button type="button" className="primary-btn" data-testid="generate-candidate" disabled={!instruction.trim() || busy || !submittable || !voiceGate} onClick={() => void submit(instruction, selection)}>{blankBootstrap && !selection ? '生成首版 3D 网页' : '生成候选版本'}</button>
      </div>
    </div>
    {error && <p className="error" data-testid="task-action-error" role="alert">{error}{error.includes('最多保留') && <a href="#approval-panel">查看待处理请示</a>}</p>}
    {active && <div className="task-card" data-testid="task-card">
      <div className="task-heading">
        <div className="task-status-group">
          <span className={`task-status-dot status-${active.status}`}/>
          <strong data-testid="task-status" data-status={active.status}>{statusLabels[active.status]}</strong>
        </div>
        <code>{active.id.slice(0, 8)}</code>
      </div>
      {state.tasks.length > 1 && <select aria-label="查看任务" data-testid="task-select" value={active.id} onChange={event => setActiveId(event.target.value)}>
        {state.tasks.map(task => <option key={task.id} value={task.id}>{task.id.slice(0, 8)} · {statusLabels[task.status]}</option>)}
      </select>}
      <p className="task-instruction">{active.instruction}</p>
      {active.events.length > 0 && <ol className="task-steps" data-testid="task-steps">{active.events.map(event => <li key={event.sequence}>{event.message}</li>)}</ol>}
      {(active.status === 'queued' || active.status === 'running') && <button type="button" className="ghost-btn compact-btn" data-testid="task-cancel" disabled={busy || !syncReady || locked([`task:${active.id}`])} onClick={() => void cancel(active)}>取消任务</button>}
      {active.error && <p className="error" data-testid="task-error" role="alert">{active.error.code === 'STALE_SELECTION' ? '页面已变化，请重新点选' : active.error.message}</p>}
      {(active.status === 'failed' || active.status === 'cancelled') && (active.kind === 'module'
        ? <p className="hint" role="status" data-testid="task-retry-reason">独立 3D 模块操作请从左侧资产面板重新发起，不能通过文字指令重试。</p>
        : <div className="task-retry-row">
          {retryPlan.reason && <p className="muted-note" role="status" data-testid="task-retry-reason">{retryPlan.reason}</p>}
          <button type="button" className="secondary-btn compact-btn" data-testid="task-retry" disabled={busy || !writable || !retryPlan.allowed || speechBusy(speechState)} onClick={() => { changeInstruction(active.instruction,true); void submit(active.instruction, retryPlan.selection, true); }}>重试</button>
        </div>)}
    </div>}
  </section>;
}
