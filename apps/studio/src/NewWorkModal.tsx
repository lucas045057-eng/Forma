import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import type { Asset, Task, WorkStarter, WorkSummary } from '@spatial/shared';
import { api, mutation } from './api.ts';
import { assetOriginLabel } from './model-provenance.tsx';

const SPATIAL_3D_INSPIRATIONS = [
  { label: '黑钛耳机 3D 发布页', prompt: '做一个黑钛旗舰无线降噪耳机的深空科技感 3D 新品发布页，突出声学腔体结构与预约体验' },
  { label: '极简月球灯互动展厅', prompt: '做一个北欧极简月球氛围灯的温润家居 3D 互动展厅，突出柔和光影层次与空间仪式感' },
  { label: '客制化键盘空间官网', prompt: '做一个全铝 CNC 客制化机械键盘的赛博工业风 3D 官网，展示结构工艺与限量预约' },
];

const FREE_WEB_INSPIRATIONS = [
  { label: '极简建筑事务所官网', prompt: '做一个北欧极简建筑与空间设计事务所官网，包含代表作品分类筛选、设计哲学与预约咨询反馈' },
  { label: '独立咖啡馆品牌主页', prompt: '做一个精品手冲咖啡馆的品牌网页，包含当季豆单风味切换卡片、门店时间与预订试饮按钮' },
  { label: '交互式专注计时工具', prompt: '做一个审美克制的番茄专注与每日待办效率网页工具，支持切换专注模式、交互计数与清单勾选' },
];

