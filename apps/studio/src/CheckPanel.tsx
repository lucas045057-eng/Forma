import { useEffect, useState } from 'react';
import type { Candidate, CheckArtifact, CheckRun } from '@spatial/shared';
import { checkView, evidenceRefs, evidenceUrl, requiredEvidence } from './check-state.ts';
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
    <p role="status">{complete ? '六份必需证据已读取并核对 hash' : '必需证据尚未全部可读'}</p>
    {error && <p role="alert" data-testid="check-error">证据无法读取，请刷新检查状态</p>}
    {requiredEvidence.filter(name => !refs.some(ref => ref.name === name)).map(name => <p key={name}>{name}：无证据或引用不一致</p>)}
    {refs.map(ref => {
      const result = read[ref.name];
      return <section key={ref.name}>
        <p><code>{ref.name}</code> · {ref.bytes} bytes · <code>{ref.hash}</code></p>
        {result && !result.error ? <>
          <a data-testid="check-evidence" data-run-id={runId} data-artifact-name={ref.name} data-hash={ref.hash} href={evidenceUrl(runId, ref.name)} download={ref.name} rel="noopener noreferrer">下载 {ref.name}</a>
          <details><summary>查看 {ref.name}</summary>{result.image ? <img src={result.image} alt={ref.name}/> : <pre>{result.text}</pre>}</details>
        </> : <button type="button" data-testid="check-evidence" data-run-id={runId} data-artifact-name={ref.name} data-hash={ref.hash} disabled>{result?.error ? '证据无法读取' : enabled ? '证据读取中' : '状态待同步'}</button>}
      </section>;
    })}
  </div>;
}

export default function CheckPanel({ candidate, run, syncReady, syncEpoch, version, onEvidence, gateReason, proofRejected = false }: {
  candidate: Candidate; run?: CheckRun; syncReady: boolean; syncEpoch: number; version: string;
  onEvidence?: (key: string, ready: boolean) => void; gateReason?: string; proofRejected?: boolean;
}) {
  const view = checkView(candidate, run);
  const refs = evidenceRefs(candidate, run);
  const stale = proofRejected || candidate.baseVersion !== version || (!!run && run.mainVersion !== version);
  const binding = proofKey(candidate, run, version, syncEpoch);
  const key = JSON.stringify([binding, syncReady]);
  return <div className="candidate-checks" data-testid="candidate-checks">
    <p role="status" data-testid="check-run-status" data-run-id={candidate.latestCheckRunId ?? ''} data-candidate-id={candidate.id}>{stale ? '历史检查结果 · 证明已失效' : syncReady ? view.label : '状态待同步'}</p>
    {!candidate.candidateCommit && <p role="alert">候选缺少记录，请重新生成</p>}
    {candidate.latestCheckRunId && !view.complete && <p role="alert" data-testid="check-error">检查状态不完整</p>}
    {view.rows.map(row => <div key={row.name} data-testid="check-item" data-check-name={row.name} data-status={row.status}>
      <strong>{row.label}：{statuses[row.status]}{row.missing ? '（结果缺失）' : ''}</strong>
      {typeof row.durationMs === 'number' && <span> · {row.durationMs} ms</span>}
      {row.message && <p>{row.message.startsWith('blocked_by') ? '前序失败，未运行：' : ''}{row.message}</p>}
      {row.status === 'failed' && <p role="alert">{failures[row.name]}</p>}
    </div>)}
    {view.associated && run && <>
      <p>检查轮次 <code>{run.id}</code> · 候选 <code>{run.candidateId}</code></p>
      {run.finishedAt && <p>完成时间：{run.finishedAt}</p>}
      {run.error && <p role="alert" data-testid="check-error">检查未通过：{run.error.code} · {run.error.message}</p>}
      <Evidence key={key} runId={run.id} refs={refs} enabled={syncReady} binding={binding} onEvidence={onEvidence}/>
    </>}
    <p data-testid="candidate-gate-reason">{gateReason ?? (stale ? '证明已失效' : '尚未满足采用门禁')}</p>
  </div>;
}
