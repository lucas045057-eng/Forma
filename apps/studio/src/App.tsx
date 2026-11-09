import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { isPreviewMessage, type Selection, type StudioMessage } from '@spatial/shared';

const AssetPanel = lazy(() => import('./AssetPanel'));
declare const __BASE_VERSION__: string;

export default function App() {
  const [showAssets, setShowAssets] = useState(false);
  const preview = useRef<HTMLIFrameElement>(null);
  const pickingRef = useRef(false);
  const [picking, setPicking] = useState(false);
  const [ready, setReady] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const send = (message: StudioMessage) => preview.current?.contentWindow?.postMessage(message, window.location.origin);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== preview.current?.contentWindow || !isPreviewMessage(event.data)) return;
      switch (event.data.type) {
        case 'ready':
          setReady(true);
          setError('');
          setSelection(null);
          send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
          break;
        case 'pick:result':
          if (!pickingRef.current) return;
          setSelection({ ...event.data.payload, baseVersion: __BASE_VERSION__ });
          setError('');
          send({ type: 'highlight', payload: { src: event.data.payload.src } });
          break;
        case 'scroll:progress': setProgress(event.data.payload.at); break;
        case 'error': setError(event.data.payload.message); break;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  function toggle() {
    pickingRef.current = !pickingRef.current;
    setPicking(pickingRef.current);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
    if (pickingRef.current && selection) send({ type: 'highlight', payload: { src: selection.src } });
  }
  return (
    <main className="studio">
      {showAssets && <Suspense fallback={<p role="status">加载 3D 视口…</p>}><AssetPanel onClose={() => setShowAssets(false)}/></Suspense>}
      <header className="toolbar">
        <div><span className="wordmark">ORBIT / STUDIO</span><h1>空间化 AI 创作工作台</h1></div>
        <div className="tools">
          <button type="button" data-testid="asset-open" onClick={() => setShowAssets(true)}>3D 资产</button>
          <span className="connection" data-testid="preview-status">{ready ? '预览已连接' : '等待预览连接'}</span>
          <button type="button" aria-pressed={picking} data-testid="pick-toggle" onClick={toggle}>{picking ? '退出选取' : '开启选取'}</button>
        </div>
      </header>
      <div className="workspace">
        <section className="preview-panel" aria-label="作品预览">
          <div className="panel-title"><span>作品 / 木间香薰</span><span>{picking ? '选取模式 · 点击查看源码' : '浏览模式'} · {Math.round(progress * 100)}%</span></div>
          <iframe ref={preview} src="/preview/main/" title="香薰商品页预览" data-testid="preview-frame" onLoad={() => {
            send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
          }}/>
        </section>
        <aside className="inspector">
          <p className="section-label">SOURCE INSPECTOR</p><h2>选中对象</h2>
          <p className="hint">开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。</p>
          {error && <p className="error" role="alert">{error}</p>}
          {selection ? <>
            <div className="selection-summary"><strong>{selection.cid}</strong><code>{selection.src}</code></div>
            {selection.note && <p className="notice">已选中外层容器</p>}
            <p className="notice" data-testid="instances">同源码实例：{selection.instances} 处{selection.instances > 1 ? '；修改将影响全部实例（共享组件或列表项）。' : ''}</p>
            <pre data-testid="selection-json">{JSON.stringify(selection, null, 2)}</pre>
          </> : <div className="empty">等待选取页面元素</div>}
        </aside>
      </div>
    </main>
  );
}
