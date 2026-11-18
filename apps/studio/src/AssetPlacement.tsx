import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ApprovalCard, Asset, AssetPlacementSession, AssetPlacementTarget, StudioMessage } from '@spatial/shared';
import { defaultSceneConfig, type SceneConfig } from '@spatial/shared/scene-config';
import { ProductScene } from '@spatial/scene-renderer';
import { placementMessage, type PlacementSession } from './placement-state.ts';
import { previewOrigin } from './preview-origin.ts';
import { useEventCenter } from './EventCenter.tsx';
import './assets.css';

export interface PlacementConfirmedOutcome {
  kind: 'replace' | 'replace-module' | 'insert';
  candidateId?: string;
}

type ConfirmResponse =
  | { kind: 'replace'; version: string }
  | { kind: 'replace-module'; version: string }
  | { kind: 'insert'; task: { id: string; status: string } };

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, Number(value.toFixed(4))));
}

function sanitizeCamera(cam: SceneConfig['hero']['camera']): SceneConfig['hero']['camera'] {
  return {
    position: [
      clampNum(cam.position[0], -20, 20),
      clampNum(cam.position[1], -20, 20),
      clampNum(cam.position[2], -20, 20),
    ],
    target: [
      clampNum(cam.target[0], -20, 20),
      clampNum(cam.target[1], -20, 20),
      clampNum(cam.target[2], -20, 20),
    ],
    fov: clampNum(cam.fov, 10, 110),
  };
}

async function requestJson<T>(url: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new Error('放置请求未确认，请刷新状态后重试');
  }
  let result: unknown;
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const message = result && typeof result === 'object' ? (result as { error?: { message?: unknown } }).error?.message : undefined;
    throw new Error(typeof message === 'string' ? message : '放置结果未确认，请刷新状态');
  }
  return result as T;
}

const SIZE_PRESETS = [
  { label: '小', value: 40 },
  { label: '中', value: 65 },
  { label: '大', value: 85 },
  { label: '满宽', value: 100 },
] as const;

