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
}

export default function ModelConfigModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (status: ModelStatusView) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('dashscope');
  const [showKey, setShowKey] = useState(false);

  const [codingBaseUrl, setCodingBaseUrl] = useState('');
  const [codingModel, setCodingModel] = useState('');
  const [codingApiKey, setCodingApiKey] = useState('');
  const [codingHasKey, setCodingHasKey] = useState(false);
  const [codingKeyMasked, setCodingKeyMasked] = useState('');

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
      const saved = await api<SaveConfigResponse>(
        '/models/config',
        mutation('PUT', {
          coding: {
            baseUrl: codingBaseUrl.trim(),
            model: codingModel.trim(),
            ...(codingApiKey.trim() ? { apiKey: codingApiKey.trim() } : {}),
          },
          persist: true,
        }),
      );

      setCodingBaseUrl(saved.coding.baseUrl);
      setCodingModel(saved.coding.model);
      setCodingHasKey(saved.coding.hasApiKey);
      setCodingKeyMasked(saved.coding.apiKeyMasked);
      setCodingApiKey('');

      onSaved(saved.status);
      setSaveNotice('编码模型配置已保存并立即生效！');
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
        aria-label="接入编码大模型"
        data-testid="model-config-modal"
      >
        <header className="modal-header">
          <div>
            <span className="section-label">CODING MODEL INTEGRATION</span>
            <h2>接入编码大模型 (OpenAI 兼容接口)</h2>
          </div>
          <button type="button" className="ghost-btn compact-btn" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>

        <form className="modal-form" onSubmit={event => void handleSave(event)}>
          <label className="modal-field">
            <span>1. 选择主流大模型厂商预设（一键自动填入标准 Base URL 与推荐模型）</span>
            <select
              className="model-preset-select"
              data-testid="model-preset-select"
              value={selectedPresetId}
              disabled={busy}
              onChange={event => applyPreset(event.target.value)}
            >
              {presets.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name} — [{p.badge}]
                </option>
              ))}
            </select>
          </label>

          {currentPreset && (
            <p className="model-doc-hint">
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
            <div className="model-field-row">
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
            <div className="model-field-row">
              <span>
                4. API Key 密钥{' '}
                {codingHasKey ? (
                  <strong className="model-key-ok">
                    （当前已配置 {codingKeyMasked}，不修改可留空）
                  </strong>
                ) : (
                  <strong className="model-key-missing">（尚未配置）</strong>
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
          </div>

          {probeResult && (
            <div
              role="status"
              data-testid="model-probe-result"
              className={`model-probe-box ${probeResult.ok ? 'is-ok' : 'is-error'}`}
            >
              <div className="model-probe-title">
                {probeResult.ok ? '✓ ' : '✕ '}
                {probeResult.message}
              </div>
              {probeResult.hint && (
                <div className="model-probe-hint">
                  排查建议：{probeResult.hint}
                </div>
              )}
            </div>
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
              className="model-save-notice"
            >
              ✓ {saveNotice}
            </p>
          )}

          <div className="modal-actions model-modal-actions">
            <button
              type="button"
              className="secondary-btn"
              data-testid="model-probe-btn"
              disabled={busy}
              onClick={() => void handleProbe()}
            >
              {probing ? '正在检测连通性…' : '⚡ 测试连通性与工具调用'}
            </button>
            <div className="model-modal-actions-right">
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
