import type { PickState } from './pick-state.ts';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isPreviewMessage, type ApprovalCard, type StudioMessage } from '@spatial/shared';
import ApprovalPanel from './ApprovalPanel.tsx';
import { impactHighlightMessages, isImpactPickError, restorePicking, waiting } from './approval-state.ts';
import { EventCenterProvider, useEventCenter } from './EventCenter.tsx';
import PointSpeak from './PointSpeak.tsx';
import CandidatePanel, { type PreviewMode } from './CandidatePanel.tsx';
import { api } from './api.ts';
import { previewOrigin, previewUrl } from './preview-origin.ts';

const AssetPanel = lazy(() => import('./AssetPanel'));
const SceneEditor = lazy(() => import('./SceneEditor'));

function syncScroll(frame: HTMLIFrameElement | null, at: number) {
  frame?.contentWindow?.postMessage({ type: 'scroll:to', payload: { at } }, previewOrigin);
}

function Studio() {
  const { state, status: eventStatus, lastSeq, syncReady, syncError, reload } = useEventCenter();
  const [impact, setImpact] = useState<{ id: string; src: string; baseVersion: string; wasPicking: boolean } | null>(null);
  const impactRef = useRef<typeof impact>(null);
  const [showAssets, setShowAssets] = useState(false);
  const [showScene, setShowScene] = useState(false);
  const preview = useRef<HTMLIFrameElement>(null);
  const candidatePreview = useRef<HTMLIFrameElement>(null);
  const pickingRef = useRef(false);
  const pickRequest = useRef(0);
  const progressRef = useRef(0);
  const canvasWidth = useRef(400);
  const [picking, setPicking] = useState(false);
  const [ready, setReady] = useState(false);
  const [candidateReady, setCandidateReady] = useState(false);
  const [pick, setPick] = useState<PickState>({ kind: 'none' });
  const selection = pick.kind === 'ready' ? pick.selection : null;
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<PreviewMode>('current');
  const [candidateId, setCandidateId] = useState('');
  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const candidate = pending.find(item => item.id === candidateId) ?? pending[0];
  const send = (message: StudioMessage) => preview.current?.contentWindow?.postMessage(message, previewOrigin);
  const sendCandidate = (message: StudioMessage) => candidatePreview.current?.contentWindow?.postMessage(message, previewOrigin);

  const selectionVersion = useRef(state.version);
  useEffect(() => {
    const previous = selectionVersion.current;
    selectionVersion.current = state.version;
    if (!previous || previous === state.version) return;
    ++pickRequest.current;
    setPick({ kind: 'none' });
    pickingRef.current = false;
    setPicking(false);
    send({ type: 'pick:stop' });
    if (pick.kind === 'ready' || pick.kind === 'pending') setError('页面已变化，请重新点选');
  }, [state.version]);

  function exitImpact(restore = true) {
    const previous = impactRef.current;
    if (!previous) return;
    impactRef.current = null;
    setImpact(null);
    send({ type: 'pick:stop' });
    pickingRef.current = !!(restore && restorePicking(previous.wasPicking, selection, state.version));
    setPicking(pickingRef.current);
    if (pickingRef.current && selection) {
      send({ type: 'pick:start' });
      send({ type: 'highlight', payload: { src: selection.src } });
    }
  }
  function highlight(card: ApprovalCard, src: string) {
    if (!syncReady || card.baseVersion !== state.version || !waiting(card)) return;
    ++pickRequest.current;
    if (pick.kind === 'pending') setPick({ kind: 'none' });
    const next = { id: card.id, src, baseVersion: card.baseVersion, wasPicking: impactRef.current?.wasPicking ?? pickingRef.current };
    impactRef.current = next;
    setImpact(next);
    setShowScene(false);
    setMode('current');
    pickingRef.current = false;
    setPicking(false);
    impactHighlightMessages(src).forEach(send);
  }
  useEffect(() => {
    if (!impact) return;
    const card = state.approvals.find(item => item.id === impact.id);
    if (!syncReady || showScene || mode !== 'current' || impact.baseVersion !== state.version || !card || !waiting(card)) exitImpact(syncReady && !showScene);
  }, [state, syncReady, showScene, mode, impact]);

  useEffect(() => {
    if (!candidate) { setCandidateId(''); if (mode !== 'current') setMode('current'); }
    else if (!pending.some(item => item.id === candidateId)) setCandidateId(candidate.id);
  }, [candidate, candidateId, mode, pending]);
  useEffect(() => { setCandidateReady(false); }, [candidate?.id]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== previewOrigin || !isPreviewMessage(event.data)) return;
      const fromMain = event.source === preview.current?.contentWindow;
      const fromCandidate = event.source === candidatePreview.current?.contentWindow;
      if (!fromMain && !fromCandidate) return;
      if (fromCandidate) {
        if (event.data.type === 'ready') {
          setCandidateReady(true);
          sendCandidate({ type: 'pick:stop' });
          syncScroll(candidatePreview.current, progressRef.current);
        } else if (event.data.type === 'scroll:progress') {
          progressRef.current = event.data.payload.at;
          setProgress(event.data.payload.at);
          syncScroll(preview.current, event.data.payload.at);
        }
        // Candidate frames deliberately never enter picking mode or change Selection.
        return;
      }
      if (impactRef.current && (event.data.type === 'pick:result' || (event.data.type === 'error' && isImpactPickError(event.data.payload.message)))) {
        impactHighlightMessages(impactRef.current.src).forEach(send);
        return;
      }
      switch (event.data.type) {
        case 'ready':
          if (impactRef.current) {
            impactRef.current = null;
            setImpact(null);
            pickingRef.current = false;
            setPicking(false);
            send({ type: 'pick:stop' });
          }
          ++pickRequest.current;
          setReady(true);
          setError('');
          setPick({ kind: 'none' });
          send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
          break;
        case 'pick:result': {
          if (impactRef.current || !pickingRef.current) return;
          const payload = event.data.payload;
          const requestId = ++pickRequest.current;
          send({ type: 'highlight', payload: { src: payload.src } });
          // The previous object stops being submittable the moment a new one is picked.
          setPick({ kind: 'pending', src: payload.src });
          void api<{ version: string }>('/version').then(result => {
            if (requestId !== pickRequest.current) return;
            setPick({ kind: 'ready', selection: { ...payload, baseVersion: result.version } });
            setError('');
          }).catch(() => {
            if (requestId !== pickRequest.current) return;
            setPick({ kind: 'failed', src: payload.src });
            setError('无法读取作品版本，请确认后端已启动后重新点选');
          });
          break;
        }
        case 'scroll:progress':
          progressRef.current = event.data.payload.at;
          setProgress(event.data.payload.at);
          syncScroll(candidatePreview.current, event.data.payload.at);
          break;
        case 'viewport:size': canvasWidth.current = event.data.payload.width; break;
        case 'error': setError(event.data.payload.message); break;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  const previewSize = () => { send({ type: 'viewport:request' }); return canvasWidth.current; };
  function toggle() {
    if (impactRef.current) { exitImpact(); return; }
    if (mode === 'candidate') setMode('current');
    pickingRef.current = !pickingRef.current;
    setPicking(pickingRef.current);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
    if (pickingRef.current && selection) send({ type: 'highlight', payload: { src: selection.src } });
  }
  const mainFrame = <iframe ref={preview} src={previewUrl('/preview/main/')} title="香薰商品页预览" data-testid="preview-frame" onLoad={() => {
    exitImpact(false);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
  }}/>;
  const candidateFrame = candidate ? <iframe key={candidate.id} ref={candidatePreview} src={previewUrl(candidate.previewUrl)} title={`候选版本 ${candidate.id.slice(0, 8)}`} data-testid="candidate-frame" data-ready={candidateReady}/> : null;

  return (
    <main className="studio">
      {showAssets && <Suspense fallback={<p role="status">加载 3D 视口…</p>}><AssetPanel onClose={() => setShowAssets(false)}/></Suspense>}
      <header className="toolbar">
        <div><span className="wordmark">ORBIT / STUDIO</span><h1>空间化 AI 创作工作台</h1></div>
        <div className="tools">
          <button type="button" data-testid="scene-open" onClick={() => { exitImpact(false); setMode('current'); pickingRef.current = false; setPicking(false); send({ type: 'pick:stop' }); setShowScene(true); }}>3D 场景编辑</button>
          <button type="button" data-testid="asset-open" onClick={() => setShowAssets(true)}>3D 资产</button>
          <span className="connection" data-testid="preview-status">{ready ? '预览已连接' : '等待预览连接'}</span>
          <span className="connection" data-testid="events-status" data-status={eventStatus}>{eventStatus === 'connected' ? '事件已连接' : eventStatus === 'reconnecting' ? '事件重连中' : '事件连接中'} · <output data-testid="events-seq">{lastSeq}</output></span>
          <button type="button" aria-pressed={picking} data-testid="pick-toggle" onClick={toggle}>{picking ? '退出选取' : '开启选取'}</button>
        </div>
      </header>
      <div className="state-sync">
        {!syncReady && <span role="status">状态待同步</span>}
        {syncError && <span role="alert">{syncError}</span>}
        <button type="button" data-testid="state-refresh" onClick={() => void reload().catch(() => {})}>刷新状态</button>
      </div>
      <div className={`workspace${showScene ? ' scene-editing' : ''}`}>
        <section className="preview-panel" aria-label="作品预览">
          <div className="panel-title"><span>作品 / 木间香薰</span><span>{impact ? '查看影响位置' : picking ? '选取模式 · 点击查看源码' : '浏览模式'} · {Math.round(progress * 100)}%</span></div>
          <CandidatePanel selectedId={candidate?.id ?? ''} onSelect={setCandidateId} mode={mode} onMode={setMode}>
            {mainFrame}
            {mode !== 'current' && candidateFrame}
          </CandidatePanel>
        </section>
        <aside className="inspector">
          {showScene && <Suspense fallback={<p>加载场景编辑器…</p>}><SceneEditor at={progress} previewSize={previewSize} onClose={() => setShowScene(false)}/></Suspense>}
          <div hidden={showScene}>
          <p className="section-label">SOURCE INSPECTOR</p><h2>选中对象</h2>
          <p className="hint">开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。</p>
          {error && <p className="error" role="alert">{error}</p>}
          {selection ? <>
            <div className="selection-summary"><strong>{selection.cid}</strong><code>{selection.src}</code></div>
            {selection.note && <p className="notice">已选中外层容器</p>}
            <p className="notice" data-testid="instances">同源码实例：{selection.instances} 处{selection.instances > 1 ? '；修改将影响全部实例（共享组件或列表项）。' : ''}</p>
            <pre data-testid="selection-json">{JSON.stringify(selection, null, 2)}</pre>
          </> : <div className="empty">等待选取页面元素</div>}
          <PointSpeak pick={pick} blocked={!!impact || showScene}/>
          </div>
          <ApprovalPanel highlightId={impact?.id ?? null} onHighlight={highlight} onExit={() => exitImpact()}/>
        </aside>
      </div>
    </main>
  );
}

export default function App() {
  return <EventCenterProvider><Studio/></EventCenterProvider>;
}
