import { useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, mutation } from './api.ts';
import { arrayBufferToBase64, collectUploadFiles, SAMPLE_IMPORT_HTML, type UploadedWorkFile } from './new-work-presets.ts';
import type { CreatedWorkResult } from './NewWorkModal.tsx';

type ImportSubMode = 'files' | 'html' | 'url' | 'directory';

/** Form panel inside NewWorkModal for importing existing HTML, files, URLs, or local directories. */
export default function ImportWorkForm({
  name,
  onNameChange,
  busy,
  error,
  onBusyChange,
  onError,
  onClose,
  onCreated,
}: {
  name: string;
  onNameChange: (value: string) => void;
  busy: boolean;
  error: string;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
  onClose: () => void;
  onCreated: (result: CreatedWorkResult) => void;
}) {
  const [importMode, setImportMode] = useState<ImportSubMode>('files');
  const [selectedFiles, setSelectedFiles] = useState<UploadedWorkFile[]>([]);
  const [htmlCode, setHtmlCode] = useState('');
  const [cssCode, setCssCode] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [directoryPath, setDirectoryPath] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  function ingestFileList(list: FileList | File[]) {
    const collected = collectUploadFiles(list);
    if (collected.length === 0) {
      onError('未识别到受支持的网页文件（支持 .html/.css/.tsx/.jsx/图片/SVG）');
      return;
    }
    onError('');
    setSelectedFiles(collected);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (event.dataTransfer.files?.length) {
      ingestFileList(event.dataTransfer.files);
    }
  }

  async function buildPayload(): Promise<Record<string, unknown>> {
    const trimmedName = name.trim();
    const base = trimmedName ? { name: trimmedName } : {};

    if (importMode === 'files') {
      if (selectedFiles.length === 0) {
        throw new Error('请先拖入或选择要导入的网页文件 / 文件夹');
      }
      const files = await Promise.all(
        selectedFiles.map(async item => ({
          path: item.relPath,
          contentBase64: arrayBufferToBase64(await item.file.arrayBuffer()),
        })),
      );
      return { mode: 'files', ...base, files };
    }
    if (importMode === 'html') {
      if (!htmlCode.trim()) {
        throw new Error('请粘贴非空的 HTML 源码（或点击右上角“填入示例网页”）');
      }
      return { mode: 'html', ...base, html: htmlCode, ...(cssCode.trim() ? { css: cssCode } : {}) };
    }
    if (importMode === 'url') {
      if (!importUrl.trim()) {
        throw new Error('请输入要拉取的 http:// 或 https:// 网页地址');
      }
      return { mode: 'url', ...base, url: importUrl.trim() };
    }
    if (!directoryPath.trim()) {
      throw new Error('请输入本机已有网页目录的完整路径');
    }
    return { mode: 'directory', ...base, directoryPath: directoryPath.trim() };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    onBusyChange(true);
    onError('');
    try {
      const payload = await buildPayload();
      const result = await api<CreatedWorkResult>('/works/import', mutation('POST', payload));
      onCreated(result);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '导入已有网页失败');
      onBusyChange(false);
    }
  }

  function switchSubMode(nextMode: ImportSubMode) {
    setImportMode(nextMode);
    onError('');
  }

  return (
    <form className="modal-form" onSubmit={event => void handleSubmit(event)}>
      <p className="import-intro">
        支持把本地 HTML/CSS 网页、React/Vite 项目目录或线上网址直接拉进 Forma：自动转为可点选源码结构，既能点选任意文字/卡片让 AI 修改，也能随时把 3D 模型拖入页面区块。
      </p>

      <div className="import-submode-bar" role="radiogroup" aria-label="选择已有网页来源">
        <button type="button" className={`submode-pill${importMode === 'files' ? ' is-active' : ''}`} data-testid="import-mode-files" onClick={() => switchSubMode('files')}>上传文件 / 文件夹</button>
        <button type="button" className={`submode-pill${importMode === 'html' ? ' is-active' : ''}`} data-testid="import-mode-html" onClick={() => switchSubMode('html')}>粘贴 HTML 源码</button>
        <button type="button" className={`submode-pill${importMode === 'url' ? ' is-active' : ''}`} data-testid="import-mode-url" onClick={() => switchSubMode('url')}>输入网址 URL</button>
        <button type="button" className={`submode-pill${importMode === 'directory' ? ' is-active' : ''}`} data-testid="import-mode-directory" onClick={() => switchSubMode('directory')}>本机目录路径</button>
      </div>

      <label className="modal-field">
        <span>导入后作品名称（选填，留空将自动提取网页标题）</span>
        <input
          data-testid="import-work-name"
          placeholder="例如：青岚茶室官网 · 改版"
          maxLength={60}
          value={name}
          onChange={event => onNameChange(event.target.value)}
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
                if (!name.trim()) onNameChange('青岚茶室 · 导入网页');
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
  );
}
