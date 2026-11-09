import { isStudioMessage, type PickSelection, type PreviewMessage, type SelectionStyles } from '@spatial/shared';

export function installBridge(): () => void {
  const origin = window.location.origin;
  let picking = false;
  let selectedSrc = '';
  let hovered: Element | null = null;
  let frame = 0;
  const overlay = document.createElement('div');
  overlay.dataset.bridgeOverlay = 'true';
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.body.append(overlay);
  const send = (message: PreviewMessage) => {
    if (window.parent !== window) window.parent.postMessage(message, origin);
  };
  const instances = (src: string) => Array.from(document.querySelectorAll('[data-src]'))
    .filter(element => element.getAttribute('data-src') === src);
  const nearest = (target: EventTarget | null) => target instanceof Element ? target.closest('[data-src]') : null;
  const draw = () => {
    frame = 0;
    overlay.replaceChildren();
    if (!picking) return;
    const elements = new Set(selectedSrc ? instances(selectedSrc) : []);
    if (hovered?.isConnected) elements.add(hovered);
    for (const element of elements) {
      const rect = element.getBoundingClientRect();
      const box = document.createElement('div');
      box.dataset.highlightSrc = element.getAttribute('data-src') ?? '';
      box.style.cssText = `position:absolute;box-sizing:border-box;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${element === hovered ? '#f59e0b' : '#22d3ee'};background:rgba(34,211,238,.08);pointer-events:none;`;
      overlay.append(box);
    }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
  const receive = (event: MessageEvent<unknown>) => {
    if (event.origin !== origin || event.source !== window.parent || !isStudioMessage(event.data)) return;
    switch (event.data.type) {
      case 'pick:start': picking = true; break;
      case 'pick:stop': picking = false; hovered = null; selectedSrc = ''; break;
      case 'highlight': selectedSrc = event.data.payload.src; break;
    }
    schedule();
  };
  const intercept = (event: Event) => {
    if (!picking) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const keyboard = (event: KeyboardEvent) => {
    if (!picking || (event.key !== 'Enter' && event.key !== ' ')) return;
    const target = event.target;
    const activatable = target instanceof Element && target.closest(
      'a[href],button,input,select,textarea,form,summary,[contenteditable],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[tabindex]',
    );
    if (activatable) intercept(event);
  };
  const click = (event: MouseEvent) => {
    if (!picking) return;
    intercept(event);
    const element = nearest(event.target);
    if (!element) {
      send({ type: 'error', payload: { message: '未找到带源码标记的外层容器' } });
      return;
    }
    const src = element.getAttribute('data-src')!;
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const styles: SelectionStyles = {
      display: computed.display, position: computed.position, color: computed.color,
      backgroundColor: computed.backgroundColor, fontSize: computed.fontSize, fontFamily: computed.fontFamily,
      fontWeight: computed.fontWeight, lineHeight: computed.lineHeight, padding: computed.padding,
      margin: computed.margin, borderRadius: computed.borderRadius, width: computed.width, height: computed.height,
    };
    const ancestors: string[] = [];
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
      const ancestorSrc = ancestor.getAttribute('data-src');
      if (ancestorSrc) ancestors.push(ancestorSrc);
    }
    const payload: PickSelection = {
      src, cid: element.getAttribute('data-cid') ?? 'Anonymous',
      text: (element.textContent ?? '').trim().slice(0, 1000),
      bbox: [rect.x, rect.y, rect.width, rect.height], styles,
      instances: instances(src).length, ancestors,
      ...(element !== event.target ? { note: 'outer-container' as const } : {}),
    };
    selectedSrc = src;
    send({ type: 'pick:result', payload });
    schedule();
  };
  const move = (event: PointerEvent) => { if (picking) { hovered = nearest(event.target); schedule(); } };
  const leave = () => { hovered = null; schedule(); };
  const scroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    send({ type: 'scroll:progress', payload: { at: max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0 } });
    schedule();
  };
  const error = (event: ErrorEvent) => send({ type: 'error', payload: { message: event.message } });
  const rejection = (event: PromiseRejectionEvent) => send({ type: 'error', payload: { message: String(event.reason) } });
  window.addEventListener('message', receive);
  const activationEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'submit'] as const;
  const listenerOptions: AddEventListenerOptions = { capture: true };
  window.addEventListener('click', click, true);
  window.addEventListener('auxclick', click, true);
  for (const type of activationEvents) window.addEventListener(type, intercept, listenerOptions);
  window.addEventListener('keydown', keyboard, true);
  window.addEventListener('keypress', keyboard, true);
  window.addEventListener('keyup', keyboard, true);
  window.addEventListener('pointermove', move, true);
  document.documentElement.addEventListener('pointerleave', leave);
  window.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('error', error);
  window.addEventListener('unhandledrejection', rejection);
  const observer = new MutationObserver(records => {
    if (records.every(record => overlay.contains(record.target))) return;
    schedule();
  });
  observer.observe(document.getElementById('root') ?? document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  send({ type: 'ready' });
  return () => {
    window.removeEventListener('message', receive);
    window.removeEventListener('click', click, true);
    window.removeEventListener('auxclick', click, true);
    for (const type of activationEvents) window.removeEventListener(type, intercept, listenerOptions);
    window.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('keypress', keyboard, true);
    window.removeEventListener('keyup', keyboard, true);
    window.removeEventListener('pointermove', move, true);
    document.documentElement.removeEventListener('pointerleave', leave);
    window.removeEventListener('scroll', scroll, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('error', error);
    window.removeEventListener('unhandledrejection', rejection);
    observer.disconnect();
    cancelAnimationFrame(frame);
    overlay.remove();
  };
}
