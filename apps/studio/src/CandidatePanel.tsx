import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Candidate } from '@spatial/shared';
import { parseDiff } from './diff.ts';
import { api, ApiError, mutation } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';

export type PreviewMode = 'current' | 'candidate' | 'compare';
import CheckPanel from './CheckPanel.tsx';
import { activeRun, associatedRun } from './check-state.ts';

export function Diff({ candidate }: { candidate: Candidate }) {
  return <div className="candidate-diff" data-testid="candidate-diff">
    <h3>改动文件</h3>
    <ul data-testid="candidate-files">{candidate.diff.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
    {candidate.diff.map(file => <section key={file.path} aria-label={`差异 ${file.path}`}>
      <code>{file.path}</code>
      <pre className="diff-view">{parseDiff(file.patch).map((line, index) => <span key={index} className={`diff-${line.kind}`}>{line.text}{'\n'}</span>)}</pre>
    </section>)}
  </div>;
}

export default function CandidatePanel({ selectedId, onSelect, mode, onMode, children }: {
  selectedId: string;
  onSelect: (id: string) => void;
  mode: PreviewMode;
  onMode: (mode: PreviewMode) => void;
  children: ReactNode;
}) {
  const { state, reload, syncReady, syncEpoch } = useEventCenter();
  const locks = useRef(new Map<string, { posting: boolean; epoch: number }>());
  const [, render] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!syncReady) return;
    let changed = false;
    for (const [id, lock] of locks.current) if (!lock.posting && syncEpoch >= lock.epoch) { locks.current.delete(id); changed = true; }
    if (changed) render(value => value + 1);
  }, [state, syncReady, syncEpoch]);
  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const selected = pending.find(candidate => candidate.id === selectedId) ?? pending[0];
  const run = selected?.latestCheckRunId ? state.runs[selected.latestCheckRunId] : undefined;
  const busy = !!selected && locks.current.has(selected.id);
  const error = selected ? errors[selected.id] : '';
  const linked = !!selected && associatedRun(selected, run);
  const canRun = !!selected && syncReady && !busy && !invalid[selected.id] && !!selected.candidateCommit && selected.baseVersion === state.version &&
    (!selected.latestCheckRunId || (linked && !activeRun(run)));
  const canCancel = syncReady && !busy && linked && activeRun(run);

  async function action(kind: 'run' | 'rerun' | 'cancel' | 'discard') {
    if (!selected || !syncReady || locks.current.has(selected.id)) return;
    if ((kind === 'run' || kind === 'rerun') && (!canRun || (kind === 'rerun') !== !!selected.latestCheckRunId)) return;
    if (kind === 'cancel' && !canCancel) return;
    const id = selected.id;
    const lock = { posting: true, epoch: syncEpoch + 1 };
    locks.current.set(id, lock);
    render(value => value + 1);
    setErrors(previous => ({ ...previous, [id]: '' }));
    let succeeded = false;
    try {
      const url = kind === 'cancel' ? `/checks/${encodeURIComponent(run!.id)}/cancel` : `/candidates/${encodeURIComponent(id)}/${kind === 'discard' ? 'discard' : 'checks'}`;
      await api(url, mutation('POST', kind === 'rerun' ? { rerun: true } : {}));
      succeeded = true;
    } catch (cause) {
      if (!mounted.current) return;
      if (cause instanceof ApiError && cause.code === 'STALE_CANDIDATE') {
        setInvalid(previous => ({ ...previous, [id]: true }));
        setErrors(previous => ({ ...previous, [id]: '候选内容或主作品已变化，请重新生成候选' }));
      } else setErrors(previous => ({ ...previous, [id]: cause instanceof ApiError ? cause.message : '无法确认服务器状态，请刷新后继续' }));
    }
    if (!mounted.current) return;
    // Never apply a mutation response or replay its POST. Release only after a new successful sync.
    lock.posting = false;
    try { await reload(); }
    catch {
      if (mounted.current) setErrors(previous => ({ ...previous, [id]: succeeded ? '操作已提交，状态刷新失败，请刷新状态' : '无法确认服务器状态，请刷新后继续' }));
    }
  }

  return <>
    <div className="preview-controls">
      <span>作品版本 <code data-testid="work-version">{state.version ? state.version.slice(0, 10) : '读取中'}</code></span>
      <button type="button" data-testid="version-revert" disabled title="共同门禁完成前不可回退">回退上一次采用</button>
      {pending.length > 0 && <>
        <select aria-label="待定候选版本" data-testid="candidate-select" value={selected?.id ?? ''} onChange={event => { onSelect(event.target.value); onMode('candidate'); }}>
          {pending.map(candidate => <option key={candidate.id} value={candidate.id}>候选 {candidate.id.slice(0, 8)}</option>)}
        </select>
        <div className="preview-modes" aria-label="预览模式">
          <button type="button" data-testid="preview-current" aria-pressed={mode === 'current'} onClick={() => onMode('current')}>当前版本</button>
          <button type="button" data-testid="preview-candidate" aria-pressed={mode === 'candidate'} onClick={() => onMode('candidate')}>候选版本</button>
          <button type="button" data-testid="preview-compare" aria-pressed={mode === 'compare'} onClick={() => onMode('compare')}>并排对比</button>
        </div>
      </>}
    </div>
    {error && <p className="candidate-error error" data-testid="candidate-action-error" role="alert">{error}</p>}
    <div className={`preview-frames mode-${mode}`}>{children}</div>
    {selected && <section className="candidate-details" data-testid="candidate-details">
      <div className="candidate-title"><h2>候选 {selected.id.slice(0, 8)}</h2><span>待定候选 {pending.length}/3</span></div>
      {selected.outOfScope.length > 0 && <p className="scope-warning" data-testid="candidate-out-of-scope" role="alert">改动超出选中范围：{selected.outOfScope.join('、')}</p>}
      <CheckPanel candidate={selected} run={run} syncReady={syncReady && !busy} syncEpoch={syncEpoch} version={state.version}/>
      <div className="check-actions">
        {!selected.latestCheckRunId ? <button type="button" data-testid="check-run" disabled={!canRun} onClick={() => void action('run')}>运行检查</button> : <button type="button" data-testid="check-rerun" disabled={!canRun} onClick={() => void action('rerun')}>重新检查</button>}
        <button type="button" data-testid="check-cancel" disabled={!canCancel} onClick={() => void action('cancel')}>取消检查</button>
        {busy && <span role="status">操作处理中，等待服务器状态确认</span>}
      </div>
      <Diff candidate={selected}/>
      <div className="candidate-actions">
        <button type="button" data-testid="candidate-adopt" disabled title="真实检查与采用门禁接入前不可采用">采用此候选</button>
        <button type="button" data-testid="candidate-discard" disabled={busy || !syncReady} onClick={() => void action('discard')}>撤回候选</button>
      </div>
    </section>}
  </>;
}
