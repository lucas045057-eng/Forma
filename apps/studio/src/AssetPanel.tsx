import { useEffect, useState } from 'react';
import { ProductScene, sceneRenderSettings } from '@spatial/scene-renderer';
import type { Asset } from '@spatial/shared';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import './assets.css';

const labels: Record<Asset['status'], string> = {
  submitting: '提交中', submit_unknown: '提交结果待确认，请查询远端任务后导入', polling: '等待生成',
  downloading: '下载中', processing: '优化模型中', ready: '可查看', failed: '失败', cancelled: '已取消',
};

export default function AssetPanel({ onClose }: { onClose: () => void }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState('');
  const [taskId, setTaskId] = useState('4969293');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadedUrl, setLoadedUrl] = useState('');
  const [failedUrl, setFailedUrl] = useState('');
  const current = assets.find(asset => asset.id === selected);
  const loaded = current?.status === 'ready' && current.modelUrl === loadedUrl;
  const ready = assets.filter(asset => asset.status === 'ready');
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch('/assets');
        if (!response.ok) throw new Error('资产服务未连接，请确认后端已启动');
        const list = await response.json() as Asset[];
        if (active) {
          setAssets(list);
          setSelected(previous => previous || list.find(asset => asset.status === 'ready')?.id || '');
          setError('');
        }
      } catch { if (active) setError('无法读取资产列表，请确认后端已启动'); }
    };
    void refresh();
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
    socket.onmessage = event => {
      try { const message = JSON.parse(String(event.data)); if (message.type === 'asset.progress' || message.type === 'asset.ready') void refresh(); } catch { /* Ignore unrelated events. */ }
    };
    // Polling also recovers state when the WebSocket connection is interrupted.
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => { active = false; clearInterval(timer); socket.close(); };
  }, []);
  async function importTask() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/assets/lux3d/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }) });
      const result = await response.json() as Asset & { error?: { message: string } };
      if (!response.ok) throw new Error(result.error?.message ?? '导入失败');
      setAssets(previous => [result, ...previous.filter(asset => asset.id !== result.id)]);
      setSelected(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入失败'); }
    finally { setBusy(false); }
  }
  return <div className="asset-dialog" role="dialog" aria-modal="true" aria-label="3D 资产视口">
    <header className="asset-header"><div><span className="wordmark">3D ASSETS</span><h2>木间 · 模型预览</h2></div><button onClick={onClose} data-testid="asset-close">返回网页</button></header>
    <div className="asset-layout">
      <section className="model-area" style={{ aspectRatio: sceneRenderSettings.aspectRatio }} data-testid="model-viewport" data-loaded={loaded}>
        {current?.status === 'ready' && current.modelUrl ? <ProductScene config={defaultSceneConfig} modelUrl={current.modelUrl} controls
          onReady={() => { setLoadedUrl(current.modelUrl!); setFailedUrl(''); }}
          onError={() => { setLoadedUrl(''); setFailedUrl(current.modelUrl!); }}
          fallback={failedUrl === current.modelUrl ? <p role="alert">3D 模型加载失败。请检查资产状态或重新导入。</p> : <p className="model-loading">加载模型中…</p>}/>
          : <p className="model-empty">{current ? labels[current.status] : '导入已有任务，或选择已处理模型'}</p>}
        <div className="orbit-hint">拖动旋转 · 滚轮缩放 · 右键平移</div>
      </section>
      <aside className="asset-controls">
        <h3>已处理模型</h3>
        <select aria-label="选择模型" data-testid="asset-select" value={current?.status === 'ready' ? selected : ''} onChange={event => setSelected(event.target.value)}>
          <option value="" disabled>选择模型</option>
          {ready.map(asset => <option key={asset.id} value={asset.id}>{asset.taskId ? `Lux3D ${asset.taskId}` : asset.id}</option>)}
        </select>
        <h3>导入已有 Lux3D 任务</h3>
        <p className="hint">读取已有结果，不创建新的付费任务。</p>
        <form onSubmit={event => { event.preventDefault(); void importTask(); }}>
          <input aria-label="任务编号" data-testid="asset-task-id" value={taskId} onChange={event => setTaskId(event.target.value)} pattern="[1-9][0-9]{0,18}" required/>
          <button type="submit" disabled={busy} data-testid="asset-import">{busy ? '请求中…' : '导入任务'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {current && <div data-testid="asset-status"><h3>{labels[current.status]}</h3><code>{current.id}</code>
          {current.error && <p role="alert" className="error">{current.error.message}</p>}
          {current.metrics?.webReady === false && <p role="alert">模型超过 3 MB 或 10 万顶点，不适合网页，请先优化。</p>}
          {current.metrics?.parts?.recognized === false && <p role="status">未识别部件，开盖关键帧不可用。</p>}
          {current.metrics && <dl><dt>文件体积</dt><dd>{(current.metrics.before.bytes / 1e6).toFixed(2)} → {(current.metrics.after.bytes / 1e6).toFixed(2)} MB</dd><dt>顶点数</dt><dd>{current.metrics.before.vertices.toLocaleString()} → {current.metrics.after.vertices.toLocaleString()}</dd><dt>处理耗时</dt><dd>{current.metrics.durationMs} ms</dd><dt>尺寸约定</dt><dd>最大边 1，底面中心为原点</dd></dl>}
        </div>}
      </aside>
    </div>
  </div>;
}
