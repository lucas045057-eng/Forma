import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { AssetPlacementTarget } from '@spatial/shared';
import type { SceneConfig } from '@spatial/shared/scene-config';
import { ProductScene } from '@spatial/scene-renderer';

export interface PlacementStageOverlayProps {
  frame: HTMLIFrameElement | null;
  target: AssetPlacementTarget | undefined;
  slotRect: [number, number, number, number] | null;
  modelUrl: string | undefined;
  previewSceneConfig: SceneConfig;
  dragging: boolean;
  busy: boolean;
  widthPercent: number;
  align: 'start' | 'center' | 'end';
  onWidthPercentChange: (nextPercent: number) => void;
  onCameraChange: (camera: SceneConfig['hero']['camera']) => void;
}

/** 1:1 viewport-aligned WebGL overlay rendered atop the preview iframe's reserved placement slot. */
export default function PlacementStageOverlay({
  frame,
  target,
  slotRect,
  modelUrl,
  previewSceneConfig,
  dragging,
  busy,
  widthPercent,
  align,
  onWidthPercentChange,
  onCameraChange,
}: PlacementStageOverlayProps) {
  const [iframeBounds, setIframeBounds] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [resizing, setResizing] = useState(false);

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

  function startCornerResize(downEvent: ReactPointerEvent<HTMLButtonElement>) {
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
      onWidthPercentChange(nextPercent);
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

  if (!target || !slotRect || !iframeBounds || !modelUrl || slotRect[2] <= 8 || slotRect[3] <= 8) {
    return null;
  }

  const [sx, sy, sw, sh] = slotRect;
  const clipTop = Math.max(0, -sy);
  const clipLeft = Math.max(0, -sx);
  const clipRight = Math.max(0, sx + sw - iframeBounds.width);
  const clipBottom = Math.max(0, sy + sh - iframeBounds.height);
  const outOfView = clipTop + clipBottom >= sh - 4 || clipLeft + clipRight >= sw - 4;

  const stageStyle: CSSProperties = {
    position: 'fixed',
    left: `${iframeBounds.left + sx}px`,
    top: `${iframeBounds.top + sy}px`,
    width: `${sw}px`,
    height: `${sh}px`,
    clipPath: `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px round 16px)`,
    visibility: outOfView ? 'hidden' : 'visible',
    pointerEvents: outOfView || dragging || busy ? 'none' : 'auto',
    opacity: dragging ? 0.25 : 1,
  };

  return (
    <div
      className={`in-page-3d-preview${resizing ? ' is-resizing' : ''}`}
      data-testid="in-page-3d-preview"
      style={stageStyle}
    >
      <ProductScene
        config={previewSceneConfig}
        modelUrl={modelUrl}
        controls
        canvasTestId="in-page-3d-canvas"
        fallback={<p className="in-page-3d-loading">正在网页中加载 3D 实物…</p>}
        onCameraChange={onCameraChange}
      />
      <div className="in-page-3d-badge">
        3D 实物预览 · 拖拽旋转 / 滚轮缩放
      </div>
      {target.kind === 'insert' && (
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
  );
}
