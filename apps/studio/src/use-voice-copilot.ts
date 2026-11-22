import { useEffect, useReducer, useRef, useState } from 'react';
import type {
  Candidate,
  Selection,
  VoiceCopilotAction,
  VoiceCopilotConfigView,
  VoiceCopilotContextPayload,
  VoiceCopilotSession,
} from '@spatial/shared';
import type { PreviewMode } from './CandidatePanel.tsx';
import { api, mutation } from './api.ts';
import type { SurfaceAction } from './surface-state.ts';
import type { AgoraVoiceTransportHandle } from './voice-copilot-agora.ts';
import {
  buildCanvasThinkPayload,
  initialVoiceCopilotState,
  reduceVoiceCopilotState,
} from './voice-copilot-state.ts';

interface ThinkResponse {
  ok: boolean;
  mode: 'mock' | 'real';
  replyText?: string;
  actions?: VoiceCopilotAction[];
}

interface NativeSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type NativeRecognitionCtor = new () => NativeSpeechRecognition;

function isRecognitionCtor(value: unknown): value is NativeRecognitionCtor {
  return typeof value === 'function';
}

function getSpeechRecognitionCtor(): NativeRecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const ctor: unknown = Reflect.get(window, 'SpeechRecognition') ?? Reflect.get(window, 'webkitSpeechRecognition');
  return isRecognitionCtor(ctor) ? ctor : undefined;
}

export interface UseVoiceCopilotOptions {
  workName: string;
  selection: Selection | null;
  pendingCandidates: Candidate[];
  onSubmitEdit: (instruction: string, variantCount: 1 | 2 | 3) => Promise<void>;
  onSwitchCandidate: (mode: PreviewMode, candidateId?: string) => void;
  onDispatchSurface: (action: SurfaceAction) => void;
  onSetPicking: (active: boolean) => void;
}

