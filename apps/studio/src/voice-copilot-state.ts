import {
  parseVoiceCopilotActions,
  type Candidate,
  type Selection,
  type VoiceCopilotAction,
  type VoiceCopilotAgentState,
  type VoiceCopilotContextPayload,
  type VoiceCopilotSession,
  type VoiceCopilotTranscriptItem,
} from '@spatial/shared';

export interface VoiceCopilotHudState {
  active: boolean;
  session: VoiceCopilotSession | null;
  agentState: VoiceCopilotAgentState;
  muted: boolean;
  ttsEnabled: boolean;
  expanded: boolean;
  audioLevel: number;
  transcript: VoiceCopilotTranscriptItem[];
  error: string;
  notice: string;
}

export const initialVoiceCopilotState: VoiceCopilotHudState = {
  active: false,
  session: null,
  agentState: 'idle',
  muted: false,
  ttsEnabled: true,
  expanded: false,
  audioLevel: 0,
  transcript: [],
  error: '',
  notice: '',
};

export type VoiceCopilotHudAction =
  | { type: 'connecting' }
  | { type: 'connected'; session: VoiceCopilotSession }
  | { type: 'set-agent-state'; agentState: VoiceCopilotAgentState }
  | { type: 'toggle-mute' }
  | { type: 'toggle-tts' }
  | { type: 'toggle-expanded' }
  | { type: 'set-expanded'; expanded: boolean }
  | { type: 'set-level'; audioLevel: number }
  | { type: 'upsert-transcript'; item: VoiceCopilotTranscriptItem }
  | { type: 'error'; message: string }
  | { type: 'clear-notice' }
  | { type: 'disconnect' };

const MAX_TRANSCRIPT_ITEMS = 40;

function mergeTranscript(
  list: VoiceCopilotTranscriptItem[],
  incoming: VoiceCopilotTranscriptItem,
): VoiceCopilotTranscriptItem[] {
  const existingIdx = list.findIndex(item => item.role === incoming.role && item.turnId === incoming.turnId);
  const next = [...list];
  if (existingIdx >= 0) {
    next[existingIdx] = incoming;
  } else {
    next.push(incoming);
  }
  return next.length > MAX_TRANSCRIPT_ITEMS ? next.slice(next.length - MAX_TRANSCRIPT_ITEMS) : next;
}

export function reduceVoiceCopilotState(
  state: VoiceCopilotHudState,
  action: VoiceCopilotHudAction,
): VoiceCopilotHudState {
  switch (action.type) {
    case 'connecting':
      return {
        ...state,
        active: true,
        session: null,
        agentState: 'connecting',
        error: '',
        notice: '',
        transcript: [],
        expanded: true,
      };
    case 'connected':
      return {
        ...state,
        active: true,
        session: action.session,
        agentState: 'listening',
        muted: false,
        error: '',
        notice: action.session.notice ?? '',
      };
    case 'set-agent-state':
      return { ...state, agentState: action.agentState };
    case 'toggle-mute':
      return { ...state, muted: !state.muted };
    case 'toggle-tts':
      return { ...state, ttsEnabled: !state.ttsEnabled };
    case 'toggle-expanded':
      return { ...state, expanded: !state.expanded };
    case 'set-expanded':
      return { ...state, expanded: action.expanded };
    case 'set-level':
      return { ...state, audioLevel: Math.max(0, Math.min(100, Math.round(action.audioLevel))) };
    case 'upsert-transcript':
      return { ...state, transcript: mergeTranscript(state.transcript, action.item) };
    case 'error':
      return { ...state, agentState: 'error', error: action.message };
    case 'clear-notice':
      return { ...state, notice: '' };
    case 'disconnect':
      return { ...initialVoiceCopilotState, ttsEnabled: state.ttsEnabled };
  }
}

