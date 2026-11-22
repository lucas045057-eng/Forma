import { lazy, Suspense, useEffect, useReducer, useRef, useState } from 'react';
import type { Asset } from '@spatial/shared';
import { reduceStudioSurface, surfaceFlags } from './surface-state.ts';
import ApprovalPanel from './ApprovalPanel.tsx';
import { waiting } from './approval-state.ts';
import { EventCenterProvider, useEventCenter } from './EventCenter.tsx';
import PointSpeak from './PointSpeak.tsx';
import CandidatePanel, { type PreviewMode } from './CandidatePanel.tsx';
import { previewUrl } from './preview-origin.ts';
import ModelOriginBadge from './model-provenance.tsx';
import SelectionLink from './SelectionLink.tsx';
import NewWorkModal, { type ModalTab } from './NewWorkModal.tsx';
import ModelConfigModal from './ModelConfigModal.tsx';
import type { PlacementSession } from './placement-state.ts';
import { luxApi } from './lux3d-api.ts';
import { usePreviewBridge } from './use-preview-bridge.ts';
import { useStudioWorks } from './use-studio-works.ts';

const AssetPanel = lazy(() => import('./AssetPanel'));
const SceneEditor = lazy(() => import('./SceneEditor'));
const AssetPlacement = lazy(() => import('./AssetPlacement'));

