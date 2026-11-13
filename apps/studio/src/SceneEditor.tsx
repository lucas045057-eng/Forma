import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Sphere, Vector3 } from 'three';
import type { Asset } from '@spatial/shared';
import { defaultSceneConfig, isSceneConfig, type SceneConfig, type Vec3 } from '@spatial/shared/scene-config';
import { setSceneHero, setSceneKeyframe, temperatureToHex, type SceneChanged } from '@spatial/shared/scene-edit';
import { ProductScene, scenePose, sceneRenderSettings } from '@spatial/scene-renderer';
import './scene-editor.css';
import { useEventCenter } from './EventCenter.tsx';

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
  const response = await fetch(url, init);
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
  const { subscribe } = useEventCenter();
  const currentAt = useRef(at); currentAt.current = at;
  const loadSequence = useRef(0);
  const dirty = useRef(false);
  const mounted = useRef(true);

  function applyConfig(config: SceneConfig) {
    const pose = scenePose(config, currentAt.current);
    setSaved(config); setDraft(structuredClone(config.hero)); setRotation(pose.rotation); setLid(pose.parts.lid?.[1] ?? 0);
    dirty.current = false;
  }
  async function load() {
    const sequence = ++loadSequence.current;
    try {
      const config = await request<SceneConfig>('/scene');
      if (!isSceneConfig(config)) throw new Error('服务返回的场景配置无效');
      if (mounted.current && sequence === loadSequence.current) { applyConfig(config); setError(''); }
    } catch (cause) { if (mounted.current) setError(String(cause)); }
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
        if (!dirty.current) { ++loadSequence.current; applyConfig(event.config); }
      }
    });
    return () => { mounted.current = false; ++loadSequence.current; unsubscribe(); };
  }, [subscribe]);
  useEffect(() => {
    if (!saved) return;
    const pose = scenePose(saved, at);
    setRotation(pose.rotation); setLid(pose.parts.lid?.[1] ?? 0);
  }, [at]);
  useEffect(() => {
    let active = true; setRecognized(false); setLoaded(false);
    if (saved?.model) {
      const metadata = saved.model === '/assets/diffuser-4969889.glb' ? '/assets/parts.json' : saved.model.replace(/\.glb$/, '.parts.json');
      void fetch(`/preview/main${metadata}`).then(response => response.ok ? response.json() : null)
        .then(value => { if (active) setRecognized(value?.recognized === true && value?.lid === 'lid'); }).catch(() => {});
    }
    return () => { active = false; };
  }, [saved?.model]);

  function editHero(update: (hero: SceneConfig['hero']) => SceneConfig['hero']) { dirty.current = true; setCompare(false); setDraft(update); }
  function editRotation(value: Vec3) { dirty.current = true; setCompare(false); setRotation(value); }
  const config = useMemo<SceneConfig>(() => {
    if (compare && saved) return saved;
    return { model: saved?.model ?? '', hero: { ...draft, model: { ...draft.model, rotation } }, scroll: [{ at: 0, parts: recognized ? { lid: { offset: [0, lid, 0] } } : {} }] };
  }, [saved, draft, rotation, lid, recognized, compare]);
  async function action(work: () => Promise<SceneChanged>) {
    setBusy(true); setError(''); ++loadSequence.current;
    try { const result = await work(); if (mounted.current) { applyConfig(result.config); setLatest(result); } }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const modelUrl = saved?.model ? `/preview/main${saved.model}` : '';
  return <section className="scene-editor" data-testid="scene-panel">
    <header><h2>3D 场景编辑</h2><button data-testid="scene-close" onClick={onClose}>关闭</button></header>
    <p>预览滚动位置 <output data-testid="scene-scroll-at">{at.toFixed(3)}</output></p>
    <div className="scene-viewport" style={{ width: compare ? size : '100%', aspectRatio: sceneRenderSettings.aspectRatio }} data-testid="scene-viewport" data-loaded={loaded}>
      {saved && <ProductScene config={config} modelUrl={modelUrl} scrollAt={compare ? at : 0} controls={!compare}
        canvasTestId="scene-canvas" onReady={() => setLoaded(true)} onError={() => { setLoaded(false); setError('3D 模型加载失败'); }}
        fallback={<p>模型尚未就绪</p>}
        onCameraChange={camera => editHero(hero => ({ ...hero, camera }))}
        onRotationChange={!compare && tool === 'rotate' ? editRotation : undefined}>
        {!compare && tool === 'light' && <LightHandle direction={draft.lights.key.direction} change={direction => editHero(hero => ({ ...hero, lights: { ...hero.lights, key: { ...hero.lights.key, direction } } }))}/>}
      </ProductScene>}
    </div>
    <fieldset disabled={!saved || busy || compare}>
      <legend>调整场景</legend>
      <label>工具 <select data-testid="scene-tool" value={tool} onChange={e => setTool(e.target.value as typeof tool)}><option value="camera">相机轨道</option><option value="rotate">旋转模型</option><option value="light">主光方向手柄</option></select></label>
      <p className="hint">拖动视口调相机；选择旋转显示旋转环；主光工具可拖动黄色球面手柄。</p>
      <label>模型 Y 旋转 <input data-testid="scene-rotation-y" type="range" min={-Math.PI} max={Math.PI} step="0.01" value={rotation[1]} onChange={e => editRotation([rotation[0], Number(e.target.value), rotation[2]])}/></label>
      <label>主光强度 {draft.lights.key.intensity.toFixed(2)}<input data-testid="scene-key-intensity" type="range" min="0" max="20" step="0.1" value={draft.lights.key.intensity} onChange={e => editHero(h => ({ ...h, lights: { ...h.lights, key: { ...h.lights.key, intensity: Number(e.target.value) } } }))}/></label>
      <label>色温 {temperature} K <input data-testid="scene-temperature" type="range" min="2700" max="6500" step="50" value={temperature} onChange={e => { const value = Number(e.target.value); setTemperature(value); editHero(h => ({ ...h, lights: { ...h.lights, key: { ...h.lights.key, color: temperatureToHex(value) } } })); }}/><span>{draft.lights.key.color}</span></label>
      <label>环境光 {draft.lights.ambient.toFixed(2)}<input data-testid="scene-ambient" type="range" min="0" max="20" step="0.1" value={draft.lights.ambient} onChange={e => editHero(h => ({ ...h, lights: { ...h.lights, ambient: Number(e.target.value) } }))}/></label>
      <label>开盖 {lid.toFixed(3)}<input data-testid="scene-lid" type="range" min="0" max="0.15" step="0.001" value={lid} disabled={!recognized} onChange={e => { dirty.current = true; setLid(Number(e.target.value)); }}/></label>
      {!recognized && <p data-testid="scene-parts-warning">未识别部件，开盖关键帧不可用。</p>}
      <button data-testid="scene-save-hero" onClick={() => saved && void action(() => request('/scene', jsonRequest('PUT', setSceneHero(saved, { ...draft, model: { ...draft.model, rotation } }, recognized ? lid : undefined))))}>设为首屏</button>
      <button data-testid="scene-save-keyframe" onClick={() => saved && void action(() => request('/scene', jsonRequest('PUT', setSceneKeyframe(saved, at, rotation, recognized ? lid : undefined))))}>记为此处关键帧</button>
    </fieldset>
    <button data-testid="scene-undo" disabled={busy || !saved} onClick={() => void action(() => request('/scene/undo', jsonRequest('POST')))}>撤回上一次写入</button>
    <fieldset disabled={busy || !saved}><legend>采用模型</legend>
      <select data-testid="scene-asset-select" value={assetId} onChange={e => { setAssetId(e.target.value); setForce(false); }}><option value="">选择已处理模型</option>{assets.filter(a => a.status === 'ready').map(a => <option key={a.id} value={a.id}>{a.id}{a.metrics?.webReady === false ? '（超过网页门槛）' : ''}</option>)}</select>
      <label><input type="checkbox" data-testid="scene-force-adopt" checked={force} onChange={e => setForce(e.target.checked)}/>允许采用超过网页门槛的模型</label>
      <button data-testid="scene-adopt" disabled={!assetId} onClick={() => void action(() => request(`/assets/${encodeURIComponent(assetId)}/adopt`, jsonRequest('POST', { force })))}>采用此模型到作品</button>
    </fieldset>
    <fieldset disabled={busy}><legend>与作品画面对照</legend>
      <button data-testid="scene-load" onClick={() => { setCompare(false); void load(); }}>读取作品配置</button>
      <label>画布边长 <input data-testid="scene-size" type="number" min="100" max="1600" value={size} onChange={e => setSize(Math.max(100, Math.min(1600, Number(e.target.value) || 400)))}/></label>
      <button data-testid="scene-match-size" onClick={() => setSize(previewSize())}>匹配作品画布尺寸</button>
      <label><input data-testid="scene-compare" type="checkbox" checked={compare} onChange={e => { setCompare(e.target.checked); if (e.target.checked) void load(); }}/>对照模式（已保存配置、当前滚动位置、隐藏手柄）</label>
    </fieldset>
    {error && <p data-testid="scene-error" className="error" role="alert">{error}</p>}
    <h3>最近写入的参数变化</h3><pre data-testid="scene-diff">{latest ? JSON.stringify(latest.diff, null, 2) : '尚无写入'}</pre>
    <details><summary>当前视口配置</summary><pre data-testid="scene-config">{JSON.stringify(config, null, 2)}</pre></details>
  </section>;
}
