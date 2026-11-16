import { expect, it } from 'vitest';
import {
  adjustSceneModuleConfig,
  defaultSceneModuleConfig,
  isManagedModulePath,
  moduleComponentPath,
  moduleConfigPath,
  parseSceneModuleConfig,
} from './scene-module.ts';

const instanceId = 'a'.repeat(32);

it('generates a static, asset-bound configuration and rejects arbitrary URLs or extra fields', () => {
  const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
  expect(config.model).toBe('/assets/asset1.glb');
  expect(config.animation.playing).toBe(false);
  expect(parseSceneModuleConfig(config)).toEqual(config);
  expect(() => parseSceneModuleConfig({ ...config, model: 'https://example.invalid/x.glb' })).toThrow();
  expect(() => parseSceneModuleConfig({ ...config, extra: true })).toThrow();
  expect(() => parseSceneModuleConfig({ ...config, layout: { ...config.layout, widthPercent: 101 } })).toThrow();
  expect(() => parseSceneModuleConfig({ ...config, animation: { ...config.animation, playing: 'yes' } })).toThrow();
});

it('only adjusts presentation fields and never changes identity, asset or model', () => {
  const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
  const next = adjustSceneModuleConfig(config, { layout: { widthPercent: 70, offsetX: 12 }, rotation: [0, 1, 0], scale: 1.5, animation: { playing: true, clip: 'Idle_Loop' } });
  expect(next.instanceId).toBe(config.instanceId);
  expect(next.assetId).toBe(config.assetId);
  expect(next.model).toBe(config.model);
  expect(next.layout.widthPercent).toBe(70);
  expect(next.animation.playing).toBe(true);
  expect(() => adjustSceneModuleConfig(config, { assetId: 'other' })).toThrow();
  expect(() => adjustSceneModuleConfig(config, { model: '/assets/other.glb' })).toThrow();
  expect(() => adjustSceneModuleConfig(config, { layout: { inset: 4 } })).toThrow();
});

it('marks the module config namespace and renderer as managed for every normalization', () => {
  expect(moduleConfigPath(instanceId)).toBe(`src/scene-modules/${instanceId}.json`);
  expect(moduleComponentPath(instanceId)).toBe(`src/scene-modules/${instanceId}.tsx`);
  for (const file of [
    `src/scene-modules/${instanceId}.json`,
    `SRC\\Scene-Modules\\${instanceId}.json`,
    `./src//scene-modules/${instanceId}.tsx`,
    'src/spatial-module.tsx',
    'SRC/SPATIAL-MODULE.TSX',
    'src/spatial-module.ts',
    'src/spatial-module.js',
    'src/spatial-module.mjs',
    'src/spatial-module/index.ts',
    'src/spatial-module.d.ts',
  ]) expect(isManagedModulePath(file)).toBe(true);
  for (const file of ['src/App.tsx', 'src/scene-modules-other/x.json', 'public/assets/x.glb']) expect(isManagedModulePath(file)).toBe(false);
  expect(() => moduleConfigPath('../escape')).toThrow();
});
