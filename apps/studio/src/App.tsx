import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isPreviewMessage, type Selection, type StudioMessage } from '@spatial/shared';
import { EventCenterProvider, useEventCenter } from './EventCenter.tsx';
import PointSpeak from './PointSpeak.tsx';
import CandidatePanel, { type PreviewMode } from './CandidatePanel.tsx';
import { api } from './api.ts';

const AssetPanel = lazy(() => import('./AssetPanel'));
const SceneEditor = lazy(() => import('./SceneEditor'));

function syncScroll(frame: HTMLIFrameElement | null, at: number) {
  try {
    const target = frame?.contentWindow;
    const document = target?.document;
    if (!target || !document) return;
    const available = document.documentElement.scrollHeight - target.innerHeight;
    target.scrollTo(0, Math.max(0, available) * at);
  } catch { /* Both previews are same-origin; an unloading frame can simply be skipped. */ }
}

function Studio() {
  const { state, status: eventStatus, lastSeq } = useEventCenter();
  const [showAssets, setShowAssets] = useState(false);
  const [showScene, setShowScene] = useState(false);
  const preview = useRef<HTMLIFrameElement>(null);
  const candidatePreview = useRef<HTMLIFrameElement>(null);
  const pickingRef = useRef(false);
  const pickRequest = useRef(0);
  const progressRef = useRef(0);
  const [picking, setPicking] = useState(false);
  const [ready, setReady] = useState(false);
  const [candidateReady, setCandidateReady] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<PreviewMode>('current');
  const [candidateId, setCandidateId] = useState('');
  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const candidate = pending.find(item => item.id === candidateId) ?? pending[0];
  const send = (message: StudioMessage) => preview.current?.contentWindow?.postMessage(message, window.location.origin);
  const sendCandidate = (message: StudioMessage) => candidatePreview.current?.contentWindow?.postMessage(message, window.location.origin);

  useEffect(() => {
    if (!candidate) { setCandidateId(''); if (mode !== 'current') setMode('current'); }
    else if (!pending.some(item => item.id === candidateId)) setCandidateId(candidate.id);
  }, [candidate, candidateId, mode, pending]);
  useEffect(() => { setCandidateReady(false); }, [candidate?.id]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !isPreviewMessage(event.data)) return;
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
      switch (event.data.type) {
        case 'ready':
          setReady(true);
          setError('');
          setSelection(null);
          send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
          break;
        case 'pick:result': {
          if (!pickingRef.current) return;
          const payload = event.data.payload;
          const requestId = ++pickRequest.current;
          send({ type: 'highlight', payload: { src: payload.src } });
          void api<{ version: string }>('/version').then(result => {
            if (requestId !== pickRequest.current || !pickingRef.current) return;
            setSelection({ ...payload, baseVersion: result.version });
            setError('');
          }).catch(() => { if (requestId === pickRequest.current) setError('无法读取作品版本，请确认后端已启动后重新点选'); });
          break;
        }
        case 'scroll:progress':
          progressRef.current = event.data.payload.at;
          setProgress(event.data.payload.at);
          syncScroll(candidatePreview.current, event.data.payload.at);
          break;
        case 'error': setError(event.data.payload.message); break;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  const previewSize = () => preview.current?.contentDocument?.querySelector('[data-testid="product-scene"] canvas')?.getBoundingClientRect().width ?? 400;
  function toggle() {
    if (mode === 'candidate') setMode('current');
    pickingRef.current = !pickingRef.current;
    setPicking(pickingRef.current);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
    if (pickingRef.current && selection) send({ type: 'highlight', payload: { src: selection.src } });
  }
  const mainFrame = <iframe ref={preview} src="/preview/main/" title="香薰商品页预览" data-testid="preview-frame" onLoad={() => {
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
  }}/>;
  const candidateFrame = candidate ? <iframe key={candidate.id} ref={candidatePreview} src={candidate.previewUrl} title={`候选版本 ${candidate.id.slice(0, 8)}`} data-testid="candidate-frame" data-ready={candidateReady}/> : null;

  return (
    <main className="studio">
      {showAssets && <Suspense fallback={<p role="status">加载 3D 视口…</p>}><AssetPanel onClose={() => setShowAssets(false)}/></Suspense>}
      <header className="toolbar">
        <div><span className="wordmark">ORBIT / STUDIO</span><h1>空间化 AI 创作工作台</h1></div>
        <div className="tools">
          <button type="button" data-testid="scene-open" onClick={() => { setMode('current'); pickingRef.current = false; setPicking(false); send({ type: 'pick:stop' }); setShowScene(true); }}>3D 场景编辑</button>
          <button type="button" data-testid="asset-open" onClick={() => setShowAssets(true)}>3D 资产</button>
          <span className="connection" data-testid="preview-status">{ready ? '预览已连接' : '等待预览连接'}</span>
          <span className="connection" data-testid="events-status" data-status={eventStatus}>{eventStatus === 'connected' ? '事件已连接' : eventStatus === 'reconnecting' ? '事件重连中' : '事件连接中'} · <output data-testid="events-seq">{lastSeq}</output></span>
          <button type="button" aria-pressed={picking} data-testid="pick-toggle" onClick={toggle}>{picking ? '退出选取' : '开启选取'}</button>
        </div>
      </header>
      <div className={`workspace${showScene ? ' scene-editing' : ''}`}>
        <section className="preview-panel" aria-label="作品预览">
          <div className="panel-title"><span>作品 / 木间香薰</span><span>{picking ? '选取模式 · 点击查看源码' : '浏览模式'} · {Math.round(progress * 100)}%</span></div>
          <CandidatePanel selectedId={candidate?.id ?? ''} onSelect={setCandidateId} mode={mode} onMode={setMode}>
            {mode !== 'candidate' && mainFrame}
            {mode !== 'current' && candidateFrame}
          </CandidatePanel>
        </section>
        {showScene ? <Suspense fallback={<p>加载场景编辑器…</p>}><SceneEditor at={progress} previewSize={previewSize} onClose={() => setShowScene(false)}/></Suspense> : <aside className="inspector">
          <p className="section-label">SOURCE INSPECTOR</p><h2>选中对象</h2>
          <p className="hint">开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。</p>
          {error && <p className="error" role="alert">{error}</p>}
          {selection ? <>
            <div className="selection-summary"><strong>{selection.cid}</strong><code>{selection.src}</code></div>
            {selection.note && <p className="notice">已选中外层容器</p>}
            <p className="notice" data-testid="instances">同源码实例：{selection.instances} 处{selection.instances > 1 ? '；修改将影响全部实例（共享组件或列表项）。' : ''}</p>
            <pre data-testid="selection-json">{JSON.stringify(selection, null, 2)}</pre>
          </> : <div className="empty">等待选取页面元素</div>}
          <PointSpeak selection={selection}/>
        </aside>}
      </div>
    </main>
  );
}

export default function App() {
  return <EventCenterProvider><Studio/></EventCenterProvider>;
}
