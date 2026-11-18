import { useEffect, useState } from 'react';
import Lux3DWorkbench from './Lux3DWorkbench.tsx';
import AssetModuleControls from './AssetModuleControls.tsx';
import type {PlacementSession} from './placement-state.ts';
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

export default function AssetPanel({ onClose,onPlace,onPreparePlace,dragging=false }: { onClose: () => void;onPlace?:(asset:Asset,session?:PlacementSession,drag?:boolean)=>void;onPreparePlace?:(asset:Asset)=>Promise<PlacementSession>;dragging?:boolean }) {
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
  return <aside className={`asset-dialog${dragging ? ' is-dragging' : ''}`} role="complementary" aria-label="3D 创作与资产">
    <header className="asset-header">
      <div>
        <span className="wordmark">3D ATELIER</span>
        <h2>3D 创作与资产</h2>
      </div>
      <button type="button" className="ghost-btn compact-btn" onClick={onClose} data-testid="asset-close">返回网页</button>
    </header>
    <div className="asset-layout">
      <section className="active-asset-card">
        <div className="active-asset-bar">
          <select aria-label="选择模型" data-testid="asset-select" value={current?.status === 'ready' ? selected : ''} onChange={event => setSelected(event.target.value)}>
            <option value="" disabled>选择已就绪模型…</option>
            {ready.map(asset => <option key={asset.id} value={asset.id}>{asset.taskId ? `Lux3D ${asset.taskId}` : asset.id.slice(0, 18)} · {assetOriginLabel(asset.provenance)}</option>)}
          </select>
          {current?.status==='ready'&&<button type="button" className="primary-btn compact-btn" data-testid="asset-place" disabled={!onPlace} onClick={()=>{if(current)onPlace?.(current)}}>放入网页</button>}
        </div>
        <div className="model-area" style={{ aspectRatio: sceneRenderSettings.aspectRatio }} data-testid="model-viewport" data-loaded={loaded}>
          {current?.status === 'ready' && current.modelUrl ? <ProductScene config={defaultSceneConfig} modelUrl={current.modelUrl} controls enableZoom
            onReady={() => { setLoadedUrl(current.modelUrl!); setFailedUrl(''); }}
            onError={() => { setLoadedUrl(''); setFailedUrl(current.modelUrl!); }}
            fallback={failedUrl === current.modelUrl ? <p role="alert">3D 模型加载失败。请检查资产状态或重新导入。</p> : <p className="model-loading">加载模型中…</p>}/>
            : <p className="model-empty">{current ? labels[current.status] : '从下方生成或导入备用模型后可预览并放入网页'}</p>}
          <div className="orbit-hint">拖动旋转 · 滚轮缩放 · 右键平移</div>
        </div>
        {current && <div className="asset-meta-strip" data-testid="asset-status">
          <div className="asset-meta-head">
            <span className="meta-tag">{labels[current.status]}</span>
            <code>{current.id.slice(0, 16)}</code>
            <span className="muted-note" data-testid="asset-provenance">{assetOriginLabel(current.provenance)}{current.provenance?.importedAt&&` · ${new Date(current.provenance.importedAt).toLocaleTimeString()}`}</span>
          </div>
          {current.error && <p role="alert" className="error">{current.error.message}</p>}
          {current.metrics?.webReady === false && <p role="alert" className="error">模型超过 3 MB 或 10 万顶点，不适合网页，请先优化。</p>}
          {current.metrics?.parts?.recognized === false && <p className="muted-note" role="status">未识别部件，开盖关键帧不可用。</p>}
          {current.metrics && <div className="metrics-chips">
            <span>体积 {(current.metrics.before.bytes / 1e6).toFixed(2)} → {(current.metrics.after.bytes / 1e6).toFixed(2)} MB</span>
            <span>顶点 {current.metrics.before.vertices.toLocaleString()} → {current.metrics.after.vertices.toLocaleString()}</span>
            <span>耗时 {current.metrics.durationMs} ms</span>
          </div>}
        </div>}
      </section>

      <div className="asset-controls">
        {error && <p className="error" role="alert">{error}</p>}
        <Lux3DWorkbench assets={assets} onPlace={onPlace} onPreparePlace={onPreparePlace}/>
        <AssetModuleControls/>

        <section className="drawer-section" data-testid="fallback-list">
          <div className="drawer-section-head">
            <h3>本地备用资产</h3>
            <span className="muted-note">本机离线处理 · 不计费</span>
          </div>
          {fallbackError&&<p className="error" role="alert">{fallbackError}</p>}
          {!fallbacks.length&&!fallbackError&&<p className="muted-note" role="status">正在读取本地备用目录…</p>}
          <div className="fallback-list-rows">
            {fallbacks.map(preset=><div className="fallback-preset" key={preset.id} data-preset-id={preset.id}>
              <div className="fallback-preset-info">
                <strong>{preset.title}</strong>
                <p>{preset.description}</p>
                {!preset.available&&<p className="muted-note" role="status">{preset.reason??'本地文件不可用'}</p>}
              </div>
              <button type="button" className="secondary-btn compact-btn" data-testid="fallback-import" disabled={busy||!canImport||!preset.available} onClick={()=>void importFallback(preset.id)}>导入备用</button>
            </div>)}
          </div>
        </section>

        <details className="drawer-section compact-details">
          <summary>导入已有 Lux3D 任务编号</summary>
          <p className="muted-note">按任务 ID 拉取已有云端结果，不创建新的付费任务。</p>
          <form className="inline-form" onSubmit={event => { event.preventDefault(); void importTask(); }}>
            <input aria-label="任务编号" data-testid="asset-task-id" value={taskId} onChange={event => setTaskId(event.target.value)} pattern="[1-9][0-9]{0,18}" required/>
            <button type="submit" className="secondary-btn compact-btn" disabled={busy||!canImport} data-testid="asset-import">{busy ? '请求中…' : '导入任务'}</button>
          </form>
        </details>
      </div>
    </div>
  </aside>;
}
