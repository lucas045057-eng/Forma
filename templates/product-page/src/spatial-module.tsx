import { ProductScene, sceneRenderSettings } from '@spatial/scene-renderer';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import { parseSceneModuleConfig, type SceneModuleConfig } from '@spatial/shared/scene-module';

/**
 * Trusted renderer for one placed 3D instance.
 *
 * It accepts only an instance id. The model, camera, transform, layout and animation state are
 * read from the server-managed `src/scene-modules/<instanceId>.json`; page code cannot pass a
 * model URL or substitute a different configuration here.
 */
const configurations = import.meta.glob<string>('./scene-modules/*.json', {
  eager: true,
  query: '?raw',
  import: 'default',
});

function load(instanceId: string): SceneModuleConfig | undefined {
  if (!/^[a-f0-9]{32}$/.test(instanceId)) return undefined;
  const raw = configurations[`./scene-modules/${instanceId}.json`];
  if (typeof raw !== 'string') return undefined;
  try { return parseSceneModuleConfig(JSON.parse(raw)); } catch { return undefined; }
}

export function SpatialModule({ instanceId }: { instanceId: string }) {
  const config = load(instanceId);
  if (!config) return null;
  const modelUrl = `${import.meta.env.BASE_URL}${config.model.slice(1)}`;
  const sceneConfig = {
    ...defaultSceneConfig,
    scroll: [],
    model: config.model,
    hero: {
      ...defaultSceneConfig.hero,
      camera: config.camera,
      model: { rotation: config.rotation, scale: config.scale },
    },
  };
  return <section
    data-spatial-module={config.instanceId}
    data-spatial-asset={config.assetId}
    style={{
      display: 'flex',
      width: '100%',
      justifyContent: config.layout.align === 'start' ? 'flex-start' : config.layout.align === 'end' ? 'flex-end' : 'center',
      marginBlock: `${config.layout.offsetY}px`,
    }}>
    <div style={{
      width: `${config.layout.widthPercent}%`,
      maxWidth: '100%',
      transform: `translateX(${config.layout.offsetX}px)`,
      aspectRatio: sceneRenderSettings.aspectRatio,
      position: 'relative',
    }}>
      <ProductScene
        config={sceneConfig}
        modelUrl={modelUrl}
        controls
        animation={{ playing: config.animation.playing, clip: config.animation.clip || undefined, loop: config.animation.loop }}
      />
    </div>
  </section>;
}
