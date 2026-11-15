import { useEffect, useState } from 'react';
import { ProductScene, sceneRenderSettings } from '@spatial/scene-renderer';
import { useSceneConfig } from '../scene-config-store';

function Placeholder() {
  return <div className="product-art" role="img" aria-label="香薰商品图占位：琥珀色瓶身与木质瓶盖" data-testid="product-placeholder">
    <div className="halo"/>
    <div className="bottle"><div className="cap"/><div className="label">木间<span>CEDARWOOD<br/>HOME DIFFUSER</span><small>100 mL</small></div></div>
    <span className="art-caption">静静陪伴 · 慢慢散香</span>
  </div>;
}

export function ProductHero() {
  const config = useSceneConfig();
  const [at, setAt] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState('');
  const modelUrl = config.model ? `${import.meta.env.BASE_URL}${config.model.slice(1)}` : '';
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setAt(max > 0 ? Math.max(0, Math.min(1, window.scrollY / max)) : 0);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); };
  }, []);
  return <div className="product-scene" style={{ aspectRatio: sceneRenderSettings.aspectRatio }} data-testid="product-scene"
    data-state={modelUrl && loadedUrl === modelUrl ? 'ready' : 'fallback'} data-scroll-at={at} aria-label="香薰三维展示">
    <ProductScene config={config} modelUrl={modelUrl} scrollAt={at} fallback={<Placeholder/>}
      onReady={() => setLoadedUrl(modelUrl)} onError={() => setLoadedUrl('')}/>
  </div>;
}
