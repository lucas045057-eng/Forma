import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Candidate } from '@spatial/shared';
import { parseDiff } from './diff.ts';
import { api, ApiError, mutation } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';
import CheckPanel from './CheckPanel.tsx';
import CandidateOverview from './CandidateOverview.tsx';
import { summarizeCandidate } from './candidate-overview.ts';
import { activeRun, associatedRun } from './check-state.ts';
import { adoptionReason, operationError, refreshError, type EvidenceReceipt } from './adoption-gate.ts';

export type PreviewMode = 'current' | 'candidate' | 'compare';
export function AdoptButton({ reason, onAdopt }: { reason: string; onAdopt: () => void }) {
  return <button type="button" className="primary-btn compact-btn" data-testid="candidate-adopt" disabled={!!reason} onClick={() => { if (!reason) onAdopt(); }}>采用此候选</button>;
}
export function Diff({ candidate }: { candidate: Candidate }) {
  return <div className="candidate-diff" data-testid="candidate-diff">
    <div className="diff-header">
      <span className="section-label">DIFF</span>
      <ul className="diff-file-pills" data-testid="candidate-files">{candidate.diff.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul>
    </div>
    {candidate.diff.map(file => <section key={file.path} className="diff-file-block" aria-label={`差异 ${file.path}`}>
      <code className="diff-file-label">{file.path}</code>
      <pre className="diff-view">{parseDiff(file.patch).map((line, index) => <span key={index} className={`diff-${line.kind}`}>{line.text}{'\n'}</span>)}</pre>
    </section>)}
  </div>;
}
export default function CandidatePanel({ selectedId, onSelect, mode, onMode, headerMeta, headerStatus, detailsTarget, children }: {
  selectedId: string;
  onSelect: (id: string) => void;
  mode: PreviewMode;
  onMode: (mode: PreviewMode) => void;
  headerMeta?: ReactNode;
  headerStatus?: ReactNode;
  /** Where the candidate checks/diff section renders. Omitted → inline below the artboards;
   *  null → the target is not mounted yet, so render nothing rather than mount inline and
   *  remount on teleport (that would abort evidence loading once). */
  detailsTarget?: HTMLElement | null;
  children: ReactNode;
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
  const checkIssue = selected ? state.checkIssues[selected.id] : undefined;
  const linked = !!selected && associatedRun(selected, run);
  const canRun = !!selected && ready && !busy && !invalid[selected.id] && !!selected.candidateCommit && selected.baseVersion === state.version &&
    (selected.latestCheckRunId ? linked && !activeRun(run) : !checkIssue);
  const canCancel = ready && !busy && linked && activeRun(run);
  const canRevert = ready && !locked(['work']);
  const reason = checkIssue || adoptionReason({ candidate: selected, run, version: state.version, epoch: syncEpoch, ready, connected,
    busy: locked(['work']), rejectedRun: selected ? (invalid[selected.id] ? run?.id : rejected[selected.id]) : undefined, receipt });

  async function action(kind: 'run' | 'rerun' | 'cancel' | 'discard' | 'adopt' | 'revert') {
    if (!ready) return;
    if (kind !== 'revert' && (!selected || selected.decision !== 'pending' || busy)) return;
    if ((kind === 'run' || kind === 'rerun') && (!canRun || (kind === 'rerun') !== !!selected?.latestCheckRunId)) return;
    if (kind === 'cancel' && !canCancel) return;
    if (kind === 'revert' && !canRevert) return;
    if (kind === 'adopt' && checkIssue) return;
    if (kind === 'adopt' && adoptionReason({ candidate: selected, run, version: state.version, epoch: syncEpoch, ready, connected,
      busy: locked(['work']), rejectedRun: selected ? (invalid[selected.id] ? run?.id : rejected[selected.id]) : undefined, receipt: receiptRef.current })) return;
    const id = kind === 'revert' ? 'work' : selected!.id;
    const keys = kind === 'revert' ? ['work'] : kind === 'adopt' ? ['work', `candidate:${id}`] : [`candidate:${id}`];
    const token = acquire(keys);
    if (!token) return;
    clearEvidence();
    setErrors(previous => ({ ...previous, [id]: '', work: '' }));
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
        setErrors(previous => ({ ...previous, [id]: operationError(kind, code, cause instanceof ApiError ? cause.status : undefined, cause instanceof Error ? cause.message : undefined) }));
      }
    }
    // Locks live in the provider, including when this panel unmounts during a request.
    awaiting(token);
    try { await reload(); }
    catch {
      if (mounted.current) setErrors(previous => ({ ...previous, [id]: refreshError(succeeded, previous[id]) }));
    }
  }

  const details = selected ? <section className="candidate-details" data-testid="candidate-details">
      <div className="candidate-header-bar">
        <div className="candidate-title">
          <span className="section-label">CANDIDATE</span>
          <h2>候选 {selected.id.slice(0, 8)}</h2>
          <span className="meta-tag">{pending.length}/3 待定</span>
        </div>
        <div className="candidate-actions-bar">
          {!selected.latestCheckRunId
            ? <button type="button" className="secondary-btn compact-btn" data-testid="check-run" disabled={!canRun} onClick={() => void action('run')}>运行检查</button>
            : <button type="button" className="secondary-btn compact-btn" data-testid="check-rerun" disabled={!canRun} onClick={() => void action('rerun')}>重新检查</button>}
          <button type="button" className="ghost-btn compact-btn" data-testid="check-cancel" disabled={!canCancel} onClick={() => void action('cancel')}>取消检查</button>
          <AdoptButton reason={reason} onAdopt={() => void action('adopt')}/>
          <button type="button" className="ghost-btn compact-btn" data-testid="candidate-discard" disabled={busy || !ready} onClick={() => void action('discard')}>撤回候选</button>
        </div>
      </div>
      {busy && <p className="muted-note" role="status">操作结果待确认；若连接中断，请刷新状态</p>}
      {selected.outOfScope.length > 0 && <p className="scope-warning" data-testid="candidate-out-of-scope" role="alert">改动超出选中范围：{selected.outOfScope.join('、')}</p>}
      <div className="candidate-body-grid">
        <CheckPanel candidate={selected} run={run} syncReady={ready && !busy} syncEpoch={syncEpoch} version={state.version} onEvidence={onEvidence} checkIssue={checkIssue} proofRejected={!!invalid[selected.id] || (!!run && rejected[selected.id] === run.id)} gateReason={reason || '四项检查与证据已就绪，点击右上角「采用此候选」即可合入主作品'}/>
        <Diff candidate={selected}/>
      </div>
    </section> : null;

  return <>
    <div className="preview-controls">
      <div className="canvas-bar-left">
        {headerMeta}
        <span className="version-badge">版本 <code data-testid="work-version">{state.version ? state.version.slice(0, 8) : '读取中'}</code></span>
        <button type="button" className="ghost-btn compact-btn" data-testid="version-revert" disabled={!canRevert} onClick={() => void action('revert')}>回退上一次采用</button>
      </div>
      <div className="canvas-bar-right">
        {pending.length > 0 && <>
          <select aria-label="待定候选版本" data-testid="candidate-select" value={selected?.id ?? ''} onChange={event => { clearEvidence(); onSelect(event.target.value); onMode('candidate'); }}>
            {pending.map(candidate => <option key={candidate.id} value={candidate.id}>候选 {candidate.id.slice(0, 8)}</option>)}
          </select>
          <div className="segmented-control" aria-label="预览模式">
            <button type="button" data-testid="preview-current" aria-pressed={mode === 'current'} onClick={() => onMode('current')}>当前版本</button>
            <button type="button" data-testid="preview-candidate" aria-pressed={mode === 'candidate'} onClick={() => onMode('candidate')}>候选版本</button>
            <button type="button" data-testid="preview-compare" aria-pressed={mode === 'compare'} onClick={() => onMode('compare')}>并排对比</button>
          </div>
        </>}
        {headerStatus}
      </div>
    </div>
    {error && <p className="candidate-error error" data-testid="candidate-action-error" role="alert">{error}</p>}
    {!canRevert && <p className="candidate-sync-hint" role="status">作品决策暂不可用，等待同步或操作结果确认；可使用“刷新状态”恢复。</p>}
    <div className={`preview-frames mode-${mode}`}>{children}</div>
    <CandidateOverview
      summaries={pending.map(candidate => {
        const candidateRun = candidate.latestCheckRunId ? state.runs[candidate.latestCheckRunId] : undefined;
        // Same inputs CheckPanel receives for the selected candidate, applied to every card.
        return summarizeCandidate(candidate, {
          run: candidateRun, tasks: state.tasks, version: state.version, epoch: syncEpoch,
          ready: ready && !locked([`candidate:${candidate.id}`]),
          checkIssue: state.checkIssues[candidate.id],
          proofRejected: !!invalid[candidate.id] || (!!candidateRun && rejected[candidate.id] === candidateRun.id),
        });
      })}
      selectedId={selected?.id ?? ''}
      mode={mode}
      onOpen={id => {
        if (id === selected?.id && mode === 'compare') return;
        if (id !== selected?.id) { clearEvidence(); onSelect(id); }
        onMode('compare');
      }}
    />
    {details && (detailsTarget === undefined ? details : detailsTarget && createPortal(details, detailsTarget))}
  </>;
}
