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
export interface AssetProvenance {
  kind: 'fallback' | 'lux3d' | 'unknown';
  presetId?: string;
  sourceTaskId?: string;
  sourceHash?: string;
  outputHash?: string;
  importedAt?: string;
}
export interface ModelProvenance extends AssetProvenance { schemaVersion: 1; note?: string }
export interface ModelProvenanceView { model: string; verified: boolean; provenance: ModelProvenance; reason?: string }
export interface FallbackPreset { id: string; title: string; available: boolean; description: string; reason?: string }
export interface Asset {
  id: string;
  taskId?: string;
  status: AssetStatus;
  createdAt: string;
  updatedAt: string;
  modelUrl?: string;
  metrics?: ModelMetrics;
  provenance?: AssetProvenance;
  error?: { code: string; message: string };
}
export interface AssetEvent {
  type: 'asset.progress' | 'asset.ready';
  ts: string;
  sequence: number;
  asset: Asset;
}

export type LuxOperation = 'image-to-3d' | 'text-to-3d' | 'image' | 'four-view' |
  'material-transfer' | 'part-split' | 'export' | 'articulation-animation' |
  'humanoid-rig' | 'animation-retarget';
export type LuxTaskStage = 'reserved' | 'uploading' | 'submitting' | 'submit_unknown' |
  'queued' | 'running' | 'ready' | 'failed' | 'cancelled';
export type LuxSubmissionClass = 'blocked' | 'rejected' | 'unknown';
export interface LuxArtifact {
  id: string;
  kind: 'image' | 'model' | 'archive';
  format: string;
  variant: 'original' | 'optimized';
  label?: string;
  /** Set for a single delivered action; omitted when one file contains several clips. */
  animationId?: string;
  /** All clip identities carried by this artifact (combined delivery keeps the list here). */
  animationIds?: string[];
  /** How separate/combined delivery relates files and clips. */
  animationMode?: 'separate' | 'combined';
  bytes: number;
  sha256: string;
  downloadUrl: string;
  previewUrl?: string;
  assetId?: string;
  sourceTaskId?: string;
  sourceUrlHash: string;
}
export interface LuxTask {
  localId: string;
  operation: LuxOperation;
  providerTaskId?: string;
  stage: LuxTaskStage;
  inputRefs: string[];
  parametersHash: string;
  artifacts: LuxArtifact[];
  error?: { code: string; message: string; classification?: LuxSubmissionClass };
  createdAt: string;
  updatedAt: string;
  resumeCandidates?: Array<{ providerTaskId: string; status: number; created?: string }>;
  /** Provenance for a user-confirmed binding when the original response had no task id. */
  manualLink?: { at: string; providerTaskId: string; listedAt: string; candidateCount: number; parametersHash: string };
  note?: string;
}
export interface LuxCapabilities {
  gateway: 'api.aholo.cn';
  activeGateway: string;
  legacyGateway: boolean;
  configured: boolean;
  billingNotice: string;
  operations: Array<{ operation: LuxOperation; label: string; description: string }>;
  upload: { imageMaxBytes: number; modelMaxBytes: number; maxImages: number; maxImagePixels: number };
  limits: { activeLocalTasks: number; maxImages: number; maxActions: number };
}
export interface AssetPlacementTarget {
  kind: 'replace' | 'replace-module' | 'insert';
  src: string;
  cid: string;
  ancestors: string[];
  position: 'before' | 'after' | 'inside';
  /** Present only for replace-module; the server still verifies the instance exists. */
  instanceId?: string;
}
export interface AssetPlacementSession {
  sessionId: string;
  assetId: string;
  baseVersion: string;
  expiresAt: number;
}
export interface AssetPlacementIntent {
  sessionId: string;
  assetId: string;
  baseVersion: string;
  target: AssetPlacementTarget;
}
export type PlacementPreviewMessage =
  | { type: 'placement:target'; payload: { sessionId: string; target: AssetPlacementTarget } }
  | { type: 'placement:slot'; payload: { sessionId: string; rect: [number, number, number, number] | null; isVoidTag?: boolean } }
  | { type: 'placement:cancelled'; payload: { sessionId: string; reason: string } };
export interface TaskEvent { type: string; ts: string; sequence: number; message: string }
export type SpeechErrorCode = 'SPEECH_NOT_CONFIGURED' | 'SPEECH_INVALID_AUDIO' | 'SPEECH_TOO_LARGE' |
  'SPEECH_UNSUPPORTED_MEDIA' | 'SPEECH_UPSTREAM' | 'SPEECH_TIMEOUT' | 'SPEECH_CANCELLED' |
  'SPEECH_BUSY' | 'SPEECH_REQUEST_CONFLICT' | 'SPEECH_NOT_FOUND' | 'SPEECH_CLOSING';