const SAMPLE_IMPORT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>青岚茶室 · 城市静谧空间</title>
  <style>
    .tea-shell { max-width: 980px; margin: 0 auto; padding: 40px 28px 72px; background: #faf8f4; color: #1f2421; }
    .tea-nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid rgba(31,36,33,0.12); }
    .tea-brand { font-size: 20px; font-weight: 700; letter-spacing: 0.06em; }
    .tea-hero { padding: 52px 0 40px; }
    .tea-tag { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #e6ede8; color: #2d5a43; font-size: 12px; font-weight: 600; }
    .tea-hero h1 { font-size: 44px; line-height: 1.18; margin: 16px 0; }
    .tea-hero p { font-size: 16px; line-height: 1.75; color: #4f5953; max-width: 560px; margin: 0 0 28px; }
    .tea-cta { padding: 12px 26px; border-radius: 999px; border: none; background: #234233; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .tea-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-top: 24px; }
    .tea-card { padding: 22px; border-radius: 16px; background: #ffffff; border: 1px solid rgba(31,36,33,0.08); }
    .tea-card h3 { margin: 0 0 8px; font-size: 17px; }
    .tea-card p { margin: 0; font-size: 13.5px; line-height: 1.65; color: #5b655f; }
  </style>
</head>
<body>
  <div class="tea-shell">
    <header class="tea-nav">
      <span class="tea-brand">青岚 QINGLAN</span>
      <a href="#rooms">空间导览</a>
    </header>
    <section class="tea-hero">
      <span class="tea-tag">EXISTING WEBPAGE IMPORT</span>
      <h1>在城市喧嚣深处，留一席温润茶事。</h1>
      <p>这是一份从外部直接拉入 Forma 的已有静态网页。你可以点击顶部「开启选取」让大模型直接改写任意段落与配色，也可以从 3D 资产库拖入茶器模型。</p>
      <button class="tea-cta">预约今日茶席</button>
    </section>
    <section id="rooms" class="tea-grid">
      <article class="tea-card">
        <h3>松风庭院</h3>
        <p>自然天光与原木长桌交织，适合二至四人静谈品茗。</p>
      </article>
      <article class="tea-card">
        <h3>山雾茶寮</h3>
        <p>甄选高山乌龙与手作陶器，四时风物皆可入席。</p>
      </article>
      <article class="tea-card">
        <h3>器物展陈</h3>
        <p>支持随时拖入独立 3D 器物模块，实现空间化网页展示。</p>
      </article>
    </section>
  </div>
</body>
</html>`;

export type ModalTab = 'create' | 'import';
type ImportSubMode = 'files' | 'html' | 'url' | 'directory';

const ALLOWED_UPLOAD_EXT = /\.(?:html?|css|tsx|ts|jsx|js|json|svg|png|jpe?g|gif|webp|ico|avif)$/i;
const IGNORED_UPLOAD_SEGMENTS = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|\.env[^/]*)(?:\/|$)/i;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export interface CreatedWorkResult {
  activeId: string;
  work: WorkSummary;
  version: string;
  task?: Task;
}

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

  // Import states
  const [importMode, setImportMode] = useState<ImportSubMode>('files');
  const [selectedFiles, setSelectedFiles] = useState<Array<{ file: File; relPath: string }>>([]);
  const [htmlCode, setHtmlCode] = useState('');
  const [cssCode, setCssCode] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

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

  function ingestFileList(list: FileList | File[]) {
    const collected: Array<{ file: File; relPath: string }> = [];
    for (const file of Array.from(list)) {
      const rawRel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replaceAll('\\', '/');
      if (IGNORED_UPLOAD_SEGMENTS.test(rawRel)) continue;
      if (!ALLOWED_UPLOAD_EXT.test(rawRel)) continue;
      collected.push({ file, relPath: rawRel });
      if (collected.length >= 250) break;
    }
    if (collected.length === 0) {
      setError('未识别到受支持的网页文件（支持 .html/.css/.tsx/.jsx/图片/SVG）');
      return;
    }
    setError('');
    setSelectedFiles(collected);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files?.length) {
      ingestFileList(event.dataTransfer.files);
    }
  }

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

  async function handleImportSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const trimmedName = name.trim();
      let payload: Record<string, unknown>;

      if (importMode === 'files') {
        if (selectedFiles.length === 0) {
          throw new Error('请先拖入或选择要导入的网页文件 / 文件夹');
        }
        const encoded = await Promise.all(
          selectedFiles.map(async item => ({
            path: item.relPath,
            contentBase64: arrayBufferToBase64(await item.file.arrayBuffer()),
          })),
        );
        payload = {
          mode: 'files',
          ...(trimmedName ? { name: trimmedName } : {}),
          files: encoded,
        };
      } else if (importMode === 'html') {
        if (!htmlCode.trim()) {
          throw new Error('请粘贴非空的 HTML 源码（或点击右上角“填入示例网页”）');
        }
        payload = {
          mode: 'html',
          ...(trimmedName ? { name: trimmedName } : {}),
          html: htmlCode,
          ...(cssCode.trim() ? { css: cssCode } : {}),
        };
      } else if (importMode === 'url') {
        if (!importUrl.trim()) {
          throw new Error('请输入要拉取的 http:// 或 https:// 网页地址');
        }
        payload = {
          mode: 'url',
          ...(trimmedName ? { name: trimmedName } : {}),
          url: importUrl.trim(),
        };
      } else {
        if (!directoryPath.trim()) {
          throw new Error('请输入本机已有网页目录的完整路径');
        }
        payload = {
          mode: 'directory',
          ...(trimmedName ? { name: trimmedName } : {}),
          directoryPath: directoryPath.trim(),
        };
      }

      const result = await api<CreatedWorkResult>('/works/import', mutation('POST', payload));
      onCreated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入已有网页失败');
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
          <form className="modal-form" onSubmit={event => void handleImportSubmit(event)}>
            <p className="import-intro">
              支持把本地 HTML/CSS 网页、React/Vite 项目目录或线上网址直接拉进 Forma：自动转为可点选源码结构，既能点选任意文字/卡片让 AI 修改，也能随时把 3D 模型拖入页面区块。
            </p>

            <div className="import-submode-bar" role="radiogroup" aria-label="选择已有网页来源">
              <button type="button" className={`submode-pill${importMode === 'files' ? ' is-active' : ''}`} data-testid="import-mode-files" onClick={() => { setImportMode('files'); setError(''); }}>上传文件 / 文件夹</button>
              <button type="button" className={`submode-pill${importMode === 'html' ? ' is-active' : ''}`} data-testid="import-mode-html" onClick={() => { setImportMode('html'); setError(''); }}>粘贴 HTML 源码</button>
              <button type="button" className={`submode-pill${importMode === 'url' ? ' is-active' : ''}`} data-testid="import-mode-url" onClick={() => { setImportMode('url'); setError(''); }}>输入网址 URL</button>
              <button type="button" className={`submode-pill${importMode === 'directory' ? ' is-active' : ''}`} data-testid="import-mode-directory" onClick={() => { setImportMode('directory'); setError(''); }}>本机目录路径</button>
            </div>

            <label className="modal-field">
              <span>导入后作品名称（选填，留空将自动提取网页标题）</span>
              <input
                data-testid="import-work-name"
                placeholder="例如：青岚茶室官网 · 改版"
                maxLength={60}
                value={name}
                onChange={event => setName(event.target.value)}
              />
            </label>

            {importMode === 'files' && (
              <div
                className={`import-dropzone${dragOver ? ' is-dragover' : ''}`}
                data-testid="import-dropzone"
                onDragOver={event => { event.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".html,.htm,.css,.tsx,.ts,.jsx,.js,.json,.svg,.png,.jpg,.jpeg,.gif,.webp,.avif,.ico"
                  hidden
                  onChange={event => { if (event.target.files?.length) ingestFileList(event.target.files); }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  // @ts-expect-error webkitdirectory is supported by Chromium/modern browsers for folder upload
                  webkitdirectory=""
                  directory=""
                  multiple
                  hidden
                  onChange={event => { if (event.target.files?.length) ingestFileList(event.target.files); }}
                />
                <strong>将网页文件拖放到此处</strong>
                <span>支持静态网页（index.html + CSS + 图片）或 React 项目文件夹（src/App.tsx）</span>
                <div className="import-picker-actions">
                  <button type="button" className="secondary-btn compact-btn" onClick={() => fileInputRef.current?.click()}>选择网页文件</button>
                  <button type="button" className="secondary-btn compact-btn" onClick={() => folderInputRef.current?.click()}>选择整个文件夹</button>
                </div>
                {selectedFiles.length > 0 && (
                  <p className="import-file-summary" data-testid="import-files-summary">
                    已就绪 {selectedFiles.length} 个文件：{selectedFiles.slice(0, 4).map(f => f.relPath).join('、')}{selectedFiles.length > 4 ? ' 等' : ''}
                  </p>
                )}
              </div>
            )}

            {importMode === 'html' && (
              <div className="bootstrap-box">
                <div className="bootstrap-box-head">
                  <span>粘贴完整 HTML 文档或局部 HTML 片段</span>
                  <button
                    type="button"
                    className="chip-btn"
                    data-testid="import-sample-html"
                    onClick={() => {
                      setHtmlCode(SAMPLE_IMPORT_HTML);
                      if (!name.trim()) setName('青岚茶室 · 导入网页');
                    }}
                  >
                    填入示例网页源码
                  </button>
                </div>
                <textarea
                  data-testid="import-html-input"
                  rows={6}
                  placeholder="<!doctype html><html>... 或直接粘贴 <div>...</div> 网页代码"
                  value={htmlCode}
                  onChange={event => setHtmlCode(event.target.value)}
                />
                <details className="compact-details">
                  <summary>附加独立 CSS 样式表（选填）</summary>
                  <textarea
                    data-testid="import-css-input"
                    rows={3}
                    placeholder="若样式未写在 <style> 标签内，可在此粘贴附加 CSS…"
                    value={cssCode}
                    onChange={event => setCssCode(event.target.value)}
                  />
                </details>
              </div>
            )}

            {importMode === 'url' && (
              <label className="modal-field">
                <span>输入线上网页地址（自动抓取 HTML、样式表与页面图片并离线本地化）</span>
                <input
                  data-testid="import-url-input"
                  placeholder="https://example.com"
                  value={importUrl}
                  onChange={event => setImportUrl(event.target.value)}
                />
              </label>
            )}

            {importMode === 'directory' && (
              <label className="modal-field">
                <span>本机已有网页项目文件夹路径（支持静态 HTML 目录或 React/Vite 目录）</span>
                <input
                  data-testid="import-dir-input"
                  placeholder="例如：D:\Projects\my-website"
                  value={directoryPath}
                  onChange={event => setDirectoryPath(event.target.value)}
                />
              </label>
            )}

            {error && <p className="error" role="alert">{error}</p>}

            <div className="modal-footer">
              <span className="muted-note">原目录与线上网页不会被改写；Forma 会在独立 Git 沙箱中为您创建可回退副本</span>
              <div className="modal-actions">
                <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>取消</button>
                <button type="submit" className="primary-btn" data-testid="import-work-submit" disabled={busy}>
                  {busy ? '正在拉入并构建预览…' : '拉入 Forma 工作台'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
