import { useEffect, useState } from 'react';
import { ProductScene, sceneRenderSettings } from '@spatial/scene-renderer';
import type { Asset, FallbackPreset } from '@spatial/shared';
import {assetOriginLabel} from './model-provenance.tsx';
import {ApiError} from './api.ts';
const fallbackErrors:Record<string,string>={UNKNOWN_PRESET:'备用编号不存在，请刷新目录。',ASSET_EXISTS:'该编号已有不同内容，请保留现有资产并刷新状态。',FALLBACK_CHANGED:'本地备用文件已变化，请恢复指定材料。',FALLBACK_PATH_DENIED:'备用路径未通过安全检查。',FALLBACK_TOO_LARGE:'备用模型超过32MiB，未开始处理。',INVALID_GLB:'备用文件不是完整的GLB模型。',SERVICE_STOPPED:'资产服务正在停止，请稍后刷新。'};
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import './assets.css';
import { useEventCenter } from './EventCenter.tsx';

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
  const [fallbacks,setFallbacks]=useState<FallbackPreset[]>([]);
  const [fallbackError,setFallbackError]=useState('');
  const { subscribe,syncReady,status } = useEventCenter();
  const canImport=syncReady&&status==='connected';
  useEffect(()=>{
    const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),5000);let active=true;
    void fetch('/assets/fallbacks',{signal:abort.signal,cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error();const list=await response.json();if(!Array.isArray(list)||!list.every(item=>item&&typeof item.id==='string'&&typeof item.title==='string'&&typeof item.description==='string'&&typeof item.available==='boolean'))throw new Error();if(active)setFallbacks(list);}).catch(()=>{if(active)setFallbackError('备用列表暂不可用，请关闭后重新打开资产面板。');}).finally(()=>clearTimeout(timer));
    return()=>{active=false;abort.abort();clearTimeout(timer);};
  },[]);
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
    const unsubscribe = subscribe(event => {
      if (event.type === 'asset.progress' || event.type === 'asset.ready' || event.type === 'state.reload') void refresh();
    });
    return () => { active = false; unsubscribe(); };
  }, [subscribe]);
  async function importTask() {
    if(!canImport||busy)return;
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
  async function importFallback(id:string){
    if(!canImport||busy)return;setBusy(true);setError('');
    try{const response=await fetch(`/assets/fallbacks/${encodeURIComponent(id)}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});const result=await response.json();if(!response.ok)throw new ApiError(response.status,typeof result?.error?.code==='string'?result.error.code:'ASSET_IMPORT_FAILED','备用导入未成功');setAssets(previous=>[result,...previous.filter(asset=>asset.id!==result.id)]);setSelected(result.id);}
    catch(cause){setError(cause instanceof ApiError&&fallbackErrors[cause.code]?fallbackErrors[cause.code]:'无法确认备用导入结果，请刷新资产状态；本操作不会发起Lux3D生成。');}finally{setBusy(false);}
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
          {ready.map(asset => <option key={asset.id} value={asset.id}>{asset.taskId ? `Lux3D ${asset.taskId}` : asset.id} · {assetOriginLabel(asset.provenance)}</option>)}
        </select>
        <section data-testid="fallback-list"><h3>本地备用资产</h3><p className="hint">预先生成的备用模型，时间未记录。仅在本机处理，不请求Lux3D；导入后可在场景编辑中明确采用。</p>
          {fallbackError&&<p role="alert">{fallbackError}</p>}
          {!fallbacks.length&&!fallbackError&&<p role="status">正在读取本地备用目录…</p>}
          {fallbacks.map(preset=><div className="fallback-preset" key={preset.id} data-preset-id={preset.id}><strong>{preset.title}</strong><p>{preset.description}</p>{!preset.available&&<p role="status">{preset.reason??'本地文件不可用'}</p>}<button type="button" data-testid="fallback-import" disabled={busy||!canImport||!preset.available} onClick={()=>void importFallback(preset.id)}>导入备用</button></div>)}
        </section>
        <h3>导入已有 Lux3D 任务</h3>
        <p className="hint">读取已有结果，不创建新的付费任务。</p>
        <form onSubmit={event => { event.preventDefault(); void importTask(); }}>
          <input aria-label="任务编号" data-testid="asset-task-id" value={taskId} onChange={event => setTaskId(event.target.value)} pattern="[1-9][0-9]{0,18}" required/>
          <button type="submit" disabled={busy||!canImport} data-testid="asset-import">{busy ? '请求中…' : '导入任务'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {current && <div data-testid="asset-status"><h3>{labels[current.status]}</h3><code>{current.id}</code>
          <p data-testid="asset-provenance">{assetOriginLabel(current.provenance)}{current.provenance?.importedAt&&` · 本地导入：${new Date(current.provenance.importedAt).toLocaleString()}`}</p>
          {current.error && <p role="alert" className="error">{current.error.message}</p>}
          {current.metrics?.webReady === false && <p role="alert">模型超过 3 MB 或 10 万顶点，不适合网页，请先优化。</p>}
          {current.metrics?.parts?.recognized === false && <p role="status">未识别部件，开盖关键帧不可用。</p>}
          {current.metrics && <dl><dt>文件体积</dt><dd>{(current.metrics.before.bytes / 1e6).toFixed(2)} → {(current.metrics.after.bytes / 1e6).toFixed(2)} MB</dd><dt>顶点数</dt><dd>{current.metrics.before.vertices.toLocaleString()} → {current.metrics.after.vertices.toLocaleString()}</dd><dt>处理耗时</dt><dd>{current.metrics.durationMs} ms</dd><dt>尺寸约定</dt><dd>最大边 1，底面中心为原点</dd></dl>}
        </div>}
      </aside>
    </div>
  </div>;
}