export interface ParsedStreamResult {
  transcript?: VoiceCopilotTranscriptItem;
  actions: VoiceCopilotAction[];
  agentState?: VoiceCopilotAgentState;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function mapStatus(raw: unknown, isFinal: unknown): VoiceCopilotTranscriptItem['status'] {
  if (raw === 2 || raw === 'interrupted' || raw === 'INTERRUPTED') return 'interrupted';
  if (raw === 1 || raw === 'completed' || raw === 'COMPLETED' || isFinal === true) return 'completed';
  return 'in_progress';
}

function mapState(raw: unknown): VoiceCopilotAgentState | undefined {
  if (raw === 'listening' || raw === 'thinking' || raw === 'speaking' || raw === 'idle') return raw;
  return undefined;
}

/**
 * Decodes both plain JSON payloads and Agora v2 chunked base64 `stream-message` packets
 * (`messageId|partIdx|totalParts|base64Chunk`), returning structured transcripts & actions.
 */
export function parseAgoraStreamPacket(
  payload: Uint8Array,
  assembler: Map<string, string[]>,
): ParsedStreamResult | null {
  const raw = new TextDecoder().decode(payload).trim();
  if (!raw) return null;

  let jsonText = raw;
  if (!raw.startsWith('{')) {
    const parts = raw.split('|');
    if (parts.length !== 4) return null;
    const [msgId, idxStr, totalStr, chunk] = parts;
    const idx = Number(idxStr);
    const total = Number(totalStr);
    if (!msgId || !Number.isInteger(idx) || !Number.isInteger(total) || idx < 1 || total < 1 || idx > total || total > 64) {
      return null;
    }
    const bucket = assembler.get(msgId) ?? new Array<string>(total).fill('');
    bucket[idx - 1] = chunk;
    assembler.set(msgId, bucket);
    if (bucket.some(item => !item)) return null;
    assembler.delete(msgId);
    if (assembler.size > 64) {
      const oldestKey = assembler.keys().next().value;
      if (oldestKey) assembler.delete(oldestKey);
    }
    try {
      jsonText = decodeBase64Utf8(bucket.join(''));
    } catch {
      return null;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed)) return null;

  const objectKind = typeof parsed.object === 'string' ? parsed.object : '';
  if (objectKind === 'agent.state') {
    const nextState = mapState(parsed.state);
    return nextState ? { actions: [], agentState: nextState } : null;
  }

  const rawText = typeof parsed.text === 'string' ? parsed.text : '';
  if (!rawText && objectKind !== 'assistant.transcription' && objectKind !== 'user.transcription') {
    return null;
  }

  const role: VoiceCopilotTranscriptItem['role'] =
    objectKind === 'user.transcription' || parsed.role === 'user' ? 'user' : 'agent';
  const turnId = typeof parsed.turn_id === 'number' && Number.isFinite(parsed.turn_id) ? parsed.turn_id : Date.now();
  const status = mapStatus(parsed.turn_status ?? parsed.status, parsed.is_final);
  const { cleanText, actions } = role === 'agent' ? parseVoiceCopilotActions(rawText) : { cleanText: rawText, actions: [] };

  if (!cleanText && actions.length === 0) return null;

  return {
    transcript: {
      id: `${role}-${turnId}`,
      turnId,
      role,
      text: cleanText,
      status,
      timestamp: typeof parsed.timestamp === 'number' ? parsed.timestamp : Date.now(),
      ...(actions.length > 0 ? { actions } : {}),
    },
    actions,
    agentState: role === 'agent' ? (status === 'in_progress' ? 'speaking' : 'listening') : 'thinking',
  };
}

export function buildCanvasThinkPayload(input: {
  kind: VoiceCopilotContextPayload['kind'];
  text: string;
  workName?: string;
  selection?: Selection | null;
  candidate?: Candidate;
}): VoiceCopilotContextPayload {
  const selection = input.selection
    ? {
        src: input.selection.src,
        cid: input.selection.cid,
        instances: input.selection.instances,
        ...(input.selection.text ? { text: input.selection.text.slice(0, 240) } : {}),
      }
    : input.selection === null
      ? null
      : undefined;

  const candidateSummary = input.candidate
    ? {
        id: input.candidate.id,
        decision: input.candidate.decision,
        passedChecks: input.candidate.checks.filter(c => c.status === 'passed').length,
        totalChecks: input.candidate.checks.length,
      }
    : undefined;

  return {
    kind: input.kind,
    text: input.text,
    ...(input.workName ? { workName: input.workName } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...(candidateSummary ? { candidateSummary } : {}),
  };
}