/** Coordinates Forma's real-time Agora MLLM / local Mock Jarvis copilot with canvas context & actions. */
export function useVoiceCopilot(options: UseVoiceCopilotOptions) {
  const [state, dispatch] = useReducer(reduceVoiceCopilotState, initialVoiceCopilotState);
  const [config, setConfig] = useState<VoiceCopilotConfigView | null>(null);
  const [micRecognizing, setMicRecognizing] = useState(false);

  const transportRef = useRef<AgoraVoiceTransportHandle | null>(null);
  const recognitionRef = useRef<NativeSpeechRecognition | null>(null);
  const sessionRef = useRef<VoiceCopilotSession | null>(null);
  sessionRef.current = state.session;

  const turnCounter = useRef(0);
  const prevSelectionKey = useRef<string>('');
  const announcedCandidates = useRef(new Set<string>());
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const stateRef = useRef(state);
  stateRef.current = state;

  async function refreshConfig() {
    const view = await api<VoiceCopilotConfigView>('/speech/copilot/config');
    setConfig(view);
    return view;
  }

  useEffect(() => {
    let mounted = true;
    void api<VoiceCopilotConfigView>('/speech/copilot/config')
      .then(view => {
        if (mounted) setConfig(view);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  function speakLocal(text: string) {
    if (!stateRef.current.ttsEnabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.08;
      dispatch({ type: 'set-agent-state', agentState: 'speaking' });
      utterance.onend = () => {
        if (sessionRef.current) dispatch({ type: 'set-agent-state', agentState: 'listening' });
      };
      utterance.onerror = () => {
        if (sessionRef.current) dispatch({ type: 'set-agent-state', agentState: 'listening' });
      };
      window.speechSynthesis.speak(utterance);
    } catch {
      // Ignore Web Speech Synthesis failures on headless browsers.
    }
  }

  function executeActions(actions: VoiceCopilotAction[]) {
    for (const action of actions) {
      switch (action.type) {
        case 'submit_edit':
          void optionsRef.current.onSubmitEdit(action.instruction, action.variantCount ?? 1);
          break;
        case 'switch_candidate':
          optionsRef.current.onSwitchCandidate(action.mode, action.candidateId);
          break;
        case 'open_surface': {
          if (action.surface === 'canvas') optionsRef.current.onDispatchSurface({ type: 'close' });
          else if (action.surface === 'inspector') optionsRef.current.onDispatchSurface({ type: 'open-inspector' });
          else if (action.surface === 'assets') optionsRef.current.onDispatchSurface({ type: 'toggle-assets' });
          else if (action.surface === 'scene') optionsRef.current.onDispatchSurface({ type: 'toggle-scene' });
          break;
        }
        case 'toggle_picking':
          optionsRef.current.onSetPicking(action.active);
          break;
      }
    }
  }

  async function pushContext(payload: VoiceCopilotContextPayload, addUserTurn = false) {
    const session = sessionRef.current;
    if (!session) return;

    if (addUserTurn) {
      const turnId = ++turnCounter.current;
      dispatch({
        type: 'upsert-transcript',
        item: {
          id: `user-${turnId}`,
          turnId,
          role: 'user',
          text: payload.text,
          status: 'completed',
          timestamp: Date.now(),
        },
      });
    }

    if (session.mode === 'mock') {
      dispatch({ type: 'set-agent-state', agentState: 'thinking' });
    }
    try {
      const res = await api<ThinkResponse>(
        `/speech/copilot/sessions/${encodeURIComponent(session.sessionId)}/think`,
        mutation('POST', payload),
      );
      if (res.mode === 'mock' && res.replyText) {
        const replyTurnId = ++turnCounter.current;
        dispatch({
          type: 'upsert-transcript',
          item: {
            id: `agent-${replyTurnId}`,
            turnId: replyTurnId,
            role: 'agent',
            text: res.replyText,
            status: 'completed',
            timestamp: Date.now(),
            ...(res.actions && res.actions.length > 0 ? { actions: res.actions } : {}),
          },
        });
        dispatch({ type: 'set-agent-state', agentState: 'listening' });
        if (res.actions && res.actions.length > 0) {
          executeActions(res.actions);
        }
        if (addUserTurn || payload.kind === 'candidate_ready' || payload.kind === 'checks_done') {
          speakLocal(res.replyText);
        }
      }
    } catch (error) {
      dispatch({
        type: 'error',
        message: error instanceof Error ? error.message : '向语音副驾发送上下文失败',
      });
    }
  }

  useEffect(() => {
    if (!state.active || !state.session) return;
    const sel = options.selection;
    const key = sel ? `${sel.src}|${sel.baseVersion}` : 'whole-page';
    if (prevSelectionKey.current === '' || prevSelectionKey.current === key) {
      prevSelectionKey.current = key;
      return;
    }
    prevSelectionKey.current = key;
    const payload = buildCanvasThinkPayload({
      kind: 'selection',
      text: sel ? `用户刚刚点选了组件 ${sel.cid} (${sel.src})` : '用户取消了局部点选，恢复整页上下文',
      workName: options.workName,
      selection: sel,
    });
    void pushContext(payload, false);
  }, [state.active, state.session, options.selection, options.workName]);

  useEffect(() => {
    if (!state.active || !state.session) return;
    for (const candidate of options.pendingCandidates) {
      const passedCount = candidate.checks.filter(c => c.status === 'passed').length;
      const doneCount = candidate.checks.filter(c => c.status !== 'not_run').length;
      const readyKey = `ready:${candidate.id}`;
      const checkedKey = `checked:${candidate.id}:${passedCount}:${doneCount}`;
      if (!announcedCandidates.current.has(readyKey)) {
        announcedCandidates.current.add(readyKey);
        const payload = buildCanvasThinkPayload({
          kind: doneCount === candidate.checks.length ? 'checks_done' : 'candidate_ready',
          text: `候选 ${candidate.id.slice(0, 8)} 已就绪`,
          workName: options.workName,
          candidate,
        });
        void pushContext(payload, false);
      } else if (doneCount === candidate.checks.length && !announcedCandidates.current.has(checkedKey)) {
        announcedCandidates.current.add(checkedKey);
        const payload = buildCanvasThinkPayload({
          kind: 'checks_done',
          text: `候选 ${candidate.id.slice(0, 8)} 质量门禁检查完成`,
          workName: options.workName,
          candidate,
        });
        void pushContext(payload, false);
      }
    }
  }, [state.active, state.session, options.pendingCandidates, options.workName]);

  async function stopSession() {
    const activeSession = sessionRef.current;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    setMicRecognizing(false);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    const handle = transportRef.current;
    transportRef.current = null;
    if (handle) await handle.stop();
    if (activeSession) {
      await api(`/speech/copilot/sessions/${encodeURIComponent(activeSession.sessionId)}`, mutation('DELETE')).catch(
        () => {},
      );
    }
    dispatch({ type: 'disconnect' });
  }

  useEffect(() => {
    return () => {
      void stopSession();
    };
  }, []);

  async function startSession(preferMock = false) {
    if (stateRef.current.active) return;
    dispatch({ type: 'connecting' });
    prevSelectionKey.current = optionsRef.current.selection
      ? `${optionsRef.current.selection.src}|${optionsRef.current.selection.baseVersion}`
      : 'whole-page';
    for (const c of optionsRef.current.pendingCandidates) {
      announcedCandidates.current.add(`ready:${c.id}`);
    }

    try {
      const session = await api<VoiceCopilotSession>(
        '/speech/copilot/sessions',
        mutation('POST', { workName: optionsRef.current.workName, ...(preferMock ? { preferMock: true } : {}) }),
      );
      if (session.mode === 'real') {
        const { startAgoraVoiceTransport } = await import('./voice-copilot-agora.ts');
        transportRef.current = await startAgoraVoiceTransport(session, {
          onAgentState: agentState => dispatch({ type: 'set-agent-state', agentState }),
          onVolumeLevel: level => dispatch({ type: 'set-level', audioLevel: level }),
          onTranscript: (item, actions) => {
            dispatch({ type: 'upsert-transcript', item });
            if (actions.length > 0) executeActions(actions);
          },
          onError: message => dispatch({ type: 'error', message }),
        });
      }
      dispatch({ type: 'connected', session });
      const greeting =
        session.mode === 'mock'
          ? '贾维斯模拟演练已上线。你可以点画布上的元素，直接打字或用浏览器麦克风对我下达设计指令。'
          : '已接入声网国际版实时语音通道，随时直接开口对话或点选页面元素。';
      const tid = ++turnCounter.current;
      dispatch({
        type: 'upsert-transcript',
        item: { id: `agent-${tid}`, turnId: tid, role: 'agent', text: greeting, status: 'completed', timestamp: Date.now() },
      });
    } catch (error) {
      dispatch({ type: 'error', message: error instanceof Error ? error.message : '启动实时语音副驾失败' });
    }
  }

  async function toggleMute() {
    const nextMuted = !stateRef.current.muted;
    dispatch({ type: 'toggle-mute' });
    await transportRef.current?.setMuted(nextMuted).catch(() => {});
  }

  async function interrupt() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    const active = sessionRef.current;
    if (!active) return;
    dispatch({ type: 'set-agent-state', agentState: 'listening' });
    await api(`/speech/copilot/sessions/${encodeURIComponent(active.sessionId)}/interrupt`, mutation('POST')).catch(
      () => {},
    );
  }

  async function sendTextTurn(text: string) {
    const clean = text.trim();
    if (!clean || !sessionRef.current) return;
    const payload = buildCanvasThinkPayload({
      kind: 'user_text',
      text: clean,
      workName: optionsRef.current.workName,
      selection: optionsRef.current.selection,
    });
    await pushContext(payload, true);
  }

  function startBrowserDictation() {
    if (micRecognizing) {
      recognitionRef.current?.stop();
      setMicRecognizing(false);
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      dispatch({ type: 'error', message: '当前浏览器不支持免密钥 Web Speech 麦克风听写，请直接输入文字演练或配置声网密钥。' });
      return;
    }
    const recognition = new Ctor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    let finalText = '';
    recognition.onresult = event => {
      finalText = Array.from(event.results)
        .filter(item => item.isFinal)
        .map(item => item[0].transcript)
        .join('')
        .trim();
    };
    recognition.onerror = () => {
      setMicRecognizing(false);
    };
    recognition.onend = () => {
      setMicRecognizing(false);
      if (finalText) void sendTextTurn(finalText);
    };
    recognitionRef.current = recognition;
    setMicRecognizing(true);
    recognition.start();
  }

  return {
    state,
    config,
    setConfig,
    refreshConfig,
    micRecognizing,
    supportsBrowserDictation: Boolean(getSpeechRecognitionCtor()),
    startSession,
    stopSession,
    toggleMute,
    toggleTts: () => dispatch({ type: 'toggle-tts' }),
    toggleExpanded: () => dispatch({ type: 'toggle-expanded' }),
    clearNotice: () => dispatch({ type: 'clear-notice' }),
    interrupt,
    sendTextTurn,
    startBrowserDictation,
  };
}
