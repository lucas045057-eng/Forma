import { useEffect, useState, type FormEvent } from 'react';
import type { Asset, Task, WorkStarter, WorkSummary } from '@spatial/shared';
import { api, mutation } from './api.ts';
import ImportWorkForm from './ImportWorkForm.tsx';
import { assetOriginLabel } from './model-provenance.tsx';
import { FREE_WEB_INSPIRATIONS, SPATIAL_3D_INSPIRATIONS } from './new-work-presets.ts';

export type ModalTab = 'create' | 'import';

export interface CreatedWorkResult {
  activeId: string;
  work: WorkSummary;
  version: string;
  task?: Task;
}

/** Modal dialog for creating a new spatial/web work or importing an existing webpage. */
export default function NewWorkModal({
  initialTab = 'create',
  onClose,
  onCreated,
}: {
  initialTab?: ModalTab;
  onClose: () => void;
  onCreated: (result: CreatedWorkResult) => void;
}) {
  const [tab, setTab] = useState<ModalTab>(initialTab);
  const [starter, setStarter] = useState<'free-web' | 'blank' | 'product-page'>('free-web');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [assetId, setAssetId] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api<Asset[]>('/assets')
      .then(list => {
        if (active && Array.isArray(list)) {
          setAssets(list.filter(item => item.status === 'ready'));
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const trimmedPrompt = starter === 'product-page' ? '' : prompt.trim();
      const trimmedName = name.trim();
      const chosenStarter: WorkStarter = starter;
      const result = await api<CreatedWorkResult>('/works', mutation('POST', {
        starter: chosenStarter,
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(starter === 'blank' && assetId ? { assetId } : {}),
      }));
      onCreated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建新作品失败');
      setBusy(false);
    }
  }

  const willBootstrap = starter !== 'product-page' && prompt.trim().length > 0;
  const inspirations = starter === 'free-web' ? FREE_WEB_INSPIRATIONS : SPATIAL_3D_INSPIRATIONS;

  return (
    <div className="modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="new-work-modal" role="dialog" aria-modal="true" aria-label="新建或导入网页作品" data-testid="new-work-modal">
        <header className="modal-header">
          <div>
            <span className="section-label">FORMA WORKSPACE</span>
            <h2>{tab === 'create' ? '自由创建网页作品' : '拉入已有网页并修改'}</h2>
          </div>
          <button type="button" className="ghost-btn compact-btn" disabled={busy} onClick={onClose}>关闭</button>
        </header>

        <div className="modal-mode-tabs" role="tablist" aria-label="创建或导入方式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'create'}
            className={`modal-tab-btn${tab === 'create' ? ' is-active' : ''}`}
            data-testid="tab-create-work"
            disabled={busy}
            onClick={() => { setTab('create'); setError(''); }}
          >
            ✦ 自由创建网页
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'import'}
            className={`modal-tab-btn${tab === 'import' ? ' is-active' : ''}`}
            data-testid="tab-import-work"
            disabled={busy}
            onClick={() => { setTab('import'); setError(''); }}
          >
            ⤓ 拉入已有网页修改
          </button>
        </div>

        {tab === 'create' ? (
          <form className="modal-form" onSubmit={event => void handleCreateSubmit(event)}>
            <div className="starter-cards starter-cards-3" role="radiogroup" aria-label="选择创作起点">
              <button
                type="button"
                className={`starter-card${starter === 'free-web' ? ' is-selected' : ''}`}
                aria-pressed={starter === 'free-web'}
                data-testid="starter-free-web"
                onClick={() => setStarter('free-web')}
              >
                <strong>✦ 自由现代网页</strong>
                <span>不设模板限制，一句话生成任意官网、作品集或交互工具；后续仍可随时拖入 3D 模块</span>
              </button>
              <button
                type="button"
                className={`starter-card${starter === 'blank' ? ' is-selected' : ''}`}
                aria-pressed={starter === 'blank'}
                data-testid="starter-blank"
                onClick={() => setStarter('blank')}
              >
                <strong>◈ 3D 空间网页</strong>
                <span>内置实时 WebGL 互动主舞台，适合 3D 产品发布页与空间展厅</span>
              </button>
              <button
                type="button"
                className={`starter-card${starter === 'product-page' ? ' is-selected' : ''}`}
                aria-pressed={starter === 'product-page'}
                data-testid="starter-product"
                onClick={() => setStarter('product-page')}
              >
                <strong>❖ 木间香薰模板</strong>
                <span>复制内置东方器物落地页，快速体验点选局部改写</span>
              </button>
            </div>

            <label className="modal-field">
              <span>作品名称（选填，留空将根据描述自动命名）</span>
              <input
                data-testid="new-work-name"
                placeholder={starter === 'free-web' ? '例如：极简建筑设计事务所官网' : starter === 'blank' ? '例如：声境 · 黑钛耳机发布页' : '例如：木间香薰 · 春季限定版'}
                maxLength={60}
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </label>

            {starter !== 'product-page' && (
              <div className="bootstrap-box">
                <div className="bootstrap-box-head">
                  <span>一句话让真实模型创建首版网页（留空则打开干净画布）</span>
                  <div className="inspiration-chips">
                    {inspirations.map(item => (
                      <button
                        key={item.label}
                        type="button"
                        className="chip-btn"
                        onClick={() => {
                          setPrompt(item.prompt);
                          if (!name.trim()) setName(item.label);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  data-testid="new-work-prompt"
                  rows={3}
                  maxLength={4000}
                  placeholder={starter === 'free-web'
                    ? '自由描述你想做的网页类型、视觉审美、核心区块与交互功能…'
                    : '描述你想做的产品、展厅风格与交互重点，例如：做一个深空黑钛无线降噪耳机的 3D 新品发布页…'}
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                />
              </div>
            )}

            {starter === 'blank' && assets.length > 0 && (
              <label className="modal-field">
                <span>初始主舞台 3D 模型（选填，已导入资产可跨作品直接复用）</span>
                <select data-testid="new-work-asset" value={assetId} onChange={event => setAssetId(event.target.value)}>
                  <option value="">使用默认三维舞台占位（稍后随时放入模型）</option>
                  {assets.map(asset => (
                    <option key={asset.id} value={asset.id}>
                      {asset.taskId ? `Lux3D ${asset.taskId}` : asset.id.slice(0, 18)} · {assetOriginLabel(asset.provenance)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {error && <p className="error" role="alert">{error}</p>}

            <div className="modal-footer">
              <span className="muted-note">
                {willBootstrap ? '创建后将立即调用真实编码模型生成完整候选，检查通过即可一键采用' : '每个作品拥有独立的 Git 版本库、预览服务与回退历史'}
              </span>
              <div className="modal-actions">
                <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>取消</button>
                <button type="submit" className="primary-btn" data-testid="new-work-submit" disabled={busy}>
                  {busy ? '正在创建…' : willBootstrap ? '创建并由 AI 生成网页' : starter === 'product-page' ? '创建模板副本' : '创建空白网页画布'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <ImportWorkForm
            name={name}
            onNameChange={setName}
            busy={busy}
            error={error}
            onBusyChange={setBusy}
            onError={setError}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </section>
    </div>
  );
}
