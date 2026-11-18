import { useEffect, useState } from 'react';
import type { Candidate, CheckArtifact, CheckRun } from '@spatial/shared';
import { activeRun, checkView, evidenceRefs, evidenceUrl, requiredEvidence } from './check-state.ts';
import { readCheckEvidence } from './api.ts';
import { proofKey } from './adoption-gate.ts';

const statuses = { passed: '通过', failed: '失败', not_run: '未检查' };
const failures = { schema: '场景配置检查失败，请查看字段原因', build: '构建失败，请查看构建日志', smoke: '页面冒烟检查失败，请查看运行错误与截图', occlusion: '交互入口被遮挡或命中检查失败，请查看报告与截图' };
type ReadResult = { text?: string; image?: string; error?: string };
function Evidence({ runId, refs, enabled, binding, onEvidence }: { runId: string; refs: CheckArtifact[]; enabled: boolean; binding: string; onEvidence?: (key: string, ready: boolean) => void }) {
  const [read, setRead] = useState<Record<string, ReadResult>>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const urls: string[] = [];
    const timer = window.setTimeout(() => {
      controller.abort();
      setRead(previous => Object.fromEntries(refs.map(ref => [ref.name, previous[ref.name] ?? { error: '证据读取超时，请刷新检查状态' }])));
    }, 30_000);
    for (const ref of refs) {
      void readCheckEvidence(runId, ref, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        let image: string | undefined;
        if (result.text === undefined) { image = URL.createObjectURL(result.blob); urls.push(image); }
        setRead(previous => ({ ...previous, [ref.name]: { text: result.text, image } }));
      }).catch(() => {
        if (!controller.signal.aborted) setRead(previous => ({ ...previous, [ref.name]: { error: '证据无法读取，请刷新检查状态' } }));
      });
    }
    return () => { clearTimeout(timer); controller.abort(); onEvidence?.(binding, false); for (const url of urls) URL.revokeObjectURL(url); };
    // This component is keyed by candidate/run, validated refs and synchronization epoch.
  }, []);
  const complete = requiredEvidence.every(name => read[name] && !read[name].error);
  const error = Object.values(read).some(result => result.error);
  useEffect(() => { onEvidence?.(binding, enabled && complete && !error); }, [binding, enabled, complete, error, onEvidence]);
  return <div className="check-evidence-list" data-evidence-ready={complete}>
    <p className="evidence-summary" role="status">{complete ? '六份必需证据已读取并核对 hash' : '必需证据尚未全部可读'}</p>
    {error && <p className="error" role="alert" data-testid="check-error">证据无法读取，请刷新检查状态</p>}
    {requiredEvidence.filter(name => !refs.some(ref => ref.name === name)).map(name => <p key={name} className="muted-note">{name}：无证据或引用不一致</p>)}
    <div className="evidence-grid">
      {refs.map(ref => {
        const result = read[ref.name];
        return <section key={ref.name} className="evidence-chip">
          <div className="evidence-chip-head">
            <code>{ref.name}</code>
            <span>{(ref.bytes / 1024).toFixed(1)} KB</span>
          </div>
          {result && !result.error ? <div className="evidence-chip-actions">
            <a data-testid="check-evidence" data-run-id={runId} data-artifact-name={ref.name} data-hash={ref.hash} href={evidenceUrl(runId, ref.name)} download={ref.name} rel="noopener noreferrer">下载</a>
            <details><summary>查看</summary>{result.image ? <img src={result.image} alt={ref.name}/> : <pre>{result.text}</pre>}</details>
          </div> : <button type="button" className="ghost-btn compact-btn" data-testid="check-evidence" data-run-id={runId} data-artifact-name={ref.name} data-hash={ref.hash} disabled>{result?.error ? '无法读取' : enabled ? '读取中…' : '待检查完成'}</button>}
        </section>;
      })}
    </div>
  </div>;
}

export default function CheckPanel({ candidate, run, syncReady, syncEpoch, version, onEvidence, gateReason, checkIssue, proofRejected = false }: {
  candidate: Candidate; run?: CheckRun; syncReady: boolean; syncEpoch: number; version: string;
  onEvidence?: (key: string, ready: boolean) => void; gateReason?: string; checkIssue?: string; proofRejected?: boolean;
}) {
  const view = checkView(candidate, run);
  const refs = evidenceRefs(candidate, run);
  const stale = proofRejected || candidate.baseVersion !== version || (!!run && run.mainVersion !== version);
  const binding = proofKey(candidate, run, version, syncEpoch);
  const evidenceEnabled = syncReady && !checkIssue && !!run && !activeRun(run);
  const key = JSON.stringify([binding, evidenceEnabled]);
  return <div className="candidate-checks" data-testid="candidate-checks">
    <div className="checks-overview-bar">
      <span className="section-label">QUALITY GATE</span>
      <span role="status" data-testid="check-run-status" data-run-id={candidate.latestCheckRunId ?? ''} data-candidate-id={candidate.id}>{checkIssue ? '检查状态不完整' : stale ? '历史检查结果 · 证明已失效' : syncReady ? view.label : '状态待同步'}</span>
    </div>
    {!candidate.candidateCommit && <p className="error" role="alert">候选缺少记录，请重新生成</p>}
    {(checkIssue || (candidate.latestCheckRunId && !view.complete)) && <p className="error" role="alert" data-testid="check-error">{checkIssue || '检查状态不完整'}</p>}
    <div className="check-items-grid">
      {view.rows.map(row => <div key={row.name} className="check-card" data-testid="check-item" data-check-name={row.name} data-status={row.status}>
        <div className="check-card-head">
          <strong>{row.label}</strong>
          <span className={`check-badge status-${row.status}`}>{statuses[row.status]}{row.missing ? '（缺失）' : ''}</span>
        </div>
        {typeof row.durationMs === 'number' && <span className="check-duration">{row.durationMs} ms</span>}
        {row.message && <p className="check-msg">{row.message.startsWith('未开始执行：') ? '前序失败，未运行：' : ''}{row.message}</p>}
        {row.status === 'failed' && <p className="error" role="alert">{failures[row.name]}</p>}
      </div>)}
    </div>
    {view.associated && run && <>
      {run.error && <p className="error" role="alert" data-testid="check-error">检查未通过：{run.error.code} · {run.error.message}</p>}
      <Evidence key={key} runId={run.id} refs={refs} enabled={evidenceEnabled} binding={binding} onEvidence={onEvidence}/>
    </>}
    <p className="gate-reason" data-testid="candidate-gate-reason">{gateReason ?? (stale ? '证明已失效' : '尚未满足采用门禁')}</p>
  </div>;
}
