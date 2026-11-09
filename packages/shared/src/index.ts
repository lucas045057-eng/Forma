export type SelectionStyles = Pick<CSSStyleDeclaration,
  'display' | 'position' | 'color' | 'backgroundColor' | 'fontSize' | 'fontFamily' |
  'fontWeight' | 'lineHeight' | 'padding' | 'margin' | 'borderRadius' | 'width' | 'height'>;

export interface Selection {
  src: string;
  cid: string;
  text?: string;
  /** Viewport-relative [x, y, width, height], CSS pixels. */
  bbox: [number, number, number, number];
  styles: SelectionStyles;
  instances: number;
  ancestors: string[];
  note?: 'outer-container';
  baseVersion: string;
}
export type PickSelection = Omit<Selection, 'baseVersion'>;
export interface TaskEvent { type: string; ts: string; sequence: number; message: string }
export interface FileDiff { path: string; patch: string }
export interface Task {
  id: string;
  instruction: string;
  selection?: Selection;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  candidateId?: string;
  events: TaskEvent[];
}
export interface Candidate {
  id: string;
  baseVersion: string;
  branch: string;
  previewUrl: string;
  diff: FileDiff[];
  checks: Check[];
  decision: 'pending' | 'adopted' | 'discarded';
}
export interface Check {
  name: 'build' | 'smoke' | 'occlusion' | 'schema';
  status: 'passed' | 'failed' | 'not_run';
  evidence?: string;
}
export interface ApprovalCard {
  id: string;
  taskId: string;
  question: string;
  reason: string;
  options: { label: string; impact: string }[];
  affected: string[];
  answer?: { option: number; at: string };
}
export type StudioMessage =
  | { type: 'pick:start' }
  | { type: 'pick:stop' }
  | { type: 'highlight'; payload: { src: string } };
export type PreviewMessage =
  | { type: 'pick:result'; payload: PickSelection }
  | { type: 'scroll:progress'; payload: { at: number } }
  | { type: 'ready' }
  | { type: 'error'; payload: { message: string } };
export type BridgeMessage = StudioMessage | PreviewMessage;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isStudioMessage(value: unknown): value is StudioMessage {
  if (!record(value)) return false;
  return value.type === 'pick:start' || value.type === 'pick:stop' ||
    (value.type === 'highlight' && record(value.payload) && typeof value.payload.src === 'string');
}
export function isPreviewMessage(value: unknown): value is PreviewMessage {
  if (!record(value)) return false;
  if (value.type === 'ready') return true;
  const p = value.payload;
  if (!record(p)) return false;
  if (value.type === 'error') return typeof p.message === 'string';
  if (value.type === 'scroll:progress') return typeof p.at === 'number' && p.at >= 0 && p.at <= 1;
  if (value.type !== 'pick:result') return false;
  return typeof p.src === 'string' && typeof p.cid === 'string' &&
    (p.text === undefined || typeof p.text === 'string') &&
    (p.note === undefined || p.note === 'outer-container') &&
    Array.isArray(p.bbox) && p.bbox.length === 4 && p.bbox.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    typeof p.instances === 'number' && Number.isInteger(p.instances) && p.instances > 0 &&
    Array.isArray(p.ancestors) && p.ancestors.length <= 3 && p.ancestors.every(s => typeof s === 'string') &&
    record(p.styles) && ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontFamily',
      'fontWeight', 'lineHeight', 'padding', 'margin', 'borderRadius', 'width', 'height'].every(k => typeof p.styles[k] === 'string');
}
