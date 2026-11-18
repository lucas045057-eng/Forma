import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Sphere, Vector3 } from 'three';
import type { Asset } from '@spatial/shared';
import { defaultSceneConfig, isSceneConfig, type SceneConfig, type Vec3 } from '@spatial/shared/scene-config';
import { setSceneHero, setSceneKeyframe, temperatureToHex, type SceneChanged } from '@spatial/shared/scene-edit';
import { ProductScene, scenePose, sceneRenderSettings } from '@spatial/scene-renderer';
import './scene-editor.css';
import { useEventCenter } from './EventCenter.tsx';
import { previewOrigin } from './preview-origin.ts';
import { SceneDraftGuard } from './scene-draft.ts';
import {assetOriginLabel} from './model-provenance.tsx';

function LightHandle({ direction, change }: { direction: Vec3; change: (direction: Vec3) => void }) {
  const dragging = useRef(false);
  const { controls } = useThree();
  const orbit = controls as unknown as { enabled: boolean } | null;
  const center = new Vector3(0, 0.5, 0), radius = 0.65;
  const position = new Vector3(...direction).normalize().multiplyScalar(radius).add(center);
  function stop() { dragging.current = false; if (orbit) orbit.enabled = true; }
  useEffect(() => stop, [orbit]);
  function move(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current) return;
    event.stopPropagation();
    const point = event.ray.intersectSphere(new Sphere(center, radius), new Vector3());
    if (point) change(point.sub(center).normalize().multiplyScalar(5).toArray() as Vec3);
  }
  return <mesh position={position} onPointerDown={event => {
    event.stopPropagation(); dragging.current = true; if (orbit) orbit.enabled = false;
    (event.target as unknown as Element).setPointerCapture(event.pointerId);
  }} onPointerMove={move} onPointerUp={event => { event.stopPropagation(); (event.target as unknown as Element).releasePointerCapture(event.pointerId); stop(); }}>
    <sphereGeometry args={[0.045, 16, 12]}/><meshBasicMaterial color="#ffdd77"/>
  </mesh>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error?.message ?? '场景请求失败'}${result.error?.fields ? `：${JSON.stringify(result.error.fields)}` : ''}`);
  return result as T;
}
const jsonRequest = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

export default function SceneEditor({ at, previewSize, onClose }: { at: number; previewSize: () => number; onClose: () => void }) {
  const [saved, setSaved] = useState<SceneConfig>();
  const [draft, setDraft] = useState(defaultSceneConfig.hero);
  const [rotation, setRotation] = useState<Vec3>([0, 0, 0]);
  const [lid, setLid] = useState(0);
  const [recognized, setRecognized] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [force, setForce] = useState(false);
  const [latest, setLatest] = useState<SceneChanged>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [compare, setCompare] = useState(false);
  const [tool, setTool] = useState<'camera' | 'rotate' | 'light'>('camera');
  const [temperature, setTemperature] = useState(4000);
  const [size, setSize] = useState(400);
  const canvasScroll=useRef<HTMLDivElement>(null);
  const [canvasOverflow,setCanvasOverflow]=useState(false);
  useEffect(()=>{
    const root=canvasScroll.current;if(!root)return;
    const measure=()=>{const viewport=root.querySelector<HTMLElement>('[data-testid="scene-viewport"]');if(!viewport){setCanvasOverflow(false);return;}const canvas=viewport.getBoundingClientRect(),bounds=root.getBoundingClientRect();setCanvasOverflow(canvas.width>bounds.width+0.5||canvas.left<bounds.left-0.5||canvas.right>bounds.right+0.5||root.scrollWidth>root.clientWidth+1);};
    const observer=new ResizeObserver(measure);observer.observe(root);root.addEventListener('scroll',measure,{passive:true});measure();return()=>{observer.disconnect();root.removeEventListener('scroll',measure);};
  },[size,compare]);
  const { subscribe, syncReady, status, acquire, awaiting, locked, reload } = useEventCenter();
  const writeBlocked = !syncReady || status !== 'connected' || locked(['work']);
  const currentAt = useRef(at); currentAt.current = at;
  const draftGuard = useRef(new SceneDraftGuard());
  const mounted = useRef(true);

  function applyConfig(config: SceneConfig) {
    const pose = scenePose(config, currentAt.current);
    setSaved(config); setDraft(structuredClone(config.hero)); setRotation(pose.rotation); setLid(pose.parts.lid?.[1] ?? 0);
    draftGuard.current.saved();
  }
  async function load(explicit = false) {
    const sequence = draftGuard.current.beginLoad(explicit);
    if (sequence === null) return;
    try {
      const config = await request<SceneConfig>('/scene');
      if (!isSceneConfig(config)) throw new Error('服务返回的场景配置无效');
      if (mounted.current && draftGuard.current.canApply(sequence)) { applyConfig(config); setError(''); }
    } catch (cause) { if (mounted.current && draftGuard.current.canApply(sequence)) setError(String(cause)); }
  }
  useEffect(() => {
    mounted.current = true;
    const loadAssets = () => request<Asset[]>('/assets').then(list => { if (mounted.current) setAssets(list); }).catch(cause => { if (mounted.current) setError(String(cause)); });
    void load();
    void loadAssets();
    const unsubscribe = subscribe(event => {
      if (event.type === 'asset.ready') void loadAssets();
      if (event.type === 'state.reload') { void load(); void loadAssets(); }
      if (event.type === 'scene.changed' && isSceneConfig(event.config) && Array.isArray(event.diff)) {
        setLatest(event as unknown as SceneChanged);
        if (!draftGuard.current.dirty) { draftGuard.current.invalidate(); applyConfig(event.config); }
      }
    });
    return () => { mounted.current = false; draftGuard.current.invalidate(); unsubscribe(); };
  }, [subscribe]);
  useEffect(() => {
    if (!saved || draftGuard.current.dirty) return;
    const pose = scenePose(saved, at);
    setRotation(pose.rotation); setLid(pose.parts.lid?.[1] ?? 0);
  }, [at]);
  useEffect(() => {
    let active = true; setRecognized(false); setLoaded(false);
    if (saved?.model) {
      const metadata = saved.model === '/assets/diffuser-4969889.glb' ? '/assets/parts.json' : saved.model.replace(/\.glb$/, '.parts.json');
      void fetch(`${previewOrigin}/preview/main${metadata}`).then(response => response.ok ? response.json() : null)
        .then(value => { if (active) setRecognized(value?.recognized === true && value?.lid === 'lid'); }).catch(() => {});
    }
    return () => { active = false; };
  }, [saved?.model]);

  function editHero(update: (hero: SceneConfig['hero']) => SceneConfig['hero']) { draftGuard.current.edit(); setCompare(false); setDraft(update); }
  function editRotation(value: Vec3) { draftGuard.current.edit(); setCompare(false); setRotation(value); }
  const config = useMemo<SceneConfig>(() => {
    if (compare && saved) return saved;
    return { model: saved?.model ?? '', hero: { ...draft, model: { ...draft.model, rotation } }, scroll: [{ at: 0, parts: recognized ? { lid: { offset: [0, lid, 0] } } : {} }] };
  }, [saved, draft, rotation, lid, recognized, compare]);
  async function action(work: () => Promise<SceneChanged>) {
    if (busy || writeBlocked) return;
    const token = acquire(['work']);
    if (!token) return;
    setBusy(true); setError(''); draftGuard.current.invalidate();
    let succeeded = false;
    try {
      const result = await work();
      succeeded = true;
      if (mounted.current) { applyConfig(result.config); setLatest(result); }
    }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    awaiting(token);
    try { await reload(); }
    catch { if (mounted.current) setError(succeeded ? '操作已提交，状态刷新失败，请刷新状态' : '无法确认服务器状态，请刷新后继续'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const modelUrl = saved?.model ? `${previewOrigin}/preview/main${saved.model}` : '';
  return <section className="scene-editor" data-testid="scene-panel">
    <header className="scene-header">
      <div>
        <span className="section-label">SCENE DIRECTOR</span>
        <h2>3D 场景编辑</h2>
      </div>
      <div className="scene-header-meta">
        <span className="meta-tag">滚动 <output data-testid="scene-scroll-at">{at.toFixed(3)}</output></span>
        <button type="button" className="ghost-btn compact-btn" data-testid="scene-close" onClick={onClose}>关闭</button>
      </div>
    </header>
    {writeBlocked && <p className="muted-note" role="status">状态待同步或作品操作待确认，请刷新状态后继续。</p>}
    <div className="scene-canvas-scroll" ref={canvasScroll} tabIndex={0} role="region" aria-label="场景画布，可横向滚动">
    <div className="scene-viewport" style={{ width: compare ? size : '100%', aspectRatio: sceneRenderSettings.aspectRatio }} data-testid="scene-viewport" data-loaded={loaded}>
      {saved && <ProductScene config={config} modelUrl={modelUrl} scrollAt={compare ? at : 0} controls={!compare && !busy && !writeBlocked}
        canvasTestId="scene-canvas" onReady={() => setLoaded(true)} onError={() => { setLoaded(false); setError('3D 模型加载失败'); }}
        fallback={<p>模型尚未就绪</p>}
        onCameraChange={camera => editHero(hero => ({ ...hero, camera }))}
        onRotationChange={!compare && !busy && !writeBlocked && tool === 'rotate' ? editRotation : undefined}>
        {!compare && !busy && !writeBlocked && tool === 'light' && <LightHandle direction={draft.lights.key.direction} change={direction => editHero(hero => ({ ...hero, lights: { ...hero.lights, key: { ...hero.lights.key, direction } } }))}/>}
      </ProductScene>}
    </div></div>
    {canvasOverflow&&<p className="notice" data-testid="scene-size-hint" role="status">画布超出可用宽度，请在画布区域横向滚动；尺寸未缩放。</p>}
    <fieldset disabled={!saved || busy || compare || writeBlocked}>
      <legend>相机 · 布光 · 关键帧</legend>
      <label className="slider-row"><span>交互工具</span><select data-testid="scene-tool" value={tool} onChange={e => setTool(e.target.value as typeof tool)}><option value="camera">相机轨道</option><option value="rotate">旋转模型</option><option value="light">主光方向手柄</option></select></label>
      <label className="slider-block"><span className="slider-head"><span>模型 Y 旋转</span><code>{rotation[1].toFixed(2)} rad</code></span><input data-testid="scene-rotation-y" type="range" min={-Math.PI} max={Math.PI} step="0.01" value={rotation[1]} onChange={e => editRotation([rotation[0], Number(e.target.value), rotation[2]])}/></label>
      <label className="slider-block"><span className="slider-head"><span>主光强度</span><code>{draft.lights.key.intensity.toFixed(2)}</code></span><input data-testid="scene-key-intensity" type="range" min="0" max="20" step="0.1" value={draft.lights.key.intensity} onChange={e => editHero(h => ({ ...h, lights: { ...h.lights, key: { ...h.lights.key, intensity: Number(e.target.value) } } }))}/></label>
      <label className="slider-block"><span className="slider-head"><span>主光色温</span><code>{temperature} K · {draft.lights.key.color}</code></span><input data-testid="scene-temperature" type="range" min="2700" max="6500" step="50" value={temperature} onChange={e => { const value = Number(e.target.value); setTemperature(value); editHero(h => ({ ...h, lights: { ...h.lights, key: { ...h.lights.key, color: temperatureToHex(value) } } })); }}/></label>
      <label className="slider-block"><span className="slider-head"><span>环境光</span><code>{draft.lights.ambient.toFixed(2)}</code></span><input data-testid="scene-ambient" type="range" min="0" max="20" step="0.1" value={draft.lights.ambient} onChange={e => editHero(h => ({ ...h, lights: { ...h.lights, ambient: Number(e.target.value) } }))}/></label>
      <label className="slider-block"><span className="slider-head"><span>开盖行程</span><code>{lid.toFixed(3)}</code></span><input data-testid="scene-lid" type="range" min="0" max="0.15" step="0.001" value={lid} disabled={!recognized} onChange={e => { draftGuard.current.edit(); setLid(Number(e.target.value)); }}/></label>
      {!recognized && <p className="muted-note" data-testid="scene-parts-warning">未识别部件，开盖关键帧不可用。</p>}
      <div className="scene-action-bar">
        <button type="button" className="primary-btn compact-btn" data-testid="scene-save-hero" onClick={() => saved && void action(() => request('/scene', jsonRequest('PUT', setSceneHero(saved, { ...draft, model: { ...draft.model, rotation } }, recognized ? lid : undefined))))}>设为首屏</button>
        <button type="button" className="secondary-btn compact-btn" data-testid="scene-save-keyframe" onClick={() => saved && void action(() => request('/scene', jsonRequest('PUT', setSceneKeyframe(saved, at, rotation, recognized ? lid : undefined))))}>记为此处关键帧</button>
        <button type="button" className="ghost-btn compact-btn" data-testid="scene-undo" disabled={busy || !saved || writeBlocked} onClick={() => void action(() => request('/scene/undo', jsonRequest('POST')))}>撤回上一次写入</button>
      </div>
    </fieldset>
    <fieldset disabled={busy || !saved || writeBlocked}><legend>快速采用主槽位模型</legend>
      <div className="inline-form">
        <select data-testid="scene-asset-select" value={assetId} onChange={e => { setAssetId(e.target.value); setForce(false); }}><option value="">选择已处理模型…</option>{assets.filter(a => a.status === 'ready').map(a => <option key={a.id} value={a.id}>{a.id.slice(0, 18)} · {assetOriginLabel(a.provenance)}{a.metrics?.webReady === false ? '（超门槛）' : ''}</option>)}</select>
        <button type="button" className="secondary-btn compact-btn" data-testid="scene-adopt" disabled={!assetId} onClick={() => void action(() => request(`/assets/${encodeURIComponent(assetId)}/adopt`, jsonRequest('POST', { force })))}>采用此模型到作品</button>
      </div>
      <label className="checkbox-row"><input type="checkbox" data-testid="scene-force-adopt" checked={force} onChange={e => setForce(e.target.checked)}/>允许采用超过网页门槛的模型</label>
    </fieldset>
    <fieldset disabled={busy}><legend>画布对照与诊断</legend>
      <div className="scene-compare-row">
        <button type="button" className="ghost-btn compact-btn" data-testid="scene-load" onClick={() => { setCompare(false); void load(true); }}>读取作品配置</button>
        <button type="button" className="ghost-btn compact-btn" data-testid="scene-match-size" onClick={() => setSize(previewSize())}>匹配作品画布尺寸</button>
        <label className="inline-number-label">边长 <input data-testid="scene-size" type="number" min="100" max="1600" value={size} onChange={e => setSize(Math.max(100, Math.min(1600, Number(e.target.value) || 400)))}/></label>
      </div>
      <label className="checkbox-row"><input data-testid="scene-compare" type="checkbox" checked={compare} onChange={e => { setCompare(e.target.checked); if (e.target.checked) void load(); }}/>对照模式（已保存配置、同步滚动位置、隐藏手柄）</label>
    </fieldset>
    {error && <p data-testid="scene-error" className="error" role="alert">{error}</p>}
    <div className="scene-diagnostics">
      <span className="section-label">LAST WRITE DIFF</span>
      <pre className="compact-pre" data-testid="scene-diff">{latest ? JSON.stringify(latest.diff, null, 2) : '尚无写入'}</pre>
      <details className="compact-details"><summary>当前视口完整配置 JSON</summary><pre data-testid="scene-config">{JSON.stringify(config, null, 2)}</pre></details>
    </div>
  </section>;
}
