import type { PickState } from './pick-state.ts';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isPreviewMessage, type ApprovalCard, type ModelStatusView, type StudioMessage, type WorkSummary, type WorksState } from '@spatial/shared';
import ApprovalPanel from './ApprovalPanel.tsx';
import { impactHighlightMessages, isImpactPickError, restorePicking, waiting } from './approval-state.ts';
import { EventCenterProvider, useEventCenter } from './EventCenter.tsx';
import PointSpeak from './PointSpeak.tsx';
import CandidatePanel, { type PreviewMode } from './CandidatePanel.tsx';
import { api, mutation } from './api.ts';
import { previewOrigin, previewUrl } from './preview-origin.ts';
import ModelOriginBadge from './model-provenance.tsx';
import AssetPlacement from './AssetPlacement.tsx';
import SelectionLink from './SelectionLink.tsx';
import NewWorkModal, { type CreatedWorkResult, type ModalTab } from './NewWorkModal.tsx';
import ModelConfigModal from './ModelConfigModal.tsx';
import type {Asset} from '@spatial/shared';
import type {PlacementSession} from './placement-state.ts';
import {luxApi} from './lux3d-api.ts';

const AssetPanel = lazy(() => import('./AssetPanel'));
const SceneEditor = lazy(() => import('./SceneEditor'));

function syncScroll(frame: HTMLIFrameElement | null, at: number) {
  frame?.contentWindow?.postMessage({ type: 'scroll:to', payload: { at } }, previewOrigin);
}

