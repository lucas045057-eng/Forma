import { useEffect, useState, type FormEvent } from 'react';
import type {
  VoiceCopilotConfigView,
  VoiceCopilotPreset,
  VoiceCopilotProbeResult,
  VoiceCopilotVendor,
} from '@spatial/shared';
import { api, mutation } from './api.ts';

interface SaveCopilotResponse {
  ok: boolean;
  config: VoiceCopilotConfigView;
}

export interface VoiceCopilotConfigModalProps {
  onClose: () => void;
  onSaved: (config: VoiceCopilotConfigView) => void;
}

export default function VoiceCopilotConfigModal({ onClose, onSaved }: VoiceCopilotConfigModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [showSecrets, setShowSecrets] = useState(false);

  const [presets, setPresets] = useState<VoiceCopilotPreset[]>([]);
  const [vendor, setVendor] = useState<VoiceCopilotVendor>('gemini_live');
  const [model, setModel] = useState('gemini-2.5-flash-native-audio-preview');
  const [voice, setVoice] = useState('Aoede');
  const [url, setUrl] = useState('');

  const [agoraAppId, setAgoraAppId] = useState('');
  const [agoraAppCertificate, setAgoraAppCertificate] = useState('');
  const [agoraCustomerId, setAgoraCustomerId] = useState('');
  const [agoraCustomerSecret, setAgoraCustomerSecret] = useState('');
  const [mllmApiKey, setMllmApiKey] = useState('');

  const [statusMeta, setStatusMeta] = useState<VoiceCopilotConfigView | null>(null);
  const [probeResult, setProbeResult] = useState<VoiceCopilotProbeResult | null>(null);
  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');

  useEffect(() => {
    let active = true;
    void api<VoiceCopilotConfigView>('/speech/copilot/config')
      .then(view => {
        if (!active) return;
        setStatusMeta(view);
        setPresets(view.presets ?? []);
        setVendor(view.vendor);
        setModel(view.model);
        setVoice(view.voice);
        setUrl(view.url);
        setAgoraAppId(view.agoraAppId);
        setLoading(false);
      })
      .catch(err => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取声网实时语音配置失败');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentPreset = presets.find(item => item.vendor === vendor) ?? presets[0];

  function switchVendor(nextVendor: VoiceCopilotVendor) {
    setVendor(nextVendor);
    setProbeResult(null);
    setError('');
    setSaveNotice('');
    const found = presets.find(item => item.vendor === nextVendor);
    if (found) {
      setModel(found.defaultModel);
      setVoice(found.defaultVoice);
      setUrl(found.defaultUrl);
    }
  }

  function buildPayload(persist = true) {
    return {
      vendor,
      model: model.trim(),
      voice: voice.trim(),
      url: url.trim(),
      agoraAppId: agoraAppId.trim(),
      ...(agoraAppCertificate.trim() ? { agoraAppCertificate: agoraAppCertificate.trim() } : {}),
      ...(agoraCustomerId.trim() ? { agoraCustomerId: agoraCustomerId.trim() } : {}),
      ...(agoraCustomerSecret.trim() ? { agoraCustomerSecret: agoraCustomerSecret.trim() } : {}),
      ...(mllmApiKey.trim() ? { mllmApiKey: mllmApiKey.trim() } : {}),
      persist,
    };
  }

  async function handleProbe() {
    setProbing(true);
    setError('');
    setSaveNotice('');
    setProbeResult(null);
    try {
      const res = await api<VoiceCopilotProbeResult>('/speech/copilot/test', mutation('POST', buildPayload(false)));
      setProbeResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : '测试声网连通性失败');
    } finally {
      setProbing(false);
    }
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaveNotice('');
    try {
      const saved = await api<SaveCopilotResponse>('/speech/copilot/config', mutation('PUT', buildPayload(true)));
      setStatusMeta(saved.config);
      setAgoraAppCertificate('');
      setAgoraCustomerId('');
      setAgoraCustomerSecret('');
      setMllmApiKey('');
      onSaved(saved.config);
      setSaveNotice(
        saved.config.mode === 'real'
          ? '声网实时语音与 MLLM 配置已保存，点击底部「实时语音」即可真声连麦！'
          : '配置已写入本地 .env（密钥尚未填全，当前仍支持 Mock 演练）。',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存实时语音配置失败');
    } finally {
      setSaving(false);
    }
  }

  const busy = loading || saving || probing;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={event => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="new-work-modal voice-config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="配置声网实时语音副驾"
        data-testid="voice-config-modal"
      >
        <header className="modal-header">
          <div>
            <span className="section-label">AGORA CONVO AI · MLLM</span>
            <h2>贾维斯实时语音配置（声网国际版）</h2>
          </div>
          <button type="button" className="ghost-btn compact-btn" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>

        <form className="modal-form" onSubmit={event => void handleSave(event)}>
          <div className="voice-modal-guide">
            <strong>4 步接入（console.agora.io 国际版每月送 300 分钟）：</strong>
            <span>1) 建 Secured 项目拿 App ID 与 Primary Certificate；2) 开启 Conversational AI Engine；3) 右上角 RESTful API 拿 Customer ID / Secret；4) 填 Gemini 或 OpenAI Realtime Key。</span>
          </div>

          <div className="modal-mode-tabs" role="tablist" aria-label="选择实时多模态语音引擎">
            <button
              type="button"
              role="tab"
              aria-selected={vendor === 'gemini_live'}
              className={`modal-tab-btn${vendor === 'gemini_live' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => switchVendor('gemini_live')}
            >
              Google Gemini Live（推荐）
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={vendor === 'openai_realtime'}
              className={`modal-tab-btn${vendor === 'openai_realtime' ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => switchVendor('openai_realtime')}
            >
              OpenAI Realtime API
            </button>
          </div>

          {currentPreset && <p className="model-doc-hint">{currentPreset.docHint}</p>}

          <div className="voice-config-grid">
            <label className="modal-field">
              <span>Agora App ID</span>
              <input
                data-testid="voice-agora-app-id"
                placeholder="32 位项目 App ID"
                value={agoraAppId}
                disabled={busy}
                onChange={e => {
                  setAgoraAppId(e.target.value);
                  setProbeResult(null);
                }}
              />
            </label>
            <label className="modal-field">
              <span>
                App Certificate{' '}
                {statusMeta?.hasAppCertificate && (
                  <strong className="model-key-ok">({statusMeta.appCertificateMasked})</strong>
                )}
              </span>
              <input
                type={showSecrets ? 'text' : 'password'}
                data-testid="voice-agora-cert"
                placeholder={statusMeta?.hasAppCertificate ? '已保存，留空保持不变' : 'Primary Certificate'}
                value={agoraAppCertificate}
                disabled={busy}
                onChange={e => setAgoraAppCertificate(e.target.value)}
              />
            </label>
            <label className="modal-field">
              <span>
                Customer ID{' '}
                {statusMeta?.hasCustomerId && <strong className="model-key-ok">({statusMeta.customerIdMasked})</strong>}
              </span>
              <input
                type={showSecrets ? 'text' : 'password'}
                data-testid="voice-agora-customer-id"
                placeholder={statusMeta?.hasCustomerId ? '已保存，留空保持不变' : 'RESTful API Customer ID'}
                value={agoraCustomerId}
                disabled={busy}
                onChange={e => setAgoraCustomerId(e.target.value)}
              />
            </label>
            <label className="modal-field">
              <span>
                Customer Secret{' '}
                {statusMeta?.hasCustomerSecret && (
                  <strong className="model-key-ok">({statusMeta.customerSecretMasked})</strong>
                )}
              </span>
              <input
                type={showSecrets ? 'text' : 'password'}
                data-testid="voice-agora-customer-secret"
                placeholder={statusMeta?.hasCustomerSecret ? '已保存，留空保持不变' : 'RESTful API Customer Secret'}
                value={agoraCustomerSecret}
                disabled={busy}
                onChange={e => setAgoraCustomerSecret(e.target.value)}
              />
            </label>
          </div>

          <div className="modal-field">
            <div className="model-field-row">
              <span>
                MLLM API Key{' '}
                {statusMeta?.hasMllmApiKey ? (
                  <strong className="model-key-ok">（已配置 {statusMeta.mllmApiKeyMasked}）</strong>
                ) : (
                  <strong className="model-key-missing">（尚未配置）</strong>
                )}
              </span>
              <button type="button" className="inline-link-btn" onClick={() => setShowSecrets(v => !v)}>
                {showSecrets ? '隐藏密钥' : '显示明文'}
              </button>
            </div>
            <input
              type={showSecrets ? 'text' : 'password'}
              data-testid="voice-mllm-api-key"
              placeholder={
                statusMeta?.hasMllmApiKey
                  ? `已保存 ${statusMeta.mllmApiKeyMasked}（输入新密钥可覆盖）`
                  : currentPreset?.keyPlaceholder ?? 'AIzaSy...'
              }
              value={mllmApiKey}
              disabled={busy}
              onChange={e => setMllmApiKey(e.target.value)}
            />
          </div>

          <div className="voice-config-grid">
            <label className="modal-field">
              <span>模型 ID</span>
              <input value={model} disabled={busy} onChange={e => setModel(e.target.value)} />
              {currentPreset && (
                <div className="inspiration-chips">
                  {currentPreset.models.map(item => (
                    <button key={item} type="button" className="chip-btn" disabled={busy} onClick={() => setModel(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label className="modal-field">
              <span>语音音色 (Voice)</span>
              <input value={voice} disabled={busy} onChange={e => setVoice(e.target.value)} />
              {currentPreset && (
                <div className="inspiration-chips">
                  {currentPreset.voices.map(item => (
                    <button key={item} type="button" className="chip-btn" disabled={busy} onClick={() => setVoice(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              )}
            </label>
          </div>

          <label className="modal-field">
            <span>MLLM WebSocket 地址</span>
            <input value={url} disabled={busy} onChange={e => setUrl(e.target.value)} />
          </label>

          {probeResult && (
            <div
              role="status"
              data-testid="voice-probe-result"
              className={`model-probe-box ${probeResult.ok ? 'is-ok' : 'is-error'}`}
            >
              <div className="model-probe-title">
                {probeResult.ok ? '✓ ' : '✕ '}
                {probeResult.message}
              </div>
              {probeResult.hint && <div className="model-probe-hint">排查建议：{probeResult.hint}</div>}
            </div>
          )}

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {saveNotice && (
            <p role="status" data-testid="voice-save-notice" className="model-save-notice">
              ✓ {saveNotice}
            </p>
          )}

          <div className="modal-actions model-modal-actions">
            <button
              type="button"
              className="secondary-btn"
              data-testid="voice-probe-btn"
              disabled={busy}
              onClick={() => void handleProbe()}
            >
              {probing ? '检测中…' : '⚡ 测试声网连通性'}
            </button>
            <div className="model-modal-actions-right">
              <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button type="submit" className="primary-btn" data-testid="voice-save-btn" disabled={busy}>
                {saving ? '保存中…' : '保存并生效'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
