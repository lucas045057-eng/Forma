import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalCard, Asset } from '@spatial/shared';
import { defaultSceneConfig, type SceneConfig } from '@spatial/shared/scene-config';
import type { PlacementSession } from './placement-state.ts';
import { previewOrigin } from './preview-origin.ts';
import { api } from './api.ts';
import { useEventCenter } from './EventCenter.tsx';
import PlacementStageOverlay from './PlacementStageOverlay.tsx';
import { placementRequest, usePlacementSession } from './use-placement-session.ts';
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

const SIZE_PRESETS = [
  { label: '小', value: 40 },
  { label: '中', value: 65 },
  { label: '大', value: 85 },
  { label: '满宽', value: 100 },
] as const;

/** HUD controller for placing, replacing, framing, and confirming 3D assets directly on the webpage. */
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
  const [heroSceneConfig, setHeroSceneConfig] = useState<SceneConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [widthPercent, setWidthPercent] = useState(65);
  const [align, setAlign] = useState<'start' | 'center' | 'end'>('center');
  const [force, setForce] = useState(false);

  const framedCameraRef = useRef<SceneConfig['hero']['camera'] | null>(null);
  const confirmed = useRef(false);

  const { session, target, setTarget, slotRect, isVoidTag, clearTarget } = usePlacementSession({
    assetId: asset.id,
    frame,
    initialSession,
    syncReady,
    status,
    stateVersion: state.version,
    confirmedRef: confirmed,
    widthPercent,
    align,
    onClose,
    onError: setError,
    onTargetSelected,
  });

  useEffect(() => {
    framedCameraRef.current = null;
  }, [asset.id]);

  // Fetch active work's hero scene config once so replacing the hero 3D stage previews with matching lights & camera.
  useEffect(() => {
    let active = true;
    void api<SceneConfig>('/scene')
      .then(cfg => {
        if (active && cfg && cfg.hero?.camera) setHeroSceneConfig(cfg);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [state.version]);

  const previewSceneConfig = useMemo<SceneConfig>(() => {
    if (target?.kind === 'replace' && heroSceneConfig) {
      return { ...heroSceneConfig, scroll: [] };
    }
    return { ...defaultSceneConfig, scroll: [] };
  }, [target?.kind, heroSceneConfig]);

  async function applyPostConfirmSideEffects(result: ConfirmResponse, framedCamera: SceneConfig['hero']['camera'] | undefined) {
    if (result.kind === 'replace' && framedCamera) {
      try {
        const latestScene = await placementRequest<SceneConfig>('/scene', 'GET');
        await placementRequest('/scene', 'PUT', {
          ...latestScene,
          hero: { ...latestScene.hero, camera: framedCamera },
        });
      } catch {
        /* preserve adopted model even if optional camera save fails */
      }
      return;
    }
    if (result.kind === 'replace-module' && framedCamera && target?.instanceId) {
      try {
        await placementRequest(`/assets/modules/${encodeURIComponent(target.instanceId)}/adjust`, 'POST', {
          baseVersion: result.version,
          adjustment: { camera: framedCamera },
        });
      } catch {
        /* preserve replaced module even if optional camera save fails */
      }
      return;
    }
    if (result.kind === 'insert' && result.task?.id) {
      // Auto-approve the insertion draft and kick off quality gates so the candidate opens right away.
      try {
        const approvals = await placementRequest<ApprovalCard[]>('/approvals', 'GET');
        const pendingCard = approvals.find(item => item.taskId === result.task.id && item.status === 'pending');
        if (pendingCard) {
          await placementRequest(`/approvals/${encodeURIComponent(pendingCard.id)}`, 'POST', { option: 0 });
          void placementRequest(`/candidates/${encodeURIComponent(result.task.id)}/checks`, 'POST', {}).catch(() => {});
        }
      } catch {
        /* if auto-approval cannot complete, sidebar ApprovalPanel still holds the card */
      }
    }
  }

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
      const result = await placementRequest<ConfirmResponse>(`/assets/placements/${session.sessionId}/confirm`, 'POST', {
        target,
        ...(adjustment ? { adjustment } : {}),
        ...(force ? { force: true } : {}),
      });
      await applyPostConfirmSideEffects(result, framedCamera);
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
                  clearTarget();
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

    <PlacementStageOverlay
      frame={frame}
      target={target}
      slotRect={slotRect}
      modelUrl={asset.modelUrl}
      previewSceneConfig={previewSceneConfig}
      dragging={dragging}
      busy={busy}
      widthPercent={widthPercent}
      align={align}
      onWidthPercentChange={setWidthPercent}
      onCameraChange={nextCam => { framedCameraRef.current = nextCam; }}
    />
  </>;
}
