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

export interface ModelMetrics {
  before: { bytes: number; vertices: number };
  after: { bytes: number; vertices: number };
  webReady?: boolean;
  parts?: { recognized: boolean; reason?: string; lid?: string; nodes: Array<{ sourceIndex: number; name: string; bounds: { min: number[]; max: number[] } }> };
  durationMs: number;
  bounds: { min: number[]; max: number[] };
}
export type AssetStatus = 'submitting' | 'submit_unknown' | 'polling' | 'downloading' | 'processing' | 'ready' | 'failed' | 'cancelled';
export interface Asset {
  id: string;
  taskId?: string;
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  modelUrl?: string;
  metrics?: ModelMetrics;
  error?: { code: string; message: string };
}
export interface AssetEvent {
  type: 'asset.progress' | 'asset.ready';
  ts: string;
  sequence: number;
  asset: Asset;
}
export interface TaskEvent { type: string; ts: string; sequence: number; message: string }
export interface FileDiff { path: string; patch: string }
export interface Task {
  id: string;
  instruction: string;
  selection?: Selection;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  candidateId?: string;
  events: TaskEvent[];
  error?: { code: string; message: string };
}
export interface Candidate {
  id: string;
  candidateCommit?: string;
  baseVersion: string;
  branch: string;
  previewUrl: string;
  diff: FileDiff[];
  outOfScope: string[];
  checks: Check[];
  decision: 'pending' | 'adopted' | 'discarded';
  latestCheckRunId?: string;
}
export interface Check {
  name: 'build' | 'smoke' | 'occlusion' | 'schema';
  status: 'passed' | 'failed' | 'not_run';
  runId?: string;
  message?: string;
  evidence?: string;
}
export type CheckName = Check['name'];
export type CheckStatus = Check['status'];
export type CheckRunStatus = 'queued' | 'running' | 'completed' | 'cancelled';
export type CheckOutcome = 'passed' | 'failed' | 'not_run' | 'blocked' | 'cancelled';
export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  message?: string;
  evidence?: string;
  durationMs?: number;
}
export interface CheckRun {
  id: string;
  candidateId: string;
  baseVersion: string;
  candidateCommit: string;
  contentDigest: string;
  mainVersion: string;
  policyVersion: string;
  status: CheckRunStatus;
  outcome?: CheckOutcome;
  toolIdentity?: string;
  artifacts?: CheckArtifact[];
  checks: CheckResult[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: { code: string; message: string };
}
export interface CheckArtifact { name: string; mime: string; bytes: number; hash: string }
export type ApprovalRuleCode = 'shared_component' | 'global_style' | 'out_of_scope' | 'analysis_uncertain';
export type ApprovalStatus = 'pending' | 'approving' | 'approved' | 'rejected' | 'cancelled' | 'stale' | 'failed';
export interface ApprovalCard {
  id: string;
  taskId: string;
  question: string;
  reason: string;
  options: { label: string; impact: string }[];
  affected: string[];
  evidence: string[];
  status: ApprovalStatus;
  ruleCodes: ApprovalRuleCode[];
  ruleVersion: string;
  baseVersion: string;
  contentDigest: string;
  createdAt: string;
  updatedAt: string;
  answer?: { option: 0 | 1; at: string };
}
export type StudioMessage =
  | { type: 'pick:start' }
  | { type: 'pick:stop' }
  | { type: 'highlight'; payload: { src: string } }
  | { type: 'scroll:to'; payload: { at: number } }
  | { type: 'viewport:request' };
export type PreviewMessage =
  | { type: 'pick:result'; payload: PickSelection }
  | { type: 'viewport:size'; payload: { width: number } }
  | { type: 'scroll:progress'; payload: { at: number } }
  | { type: 'ready' }
  | { type: 'error'; payload: { message: string } };
export type BridgeMessage = StudioMessage | PreviewMessage;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isStudioMessage(value: unknown): value is StudioMessage {
  if (!record(value)) return false;
  return value.type === 'pick:start' || value.type === 'pick:stop' || value.type === 'viewport:request' ||
    (value.type === 'scroll:to' && record(value.payload) && typeof value.payload.at === 'number' && Number.isFinite(value.payload.at) && value.payload.at >= 0 && value.payload.at <= 1) ||
    (value.type === 'highlight' && record(value.payload) && typeof value.payload.src === 'string');
}
export function isPreviewMessage(value: unknown): value is PreviewMessage {
  if (!record(value)) return false;
  if (value.type === 'ready') return true;
  const p = value.payload;
  if (!record(p)) return false;
  if (value.type === 'error') return typeof p.message === 'string';
  if (value.type === 'viewport:size') return typeof p.width === 'number' && Number.isFinite(p.width) && p.width > 0 && p.width <= 10000;
  if (value.type === 'scroll:progress') return typeof p.at === 'number' && p.at >= 0 && p.at <= 1;
  if (value.type !== 'pick:result') return false;
  const styles = p.styles;
  return typeof p.src === 'string' && typeof p.cid === 'string' &&
    (p.text === undefined || typeof p.text === 'string') &&
    (p.note === undefined || p.note === 'outer-container') &&
    Array.isArray(p.bbox) && p.bbox.length === 4 && p.bbox.every(n => typeof n === 'number' && Number.isFinite(n)) &&
    typeof p.instances === 'number' && Number.isInteger(p.instances) && p.instances > 0 &&
    Array.isArray(p.ancestors) && p.ancestors.length <= 3 && p.ancestors.every(s => typeof s === 'string') &&
    record(styles) && ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontFamily',
      'fontWeight', 'lineHeight', 'padding', 'margin', 'borderRadius', 'width', 'height'].every(k => typeof styles[k] === 'string');
}