export default function AssetPlacement({
  asset,
  frame,
  onClose,
  initialSession,
  dragging = false,
  onDragStateChange,
  onTargetSelected,
  onConfirmed,
}: {
  asset: Asset;
  frame: HTMLIFrameElement | null;
  onClose: () => void;
  initialSession?: PlacementSession;
  dragging?: boolean;
  onDragStateChange?: (dragging: boolean) => void;
  onTargetSelected?: () => void;
  onConfirmed?: (outcome: PlacementConfirmedOutcome) => void;
}) {
  const { state, syncReady, status, reload, acquire, awaiting } = useEventCenter();
  const [session, setSession] = useState<AssetPlacementSession | undefined>(() => initialSession);
  const [target, setTarget] = useState<AssetPlacementTarget>();
  const [slotRect, setSlotRect] = useState<[number, number, number, number] | null>(null);
  const [isVoidTag, setIsVoidTag] = useState(false);
  const [iframeBounds, setIframeBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [heroSceneConfig, setHeroSceneConfig] = useState<SceneConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [widthPercent, setWidthPercent] = useState(65);
  const [align, setAlign] = useState<'start' | 'center' | 'end'>('center');
  const [force, setForce] = useState(false);

  const framedCameraRef = useRef<SceneConfig['hero']['camera'] | null>(null);
  const confirmed = useRef(false);
  const currentVersion = useRef(state.version);
  currentVersion.current = state.version;
  const onTargetSelectedRef = useRef(onTargetSelected);
  onTargetSelectedRef.current = onTargetSelected;

  const send = (message: StudioMessage) => frame?.contentWindow?.postMessage(message, previewOrigin);

  useEffect(() => {
    framedCameraRef.current = null;
  }, [asset.id]);

  // Fetch active work's hero scene config once so replacing the hero 3D stage previews with matching lights & camera.
  useEffect(() => {
    let active = true;
    void fetch('/scene', { cache: 'no-store' })
      .then(res => (res.ok ? (res.json() as Promise<SceneConfig>) : null))
      .then(cfg => {
        if (active && cfg && cfg.hero?.camera) setHeroSceneConfig(cfg);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [state.version]);

  // Keep iframe viewport bounds synchronized so the in-page 3D stage stays locked 1:1 over the webpage slot.
  useEffect(() => {
    if (!frame) {
      setIframeBounds(null);
      return;
    }
    const measure = () => {
      const r = frame.getBoundingClientRect();
      setIframeBounds(prev => (
        prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height
          ? prev
          : { left: r.left, top: r.top, width: r.width, height: r.height }
      ));
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(frame);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [frame]);

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
      frame.contentWindow?.postMessage({
        type: 'placement:preview-layout',
        payload: { sessionId: session.sessionId, target: target ?? null, layout: { widthPercent, align } },
      }, previewOrigin);
      return;
    }
    const version = state.version;
    void requestJson<AssetPlacementSession>('/assets/placements/sessions', 'POST', { assetId: asset.id, baseVersion: version })
      .then(result => {
        if (!active) return;
        setSession(result);
        frame.contentWindow?.postMessage({ type: 'pick:stop' }, previewOrigin);
        frame.contentWindow?.postMessage({ type: 'placement:start', payload: result }, previewOrigin);
        frame.contentWindow?.postMessage({
          type: 'placement:preview-layout',
          payload: { sessionId: result.sessionId, target: null, layout: { widthPercent, align } },
        }, previewOrigin);
      })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '放置会话未创建'); });
    return () => { active = false; };
  }, [asset.id, frame, syncReady, status, state.version, session]);

  // Sync live layout (position / widthPercent / align) into the webpage's in-flow preview slot.
  useEffect(() => {
    if (!session || !frame) return;
    send({
      type: 'placement:preview-layout',
      payload: {
        sessionId: session.sessionId,
        target: target ?? null,
        layout: { widthPercent, align },
      },
    });
  }, [session, frame, target, widthPercent, align]);

  useEffect(() => {
    if (!session) return;
    const receive = (event: MessageEvent<unknown>) => {
      const result = placementMessage(event, {
        origin: previewOrigin,
        frame: frame?.contentWindow,
        session,
        version: currentVersion.current,
        now: Date.now(),
      });
      if (!result) return;
      if ('cancelled' in result) {
        onClose();
        return;
      }
      if ('slotRect' in result) {
        setSlotRect(result.slotRect);
        if (result.isVoidTag !== undefined) setIsVoidTag(result.isVoidTag);
        return;
      }
      setError('');
      setTarget(result.target);
      onTargetSelectedRef.current?.();
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => {
      setError('放置会话已过期，请重新放入');
      setTarget(undefined);
      setSlotRect(null);
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
      setSlotRect(null);
      if (state.version !== session.baseVersion) setError('作品版本已变化，请重新放置');
    }
  }, [state.version, syncReady, session]);

  const previewSceneConfig = useMemo<SceneConfig>(() => {
    if (target?.kind === 'replace' && heroSceneConfig) {
      return { ...heroSceneConfig, scroll: [] };
    }
    return { ...defaultSceneConfig, scroll: [] };
  }, [target?.kind, heroSceneConfig]);

  async function confirm() {
    if (!session || !target || busy || confirmed.current || !syncReady || status !== 'connected') return;
    const token = acquire(['work']);
    if (!token) return;
    confirmed.current = true;
    setBusy(true);
    setError('');
    try {
      const framedCamera = framedCameraRef.current ? sanitizeCamera(framedCameraRef.current) : undefined;
      const adjustment = target.kind === 'insert'
        ? {
            layout: { widthPercent, align, offsetX: 0, offsetY: 0 },
            ...(framedCamera ? { camera: framedCamera } : {}),
          }
        : undefined;
      const result = await requestJson<ConfirmResponse>(`/assets/placements/${session.sessionId}/confirm`, 'POST', {
        target,
        ...(adjustment ? { adjustment } : {}),
        ...(force ? { force: true } : {}),
      });

      if (result.kind === 'replace' && framedCamera) {
        try {
          const latestScene = await requestJson<SceneConfig>('/scene', 'GET');
          await requestJson('/scene', 'PUT', {
            ...latestScene,
            hero: { ...latestScene.hero, camera: framedCamera },
          });
        } catch {
          /* preserve adopted model even if optional camera save fails */
        }
      } else if (result.kind === 'replace-module' && framedCamera && target.instanceId) {
        try {
          await requestJson(`/assets/modules/${encodeURIComponent(target.instanceId)}/adjust`, 'POST', {
            baseVersion: result.version,
            adjustment: { camera: framedCamera },
          });
        } catch {
          /* preserve replaced module even if optional camera save fails */
        }
      } else if (result.kind === 'insert' && result.task?.id) {
        // User just previewed the 3D object directly inside the webpage and clicked Confirm:
        // automatically approve the insertion draft and kick off quality gates so the candidate opens right away.
        try {
          const approvals = await requestJson<ApprovalCard[]>('/approvals', 'GET');
          const pendingCard = approvals.find(item => item.taskId === result.task.id && item.status === 'pending');
          if (pendingCard) {
            await requestJson(`/approvals/${encodeURIComponent(pendingCard.id)}`, 'POST', { option: 0 });
            void requestJson(`/candidates/${encodeURIComponent(result.task.id)}/checks`, 'POST', {}).catch(() => {});
          }
        } catch {
          /* if auto-approval cannot complete, sidebar ApprovalPanel still holds the card */
        }
      }

      awaiting(token);
      await reload();
      onConfirmed?.({
        kind: result.kind,
        candidateId: result.kind === 'insert' ? result.task?.id : undefined,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '放置结果未确认');
      awaiting(token);
      try { await reload(); } catch { /* surfaced by EventCenter */ }
      confirmed.current = false;
    } finally {
      setBusy(false);
    }
  }

  function startCornerResize(downEvent: React.PointerEvent<HTMLButtonElement>) {
    if (!slotRect || target?.kind !== 'insert') return;
    downEvent.preventDefault();
    downEvent.stopPropagation();
    const startX = downEvent.clientX;
    const startWidthPx = slotRect[2];
    const fullContainerWidth = Math.max(220, startWidthPx / Math.max(0.1, widthPercent / 100));
    setResizing(true);

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const deltaWidth = align === 'center' ? dx * 2 : align === 'end' ? -dx : dx;
      const nextPercent = Math.round(Math.min(100, Math.max(25, ((startWidthPx + deltaWidth) / fullContainerWidth) * 100)));
      setWidthPercent(nextPercent);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Compute exact 1:1 viewport position + iframe edge clipping for the live in-page 3D object stage.
  let stageStyle: CSSProperties | null = null;
  if (target && slotRect && iframeBounds && asset.modelUrl && slotRect[2] > 8 && slotRect[3] > 8) {
    const [sx, sy, sw, sh] = slotRect;
    const boxLeft = iframeBounds.left + sx;
    const boxTop = iframeBounds.top + sy;
    const clipTop = Math.max(0, -sy);
    const clipLeft = Math.max(0, -sx);
    const clipRight = Math.max(0, sx + sw - iframeBounds.width);
    const clipBottom = Math.max(0, sy + sh - iframeBounds.height);
    const outOfView = clipTop + clipBottom >= sh - 4 || clipLeft + clipRight >= sw - 4;

    stageStyle = {
      position: 'fixed',
      left: `${boxLeft}px`,
      top: `${boxTop}px`,
      width: `${sw}px`,
      height: `${sh}px`,
      clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px round 16px)`,
      visibility: outOfView ? 'hidden' : 'visible',
      pointerEvents: outOfView || dragging || busy ? 'none' : 'auto',
      opacity: dragging ? 0.25 : 1,
    };
  }

  return <>
    <section
      className={`asset-placement-hud${dragging ? ' is-dragging' : ''}${target ? ' has-target' : ''}`}
      role="region"
      aria-label="放置模型确认"
      data-testid="asset-placement"
    >
      {!target ? (
        <div className="placement-hud-row">
          <span className="placement-live-pill">3D 实景放入网页</span>
          <span className="placement-hud-guide">直接点击下方网页任意区块或 3D 舞台，即可在网页内实时看到 3D 实物效果</span>
          <div
            tabIndex={0}
            role="button"
            aria-label="拖动模型卡片到网页"
            draggable={!!session && !busy}
            onDragStart={event => {
              if (!session) return;
              frame?.contentWindow?.postMessage({ type: 'placement:start', payload: session }, previewOrigin);
              event.dataTransfer.effectAllowed = 'copy';
              event.dataTransfer.setData('application/x-spatial-asset', JSON.stringify({ sessionId: session.sessionId, assetId: asset.id }));
              requestAnimationFrame(() => onDragStateChange?.(true));
            }}
            onDragEnd={() => onDragStateChange?.(false)}
            className="placement-drag-chip"
          >
            ⠿ 或拖入网页
          </div>
          <button type="button" className="ghost-btn compact-btn" onClick={onClose} disabled={busy}>取消</button>
        </div>
      ) : (
        <>
          <div className="placement-hud-row">
            <span className="placement-live-pill is-ready">网页实景预览中</span>
            <p className="placement-target-title" data-testid="placement-target">
              {target.kind === 'replace'
                ? '替换主 3D 槽位'
                : target.kind === 'replace-module'
                  ? `替换实例 ${target.instanceId?.slice(0, 8)} 的模型`
                  : '在此嵌入 3D 实物模块'}
              <span className="placement-target-sub"> · 点击网页其他区块可换位置，直接在 3D 实物上拖拽可调视角</span>
            </p>
            <div className="placement-hud-actions">
              <button
                type="button"
                className="ghost-btn compact-btn"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setTarget(undefined);
                  setSlotRect(null);
                }}
              >
                重选位置
              </button>
              <button type="button" className="ghost-btn compact-btn" onClick={onClose} disabled={busy}>取消</button>
              <button
                type="button"
                className="primary-btn compact-btn placement-confirm-btn"
                data-testid="placement-confirm"
                disabled={busy || !syncReady}
                onClick={() => void confirm()}
              >
                {busy ? '正在放入网页…' : '✓ 确认放入此处'}
              </button>
            </div>
          </div>

          {(target.kind === 'insert' || asset.metrics?.webReady !== true) && (
            <div className="placement-hud-subrow">
              {target.kind === 'insert' && (
                <>
                  <div className="placement-pill-group" role="group" aria-label="插入位置">
                    <span className="placement-group-label">位置</span>
                    {([
                      { id: 'before', label: '区块上方', disabled: false },
                      { id: 'inside', label: '区块内部', disabled: isVoidTag },
                      { id: 'after', label: '区块下方', disabled: false },
                    ] as const).map(item => (
                      <button
                        key={item.id}
                        type="button"
                        disabled={busy || item.disabled}
                        className={`placement-seg-btn${target.position === item.id ? ' is-active' : ''}`}
                        onClick={() => setTarget(prev => (prev ? { ...prev, position: item.id } : prev))}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>

                  <div className="placement-pill-group" role="group" aria-label="舞台尺寸">
                    <span className="placement-group-label">大小</span>
                    {SIZE_PRESETS.map(preset => (
                      <button
                        key={preset.value}
                        type="button"
                        disabled={busy}
                        className={`placement-seg-btn${widthPercent === preset.value ? ' is-active' : ''}`}
                        onClick={() => setWidthPercent(preset.value)}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <span className="placement-size-readout">{widthPercent}%</span>
                  </div>

                  {widthPercent < 100 && (
                    <div className="placement-pill-group" role="group" aria-label="水平对齐">
                      <span className="placement-group-label">对齐</span>
                      {([
                        { id: 'start', label: '靠左' },
                        { id: 'center', label: '居中' },
                        { id: 'end', label: '靠右' },
                      ] as const).map(item => (
                        <button
                          key={item.id}
                          type="button"
                          disabled={busy}
                          className={`placement-seg-btn${align === item.id ? ' is-active' : ''}`}
                          onClick={() => setAlign(item.id)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {asset.metrics?.webReady !== true && (
                <label className="checkbox-row placement-force-check">
                  <input type="checkbox" checked={force} onChange={event => setForce(event.target.checked)} />
                  模型超预算，强制放入
                </label>
              )}
            </div>
          )}
        </>
      )}

      {error && <p className="error placement-hud-error" role="alert">{error}</p>}
    </section>

    {stageStyle && asset.modelUrl && (
      <div
        className={`in-page-3d-preview${resizing ? ' is-resizing' : ''}`}
        data-testid="in-page-3d-preview"
        style={stageStyle}
      >
        <ProductScene
          config={previewSceneConfig}
          modelUrl={asset.modelUrl}
          controls
          canvasTestId="in-page-3d-canvas"
          fallback={<p className="in-page-3d-loading">正在网页中加载 3D 实物…</p>}
          onCameraChange={nextCam => {
            framedCameraRef.current = nextCam;
          }}
        />
        <div className="in-page-3d-badge">
          3D 实物预览 · 拖拽旋转 / 滚轮缩放
        </div>
        {target?.kind === 'insert' && (
          <button
            type="button"
            className="in-page-resize-handle"
            data-testid="placement-resize-handle"
            title="按住右下角拖拽即可在网页中直接缩放大小"
            onPointerDown={startCornerResize}
          >
            ↘ {widthPercent}%
          </button>
        )}
      </div>
    )}
  </>;
}
