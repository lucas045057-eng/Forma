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
  batchId?: string;
  variantLabel?: string;
  variantIndex?: number;
  variantTotal?: number;
  instruction: string;
  selection?: Selection;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  candidateId?: string;
  events: TaskEvent[];
  error?: { code: string; message: string };
}
export interface TaskBatchResult {
  batchId: string;
  tasks: Task[];
}
export interface CandidateVariantPreset {
  key: 'refined' | 'expressive' | 'editorial';
  shortLabel: string;
  label: string;
  summary: string;
  guidance: string;
}
export const CANDIDATE_VARIANT_PRESETS: readonly CandidateVariantPreset[] = [
  {
    key: 'refined',
    shortLabel: '方案 A',
    label: '方案 A · 稳健精致',
    summary: '稳健精致',
    guidance: '采用克制、稳健、易读的高完成度设计：保持清晰信息层级、均衡留白与细腻微交互，严格落实需求与范围，不做多余装饰。',
  },
  {
    key: 'expressive',
    shortLabel: '方案 B',
    label: '方案 B · 对比张力',
    summary: '对比张力',
    guidance: '强化视觉对比、版式节奏与交互反馈：使用更有辨识度的色彩对比、字号张力、按钮状态与细节层次，与稳健方案形成鲜明差异。',
  },
  {
    key: 'editorial',
    shortLabel: '方案 C',
    label: '方案 C · 编排重构',
    summary: '编排重构',
    guidance: '在满足全部功能与范围约束的前提下，尝试更具创意的编排结构、非对称比例或画报感排版节奏，提供真正不同的备选方向。',
  },
] as const;
export function candidateVariants(count: 2 | 3): readonly CandidateVariantPreset[] {
  return CANDIDATE_VARIANT_PRESETS.slice(0, count);
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

export type VoiceCopilotVendor = 'gemini_live' | 'openai_realtime';
export type VoiceCopilotMode = 'unconfigured' | 'mock' | 'real';
export type VoiceCopilotAgentState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceCopilotPreset {
  vendor: VoiceCopilotVendor;
  name: string;
  badge: string;
  defaultModel: string;
  models: string[];
  defaultVoice: string;
  voices: string[];
  defaultUrl: string;
  keyPlaceholder: string;
  docHint: string;
}

export interface VoiceCopilotConfigView {
  configured: boolean;
  mode: VoiceCopilotMode;
  vendor: VoiceCopilotVendor;
  model: string;
  voice: string;
  url: string;
  agoraAppId: string;
  hasAppCertificate: boolean;
  appCertificateMasked: string;
  hasCustomerId: boolean;
  customerIdMasked: string;
  hasCustomerSecret: boolean;
  customerSecretMasked: string;
  hasMllmApiKey: boolean;
  mllmApiKeyMasked: string;
  presets: VoiceCopilotPreset[];
}

export interface VoiceCopilotProbeResult {
  ok: boolean;
  mode: VoiceCopilotMode;
  latencyMs: number;
  status?: number;
  message: string;
  hint?: string;
}

export interface VoiceCopilotSession {
  sessionId: string;
  mode: 'mock' | 'real';
  vendor: VoiceCopilotVendor;
  model: string;
  voice: string;
  agentId: string;
  appId: string;
  channel: string;
  userUid: number;
  agentUid: number;
  rtcToken: string;
  rtmToken: string;
  createdAt: string;
  notice?: string;
}

export type VoiceCopilotAction =
  | { type: 'submit_edit'; instruction: string; variantCount?: 1 | 2 | 3 }
  | { type: 'switch_candidate'; candidateId?: string; mode: 'current' | 'candidate' | 'compare' }
  | { type: 'open_surface'; surface: 'canvas' | 'inspector' | 'scene' | 'assets' }
  | { type: 'toggle_picking'; active: boolean };

export interface VoiceCopilotTranscriptItem {
  id: string;
  turnId: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  status: 'in_progress' | 'completed' | 'interrupted';
  timestamp: number;
  actions?: VoiceCopilotAction[];
}

export interface VoiceCopilotContextPayload {
  kind: 'user_text' | 'selection' | 'candidate_ready' | 'checks_done' | 'work_switched';
  text: string;
  workName?: string;
  selection?: Pick<Selection, 'src' | 'cid' | 'instances' | 'text'> | null;
  candidateSummary?: {
    id: string;
    decision: Candidate['decision'];
    passedChecks: number;
    totalChecks: number;
  };
}

/** Validates structured actions emitted by the real-time voice copilot against the Studio allowlist. */
export function isVoiceCopilotAction(value: unknown): value is VoiceCopilotAction {
  if (!record(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'submit_edit': {
      if (typeof value.instruction !== 'string' || !value.instruction.trim() || value.instruction.length > 4000) {
        return false;
      }
      if (value.variantCount !== undefined && value.variantCount !== 1 && value.variantCount !== 2 && value.variantCount !== 3) {
        return false;
      }
      return true;
    }
    case 'switch_candidate': {
      if (value.candidateId !== undefined && typeof value.candidateId !== 'string') return false;
      return value.mode === 'current' || value.mode === 'candidate' || value.mode === 'compare';
    }
    case 'open_surface':
      return value.surface === 'canvas' || value.surface === 'inspector' || value.surface === 'scene' || value.surface === 'assets';
    case 'toggle_picking':
      return typeof value.active === 'boolean';
    default:
      return false;
  }
}

const FORMA_ACTION_BLOCK = /\[FORMA_ACTION\]([\s\S]*?)\[\/FORMA_ACTION\]/g;

/** Strips `[FORMA_ACTION]{...}[/FORMA_ACTION]` blocks from spoken/transcript text and returns valid actions. */
export function parseVoiceCopilotActions(text: string): { cleanText: string; actions: VoiceCopilotAction[] } {
  const actions: VoiceCopilotAction[] = [];
  const cleanText = text
    .replace(FORMA_ACTION_BLOCK, (_full, body: string) => {
      try {
        const parsed: unknown = JSON.parse(body.trim());
        if (isVoiceCopilotAction(parsed)) actions.push(parsed);
      } catch {
        // Ignore malformed directive payloads without corrupting spoken transcript display.
      }
      return '';
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { cleanText, actions };
}
