import { useEffect, useState, type FormEvent } from 'react';
import type { Asset, Task, WorkStarter, WorkSummary } from '@spatial/shared';
import { api, mutation } from './api.ts';
import { assetOriginLabel } from './model-provenance.tsx';

const INSPIRATIONS = [
  { label: '黑钛耳机 3D 发布页', prompt: '做一个黑钛旗舰无线降噪耳机的深空科技感 3D 新品发布页，突出声学腔体结构与预约体验' },
  { label: '极简月球灯互动展厅', prompt: '做一个北欧极简月球氛围灯的温润家居 3D 互动展厅，突出柔和光影层次与空间仪式感' },
  { label: '客制化键盘空间官网', prompt: '做一个全铝 CNC 客制化机械键盘的赛博工业风 3D 官网，展示结构工艺与限量预约' },
];

export interface CreatedWorkResult {
  activeId: string;
  work: WorkSummary;
  version: string;
  task?: Task;
}

export default function NewWorkModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (result: CreatedWorkResult) => void;
}) {
  const [starter, setStarter] = useState<WorkStarter>('blank');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [assetId, setAssetId] = useState('');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void fetch('/assets')
      .then(res => (res.ok ? (res.json() as Promise<Asset[]>) : []))
      .then(list => {
        if (active && Array.isArray(list)) {
          setAssets(list.filter(item => item.status === 'ready'));
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const trimmedPrompt = starter === 'blank' ? prompt.trim() : '';
      const trimmedName = name.trim();
      const result = await api<CreatedWorkResult>('/works', mutation('POST', {
        starter,
        ...(trimmedName ? { name: trimmedName } : {}),
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(assetId ? { assetId } : {}),
      }));
      onCreated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建新作品失败');
      setBusy(false);
    }
  }

  const willBootstrap = starter === 'blank' && prompt.trim().length > 0;

  return (
    <div className="modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="new-work-modal" role="dialog" aria-modal="true" aria-label="新建空间作品" data-testid="new-work-modal">
        <header className="modal-header">
          <div>
            <span className="section-label">NEW WORKSPACE</span>
            <h2>新建 3D 网页作品</h2>
          </div>
          <button type="button" className="ghost-btn compact-btn" disabled={busy} onClick={onClose}>关闭</button>
        </header>

        <form className="modal-form" onSubmit={event => void handleSubmit(event)}>
          <div className="starter-cards" role="radiogroup" aria-label="选择起点模板">
            <button
              type="button"
              className={`starter-card${starter === 'blank' ? ' is-selected' : ''}`}
              aria-pressed={starter === 'blank'}
              data-testid="starter-blank"
              onClick={() => setStarter('blank')}
            >
              <strong>✦ 空白 3D 画布 / 一句话生成</strong>
              <span>从零创建干净的三维主舞台；输入一句话即可自动生成首版完整 3D 网页</span>
            </button>
            <button
              type="button"
              className={`starter-card${starter === 'product-page' ? ' is-selected' : ''}`}
              aria-pressed={starter === 'product-page'}
              data-testid="starter-product"
              onClick={() => setStarter('product-page')}
            >
              <strong>木间香薰模板</strong>
              <span>复制内置东方器物香薰落地页作为起点，适合快速体验点选微调</span>
            </button>
          </div>

          <label className="modal-field">
            <span>作品名称（选填，留空将根据描述自动命名）</span>
            <input
              data-testid="new-work-name"
              placeholder={starter === 'blank' ? '例如：声境 · 黑钛耳机发布页' : '例如：木间香薰 · 春季限定版'}
              maxLength={60}
              value={name}
              onChange={event => setName(event.target.value)}
            />
          </label>

          {starter === 'blank' && (
            <div className="bootstrap-box">
              <div className="bootstrap-box-head">
                <span>一句话生成首版 3D 网页（留空则直接打开纯空白 3D 画布）</span>
                <div className="inspiration-chips">
                  {INSPIRATIONS.map(item => (
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
                placeholder="描述你想做的产品、展厅风格与交互重点，例如：做一个深空黑钛无线降噪耳机的 3D 新品发布页…"
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
              />
            </div>
          )}

          {assets.length > 0 && (
            <label className="modal-field">
              <span>初始主舞台 3D 模型（选填，工作台已导入资产可跨作品直接复用）</span>
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
              {willBootstrap ? '创建后将自动启动编码 Agent 生成首版候选，经检查即可一键采用' : '每个作品拥有独立的 Git 版本库、预览服务与场景历史'}
            </span>
            <div className="modal-actions">
              <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>取消</button>
              <button type="submit" className="primary-btn" data-testid="new-work-submit" disabled={busy}>
                {busy ? '正在创建…' : willBootstrap ? '创建并生成首版网页' : starter === 'blank' ? '创建空白 3D 作品' : '创建模板副本'}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
