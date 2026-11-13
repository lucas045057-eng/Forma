import { useState, type KeyboardEvent } from 'react';
import type { Selection, Task } from '@spatial/shared';
import { api, ApiError, mutation } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';

const statusLabels: Record<Task['status'], string> = {
  queued: '排队中', running: '执行中', awaiting_approval: '等待请示', done: '候选已就绪', failed: '失败', cancelled: '已取消',
};

export default function PointSpeak({ selection }: { selection: Selection | null }) {
  const { state, reload } = useEventCenter();
  const [instruction, setInstruction] = useState('');
  const [activeId, setActiveId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = state.tasks.find(task => task.id === activeId) ?? state.tasks[0];

  async function submit(text: string, picked: Selection | null) {
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const task = await api<Task>('/tasks', mutation('POST', { instruction: text.trim(), ...(picked ? { selection: picked } : {}) }));
      setActiveId(task.id);
      await reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'STALE_SELECTION') setError('页面已变化，请重新点选');
      else setError(cause instanceof Error ? cause.message : '任务提交失败');
    } finally { setBusy(false); }
  }
  function keyboard(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit(instruction, selection);
    }
  }
  async function cancel(task: Task) {
    setBusy(true); setError('');
    try { await api(`/tasks/${encodeURIComponent(task.id)}/cancel`, mutation('POST')); await reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '取消失败'); }
    finally { setBusy(false); }
  }

  return <section className="point-speak" aria-label="指着说">
    <p className="section-label">POINT &amp; SPEAK</p><h2>指着说</h2>
    <label className="instruction-label">修改指令
      <textarea data-testid="instruction-input" value={instruction} onChange={event => setInstruction(event.target.value)} onKeyDown={keyboard}
        placeholder="例如：把这个按钮改成“马上购买”" rows={3}/>
    </label>
    <p className="hint">{selection ? `将携带 ${selection.src} 作为选中对象。` : '当前没有选中对象，也可以提交整体修改。'} Ctrl/⌘ + Enter 提交。</p>
    <button type="button" data-testid="generate-candidate" disabled={!instruction.trim() || busy} onClick={() => void submit(instruction, selection)}>生成候选版本</button>
    {error && <p className="error" data-testid="task-action-error" role="alert">{error}</p>}
    {active && <div className="task-card" data-testid="task-card">
      <div className="task-heading"><strong data-testid="task-status" data-status={active.status}>{statusLabels[active.status]}</strong><code>{active.id.slice(0, 8)}</code></div>
      {state.tasks.length > 1 && <select aria-label="查看任务" data-testid="task-select" value={active.id} onChange={event => setActiveId(event.target.value)}>
        {state.tasks.map(task => <option key={task.id} value={task.id}>{task.id.slice(0, 8)} · {statusLabels[task.status]}</option>)}
      </select>}
      <p className="task-instruction">{active.instruction}</p>
      <ol className="task-steps" data-testid="task-steps">{active.events.map(event => <li key={event.sequence}>{event.message}</li>)}</ol>
      {(active.status === 'queued' || active.status === 'running') && <button type="button" data-testid="task-cancel" disabled={busy} onClick={() => void cancel(active)}>取消任务</button>}
      {active.error && <p className="error" data-testid="task-error" role="alert">{active.error.message}</p>}
      {(active.status === 'failed' || active.status === 'cancelled') && <button type="button" data-testid="task-retry" disabled={busy} onClick={() => { setInstruction(active.instruction); void submit(active.instruction, active.selection ?? null); }}>重试</button>}
    </div>}
  </section>;
}