function Studio() {
  const { state, status: eventStatus, lastSeq, syncReady, syncError, reload, subscribe } = useEventCenter();
  const [worksState, setWorksState] = useState<WorksState>({
    activeId: 'default',
    works: [{ id: 'default', name: '木间香薰', starter: 'product-page', createdAt: '', updatedAt: '', active: true }],
  });
  const [modalTab, setModalTab] = useState<ModalTab | null>(null);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelStatusView | null>(null);
  const [switchingWork, setSwitchingWork] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [impact, setImpact] = useState<{ id: string; src: string; baseVersion: string; wasPicking: boolean } | null>(null);
  const impactRef = useRef<typeof impact>(null);
  const [showAssets, setShowAssets] = useState(false);
  const [placingAsset,setPlacingAsset]=useState<Asset>();
  const [initialPlacement,setInitialPlacement]=useState<PlacementSession>();
  const [placementGeneration,setPlacementGeneration]=useState(0);
  const [draggingPlacement,setDraggingPlacement]=useState(false);
  const placementSessions=useRef(new Map<string,Promise<PlacementSession>>());
  const [showScene, setShowScene] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [candidateSlot, setCandidateSlot] = useState<HTMLDivElement | null>(null);
  const preview = useRef<HTMLIFrameElement>(null);
  const candidatePreview = useRef<HTMLIFrameElement>(null);
  const pickingRef = useRef(false);
  const pickRequest = useRef(0);
  const progressRef = useRef(0);
  const targetCard = useRef<HTMLDivElement>(null);
  const [pickedAt, setPickedAt] = useState<number | null>(null);
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
          if (event.data.payload.sync !== false) syncScroll(preview.current, event.data.payload.at);
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
          setPickedAt(progressRef.current);
          setInspectorOpen(true);
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
          // Only a real scroll moves the other artboard; a pick reports its position with sync: false.
          if (event.data.payload.sync !== false) syncScroll(candidatePreview.current, event.data.payload.at);
          break;
        case 'viewport:size': canvasWidth.current = event.data.payload.width; break;
        case 'error': setError(event.data.payload.message); break;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  async function preparePlacement(asset:Asset):Promise<PlacementSession>{
    if(!ready||!syncReady||eventStatus!=='connected'||!state.version)throw new Error('请等待主预览和作品状态同步后放置');
    const key=asset.id+':'+state.version;
    const request=()=>{
      const guarded=luxApi.placementSession(asset.id,state.version).catch(error=>{
        if(placementSessions.current.get(key)===guarded)placementSessions.current.delete(key);
        throw error;
      });
      return guarded;
    };
    let pending=placementSessions.current.get(key);
    if(!pending){pending=request();placementSessions.current.set(key,pending);}
    const session=await pending;
    if(session.expiresAt>Date.now())return session;
    // The cached promise resolved to an expired session: drop only this value and prepare once
    // more inside the same interaction. A concurrent interaction may already have installed a
    // fresh request for this asset+version, which is reused instead of creating a second one.
    if(placementSessions.current.get(key)===pending)placementSessions.current.delete(key);
    let refreshed=placementSessions.current.get(key);
    if(!refreshed){refreshed=request();placementSessions.current.set(key,refreshed);}
    const next=await refreshed;
    if(next.expiresAt>Date.now())return next;
    if(placementSessions.current.get(key)===refreshed)placementSessions.current.delete(key);
    throw new Error('放置会话已过期，请重新准备');
  }
  useEffect(() => {
    if (!draggingPlacement) return;
    const stopDrag = () => setDraggingPlacement(false);
    window.addEventListener('dragend', stopDrag, true);
    window.addEventListener('drop', stopDrag, true);
    return () => {
      window.removeEventListener('dragend', stopDrag, true);
      window.removeEventListener('drop', stopDrag, true);
    };
  }, [draggingPlacement]);

  function beginAssetPlacement(asset: Asset, session?: PlacementSession, fromDrag = false) {
    exitImpact(false);
    pickingRef.current = false;
    setPicking(false);
    setMode('current');
    setShowScene(false);
    send({ type: 'pick:stop' });
    if (session) {
      send({ type: 'placement:start', payload: session });
    }
    setInitialPlacement(session);
    if (!placingAsset || placingAsset.id !== asset.id || !session) {
      setPlacementGeneration(value => value + 1);
    }
    setPlacingAsset(asset);
    if (fromDrag) {
      requestAnimationFrame(() => setDraggingPlacement(true));
    } else {
      setDraggingPlacement(false);
      setShowAssets(false);
    }
  }
  const previewSize = () => { send({ type: 'viewport:request' }); return canvasWidth.current; };
  function toggle() {
    if (impactRef.current) { exitImpact(); return; }
    if (mode === 'candidate') setMode('current');
    pickingRef.current = !pickingRef.current;
    setPicking(pickingRef.current);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
    if (pickingRef.current && selection) send({ type: 'highlight', payload: { src: selection.src } });
  }
  useEffect(() => {
    let active = true;
    const isJson = (res: Response) => res.ok && (res.headers.get('content-type') ?? '').includes('application/json');
    const loadWorks = () => {
      void fetch('/works', { cache: 'no-store' })
        .then(res => (isJson(res) ? (res.json() as Promise<WorksState>) : null))
        .then(value => {
          if (!active || !value || !Array.isArray(value.works) || typeof value.activeId !== 'string') return;
          setWorksState(previous => {
            if (previous.activeId !== value.activeId) {
              setReady(false);
              setPreviewRevision(rev => rev + 1);
            }
            return value;
          });
        })
        .catch(() => {});
    };
    const loadModelStatus = () => {
      void fetch('/models/status', { cache: 'no-store' })
        .then(res => (isJson(res) ? (res.json() as Promise<ModelStatusView>) : null))
        .then(value => {
          if (!active || !value || !value.coding) return;
          setModelStatus(value);
        })
        .catch(() => {});
    };
    loadWorks();
    loadModelStatus();
    const unsubscribe = subscribe(event => {
      if (event.type === 'work.changed' || event.type === 'work.updated') loadWorks();
      if (event.type === 'models.updated') loadModelStatus();
      if (event.type === 'candidate.ready') {
        const readyCandidate = event.candidate as { id?: string; taskId?: string } | undefined;
        const relatedTask = state.tasks.find(t => t.id === readyCandidate?.taskId || t.id === readyCandidate?.id);
        if (readyCandidate?.id && relatedTask?.bootstrap) {
          setCandidateId(readyCandidate.id);
          setMode('candidate');
        }
      }
    });
    return () => { active = false; unsubscribe(); };
  }, [subscribe, state.tasks]);

  async function selectWork(nextId: string) {
    if (!nextId || nextId === worksState.activeId || switchingWork) return;
    setSwitchingWork(true);
    setError('');
    try {
      exitImpact(false);
      pickingRef.current = false;
      setPicking(false);
      setPick({ kind: 'none' });
      setPlacingAsset(undefined);
      setShowScene(false);
      setMode('current');
      setReady(false);
      await api(`/works/${encodeURIComponent(nextId)}/select`, mutation('POST', {}));
      setPreviewRevision(rev => rev + 1);
      await reload(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换作品失败');
    } finally {
      setSwitchingWork(false);
    }
  }

  async function handleWorkCreated(created: CreatedWorkResult) {
    setModalTab(null);
    exitImpact(false);
    pickingRef.current = false;
    setPicking(false);
    setPick({ kind: 'none' });
    setPlacingAsset(undefined);
    setShowScene(false);
    setMode('current');
    setReady(false);
    setWorksState(previous => {
      const others = previous.works.filter(item => item.id !== created.work.id).map(item => ({ ...item, active: false }));
      return { activeId: created.activeId, works: [...others, { ...created.work, active: true }] };
    });
    setPreviewRevision(rev => rev + 1);
    await reload(true).catch(() => {});
  }

  const activeWorkSummary: WorkSummary | undefined = worksState.works.find(item => item.id === worksState.activeId) ?? worksState.works[0];
  const blankBootstrap = (activeWorkSummary?.starter === 'blank' || activeWorkSummary?.starter === 'free-web') && !state.candidates.some(item => item.decision === 'adopted');

  const modelStatusTooltip = modelStatus
    ? [
        `编码模型：${modelStatus.coding.mode === 'real' ? `${modelStatus.coding.model} (${modelStatus.coding.providerHost})` : modelStatus.coding.mode === 'mock' ? '本地模拟' : '未配置'}`,
        `语音识别：${modelStatus.speech.mode === 'real' ? `百炼 ${modelStatus.speech.model}` : modelStatus.speech.mode === 'mock' ? '本地模拟' : '未配置'}`,
        `3D 生成：${modelStatus.lux3d.mode === 'real' ? `Lux3D (${modelStatus.lux3d.gateway})` : modelStatus.lux3d.mode === 'mock' ? '本地模拟' : '未配置'}`,
      ].join(' · ')
    : '';

  const mainFrame = <iframe key={`${worksState.activeId}:${previewRevision}`} ref={preview} src={previewUrl('/preview/main/')} title={`${activeWorkSummary?.name ?? '空间作品'}预览`} data-testid="preview-frame" onLoad={() => {
    exitImpact(false);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
  }}/>;
  const workName = activeWorkSummary?.name ?? '空间作品';
  const candidateFrame = candidate ? <iframe key={candidate.id} ref={candidatePreview} src={previewUrl(candidate.previewUrl)} title={`候选版本 ${candidate.id.slice(0, 8)}`} data-testid="candidate-frame" data-ready={candidateReady}/> : null;

  return (
    <main className="studio">
      {modalTab && <NewWorkModal initialTab={modalTab} onClose={() => setModalTab(null)} onCreated={result => void handleWorkCreated(result)}/>}
      {showModelConfig && <ModelConfigModal onClose={() => setShowModelConfig(false)} onSaved={nextStatus => setModelStatus(nextStatus)}/>}
      {showAssets && <Suspense fallback={<p className="floating-status" role="status">加载 3D 视口…</p>}><AssetPanel dragging={draggingPlacement} onClose={() => setShowAssets(false)} onPreparePlace={preparePlacement} onPlace={beginAssetPlacement}/></Suspense>}
      {placingAsset&&<AssetPlacement key={`${placingAsset.id}:${placementGeneration}`} asset={placingAsset} initialSession={initialPlacement} dragging={draggingPlacement} onDragStateChange={setDraggingPlacement} onTargetSelected={()=>{setDraggingPlacement(false);setShowAssets(false);}} onConfirmed={outcome=>{if(outcome.kind==='insert'&&outcome.candidateId){setCandidateId(outcome.candidateId);setMode('candidate');}}} frame={ready?preview.current:null} onClose={()=>{setDraggingPlacement(false);for(const key of placementSessions.current.keys())if(key.startsWith(placingAsset.id+':'))placementSessions.current.delete(key);setPlacingAsset(undefined);}}/>}
      <header className="studio-top">
        <div className="island brand-island">
          <span className="wordmark" aria-hidden="true">F</span>
          <h1>Forma 空间工作台</h1>
        </div>
        {import.meta.env.VITE_DEMO_MODE==='mock'&&<p className="demo-banner" data-testid="demo-mode" role="status">离线模拟演示：语音为固定示例转写，编码与生成上游为模拟；不代表真实语音识别或现场模型生成。</p>}
        {import.meta.env.VITE_DEMO_MODE==='real'&&<p className="demo-banner is-real" data-testid="demo-mode" role="status">真实服务模式：已接入真实编码模型与云端服务，提交生成或语音识别可能产生对应平台计费。</p>}
        <div className="island status-island status-cluster">
          <span className={`status-pill ${ready ? 'is-ok' : 'is-wait'}`} data-testid="preview-status">{ready ? '预览已连接' : '等待预览连接'}</span>
          <span className={`status-pill ${eventStatus === 'connected' ? 'is-ok' : 'is-wait'}`} data-testid="events-status" data-status={eventStatus}>{eventStatus === 'connected' ? '事件已连接' : eventStatus === 'reconnecting' ? '事件重连中' : '事件连接中'} · <output data-testid="events-seq">{lastSeq}</output></span>
          {modelStatus && (
            <span
              className={`status-pill ${modelStatus.coding.mode === 'real' ? 'is-ok' : 'is-wait'}`}
              data-testid="model-status"
              data-mode={modelStatus.coding.mode}
              title={`${modelStatusTooltip}（点击配置或切换大模型）`}
              style={{ cursor: 'pointer' }}
              onClick={() => setShowModelConfig(true)}
            >
              {modelStatus.coding.mode === 'real'
                ? `真实模型 · ${modelStatus.coding.model}`
                : modelStatus.coding.mode === 'mock'
                  ? '模拟编码模型'
                  : '未配置编码模型'}
            </span>
          )}
          {!syncReady && <span className="status-pill is-wait" role="status">状态待同步</span>}
          {syncError && <span className="status-pill is-error" role="alert">{syncError}</span>}
          <button type="button" className="ghost-btn compact-btn" data-testid="model-config-open" onClick={() => setShowModelConfig(true)}>接入模型</button>
          <button type="button" className="ghost-btn compact-btn" data-testid="state-refresh" onClick={() => void reload().catch(() => {})}>刷新状态</button>
        </div>
      </header>
      <div className={`workspace${showScene ? ' scene-editing' : ''}${inspectorOpen ? '' : ' inspector-collapsed'}`}>
        <section className="preview-panel" aria-label="作品预览">
          <CandidatePanel
            selectedId={candidate?.id ?? ''}
            onSelect={setCandidateId}
            mode={mode}
            onMode={setMode}
            headerMeta={<>
              <div className="work-switcher-group">
                <select
                  aria-label="切换当前作品"
                  data-testid="work-switcher"
                  disabled={switchingWork || !syncReady}
                  value={worksState.activeId}
                  onChange={event => void selectWork(event.target.value)}
                >
                  {worksState.works.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.starter === 'blank'
                        ? ' · 3D 画布'
                        : item.starter === 'free-web'
                          ? ' · 自由网页'
                          : item.starter === 'imported'
                            ? ' · 已导入网页'
                            : ''}
                    </option>
                  ))}
                </select>
                <button type="button" className="secondary-btn compact-btn" data-testid="work-new-open" disabled={switchingWork || !syncReady} onClick={() => setModalTab('create')}>+ 新建网页</button>
                <button type="button" className="ghost-btn compact-btn" data-testid="work-import-open" disabled={switchingWork || !syncReady} onClick={() => setModalTab('import')}>⤓ 导入网页</button>
              </div>
              <ModelOriginBadge/>
            </>}
            detailsTarget={candidateSlot}
          >
            <figure className="artboard artboard-main">
              <figcaption className="artboard-name"><b>{workName}</b><span>当前版本</span></figcaption>
              {mainFrame}
            </figure>
            {mode !== 'current' && candidate && <figure className="artboard artboard-candidate">
              <figcaption className="artboard-name"><b>候选 {candidate.id.slice(0, 8)}</b><span>{mode === 'compare' ? '并排对比' : '候选预览'}</span></figcaption>
              {candidateFrame}
            </figure>}
          </CandidatePanel>
        </section>
        <aside className="inspector">
          {showScene && <Suspense fallback={<p className="hint">加载场景编辑器…</p>}><SceneEditor at={progress} previewSize={previewSize} onClose={() => setShowScene(false)}/></Suspense>}
          <div className="candidate-slot" ref={setCandidateSlot}/>
          <div className="inspector-main" hidden={showScene}>
            <div ref={targetCard} className={`target-card${selection ? ' has-selection' : ''}${picking ? ' is-picking' : ''}`}>
              <div className="target-card-header">
                <span className="section-label">TARGET</span>
                <button type="button" className="inline-link-btn" onClick={toggle}>{picking ? '完成选取' : selection ? '重选元素' : '点选页面元素'}</button>
              </div>
              {error && <p className="error" role="alert">{error}</p>}
              {selection ? <>
                <div className="selection-summary">
                  <strong>{selection.cid}</strong>
                  <code>{selection.src}</code>
                </div>
                <div className="selection-badges">
                  {selection.note && <span className="meta-tag">外层容器</span>}
                  <span className="meta-tag" data-testid="instances">同源码实例：{selection.instances} 处{selection.instances > 1 ? '（共享组件/列表，修改将同步生效）' : ''}</span>
                </div>
                <pre className="selection-raw" data-testid="selection-json">{JSON.stringify(selection, null, 2)}</pre>
              </> : <p className="target-empty">{picking ? '请在左侧网页中点击要修改的标题、按钮或区块…' : '当前作用于整页 · 开启选取可精准锁定局部元素'}</p>}
            </div>
            <PointSpeak pick={pick} blocked={!!impact || showScene} blankBootstrap={blankBootstrap} starterKind={activeWorkSummary?.starter}/>
          </div>
          <ApprovalPanel highlightId={impact?.id ?? null} onHighlight={highlight} onExit={() => exitImpact()}/>
        </aside>
      </div>
      <SelectionLink
        frame={preview}
        target={targetCard}
        bbox={selection?.bbox ?? null}
        visible={!!selection && ready && !picking && mode === 'current' && !showScene && !impact && !showAssets && !placingAsset && inspectorOpen && pickedAt === progress}
      />
      <nav className="island dock tools" role="toolbar" aria-label="工具">
        <button type="button" className={`tool-btn${picking ? ' is-active' : ''}`} aria-pressed={picking} data-testid="pick-toggle" onClick={toggle}>{picking ? '退出选取' : '开启选取'}</button>
        <button type="button" className={`tool-btn${showAssets ? ' is-active' : ''}`} data-testid="asset-open" onClick={() => setShowAssets(true)}>3D 资产</button>
        <button type="button" className={`tool-btn${showScene ? ' is-active' : ''}`} data-testid="scene-open" onClick={() => { exitImpact(false); setMode('current'); pickingRef.current = false; setPicking(false); send({ type: 'pick:stop' }); setInspectorOpen(true); setShowScene(true); }}>3D 场景编辑</button>
        <span className="dock-sep" aria-hidden="true"/>
        <button type="button" className={`tool-btn${inspectorOpen ? '' : ' is-active'}`} aria-pressed={!inspectorOpen} data-testid="inspector-toggle" onClick={() => setInspectorOpen(value => !value)}>
          {inspectorOpen ? '收起面板' : `展开面板${pending.length > 0 ? ` · ${pending.length} 待定` : ''}`}
        </button>
        <span className="dock-sep" aria-hidden="true"/>
        <span className="viewport-mode-pill">{impact ? '影响定位' : picking ? '选取中 · 点击页面元素' : '浏览'} · {Math.round(progress * 100)}%</span>
      </nav>
    </main>
  );
}

export default function App() {
  return <EventCenterProvider><Studio/></EventCenterProvider>;
}
