// Playwright evaluates this entire function in Chromium before interacting with the candidate.
export async function inspectPlacedModules(settleMs: number) {
  const marker = '[data-spatial-module]';
  const seen = new Set<string>();
  const visibility = { checkOpacity: true, checkVisibilityCSS: true };
  const size = (element: Element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  };

  // Keep the range that could be seen by scrolling. A clip with no overlap is permanent,
  // whereas a canvas below the fold or inside a scrollable panel can still be reached.
  function visibleRange(start: number, end: number, min: number, max: number, overflow: string, canScroll: boolean) {
    if (overflow === 'visible') return [start, end];
    if (canScroll && (overflow === 'auto' || overflow === 'scroll')) return [min, max];
    return [Math.max(start, min), Math.min(end, max)];
  }
  function fullyClipped(canvas: HTMLCanvasElement) {
    let { left, right, top, bottom } = canvas.getBoundingClientRect();
    for (let parent = canvas.parentElement; parent && parent !== document.scrollingElement; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'contents' || (style.overflowX === 'visible' && style.overflowY === 'visible')) continue;
      const rect = parent.getBoundingClientRect();
      const scaleX = parent.offsetWidth ? rect.width / parent.offsetWidth : 1;
      const scaleY = parent.offsetHeight ? rect.height / parent.offsetHeight : 1;
      const x = rect.left + parent.clientLeft * scaleX;
      const y = rect.top + parent.clientTop * scaleY;
      const margin = Number.parseFloat(style.overflowClipMargin) || 0;
      const marginX = style.overflowX === 'clip' ? margin * scaleX : 0;
      const marginY = style.overflowY === 'clip' ? margin * scaleY : 0;
      [left, right] = visibleRange(left, right, x - marginX, x + parent.clientWidth * scaleX + marginX, style.overflowX, parent.scrollWidth > parent.clientWidth);
      [top, bottom] = visibleRange(top, bottom, y - marginY, y + parent.clientHeight * scaleY + marginY, style.overflowY, parent.scrollHeight > parent.clientHeight);
      if (right <= left || bottom <= top) return true;
    }
    return false;
  }
  function measure(module: Element) {
    const id = module.getAttribute('data-spatial-module')!;
    const box = size(module);
    const canvas = Array.from(module.querySelectorAll('canvas')).find(child => child.closest(marker) === module);
    const canvasBox = canvas ? size(canvas) : null;
    let reason: string | null = null;
    if (!(module instanceof HTMLElement)) reason = 'non-html-module';
    else if (!canvas || !canvasBox) reason = 'missing-canvas';
    else if (!(canvas instanceof HTMLCanvasElement)) reason = 'non-html-canvas';
    else if (!canvas.width || !canvas.height) reason = 'empty-buffer';
    else if (!box.width || !box.height || !canvasBox.width || !canvasBox.height) reason = 'zero-size';
    else if (!module.checkVisibility(visibility) || !canvas.checkVisibility(visibility)) reason = 'hidden';
    else if (fullyClipped(canvas)) reason = 'clipped';
    return { id, reason, box, canvasBox, namespace: module.namespaceURI };
  }

  const deadline = performance.now() + settleMs;
  for (;;) {
    const samples = Array.from(document.querySelectorAll('#root ' + marker), measure);
    const mounted = new Set(samples.map(sample => sample.id));
    for (const id of seen) {
      if (!mounted.has(id)) samples.push({ id, reason: 'unmounted', box: { width: 0, height: 0 }, canvasBox: null, namespace: null });
    }
    for (const id of mounted) seen.add(id);
    const failures = samples.filter(sample => sample.reason !== null);
    const wrongNamespace = failures.some(sample => sample.reason === 'non-html-module' || sample.reason === 'non-html-canvas');
    const remainingMs = deadline - performance.now();
    if (!failures.length || wrongNamespace || remainingMs <= 0) {
      const ordered = [...failures, ...samples.filter(sample => sample.reason === null)];
      return { count: samples.length, failed: failures.length, wrongNamespace,
        samples: ordered.slice(0, 32).map(sample => ({ ...sample, id: sample.id.slice(0, 80) })) };
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remainingMs)));
  }
}
