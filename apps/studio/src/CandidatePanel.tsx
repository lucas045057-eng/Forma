import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Candidate } from '@spatial/shared';
import { parseDiff } from './diff.ts';
import { api, ApiError, mutation } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';
import CheckPanel from './CheckPanel.tsx';
import { activeRun, associatedRun } from './check-state.ts';
import { adoptionReason, operationError, type EvidenceReceipt } from './adoption-gate.ts';

export type PreviewMode = 'current' | 'candidate' | 'compare';
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
  selectedId: string; onSelect: (id: string) => void; mode: PreviewMode; onMode: (mode: PreviewMode) => void; children: ReactNode;
}) {
  const { state, status, reload, syncReady, syncEpoch, acquire, awaiting, locked } = useEventCenter();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const [rejected, setRejected] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<EvidenceReceipt>(null);
  const receiptRef = useRef<EvidenceReceipt>(null);
  const onEvidence = useCallback((key: string, ready: boolean) => {
    const previous = receiptRef.current;
    if (ready) {
      if (previous?.key === key && previous.ready) return;
      receiptRef.current = { key, ready };
    } else {
      if (previous?.key !== key) return;
      receiptRef.current = null;
    }
    setReceipt(receiptRef.current);
  }, []);
  const clearEvidence = () => { receiptRef.current = null; setReceipt(null); };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const selected = pending.find(candidate => candidate.id === selectedId) ?? pending[0];
  const run = selected?.latestCheckRunId ? state.runs[selected.latestCheckRunId] : undefined;
  const busy = !!selected && locked([`candidate:${selected.id}`]);
  const connected = status === 'connected';
  const ready = syncReady && connected;
  const error = (selected ? errors[selected.id] : '') || errors.work;
  const linked = !!selected && associatedRun(selected, run);
  const canRun = !!selected && ready && !busy && !invalid[selected.id] && !!selected.candidateCommit && selected.baseVersion === state.version &&
    (!selected.latestCheckRunId || (linked && !activeRun(run)));
  const canCancel = ready && !busy && linked && activeRun(run);
  const canRevert = ready && !locked(['work']);
  const reason = adoptionReason({ candidate: selected, run, version: state.version, epoch: syncEpoch, ready, connected,
    busy: locked(['work']), rejectedRun: selected ? (invalid[selected.id] ? run?.id : rejected[selected.id]) : undefined, receipt });

  async function action(kind: 'run' | 'rerun' | 'cancel' | 'discard' | 'adopt' | 'revert') {
    if (!ready) return;
    if (kind !== 'revert' && (!selected || selected.decision !== 'pending' || busy)) return;
    if ((kind === 'run' || kind === 'rerun') && (!canRun || (kind === 'rerun') !== !!selected?.latestCheckRunId)) return;
    if (kind === 'cancel' && !canCancel) return;
    if (kind === 'revert' && !canRevert) return;
    if (kind === 'adopt' && adoptionReason({ candidate: selected, run, version: state.version, epoch: syncEpoch, ready, connected,
      busy: locked(['work']), rejectedRun: selected ? (invalid[selected.id] ? run?.id : rejected[selected.id]) : undefined, receipt: receiptRef.current })) return;
    const id = kind === 'revert' ? 'work' : selected!.id;
    const keys = kind === 'revert' ? ['work'] : kind === 'adopt' ? ['work', `candidate:${id}`] : [`candidate:${id}`];
    const token = acquire(keys);
    if (!token) return;
    clearEvidence();
    setErrors(previous => ({ ...previous, [id]: '' }));
    let succeeded = false;
    try {
      const url = kind === 'revert' ? '/version/revert' : kind === 'cancel' ? `/checks/${encodeURIComponent(run!.id)}/cancel` :
        `/candidates/${encodeURIComponent(id)}/${kind === 'run' || kind === 'rerun' ? 'checks' : kind}`;
      await api(url, mutation('POST', kind === 'rerun' ? { rerun: true } : {}));
      succeeded = true;
      if (mounted.current && (kind === 'adopt' || kind === 'revert')) onMode('current');
    } catch (cause) {
      if (mounted.current) {
        const code = cause instanceof ApiError ? cause.code : undefined;
        if ((kind === 'run' || kind === 'rerun') && code === 'STALE_CANDIDATE') setInvalid(previous => ({ ...previous, [id]: true }));
        if (kind === 'adopt' && code === 'CHECKS_NOT_PASSED') setRejected(previous => ({ ...previous, [id]: run!.id }));
        setErrors(previous => ({ ...previous, [id]: operationError(kind, code) }));
      }
    }
    // Locks live in the provider, including when this panel unmounts during a request.
    awaiting(token);
    try { await reload(); }
    catch {
      if (mounted.current) setErrors(previous => ({ ...previous, [id]: succeeded ? '操作已提交，状态刷新失败，请刷新状态' : '无法确认服务器状态，请刷新后继续' }));
    }
  }

  return <>
    <div className="preview-controls">
      <span>作品版本 <code data-testid="work-version">{state.version ? state.version.slice(0, 10) : '读取中'}</code></span>
      <button type="button" data-testid="version-revert" disabled={!canRevert} onClick={() => void action('revert')}>回退上一次采用</button>
      {pending.length > 0 && <>
        <select aria-label="待定候选版本" data-testid="candidate-select" value={selected?.id ?? ''} onChange={event => { clearEvidence(); onSelect(event.target.value); onMode('candidate'); }}>
          {pending.map(candidate => <option key={candidate.id} value={candidate.id}>候选 {candidate.id.slice(0, 8)}</option>)}</select>
        <div className="preview-modes" aria-label="预览模式">
          <button type="button" data-testid="preview-current" aria-pressed={mode === 'current'} onClick={() => onMode('current')}>当前版本</button>
          <button type="button" data-testid="preview-candidate" aria-pressed={mode === 'candidate'} onClick={() => onMode('candidate')}>候选版本</button>
          <button type="button" data-testid="preview-compare" aria-pressed={mode === 'compare'} onClick={() => onMode('compare')}>并排对比</button>
        </div>
      </>}
    </div>
    {error && <p className="candidate-error error" data-testid="candidate-action-error" role="alert">{error}</p>}
    {!canRevert && <p role="status">作品决策暂不可用，等待同步或操作结果确认；可使用“刷新状态”恢复。</p>}
    <div className={`preview-frames mode-${mode}`}>{children}</div>
    {selected && <section className="candidate-details" data-testid="candidate-details">
      <div className="candidate-title"><h2>候选 {selected.id.slice(0, 8)}</h2><span>待定候选 {pending.length}/3</span></div>
      {selected.outOfScope.length > 0 && <p className="scope-warning" data-testid="candidate-out-of-scope" role="alert">改动超出选中范围：{selected.outOfScope.join('、')}</p>}
      <CheckPanel candidate={selected} run={run} syncReady={ready && !busy} syncEpoch={syncEpoch} version={state.version} onEvidence={onEvidence} gateReason={reason || '前端检查与证据已就绪，采用时仍由服务器最终核对'}/>
      <div className="check-actions">
        {!selected.latestCheckRunId ? <button type="button" data-testid="check-run" disabled={!canRun} onClick={() => void action('run')}>运行检查</button> : <button type="button" data-testid="check-rerun" disabled={!canRun} onClick={() => void action('rerun')}>重新检查</button>}
        <button type="button" data-testid="check-cancel" disabled={!canCancel} onClick={() => void action('cancel')}>取消检查</button>
        {busy && <span role="status">操作结果待确认；若连接中断，请刷新状态</span>}
      </div>
      <Diff candidate={selected}/>
      <div className="candidate-actions">
        <button type="button" data-testid="candidate-adopt" disabled={!!reason} onClick={() => void action('adopt')}>采用此候选</button>
        <button type="button" data-testid="candidate-discard" disabled={busy || !ready} onClick={() => void action('discard')}>撤回候选</button>
      </div>
    </section>}
  </>;
}
