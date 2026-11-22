import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { VoiceCopilotAgentState, VoiceCopilotConfigView } from '@spatial/shared';
import type { VoiceCopilotHudState } from './voice-copilot-state.ts';

const AGENT_STATE_LABELS: Record<VoiceCopilotAgentState, string> = {
  idle: '待命',
  connecting: '正在连麦…',
  listening: '聆听中',
  thinking: '思考中…',
  speaking: '贾维斯说话中',
  error: '连接异常',
};

const QUICK_PROMPTS = [
  '开启选取',
  '把选中按钮改成高级暖金色，出 2 个方案',
  '打开并排对比看看效果',
  '打开 3D 资产抽屉',
];

export interface VoiceCopilotHudProps {
  state: VoiceCopilotHudState;
  config: VoiceCopilotConfigView | null;
  micRecognizing: boolean;
  supportsDictation: boolean;
  onToggleMute: () => void;
  onToggleTts: () => void;
  onToggleExpanded: () => void;
  onInterrupt: () => void;
  onDisconnect: () => void;
  onOpenConfig: () => void;
  onSendText: (text: string) => Promise<void>;
  onStartDictation: () => void;
}

export default function VoiceCopilotHud({
  state,
  config,
  micRecognizing,
  supportsDictation,
  onToggleMute,
  onToggleTts,
  onToggleExpanded,
  onInterrupt,
  onDisconnect,
  onOpenConfig,
  onSendText,
  onStartDictation,
}: VoiceCopilotHudProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.transcript.length, state.expanded]);

  if (!state.active) return null;

  const isMock = state.session?.mode === 'mock' || (!state.session && config?.mode !== 'real');
  const vendorBadge = isMock
    ? '本地 Mock 演练'
    : state.session?.vendor === 'openai_realtime'
      ? 'Agora · OpenAI Realtime'
      : 'Agora · Gemini Live';

  const waveFactor =
    state.agentState === 'speaking'
      ? 0.85
      : state.agentState === 'listening'
        ? Math.max(0.28, state.audioLevel / 100)
        : 0.16;

  async function submitDraft(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await onSendText(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <aside
      className={`island voice-hud${state.expanded ? ' is-expanded' : ''}`}
      aria-label="贾维斯实时语音副驾"
      data-testid="voice-copilot-hud"
      data-agent-state={state.agentState}
      data-mode={isMock ? 'mock' : 'real'}
    >
      <div className="voice-hud-bar">
        <div className={`voice-wave state-${state.agentState}`} aria-hidden="true">
          {[0.65, 1, 0.82, 0.94, 0.58].map((mult, index) => (
            <span
              key={index}
              style={{ transform: `scaleY(${Math.min(1, 0.24 + waveFactor * mult)})` }}
            />
          ))}
        </div>

        <div className="voice-hud-meta">
          <div className="voice-hud-title-row">
            <strong>Jarvis 副驾</strong>
            <span className={`meta-tag ${isMock ? '' : 'is-accent'}`} data-testid="voice-mode-badge">
              {vendorBadge}
            </span>
          </div>
          <span className="voice-hud-status" data-testid="voice-agent-state">
            {AGENT_STATE_LABELS[state.agentState]}
            {state.muted ? ' · 已静音' : ''}
          </span>
        </div>

        <div className="voice-hud-controls">
          {!isMock && (
            <button
              type="button"
              className={`ghost-btn compact-btn${state.muted ? ' is-warn' : ''}`}
              data-testid="voice-mute-btn"
              onClick={onToggleMute}
            >
              {state.muted ? '取消静音' : '静音'}
            </button>
          )}
          {isMock && (
            <button
              type="button"
              className="ghost-btn compact-btn"
              data-testid="voice-tts-btn"
              title="切换本地语音朗读反馈"
              onClick={onToggleTts}
            >
              {state.ttsEnabled ? '播报开' : '播报关'}
            </button>
          )}
          <button
            type="button"
            className="secondary-btn compact-btn"
            data-testid="voice-interrupt-btn"
            disabled={state.agentState === 'connecting'}
            onClick={onInterrupt}
          >
            打断
          </button>
          <button
            type="button"
            className="ghost-btn compact-btn"
            data-testid="voice-expand-btn"
            onClick={onToggleExpanded}
          >
            {state.expanded ? '收起对话' : '字幕与指令'}
          </button>
          <button
            type="button"
            className="ghost-btn compact-btn"
            data-testid="voice-config-open-from-hud"
            title="配置声网与 Gemini/OpenAI 密钥"
            onClick={onOpenConfig}
          >
            声网配置
          </button>
          <button
            type="button"
            className="ghost-btn compact-btn is-danger"
            data-testid="voice-disconnect-btn"
            onClick={onDisconnect}
          >
            挂断
          </button>
        </div>
      </div>

      {state.expanded && (
        <div className="voice-hud-drawer" data-testid="voice-hud-drawer">
          {state.notice && (
            <p className="voice-hud-notice" role="status">
              {state.notice}{' '}
              <button type="button" className="inline-link-btn" onClick={onOpenConfig}>
                填入声网密钥
              </button>
            </p>
          )}
          {state.error && (
            <p className="error" role="alert" data-testid="voice-hud-error">
              {state.error}
            </p>
          )}

          <div className="voice-transcript" ref={logRef} data-testid="voice-transcript-list">
            {state.transcript.length === 0 ? (
              <p className="voice-transcript-empty">等待语音或指令输入…</p>
            ) : (
              state.transcript.map(item => (
                <div key={item.id} className={`voice-turn role-${item.role}`}>
                  <span className="voice-turn-role">
                    {item.role === 'user' ? '你' : item.role === 'agent' ? 'Jarvis' : '系统'}
                  </span>
                  <div className="voice-turn-body">
                    <p>{item.text}</p>
                    {item.actions && item.actions.length > 0 && (
                      <div className="voice-turn-actions">
                        {item.actions.map((act, idx) => (
                          <span key={idx} className="meta-tag is-accent">
                            ⚡ {act.type}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {isMock && (
            <div className="voice-quick-chips" role="group" aria-label="快捷演练指令">
              {QUICK_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  type="button"
                  className="chip-btn"
                  disabled={sending}
                  onClick={() => void onSendText(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}

          <form className="voice-input-row" onSubmit={event => void submitDraft(event)}>
            <input
              type="text"
              data-testid="voice-text-input"
              value={draft}
              disabled={sending || !state.session}
              onChange={event => setDraft(event.target.value)}
              placeholder={
                isMock
                  ? '输入或点击麦克风说出设计意图，例如：“把这个按钮改成暖琥珀色出 2 个方案”'
                  : '向声网通话中静默注入文本补充说明（或直接对着麦克风说话）…'
              }
            />
            {isMock && supportsDictation && (
              <button
                type="button"
                className={`secondary-btn compact-btn${micRecognizing ? ' is-recording' : ''}`}
                data-testid="voice-dictation-btn"
                disabled={!state.session}
                onClick={onStartDictation}
              >
                {micRecognizing ? '识别中…' : '语音说一句'}
              </button>
            )}
            <button
              type="submit"
              className="primary-btn compact-btn"
              data-testid="voice-send-btn"
              disabled={sending || !draft.trim() || !state.session}
            >
              发送
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}
