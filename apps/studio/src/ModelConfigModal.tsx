import { useEffect, useState, type FormEvent } from 'react';
import type { ModelStatusView } from '@spatial/shared';
import { api, mutation } from './api.ts';

export interface ProviderPreset {
  id: string;
  name: string;
  badge: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  keyPlaceholder: string;
  docHint: string;
  requiresKey: boolean;
}

interface ModelConfigResponse {
  coding: {
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
  };
  speech: {
    baseUrl: string;
    model: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
  };
  lux3d: {
    baseUrl: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
  };
  presets: ProviderPreset[];
  status: ModelStatusView;
}

interface ProbeResponse {
  ok: boolean;
  normalizedBaseUrl: string;
  endpoint: string;
  latencyMs: number;
  status?: number;
  toolCallSupported: boolean;
  message: string;
  hint?: string;
}

interface SaveConfigResponse {
  ok: boolean;
  status: ModelStatusView;
  coding: ModelConfigResponse['coding'];
  speech: ModelConfigResponse['speech'];
  lux3d: ModelConfigResponse['lux3d'];
}

export default function ModelConfigModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (status: ModelStatusView) => void;
}) {
  const [tab, setTab] = useState<'coding' | 'extra'>('coding');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('dashscope');
  const [showKey, setShowKey] = useState(false);

  // Coding fields
  const [codingBaseUrl, setCodingBaseUrl] = useState('');
  const [codingModel, setCodingModel] = useState('');
  const [codingApiKey, setCodingApiKey] = useState('');
  const [codingHasKey, setCodingHasKey] = useState(false);
  const [codingKeyMasked, setCodingKeyMasked] = useState('');
  const [syncKeyToSpeech, setSyncKeyToSpeech] = useState(false);

  // Speech & Lux3D fields
  const [speechBaseUrl, setSpeechBaseUrl] = useState('https://dashscope.aliyuncs.com/compatible-mode/v1');
  const [speechApiKey, setSpeechApiKey] = useState('');
  const [speechHasKey, setSpeechHasKey] = useState(false);
  const [speechKeyMasked, setSpeechKeyMasked] = useState('');

  const [luxBaseUrl, setLuxBaseUrl] = useState('https://api.aholo.cn');
  const [luxApiKey, setLuxApiKey] = useState('');
  const [luxHasKey, setLuxHasKey] = useState(false);
  const [luxKeyMasked, setLuxKeyMasked] = useState('');

  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);

  useEffect(() => {
    let active = true;
    void api<ModelConfigResponse>('/models/config')
      .then(data => {
        if (!active) return;
        setPresets(data.presets ?? []);
        setCodingBaseUrl(data.coding.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1');
        setCodingModel(data.coding.model || 'qwen3-coder-plus');
        setCodingHasKey(data.coding.hasApiKey);
        setCodingKeyMasked(data.coding.apiKeyMasked);

        setSpeechBaseUrl(data.speech.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1');
        setSpeechHasKey(data.speech.hasApiKey);
        setSpeechKeyMasked(data.speech.apiKeyMasked);

        setLuxBaseUrl(data.lux3d.baseUrl || 'https://api.aholo.cn');
        setLuxHasKey(data.lux3d.hasApiKey);
        setLuxKeyMasked(data.lux3d.apiKeyMasked);

        const matched = (data.presets ?? []).find(
          p => data.coding.baseUrl && data.coding.baseUrl.toLowerCase().startsWith(p.baseUrl.toLowerCase()),
        );
        if (matched) {
          setSelectedPresetId(matched.id);
        } else if (data.coding.baseUrl) {
          setSelectedPresetId('openai-compatible');
        }
        setLoading(false);
      })
      .catch(err => {
        if (!active) return;
        setError(err instanceof Error ? err.message : '读取模型配置失败');
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentPreset = presets.find(p => p.id === selectedPresetId) ?? presets[0];

  function applyPreset(presetId: string) {
    setSelectedPresetId(presetId);
    const found = presets.find(p => p.id === presetId);
    if (!found) return;
    setCodingBaseUrl(found.baseUrl);
    setCodingModel(found.defaultModel);
    setProbeResult(null);
    setError('');
    setSaveNotice('');
  }

  async function handleProbe() {
    setProbing(true);
    setError('');
    setSaveNotice('');
    setProbeResult(null);
    try {
      const res = await api<ProbeResponse>(
        '/models/test',
        mutation('POST', {
          baseUrl: codingBaseUrl.trim(),
          model: codingModel.trim(),
          ...(codingApiKey.trim() ? { apiKey: codingApiKey.trim() } : {}),
        }),
      );
      setProbeResult(res);
      if (res.normalizedBaseUrl && res.normalizedBaseUrl !== codingBaseUrl.trim()) {
        setCodingBaseUrl(res.normalizedBaseUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连通性测试请求失败');
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
      const speechKeyToSend =
        speechApiKey.trim() || (syncKeyToSpeech && codingApiKey.trim() ? codingApiKey.trim() : undefined);

      const saved = await api<SaveConfigResponse>(
        '/models/config',
        mutation('PUT', {
          coding: {
            baseUrl: codingBaseUrl.trim(),
            model: codingModel.trim(),
            ...(codingApiKey.trim() ? { apiKey: codingApiKey.trim() } : {}),
          },
          speech: {
            baseUrl: speechBaseUrl.trim(),
            ...(speechKeyToSend ? { apiKey: speechKeyToSend } : {}),
          },
          lux3d: {
            baseUrl: luxBaseUrl.trim(),
            ...(luxApiKey.trim() ? { apiKey: luxApiKey.trim() } : {}),
          },
          persist: true,
        }),
      );

      setCodingBaseUrl(saved.coding.baseUrl);
      setCodingModel(saved.coding.model);
      setCodingHasKey(saved.coding.hasApiKey);
      setCodingKeyMasked(saved.coding.apiKeyMasked);
      setCodingApiKey('');

      setSpeechBaseUrl(saved.speech.baseUrl);
      setSpeechHasKey(saved.speech.hasApiKey);
      setSpeechKeyMasked(saved.speech.apiKeyMasked);
      setSpeechApiKey('');

      setLuxBaseUrl(saved.lux3d.baseUrl);
      setLuxHasKey(saved.lux3d.hasApiKey);
      setLuxKeyMasked(saved.lux3d.apiKeyMasked);
      setLuxApiKey('');

      onSaved(saved.status);
      setSaveNotice('配置已保存至 apps/server/.env 并已在当前工作台热更新生效！');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存模型配置失败');
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
        className="new-work-modal"
        role="dialog"
        aria-modal="true"
        aria-label="大模型接入与服务配置"
        data-testid="model-config-modal"
      >
        <header className="modal-header">
          <div>
            <span className="section-label">MODEL INTEGRATION & DIAGNOSTICS</span>
            <h2>接入自定义大模型与云端服务</h2>
          </div>
          <button type="button" className="ghost-btn compact-btn" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="modal-mode-tabs" role="tablist" aria-label="模型配置分类">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'coding'}
            className={`modal-tab-btn${tab === 'coding' ? ' is-active' : ''}`}
            data-testid="tab-model-coding"
            disabled={busy}
            onClick={() => {
              setTab('coding');
              setError('');
            }}
          >
            ✦ 编码大模型接入 (OpenAI 兼容)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'extra'}
            className={`modal-tab-btn${tab === 'extra' ? ' is-active' : ''}`}
            data-testid="tab-model-extra"
            disabled={busy}
            onClick={() => {
              setTab('extra');
              setError('');
            }}
          >
            🎙 语音识别 (ASR) 与 3D 资产服务
          </button>
        </div>

        <form className="modal-form" onSubmit={event => void handleSave(event)}>
          {tab === 'coding' ? (
            <>
              <label className="modal-field">
                <span>1. 选择主流大模型厂商预设（一键自动填入标准 Base URL 与推荐模型）</span>
                <select
                  data-testid="model-preset-select"
                  value={selectedPresetId}
                  disabled={busy}
                  onChange={event => applyPreset(event.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '10px',
                    background: 'rgba(255,255,255,0.05)',
                    color: 'inherit',
                    border: '1px solid rgba(255,255,255,0.14)',
                    fontSize: '13.5px',
                  }}
                >
                  {presets.map(p => (
                    <option key={p.id} value={p.id} style={{ background: '#1e1e1c', color: '#f2efe9' }}>
                      {p.name} — [{p.badge}]
                    </option>
                  ))}
                </select>
              </label>

              {currentPreset && (
                <p
                  className="modal-hint"
                  style={{
                    margin: '-4px 0 4px',
                    padding: '10px 12px',
                    borderRadius: '10px',
                    background: 'rgba(212, 255, 51, 0.08)',
                    border: '1px solid rgba(212, 255, 51, 0.22)',
                    fontSize: '12.5px',
                    lineHeight: 1.55,
                  }}
                >
                  <strong>接入提示：</strong>
                  {currentPreset.docHint}
                </p>
              )}

              <label className="modal-field">
                <span>2. 接口 Base URL（自动剔除末尾多余的 /chat/completions 并补全版本路径）</span>
                <input
                  data-testid="coding-base-url"
                  placeholder="例如：https://dashscope.aliyuncs.com/compatible-mode/v1"
                  value={codingBaseUrl}
                  disabled={busy}
                  onChange={event => {
                    setCodingBaseUrl(event.target.value);
                    setProbeResult(null);
                  }}
                />
              </label>

              <div className="modal-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                  <span>3. 模型名称 (Model ID · 需支持 Function Calling 工具调用)</span>
                  {currentPreset && currentPreset.models.length > 0 && (
                    <div className="inspiration-chips">
                      {currentPreset.models.map(m => (
                        <button
                          key={m}
                          type="button"
                          className="chip-btn"
                          disabled={busy}
                          onClick={() => {
                            setCodingModel(m);
                            setProbeResult(null);
                          }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  data-testid="coding-model-name"
                  placeholder="例如：qwen3-coder-plus / deepseek-chat / glm-4-plus"
                  value={codingModel}
                  disabled={busy}
                  onChange={event => {
                    setCodingModel(event.target.value);
                    setProbeResult(null);
                  }}
                />
              </div>

              <div className="modal-field">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    4. API Key 密钥{' '}
                    {codingHasKey ? (
                      <strong style={{ color: '#4ade80', fontWeight: 600 }}>
                        （当前已配置 {codingKeyMasked}，不修改可留空）
                      </strong>
                    ) : (
                      <strong style={{ color: '#fbbf24', fontWeight: 600 }}>（尚未配置）</strong>
                    )}
                  </span>
                  <button
                    type="button"
                    className="inline-link-btn"
                    onClick={() => setShowKey(v => !v)}
                  >
                    {showKey ? '隐藏明文' : '显示明文'}
                  </button>
                </div>
                <input
                  type={showKey ? 'text' : 'password'}
                  data-testid="coding-api-key"
                  placeholder={
                    codingHasKey
                      ? `已保存 ${codingKeyMasked}（输入新密钥可覆盖，留空则保持不变）`
                      : currentPreset?.keyPlaceholder || 'sk-...'
                  }
                  value={codingApiKey}
                  disabled={busy}
                  onChange={event => {
                    setCodingApiKey(event.target.value);
                    setProbeResult(null);
                  }}
                />
                {selectedPresetId === 'dashscope' && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '12.5px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={syncKeyToSpeech}
                      onChange={e => setSyncKeyToSpeech(e.target.checked)}
                    />
                    <span>将该百炼 API Key 同步用于「阿里云百炼语音识别 (qwen3-asr-flash)」</span>
                  </label>
                )}
              </div>

              {probeResult && (
                <div
                  role="status"
                  data-testid="model-probe-result"
                  style={{
                    padding: '12px 14px',
                    borderRadius: '10px',
                    background: probeResult.ok ? 'rgba(74, 222, 128, 0.1)' : 'rgba(248, 113, 113, 0.1)',
                    border: `1px solid ${probeResult.ok ? 'rgba(74, 222, 128, 0.35)' : 'rgba(248, 113, 113, 0.35)'}`,
                    fontSize: '13px',
                    lineHeight: 1.55,
                  }}
                >
                  <div style={{ fontWeight: 600, color: probeResult.ok ? '#4ade80' : '#f87171' }}>
                    {probeResult.ok ? '✓ ' : '✕ '}
                    {probeResult.message}
                  </div>
                  {probeResult.hint && (
                    <div style={{ marginTop: '4px', color: 'rgba(242,239,233,0.82)', fontSize: '12.5px' }}>
                      排查建议：{probeResult.hint}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  fontSize: '12.5px',
                  lineHeight: 1.55,
                }}
              >
                <strong>语音识别避坑说明：</strong>
                普通第三方文本大模型中转站通常未实现音频转写接口。Forma 语音指令固定对接<strong>阿里云百炼 qwen3-asr-flash</strong> 多模态音频兼容端点，只需填入阿里云百炼 API Key 即可开启按住说话。
              </div>

              <label className="modal-field">
                <span>阿里云百炼语音识别 Base URL (SPEECH_BASE_URL)</span>
                <select
                  value={speechBaseUrl}
                  disabled={busy}
                  onChange={e => setSpeechBaseUrl(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '10px',
                    background: 'rgba(255,255,255,0.05)',
                    color: 'inherit',
                    border: '1px solid rgba(255,255,255,0.14)',
                    fontSize: '13.5px',
                  }}
                >
                  <option value="https://dashscope.aliyuncs.com/compatible-mode/v1" style={{ background: '#1e1e1c', color: '#f2efe9' }}>
                    阿里云百炼 · 国内北京节点 (https://dashscope.aliyuncs.com/compatible-mode/v1)
                  </option>
                  <option value="https://dashscope-intl.aliyuncs.com/compatible-mode/v1" style={{ background: '#1e1e1c', color: '#f2efe9' }}>
                    阿里云百炼 · 国际新加坡节点 (https://dashscope-intl.aliyuncs.com/compatible-mode/v1)
                  </option>
                </select>
              </label>

              <label className="modal-field">
                <span>
                  阿里云百炼语音 API Key (DASHSCOPE_API_KEY){' '}
                  {speechHasKey ? (
                    <strong style={{ color: '#4ade80' }}>（已配置 {speechKeyMasked}，留空保持不变）</strong>
                  ) : (
                    <strong style={{ color: '#fbbf24' }}>（未配置）</strong>
                  )}
                </span>
                <input
                  type={showKey ? 'text' : 'password'}
                  data-testid="speech-api-key"
                  placeholder={speechHasKey ? `已保存 ${speechKeyMasked}（留空保持不变）` : 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}
                  value={speechApiKey}
                  disabled={busy}
                  onChange={e => setSpeechApiKey(e.target.value)}
                />
              </label>

              <label className="modal-field">
                <span>Lux3D 3D 资产生成服务地址 (LUX3D_BASE)</span>
                <input
                  data-testid="lux3d-base-url"
                  placeholder="https://api.aholo.cn"
                  value={luxBaseUrl}
                  disabled={busy}
                  onChange={e => setLuxBaseUrl(e.target.value)}
                />
              </label>

              <label className="modal-field">
                <span>
                  Lux3D API Key (LUX3D_API_KEY){' '}
                  {luxHasKey ? (
                    <strong style={{ color: '#4ade80' }}>（已配置 {luxKeyMasked}，留空保持不变）</strong>
                  ) : (
                    <strong style={{ color: '#fbbf24' }}>（未配置，仍可使用本地内置备用 3D 资产）</strong>
                  )}
                </span>
                <input
                  type={showKey ? 'text' : 'password'}
                  data-testid="lux3d-api-key"
                  placeholder={luxHasKey ? `已保存 ${luxKeyMasked}（留空保持不变）` : '选填：填入 Lux3D 密钥以启用云端文生/图生 3D'}
                  value={luxApiKey}
                  disabled={busy}
                  onChange={e => setLuxApiKey(e.target.value)}
                />
              </label>
            </>
          )}

          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {saveNotice && (
            <p
              role="status"
              data-testid="model-save-notice"
              style={{
                margin: 0,
                padding: '10px 12px',
                borderRadius: '10px',
                background: 'rgba(74, 222, 128, 0.12)',
                color: '#4ade80',
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              ✓ {saveNotice}
            </p>
          )}

          <div className="modal-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <div>
              {tab === 'coding' && (
                <button
                  type="button"
                  className="secondary-btn"
                  data-testid="model-probe-btn"
                  disabled={busy}
                  onClick={() => void handleProbe()}
                >
                  {probing ? '正在检测连通性…' : '⚡ 测试连通性与工具调用'}
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button type="submit" className="primary-btn" data-testid="model-save-btn" disabled={busy}>
                {saving ? '保存中…' : '保存并立即生效'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
