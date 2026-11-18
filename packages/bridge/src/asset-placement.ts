import type { AssetPlacementTarget, PlacementPreviewMessage } from '@spatial/shared';
import { isStudioMessage } from '@spatial/shared';

const mime = 'application/x-spatial-asset';
const VOID_TAGS = new Set([
  'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
  'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR',
]);

export function installAssetPlacement(origin: string): () => void {
  let session: { sessionId: string; assetId: string; baseVersion: string } | undefined;
  let hover: Element | null = null;
  let activeTarget: AssetPlacementTarget | null = null;
  let activeIsVoid = false;
  let currentLayout: { widthPercent: number; align: 'start' | 'center' | 'end' } = { widthPercent: 65, align: 'center' };
  let slotWrapper: HTMLDivElement | null = null;
  let slotStage: Element | null = null;
  let slotRaf = 0;
  const hiddenElements: Array<{ el: HTMLElement; visibility: string }> = [];
  const tabStops = new Map<Element, string | null>();

  const overlay = document.createElement('div');
  overlay.dataset.placementOverlay = 'true';
  overlay.style.cssText = [
    'position:fixed',
    'pointer-events:none',
    'z-index:2147483646',
    'border:2.5px solid #67e5d5',
    'border-radius:12px',
    'background:rgba(103,229,213,0.14)',
    'color:#082729',
    'font:600 12.5px/1.4 system-ui,sans-serif',
    'padding:6px 10px',
    'box-sizing:border-box',
    'display:none',
  ].join(';');
  document.body.append(overlay);

  const send = (message: PlacementPreviewMessage) => {
    if (window.parent !== window) window.parent.postMessage(message, origin);
  };

  const emitSlotNow = () => {
    slotRaf = 0;
    if (!session) return;
    if (!slotStage || !slotStage.isConnected) {
      send({ type: 'placement:slot', payload: { sessionId: session.sessionId, rect: null } });
      return;
    }
    const r = slotStage.getBoundingClientRect();
    send({
      type: 'placement:slot',
      payload: {
        sessionId: session.sessionId,
        rect: [r.x, r.y, r.width, r.height],
        isVoidTag: activeIsVoid,
      },
    });
  };

  const scheduleSlotEmit = () => {
    if (!session || !slotStage || slotRaf) return;
    slotRaf = requestAnimationFrame(emitSlotNow);
  };

  const slotObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => scheduleSlotEmit())
    : null;

  const clearPreviewSlot = (notifyParent: boolean) => {
    if (slotRaf) {
      cancelAnimationFrame(slotRaf);
      slotRaf = 0;
    }
    slotObserver?.disconnect();
    for (const item of hiddenElements.splice(0)) {
      item.el.style.visibility = item.visibility;
    }
    if (slotWrapper) {
      slotWrapper.remove();
      slotWrapper = null;
    }
    slotStage = null;
    activeTarget = null;
    activeIsVoid = false;
    if (notifyParent && session) {
      send({ type: 'placement:slot', payload: { sessionId: session.sessionId, rect: null } });
    }
  };

  const sameTarget = (a: AssetPlacementTarget | null, b: AssetPlacementTarget | null): boolean =>
    Boolean(a && b && a.kind === b.kind && a.src === b.src && a.position === b.position && a.instanceId === b.instanceId);

  const applyPreviewSlot = (
    nextTarget: AssetPlacementTarget | null,
    layout: { widthPercent: number; align: 'start' | 'center' | 'end' },
  ) => {
    currentLayout = layout;
    if (nextTarget?.kind === 'insert' && sameTarget(activeTarget, nextTarget) && slotWrapper?.isConnected && slotStage instanceof HTMLElement) {
      slotWrapper.style.justifyContent = layout.align === 'start' ? 'flex-start' : layout.align === 'end' ? 'flex-end' : 'center';
      slotStage.style.width = `${layout.widthPercent}%`;
      emitSlotNow();
      return;
    }
    if ((nextTarget?.kind === 'replace' || nextTarget?.kind === 'replace-module') && sameTarget(activeTarget, nextTarget) && slotStage?.isConnected) {
      emitSlotNow();
      return;
    }

    clearPreviewSlot(false);
    if (!session || !nextTarget) {
      if (session) send({ type: 'placement:slot', payload: { sessionId: session.sessionId, rect: null } });
      return;
    }

    const anchor = nextTarget.kind === 'replace-module'
      ? document.querySelector(`[data-spatial-module="${nextTarget.instanceId}"]`)
      : Array.from(document.querySelectorAll('[data-src]')).find(item => item.getAttribute('data-src') === nextTarget.src) ?? null;

    if (!anchor) {
      send({ type: 'placement:slot', payload: { sessionId: session.sessionId, rect: null } });
      return;
    }

    activeTarget = nextTarget;

    if (nextTarget.kind === 'replace' || nextTarget.kind === 'replace-module') {
      const targetStage = nextTarget.kind === 'replace-module'
        ? (anchor.firstElementChild ?? anchor)
        : anchor;
      for (const child of Array.from(targetStage.children)) {
        if (child instanceof HTMLElement) {
          hiddenElements.push({ el: child, visibility: child.style.visibility });
          child.style.visibility = 'hidden';
        }
      }
      slotStage = targetStage;
      activeIsVoid = false;
      slotObserver?.observe(targetStage);
      slotObserver?.observe(document.documentElement);
      emitSlotNow();
      return;
    }

    const isVoid = VOID_TAGS.has(anchor.tagName.toUpperCase());
    activeIsVoid = isVoid;

    const wrapper = document.createElement('div');
    wrapper.dataset.spatialPreviewSlot = 'true';
    const justify = layout.align === 'start' ? 'flex-start' : layout.align === 'end' ? 'flex-end' : 'center';
    wrapper.style.cssText = `display:flex;width:100%;justify-content:${justify};margin:14px 0;box-sizing:border-box;pointer-events:none;`;

    const stage = document.createElement('div');
    stage.dataset.spatialPreviewStage = 'true';
    stage.style.cssText = [
      `width:${layout.widthPercent}%`,
      'max-width:100%',
      'aspect-ratio:1 / 1',
      'min-height:160px',
      'position:relative',
      'border-radius:16px',
      'box-sizing:border-box',
      'background:rgba(239,232,220,0.35)',
      'outline:2px dashed rgba(103,229,213,0.72)',
      'outline-offset:-2px',
    ].join(';');
    wrapper.appendChild(stage);

    if (nextTarget.position === 'before' && anchor.parentNode) {
      anchor.parentNode.insertBefore(wrapper, anchor);
    } else if (nextTarget.position === 'inside' && !isVoid) {
      anchor.appendChild(wrapper);
    } else {
      anchor.after(wrapper);
    }

    slotWrapper = wrapper;
    slotStage = stage;
    slotObserver?.observe(stage);
    slotObserver?.observe(document.documentElement);

    const initialRect = stage.getBoundingClientRect();
    if (initialRect.bottom < 48 || initialRect.top > window.innerHeight - 48) {
      stage.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
    }
    emitSlotNow();
  };

  const stop = () => {
    clearPreviewSlot(false);
    session = undefined;
    hover = null;
    overlay.style.display = 'none';
    for (const [element, previous] of tabStops) {
      if (previous === null) element.removeAttribute('tabindex');
      else element.setAttribute('tabindex', previous);
    }
    tabStops.clear();
  };

  const target = (element: Element): AssetPlacementTarget | null => {
    if (element.closest('[data-spatial-preview-slot]')) return null;
    const mainSlot = element.closest('[data-testid="product-scene"]');
    const module = element.closest('[data-spatial-module]');
    if (module) {
      const instanceId = module.getAttribute('data-spatial-module');
      if (!instanceId || !/^[a-f0-9]{32}$/.test(instanceId)) return null;
      const ancestors: string[] = [];
      let parent = module.parentElement;
      while (parent && ancestors.length < 3) {
        const source = parent.getAttribute('data-src');
        if (source) ancestors.push(source);
        parent = parent.parentElement;
      }
      return { kind: 'replace-module', instanceId, src: 'src/spatial-module.tsx:1:1', cid: 'SpatialModule', ancestors, position: 'inside' };
    }
    let node = mainSlot ?? element.closest('[data-src]');
    if (!node) return null;
    if (!mainSlot) {
      const marked = Array.from(document.querySelectorAll('[data-src]'));
      while (node && marked.filter(item => item.getAttribute('data-src') === node?.getAttribute('data-src')).length > 1) {
        node = node.parentElement?.closest('[data-src]') ?? null;
      }
    }
    const src = node?.getAttribute('data-src');
    if (!src || !node) return null;
    const ancestors: string[] = [];
    let parent = node.parentElement;
    while (parent && ancestors.length < 3) {
      const source = parent.getAttribute('data-src');
      if (source) ancestors.push(source);
      parent = parent.parentElement;
    }
    const inheritedPos = activeTarget?.kind === 'insert' ? activeTarget.position : 'after';
    const safePos = VOID_TAGS.has(node.tagName.toUpperCase()) && inheritedPos === 'inside' ? 'after' : inheritedPos;
    return {
      kind: mainSlot ? 'replace' : 'insert',
      src,
      cid: node.getAttribute('data-cid') ?? 'Node',
      ancestors,
      position: mainSlot ? 'inside' : safePos,
    };
  };

  const draw = (element: Element) => {
    if (element.closest('[data-spatial-preview-slot]')) {
      overlay.style.display = 'none';
      return;
    }
    const data = target(element);
    if (!data) {
      overlay.style.display = 'none';
      return;
    }
    // Hide hover outline when hovering the exact same element already being live-previewed (unless dragging)
    if (activeTarget && activeTarget.kind === data.kind && activeTarget.src === data.src && activeTarget.instanceId === data.instanceId) {
      overlay.style.display = 'none';
      return;
    }
    hover = element;
    const anchor = data.kind === 'replace-module'
      ? element.closest('[data-spatial-module]') ?? element
      : Array.from(document.querySelectorAll('[data-src]')).find(item => item.getAttribute('data-src') === data.src);
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: 'block',
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
      transform: 'none',
    });
    overlay.textContent = data.kind === 'replace'
      ? '点击或松开 · 在此舞台预览替换后的 3D 模型'
      : data.kind === 'replace-module'
        ? '点击或松开 · 在此模块预览替换后的 3D 模型'
        : '点击或松开 · 在此处直接预览 3D 实物效果';
  };

  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== origin || event.source !== window.parent || !isStudioMessage(event.data)) return;
    if (event.data.type === 'placement:start') {
      stop();
      session = event.data.payload;
      currentLayout = { widthPercent: 65, align: 'center' };
      for (const element of Array.from(document.querySelectorAll('[data-src]')).slice(0, 300)) {
        if (element instanceof HTMLElement && !element.hasAttribute('tabindex')) {
          tabStops.set(element, null);
          element.setAttribute('tabindex', '0');
        }
      }
      return;
    }
    if (event.data.type === 'placement:preview-layout' && session?.sessionId === event.data.payload.sessionId) {
      applyPreviewSlot(event.data.payload.target, event.data.payload.layout);
      return;
    }
    if (event.data.type === 'placement:stop' && session?.sessionId === event.data.payload.sessionId) {
      stop();
    }
  };

  const move = (event: PointerEvent) => {
    if (session && event.target instanceof Element) draw(event.target);
  };

  const dragOver = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    if (!session) {
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'none';
        overlay.style.display = 'block';
        overlay.style.left = '50%';
        overlay.style.top = '16px';
        overlay.style.width = 'auto';
        overlay.style.height = 'auto';
        overlay.style.transform = 'translateX(-50%)';
        overlay.textContent = '外部文件不能直接放到网页；请回到工作台的“从图片创作 3D”上传区';
      }
      return;
    }
    event.preventDefault();
    if (!event.dataTransfer.types.includes(mime)) {
      event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.dataTransfer.dropEffect = 'copy';
    if (event.target instanceof Element) {
      const resolved = target(event.target);
      if (resolved) {
        const anchor = resolved.kind === 'replace-module'
          ? event.target.closest('[data-spatial-module]') ?? event.target
          : Array.from(document.querySelectorAll('[data-src]')).find(item => item.getAttribute('data-src') === resolved.src);
        if (anchor) {
          const box = anchor.getBoundingClientRect();
          Object.assign(overlay.style, {
            display: 'block',
            left: `${box.x}px`,
            top: `${box.y}px`,
            width: `${box.width}px`,
            height: `${box.height}px`,
            transform: 'none',
          });
          overlay.textContent = resolved.kind === 'replace'
            ? '松开预览替换后的 3D 舞台效果'
            : resolved.kind === 'replace-module'
              ? '松开预览替换后的 3D 模块效果'
              : '松开在此处实时预览 3D 实物效果';
        }
      }
    }
  };

  const choose = (element: Element) => {
    if (!session) return;
    const data = target(element);
    if (!data) return;
    overlay.style.display = 'none';
    send({ type: 'placement:target', payload: { sessionId: session.sessionId, target: data } });
    applyPreviewSlot(data, currentLayout);
  };

  const drop = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    if (!session) {
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        overlay.style.display = 'none';
      }
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    let data: unknown;
    try { data = JSON.parse(event.dataTransfer.getData(mime)); } catch { return; }
    const item = data as { sessionId?: unknown; assetId?: unknown };
    if (item.sessionId !== session.sessionId || item.assetId !== session.assetId) return;
    if (event.target instanceof Element) choose(event.target);
  };

  const click = (event: MouseEvent) => {
    if (!session || !(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    choose(event.target);
  };

  const key = (event: KeyboardEvent) => {
    if (!session) return;
    if (event.key === 'Escape') {
      send({ type: 'placement:cancelled', payload: { sessionId: session.sessionId, reason: '已取消放置' } });
      stop();
    } else if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element) {
      event.preventDefault();
      choose(event.target);
    }
  };

  const focus = (event: FocusEvent) => {
    if (session && event.target instanceof Element) draw(event.target);
  };

  const dragLeave = () => {
    if (!session) overlay.style.display = 'none';
  };

  const onViewportShift = () => {
    if (!session) return;
    if (hover?.isConnected && overlay.style.display === 'block') draw(hover);
    if (slotStage?.isConnected) scheduleSlotEmit();
  };

  window.addEventListener('focusin', focus, true);
  window.addEventListener('message', receive);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('dragleave', dragLeave, true);
  window.addEventListener('dragover', dragOver, true);
  window.addEventListener('drop', drop, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', key, true);
  window.addEventListener('scroll', onViewportShift, true);
  window.addEventListener('resize', onViewportShift);

  return () => {
    stop();
    slotObserver?.disconnect();
    overlay.remove();
    window.removeEventListener('focusin', focus, true);
    window.removeEventListener('message', receive);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('dragleave', dragLeave, true);
    window.removeEventListener('dragover', dragOver, true);
    window.removeEventListener('drop', drop, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('scroll', onViewportShift, true);
    window.removeEventListener('resize', onViewportShift);
  };
}
