import { useEffect, useRef, useState } from 'react';
import type { Asset, AssetPlacementSession, AssetPlacementTarget, StudioMessage } from '@spatial/shared';
import { placementMessage, type PlacementSession } from './placement-state.ts';
import { previewOrigin } from './preview-origin.ts';
import { useEventCenter } from './EventCenter.tsx';
import { ProductScene } from '@spatial/scene-renderer';
import { defaultSceneConfig } from '@spatial/shared/scene-config';

async function post<T>(url: string, body: unknown): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); }
  catch { throw new Error('放置请求未确认，请刷新状态后重试'); }
  let result: unknown;
  try { result = await response.json(); } catch { /* handled */ }
  if (!response.ok) {
    const message = result && typeof result === 'object' ? (result as { error?: { message?: unknown } }).error?.message : undefined;
    throw new Error(typeof message === 'string' ? message : '放置结果未确认，请刷新状态');
  }
  return result as T;
}

export default function AssetPlacement({ asset, frame, onClose, initialSession, dragging = false, onDragStateChange, onTargetSelected }: {
  asset: Asset;
  frame: HTMLIFrameElement | null;
  onClose: () => void;
  initialSession?: PlacementSession;
  dragging?: boolean;
  onDragStateChange?: (dragging: boolean) => void;
  onTargetSelected?: () => void;
}) {
  const { state, syncReady, status, reload, acquire, awaiting } = useEventCenter();
  const panelRef = useRef<HTMLElement>(null);
  const [session, setSession] = useState<AssetPlacementSession | undefined>(() => initialSession);
  const [target, setTarget] = useState<AssetPlacementTarget>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [widthPercent, setWidthPercent] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const [align, setAlign] = useState<'start' | 'center' | 'end'>('center');
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [force, setForce] = useState(false);
  const confirmed = useRef(false);
  const currentVersion = useRef(state.version);
  currentVersion.current = state.version;
  const onTargetSelectedRef = useRef(onTargetSelected);
  onTargetSelectedRef.current = onTargetSelected;
  const send = (message: StudioMessage) => frame?.contentWindow?.postMessage(message, previewOrigin);

  useEffect(() => {
    if (!initialSession || initialSession.expiresAt <= Date.now()) return;
    if (session?.sessionId === initialSession.sessionId) return;
    setSession(initialSession);
    setError('');
  }, [initialSession, session?.sessionId]);

  useEffect(() => {
    let active = true;
    if (confirmed.current || !syncReady || status !== 'connected' || !frame || !state.version) return;
    if (session) {
      frame.contentWindow?.postMessage({ type: 'pick:stop' }, previewOrigin);
      frame.contentWindow?.postMessage({ type: 'placement:start', payload: session }, previewOrigin);
      return;
    }
    const version = state.version;
    void post<AssetPlacementSession>('/assets/placements/sessions', { assetId: asset.id, baseVersion: version })
      .then(result => {
        if (!active) return;
        setSession(result);
        frame.contentWindow?.postMessage({ type: 'pick:stop' }, previewOrigin);
        frame.contentWindow?.postMessage({ type: 'placement:start', payload: result }, previewOrigin);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '放置会话未创建'); });
    return () => { active = false; };
  }, [asset.id, frame, syncReady, status, state.version, session]);

  useEffect(() => {
    if (!session) return;
    const receive = (event: MessageEvent<unknown>) => {
      const result = placementMessage(event, { origin: previewOrigin, frame: frame?.contentWindow, session, version: currentVersion.current, now: Date.now() });
      if (!result) return;
      if ('cancelled' in result) { onClose(); return; }
      setTarget(result.target);
      onTargetSelectedRef.current?.();
      panelRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => {
      setError('放置会话已过期，请重新放入');
      setTarget(undefined);
      send({ type: 'placement:stop', payload: { sessionId: session.sessionId } });
    }, Math.max(1, session.expiresAt - Date.now()));
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      send({ type: 'placement:stop', payload: { sessionId: session.sessionId } });
    };
  }, [session, frame]);

  useEffect(() => {
    if (session && (state.version !== session.baseVersion || !syncReady)) {
      setTarget(undefined);
      if (state.version !== session.baseVersion) setError('作品版本已变化，请重新放置');
    }
  }, [state.version, syncReady, session]);

  async function confirm() {
    if (!session || !target || busy || confirmed.current || !syncReady || status !== 'connected') return;
    const token = acquire(['work']);
    if (!token) return;
    confirmed.current = true; setBusy(true); setError('');
    try {
      const adjustment = target.kind === 'insert' ? {
        layout: { widthPercent, align, offsetX, offsetY },
        rotation: [0, rotation, 0],
        scale,
      } : undefined;
      await post(`/assets/placements/${session.sessionId}/confirm`, { target, ...(adjustment ? { adjustment } : {}), ...(force ? { force } : {}) });
      awaiting(token);
      await reload();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '放置结果未确认');
      awaiting(token);
      try { await reload(); } catch { /* reload error is already surfaced by the event center */ }
      confirmed.current = false;
    } finally { setBusy(false); }
  }

  return <section ref={panelRef} className={`asset-placement${dragging ? ' is-dragging' : ''}`} role="region" aria-label="放置模型确认" data-testid="asset-placement">
    <h3>将模型放入网页</h3>
    {target && <div className="placement-target-banner">
      <p data-testid="placement-target">
        {target.kind === 'replace' ? '替换主 3D 槽位' : target.kind === 'replace-module' ? `替换实例 ${target.instanceId?.slice(0, 8)} 的模型` : '在此添加独立 3D 模块'} · {target.src}
      </p>
      <p>采用前主作品不会改变。{target.kind === 'insert' ? '将创建候选，仍需批准、检查和采用。' : target.kind === 'replace' ? '确认后通过场景历史替换，可撤回。' : '确认后写入该实例的独立历史，可单独撤回。'}</p>
      {target.kind === 'insert' && <fieldset>
        <legend>独立实例布局</legend>
        <label>宽度（%）<input type="number" min={10} max={100} value={widthPercent} onChange={event => setWidthPercent(Number(event.target.value))} /></label>
        <label>Y 角度<input type="number" step={0.1} value={rotation} onChange={event => setRotation(Number(event.target.value))} /></label>
        <label>比例<input type="number" min={0.01} max={100} step={0.1} value={scale} onChange={event => setScale(Number(event.target.value))} /></label>
        <label>容器内对齐<select value={align} onChange={event => setAlign(event.target.value as typeof align)}>
          <option value="start">左</option><option value="center">居中</option><option value="end">右</option>
        </select></label>
        <label>水平偏移<input type="number" min={-500} max={500} value={offsetX} onChange={event => setOffsetX(Number(event.target.value))} /></label>
        <label>上下偏移<input type="number" min={-500} max={500} value={offsetY} onChange={event => setOffsetY(Number(event.target.value))} /></label>
      </fieldset>}
      {asset.metrics?.webReady !== true && <label>
        <input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />该模型超过网页门槛；我明确要求强制采用
      </label>}
      <button type="button" data-testid="placement-confirm" disabled={busy || !syncReady} onClick={() => void confirm()}>{busy ? '确认中…' : '确认放置'}</button>
    </div>}
    {error && <p role="alert">{error}</p>}
    <p>{target ? '如需改选位置，可继续拖动下方卡片或直接点击网页其他区块。' : '拖动下方卡片到右侧作品，或直接点击网页中的香薰瓶/区块选择目标；松开选定目标后点击上方“确认放置”即可生效。'}</p>
    <div tabIndex={0} role="button" aria-label="拖动模型卡片到网页" draggable={!!session && !busy}
      onDragStart={event => {
        if (!session) return;
        frame?.contentWindow?.postMessage({ type: 'placement:start', payload: session }, previewOrigin);
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-spatial-asset', JSON.stringify({ sessionId: session.sessionId, assetId: asset.id }));
        requestAnimationFrame(() => onDragStateChange?.(true));
      }}
      onDragEnd={() => onDragStateChange?.(false)}
      className="placement-card">⠿ 按住拖入网页（或直接点击网页目标） · {asset.id.slice(0, 10)}…</div>
    {asset.modelUrl && <div className="lux-model-preview"><ProductScene config={defaultSceneConfig} modelUrl={asset.modelUrl} controls /></div>}
    <button type="button" onClick={onClose} disabled={busy}>取消放置</button>
  </section>;
}
