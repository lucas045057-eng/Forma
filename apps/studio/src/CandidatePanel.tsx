import { useState, type ReactNode } from 'react';
import type { Candidate } from '@spatial/shared';
import { parseDiff } from './diff.ts';
import { api, ApiError, mutation } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';

export type PreviewMode = 'current' | 'candidate' | 'compare';
const checkNames = { build: '构建', smoke: '冒烟', occlusion: '遮挡', schema: 'Schema' } as const;

function Diff({ candidate }: { candidate: Candidate }) {
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
  const { state, reload } = useEventCenter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const selected = pending.find(candidate => candidate.id === selectedId) ?? pending[0];

  async function action(kind: 'adopt' | 'discard' | 'revert', id?: string) {
    setBusy(true); setError('');
    try {
      const url = kind === 'revert' ? '/version/revert' : `/candidates/${encodeURIComponent(id!)}/${kind}`;
      await api(url, mutation('POST'));
      if (kind !== 'revert') onMode('current');
      await reload();
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'MERGE_CONFLICT') setError('候选与当前版本冲突，请撤回该候选并重新生成。');
      else if (cause instanceof ApiError && cause.code === 'NO_ADOPTION') setError('暂无可回退的采用记录。');
      else setError(cause instanceof Error ? cause.message : '候选操作失败');
    } finally { setBusy(false); }
  }

  return <>
    <div className="preview-controls">
      <span>作品版本 <code data-testid="work-version">{state.version ? state.version.slice(0, 10) : '读取中'}</code></span>
      <button type="button" data-testid="version-revert" disabled={busy} onClick={() => void action('revert')}>回退上一次采用</button>
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
      <div className="candidate-checks" data-testid="candidate-checks">{selected.checks.map(check => <span key={check.name} data-status="not_run">{checkNames[check.name]}：未检查</span>)}</div>
      <Diff candidate={selected}/>
      <div className="candidate-actions">
        <button type="button" data-testid="candidate-adopt" disabled={busy} onClick={() => void action('adopt', selected.id)}>采用此候选</button>
        <button type="button" data-testid="candidate-discard" disabled={busy} onClick={() => void action('discard', selected.id)}>撤回候选</button>
      </div>
    </section>}
  </>;
}
