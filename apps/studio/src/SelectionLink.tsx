import { useEffect, useRef, useState, type RefObject } from 'react';

type Point = { x: number; y: number };
type Geometry = { from: Point; to: Point };

/**
 * Draws a thin connector from the picked element (inside the preview iframe) to the
 * inspector's target card, so the selection reads as one object across the canvas.
 *
 * The overlay is `pointer-events: none`, so hit-testing, picking and Playwright clicks
 * still land on the iframe underneath. `bbox` is in iframe-viewport CSS pixels at pick
 * time; callers hide the link once the preview scrolls (the bbox would be stale).
 */
export default function SelectionLink({ frame, target, bbox, visible }: {
  frame: RefObject<HTMLIFrameElement | null>;
  target: RefObject<HTMLElement | null>;
  bbox: [number, number, number, number] | null;
  visible: boolean;
}) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  // Iframe size when this bbox was first measured: a later resize reflows the page, so the bbox goes stale.
  const frameSizeAtPick = useRef<{ bbox: unknown; width: number; height: number } | null>(null);

  useEffect(() => {
    if (!visible || !bbox) { setGeometry(null); return; }
    let raf = 0;
    const measure = () => {
      raf = 0;
      const frameNode = frame.current;
      const card = target.current;
      if (!frameNode || !card) { setGeometry(null); return; }
      const f = frameNode.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      if (frameSizeAtPick.current?.bbox !== bbox) frameSizeAtPick.current = { bbox, width: f.width, height: f.height };
      const atPick = frameSizeAtPick.current;
      if (Math.abs(atPick.width - f.width) > 1 || Math.abs(atPick.height - f.height) > 1) { setGeometry(null); return; }
      const [x, y, width, height] = bbox;
      // Anchor on the element's right edge, clamped to the iframe (wide elements overflow it).
      const from = { x: Math.max(f.left + 2, Math.min(f.left + x + width, f.right - 2)), y: f.top + y + height / 2 };
      const insideFrame = x + width > 0 && from.y > f.top && from.y < f.bottom;
      // Clamp the card anchor to the visible part of the scrolling inspector.
      const scroller = card.closest('.inspector')?.getBoundingClientRect();
      // Aim at the middle of the card's header row rather than a fixed offset.
      const header = card.firstElementChild?.getBoundingClientRect();
      const toY = header && header.height > 0 ? header.top + header.height / 2 : c.top + 20;
      const cardVisible = !scroller || (toY > scroller.top + 4 && toY < scroller.bottom - 4);
      setGeometry(insideFrame && cardVisible && c.width > 0 ? { from, to: { x: c.left, y: toY } } : null);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    schedule();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (frame.current) observer?.observe(frame.current);
    if (target.current) observer?.observe(target.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [visible, bbox, frame, target]);

  if (!geometry) return null;
  const { from, to } = geometry;
  const bend = Math.max(40, (to.x - from.x) * 0.45);
  const d = `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
  return <svg className="selection-link" aria-hidden="true" data-testid="selection-link">
    <path className="selection-link-casing" d={d}/>
    <path className="selection-link-line" d={d}/>
    <circle className="selection-link-dot" cx={from.x} cy={from.y} r={4}/>
  </svg>;
}