export interface SpeechConfig {
  enabled: boolean;
  provider: 'aliyun';
  model: 'qwen3-asr-flash';
  supportedMimeTypes: string[];
  maxBytes: number;
  maxDurationMs: number;
  notice: string;
}
export interface SpeechResult { requestId: string; text: string; provider: 'aliyun'; model: 'qwen3-asr-flash' }
export interface SpeechCancelResult { requestId: string; status: 'cancelled' | 'completed' }
export interface FileDiff { path: string; patch: string }
export type WorkStarter = 'blank' | 'free-web' | 'product-page' | 'imported';
export interface WorkSummary {
  id: string;
  name: string;
  starter: WorkStarter;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  initialPrompt?: string;
  sourceLabel?: string;
}
export interface WorksState {
  activeId: string;
  works: WorkSummary[];
}
export interface ModelStatusView {
  coding: {
    configured: boolean;
    mode: 'real' | 'mock' | 'unconfigured';
    model: string | null;
    providerHost: string | null;
  };
  speech: {
    configured: boolean;
    mode: 'real' | 'mock' | 'unconfigured';
    model: string;
  };
  lux3d: {
    configured: boolean;
    mode: 'real' | 'mock' | 'unconfigured';
    gateway: string;
    legacyGateway: boolean;
  };
}

export interface Task {
  id: string;
  kind?: 'agent' | 'module';
  bootstrap?: boolean;
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
  | { type: 'viewport:request' }
  | { type: 'placement:start'; payload: { sessionId: string; assetId: string; baseVersion: string } }
  | { type: 'placement:stop'; payload: { sessionId: string } }
  | { type: 'placement:hover'; payload: { sessionId: string; target: AssetPlacementTarget | null } }
  | {
      type: 'placement:preview-layout';
      payload: {
        sessionId: string;
        target: AssetPlacementTarget | null;
        layout: { widthPercent: number; align: 'start' | 'center' | 'end' };
      };
    };
export type PreviewMessage =
  | { type: 'pick:result'; payload: PickSelection }
  | { type: 'viewport:size'; payload: { width: number } }
  /** `sync: false` reports the position without asking the other artboard to follow (no scroll happened). */
  | { type: 'scroll:progress'; payload: { at: number; sync?: boolean } }
  | { type: 'ready' }
  | { type: 'error'; payload: { message: string } };
export type BridgeMessage = StudioMessage | PreviewMessage | PlacementPreviewMessage;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
export function isPlacementTarget(value: unknown): value is AssetPlacementTarget {
  if (!record(value) || !['replace', 'replace-module', 'insert'].includes(String(value.kind)) ||
    typeof value.src !== 'string' || typeof value.cid !== 'string' ||
    !Array.isArray(value.ancestors) || value.ancestors.length > 3 || !value.ancestors.every(item => typeof item === 'string') ||
    !['before', 'after', 'inside'].includes(String(value.position))) return false;
  if (value.kind === 'replace-module') return typeof value.instanceId === 'string' && /^[a-f0-9]{32}$/.test(value.instanceId);
  return value.instanceId === undefined;
}

export function isStudioMessage(value: unknown): value is StudioMessage {
  if (!record(value)) return false;
  if (value.type === 'placement:start' || value.type === 'placement:stop') {
    return record(value.payload) && typeof value.payload.sessionId === 'string' &&
      (value.type === 'placement:stop' || (typeof value.payload.assetId === 'string' && typeof value.payload.baseVersion === 'string'));
  }
  if (value.type === 'placement:hover') return record(value.payload) && typeof value.payload.sessionId === 'string' && (value.payload.target === null || isPlacementTarget(value.payload.target));
  if (value.type === 'placement:preview-layout') {
    if (!record(value.payload) || typeof value.payload.sessionId !== 'string') return false;
    if (value.payload.target !== null && !isPlacementTarget(value.payload.target)) return false;
    const layout = value.payload.layout;
    return record(layout) && typeof layout.widthPercent === 'number' && Number.isFinite(layout.widthPercent) &&
      layout.widthPercent >= 10 && layout.widthPercent <= 100 && ['start', 'center', 'end'].includes(String(layout.align));
  }
  return value.type === 'pick:start' || value.type === 'pick:stop' || value.type === 'viewport:request' ||
    (value.type === 'scroll:to' && record(value.payload) && typeof value.payload.at === 'number' && Number.isFinite(value.payload.at) && value.payload.at >= 0 && value.payload.at <= 1) ||
    (value.type === 'highlight' && record(value.payload) && typeof value.payload.src === 'string');
}
export function isPlacementPreviewMessage(value:unknown):value is PlacementPreviewMessage {
  if(!record(value)||!record(value.payload)||typeof value.payload.sessionId!=='string')return false;
  if(value.type==='placement:slot'){
    const rect=value.payload.rect;
    return (rect===null||(Array.isArray(rect)&&rect.length===4&&rect.every(n=>typeof n==='number'&&Number.isFinite(n)))) &&
      (value.payload.isVoidTag===undefined||typeof value.payload.isVoidTag==='boolean');
  }
  return value.type==='placement:target'?isPlacementTarget(value.payload.target):value.type==='placement:cancelled'&&typeof value.payload.reason==='string';
}
export function isPreviewMessage(value: unknown): value is PreviewMessage {
  if (!record(value)) return false;
  if (value.type === 'ready') return true;
  const p = value.payload;
  if (!record(p)) return false;
  if (value.type === 'error') return typeof p.message === 'string';
  if (value.type === 'viewport:size') return typeof p.width === 'number' && Number.isFinite(p.width) && p.width > 0 && p.width <= 10000;
  if (value.type === 'scroll:progress') return typeof p.at === 'number' && p.at >= 0 && p.at <= 1 && (p.sync === undefined || typeof p.sync === 'boolean');
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