function Studio() {
  const { state, status: eventStatus, lastSeq, syncReady, syncError, reload, subscribe } = useEventCenter();
  const [surface, dispatchSurface] = useReducer(reduceStudioSurface, 'canvas');
  const { showAssets, showScene, inspectorOpen } = surfaceFlags(surface);

  const [modalTab, setModalTab] = useState<ModalTab | null>(null);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<PreviewMode>('current');
  const [candidateId, setCandidateId] = useState('');
  const [placingAsset, setPlacingAsset] = useState<Asset>();
  const [initialPlacement, setInitialPlacement] = useState<PlacementSession>();
  const [placementGeneration, setPlacementGeneration] = useState(0);
  const [draggingPlacement, setDraggingPlacement] = useState(false);
  const placementSessions = useRef(new Map<string, Promise<PlacementSession>>());

  const [candidateSlot, setCandidateSlot] = useState<HTMLDivElement | null>(null);
  const [topLeftSlot, setTopLeftSlot] = useState<HTMLDivElement | null>(null);
  const [topCenterSlot, setTopCenterSlot] = useState<HTMLDivElement | null>(null);
  const targetCard = useRef<HTMLDivElement>(null);

  const pending = state.candidates.filter(candidate => candidate.decision === 'pending');
  const candidate = pending.find(item => item.id === candidateId) ?? pending[0];

  const bridge = usePreviewBridge({
    state,
    syncReady,
    showScene,
    mode,
    activeCandidateId: candidate?.id,
    onSetMode: setMode,
    onDispatchSurface: dispatchSurface,
    onError: setError,
  });

  const works = useStudioWorks({
    tasks: state.tasks,
    candidates: state.candidates,
    subscribe,
    reload,
    onBeforeWorkChange: () => {
      bridge.resetForWorkChange();
      setPlacingAsset(undefined);
    },
    onWorkChangedSurface: () => dispatchSurface({ type: 'work-switched' }),
    onWorkCreatedSurface: openInspector => {
      setModalTab(null);
      dispatchSurface({ type: 'work-created', openInspector });
    },
    onAutoOpenCandidate: id => {
      setCandidateId(id);
      setMode('candidate');
    },
    onError: setError,
    onResetReady: () => bridge.setReady(false),
    onSetModeCurrent: () => setMode('current'),
  });

  useEffect(() => {
    if (!candidate) { setCandidateId(''); if (mode !== 'current') setMode('current'); }
    else if (!pending.some(item => item.id === candidateId)) setCandidateId(candidate.id);
  }, [candidate, candidateId, mode, pending]);

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

  const pendingApprovalsCount = state.approvals.filter(waiting).length;
  const previousPendingApprovals = useRef(0);
  useEffect(() => {
    if (previousPendingApprovals.current === 0 && pendingApprovalsCount > 0) {
      dispatchSurface({ type: 'approval-arrived' });
    }
    previousPendingApprovals.current = pendingApprovalsCount;
  }, [pendingApprovalsCount]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dispatchSurface({ type: 'escape', blocked: Boolean(modalTab || showModelConfig || placingAsset) });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalTab, showModelConfig, placingAsset]);

  async function preparePlacement(asset: Asset): Promise<PlacementSession> {
    void import('./AssetPlacement');
    if (!bridge.ready || !syncReady || eventStatus !== 'connected' || !state.version) throw new Error('请等待主预览和作品状态同步后放置');
    const key = asset.id + ':' + state.version;
    const request = () => {
      const guarded = luxApi.placementSession(asset.id, state.version).catch(err => {
        if (placementSessions.current.get(key) === guarded) placementSessions.current.delete(key);
        throw err;
      });
      return guarded;
    };
    let pendingSession = placementSessions.current.get(key);
    if (!pendingSession) { pendingSession = request(); placementSessions.current.set(key, pendingSession); }
    const session = await pendingSession;
    if (session.expiresAt > Date.now()) return session;
    // Drop only the stale promise so concurrent preparations reuse any newly installed session request.
    if (placementSessions.current.get(key) === pendingSession) placementSessions.current.delete(key);
    let refreshed = placementSessions.current.get(key);
    if (!refreshed) { refreshed = request(); placementSessions.current.set(key, refreshed); }
    const next = await refreshed;
    if (next.expiresAt > Date.now()) return next;
    if (placementSessions.current.get(key) === refreshed) placementSessions.current.delete(key);
    throw new Error('放置会话已过期，请重新准备');
  }

  function closeInspector() { dispatchSurface({ type: 'close' }); }

  function toggleAssets() {
    if (!showAssets) {
      bridge.exitImpact(false);
      bridge.stopPicking();
      setPlacingAsset(undefined);
    }
    dispatchSurface({ type: 'toggle-assets' });
  }

  function toggleScene() {
    if (!showScene) {
      bridge.exitImpact(false);
      bridge.stopPicking();
      setMode('current');
      setPlacingAsset(undefined);
    }
    dispatchSurface({ type: 'toggle-scene' });
  }

  function beginAssetPlacement(asset: Asset, session?: PlacementSession, fromDrag = false) {
    bridge.exitImpact(false);
    bridge.stopPicking();
    setMode('current');
    dispatchSurface({ type: 'placement-started', fromDrag });
    if (session) bridge.send({ type: 'placement:start', payload: session });
    setInitialPlacement(session);
    if (!placingAsset || placingAsset.id !== asset.id || !session) setPlacementGeneration(value => value + 1);
    setPlacingAsset(asset);
    if (fromDrag) requestAnimationFrame(() => setDraggingPlacement(true));
    else setDraggingPlacement(false);
  }

  const workName = works.activeWorkSummary?.name ?? '空间作品';
  const mainFrame = (
    <iframe
      key={`${works.worksState.activeId}:${works.previewRevision}`}
      ref={bridge.preview}
      src={previewUrl('/preview/main/')}
      title={`${workName}预览`}
      data-testid="preview-frame"
      onLoad={bridge.handleMainFrameLoad}
    />
  );
  const candidateFrame = candidate ? (
    <iframe
      key={candidate.id}
      ref={bridge.candidatePreview}
      src={previewUrl(candidate.previewUrl)}
      title={`候选版本 ${candidate.id.slice(0, 8)}`}
      data-testid="candidate-frame"
      data-ready={bridge.candidateReady}
    />
  ) : null;

  return (
    <main className="studio">
      {modalTab && <NewWorkModal initialTab={modalTab} onClose={() => setModalTab(null)} onCreated={result => void works.handleWorkCreated(result)}/>}
      {showModelConfig && <ModelConfigModal onClose={() => setShowModelConfig(false)} onSaved={nextStatus => works.setModelStatus(nextStatus)}/>}
      {showAssets && <Suspense fallback={<p className="floating-status" role="status">加载 3D 视口…</p>}><AssetPanel dragging={draggingPlacement} onClose={closeInspector} onPreparePlace={preparePlacement} onPlace={beginAssetPlacement}/></Suspense>}
      {placingAsset && <Suspense fallback={<p className="floating-status" role="status">加载 3D 放置预览…</p>}><AssetPlacement key={`${placingAsset.id}:${placementGeneration}`} asset={placingAsset} initialSession={initialPlacement} dragging={draggingPlacement} onDragStateChange={setDraggingPlacement} onTargetSelected={() => { setDraggingPlacement(false); closeInspector(); }} onConfirmed={outcome => { if (outcome.kind === 'insert' && outcome.candidateId) { setCandidateId(outcome.candidateId); setMode('candidate'); } }} frame={bridge.ready ? bridge.preview.current : null} onClose={() => { setDraggingPlacement(false); for (const key of placementSessions.current.keys()) if (key.startsWith(placingAsset.id + ':')) placementSessions.current.delete(key); setPlacingAsset(undefined); }}/></Suspense>}
      <header className="studio-top">
        <div className="island brand-island">
          <span className="wordmark" aria-hidden="true">F</span>
          <h1 title="Forma 空间工作台">Forma</h1>
          <span className="island-sep" aria-hidden="true"/>
          <div className="work-switcher-group">
            <select aria-label="切换当前作品" data-testid="work-switcher" disabled={works.switchingWork || !syncReady} value={works.worksState.activeId} onChange={event => void works.selectWork(event.target.value)}>
              {works.worksState.works.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.starter === 'blank' ? ' · 3D 画布' : item.starter === 'free-web' ? ' · 自由网页' : item.starter === 'imported' ? ' · 已导入网页' : ''}
                </option>
              ))}
            </select>
            <button type="button" className="secondary-btn compact-btn" data-testid="work-new-open" title="新建网页作品" disabled={works.switchingWork || !syncReady} onClick={() => setModalTab('create')}>+ 新建</button>
            <button type="button" className="ghost-btn compact-btn" data-testid="work-import-open" title="导入已有网页" disabled={works.switchingWork || !syncReady} onClick={() => setModalTab('import')}>⤓ 导入</button>
          </div>
          <div className="top-slot" ref={setTopLeftSlot}/>
        </div>
        <div className="top-center-wrap">
          <div className="top-center-slot" ref={setTopCenterSlot}/>
          {import.meta.env.VITE_DEMO_MODE === 'mock' && <p className="demo-banner" data-testid="demo-mode" role="status">离线模拟演示</p>}
          {import.meta.env.VITE_DEMO_MODE === 'real' && <p className="demo-banner is-real" data-testid="demo-mode" role="status">真实服务模式</p>}
        </div>
        <div className="island status-island status-cluster">
          <span className={`status-pill ${bridge.ready ? 'is-ok' : 'is-wait'}`} data-testid="preview-status">{bridge.ready ? '预览已连接' : '等待预览'}</span>
          <span className={`status-pill ${eventStatus === 'connected' ? 'is-ok' : 'is-wait'}`} data-testid="events-status" data-status={eventStatus} title={eventStatus === 'connected' ? '事件流已连接' : eventStatus === 'reconnecting' ? '事件重连中' : '事件连接中'}>事件 · <output data-testid="events-seq">{lastSeq}</output></span>
          {works.modelStatus && (
            <span
              className={`status-pill model-status-pill ${works.modelStatus.coding.mode === 'real' ? 'is-ok' : 'is-wait'}`}
              data-testid="model-status"
              data-mode={works.modelStatus.coding.mode}
              title={`${works.modelStatusTooltip}（点击配置或切换大模型）`}
              onClick={() => setShowModelConfig(true)}
            >
              {works.modelStatus.coding.mode === 'real' ? works.modelStatus.coding.model : works.modelStatus.coding.mode === 'mock' ? '模拟模型' : '未配置模型'}
            </span>
          )}
          {!syncReady && <span className="status-pill is-wait" role="status">待同步</span>}
          {syncError && <span className="status-pill is-error" role="alert">{syncError}</span>}
          <span className="island-sep" aria-hidden="true"/>
          <button type="button" className="ghost-btn compact-btn" data-testid="model-config-open" onClick={() => setShowModelConfig(true)}>接入模型</button>
          <button type="button" className="ghost-btn compact-btn" data-testid="state-refresh" title="刷新状态" onClick={() => void reload().catch(() => {})}>刷新</button>
          {pendingApprovalsCount > 0 && (
            <button type="button" className="approval-alert-pill" onClick={() => dispatchSurface({ type: 'open-inspector' })}>
              越界请示 · {pendingApprovalsCount}
            </button>
          )}
          <button type="button" className={`${inspectorOpen && !showScene ? 'ghost-btn' : 'secondary-btn'} compact-btn`} onClick={() => dispatchSurface({ type: 'toggle-inspector' })}>
            {inspectorOpen && !showScene ? '收起抽屉' : pending.length > 0 ? '检查与 Diff' : '改写面板'}
          </button>
        </div>
      </header>
      <div className={`workspace${showScene ? ' scene-editing' : ''}${inspectorOpen ? '' : ' inspector-collapsed'}`}>
        <section className="preview-panel" aria-label="作品预览">
          <CandidatePanel selectedId={candidate?.id ?? ''} onSelect={setCandidateId} mode={mode} onMode={setMode} topLeftTarget={topLeftSlot} topCenterTarget={topCenterSlot} detailsTarget={candidateSlot}>
            <figure className="artboard artboard-main">
              <figcaption className="artboard-name">
                <b>{workName}</b>
                <span>当前版本</span>
                <span className="artboard-name-spacer" aria-hidden="true"/>
                <ModelOriginBadge/>
              </figcaption>
              {mainFrame}
            </figure>
            {mode !== 'current' && candidate && <figure className="artboard artboard-candidate">
              <figcaption className="artboard-name"><b>候选 {candidate.id.slice(0, 8)}</b><span>{mode === 'compare' ? '并排对比' : '候选预览'}</span></figcaption>
              {candidateFrame}
            </figure>}
          </CandidatePanel>
        </section>
        <aside className="inspector" aria-label="画室工具抽屉">
          <div className="inspector-head">
            <div className="inspector-head-title">
              <span className="section-label">ATELIER SHEET</span>
              <h2>{showScene ? '3D 场景调节' : pending.length > 0 ? '检查与改写' : '点选与改写'}</h2>
            </div>
            <button type="button" className="ghost-btn compact-btn" data-testid="inspector-close" onClick={closeInspector}>收起</button>
          </div>
          {showScene && <Suspense fallback={<p className="hint">加载场景编辑器…</p>}><SceneEditor at={bridge.progress} previewSize={bridge.previewSize} onClose={closeInspector}/></Suspense>}
          <div className="candidate-slot" ref={setCandidateSlot}/>
          <div className="inspector-main" hidden={showScene}>
            <div ref={targetCard} className={`target-card${bridge.selection ? ' has-selection' : ''}${bridge.picking ? ' is-picking' : ''}`}>
              <div className="target-card-header">
                <span className="section-label">TARGET</span>
                <button type="button" className="inline-link-btn" onClick={bridge.togglePicking}>{bridge.picking ? '完成选取' : bridge.selection ? '重选元素' : '点选页面元素'}</button>
              </div>
              {error && <p className="error" role="alert">{error}</p>}
              {bridge.selection ? <>
                <div className="selection-summary">
                  <strong>{bridge.selection.cid}</strong>
                  <code>{bridge.selection.src}</code>
                </div>
                <div className="selection-badges">
                  {bridge.selection.note && <span className="meta-tag">外层容器</span>}
                  <span className="meta-tag" data-testid="instances">同源码实例：{bridge.selection.instances} 处{bridge.selection.instances > 1 ? '（共享组件/列表，修改将同步生效）' : ''}</span>
                </div>
                <pre className="selection-raw" data-testid="selection-json">{JSON.stringify(bridge.selection, null, 2)}</pre>
              </> : <p className="target-empty">{bridge.picking ? '请在左侧网页中点击要修改的标题、按钮或区块…' : '当前作用于整页 · 开启选取可精准锁定局部元素'}</p>}
            </div>
            <PointSpeak pick={bridge.pick} blocked={!!bridge.impact || showScene} blankBootstrap={works.blankBootstrap} starterKind={works.activeWorkSummary?.starter}/>
          </div>
          <ApprovalPanel highlightId={bridge.impact?.id ?? null} onHighlight={bridge.highlight} onExit={() => bridge.exitImpact()}/>
        </aside>
      </div>
      <SelectionLink
        frame={bridge.preview}
        target={targetCard}
        bbox={bridge.selection?.bbox ?? null}
        visible={!!bridge.selection && bridge.ready && !bridge.picking && mode === 'current' && !showScene && !bridge.impact && !showAssets && !placingAsset && inspectorOpen && bridge.pickedAt === bridge.progress}
      />
      <nav className="island dock tools" role="toolbar" aria-label="工具">
        <button type="button" className={`tool-btn${bridge.picking ? ' is-active' : ''}`} aria-pressed={bridge.picking} data-testid="pick-toggle" onClick={bridge.togglePicking}>{bridge.picking ? '退出选取' : '开启选取'}</button>
        <button type="button" className={`tool-btn${showAssets ? ' is-active' : ''}`} aria-pressed={showAssets} data-testid="asset-open" onClick={toggleAssets}>3D 资产</button>
        <button type="button" className={`tool-btn${showScene ? ' is-active' : ''}`} aria-pressed={showScene} data-testid="scene-open" onClick={toggleScene}>3D 场景编辑</button>
        <span className="dock-sep" aria-hidden="true"/>
        <button
          type="button"
          className={`tool-btn ${inspectorOpen && !showScene ? 'is-active' : 'tool-btn-accent'}`}
          aria-pressed={inspectorOpen && !showScene}
          data-testid="inspector-toggle"
          onClick={() => dispatchSurface({ type: 'toggle-inspector' })}
        >
          {inspectorOpen && !showScene ? '收起面板' : pending.length > 0 ? `✦ 检查与 Diff · ${pending.length}` : '✦ 改写与检查'}
        </button>
        <span className="dock-sep" aria-hidden="true"/>
        <span className="viewport-mode-pill">{bridge.impact ? '影响定位' : bridge.picking ? '选取中 · 点击页面元素' : '浏览'} · {Math.round(bridge.progress * 100)}%</span>
      </nav>
    </main>
  );
}

export default function App() {
  return <EventCenterProvider><Studio/></EventCenterProvider>;
}
