/// <reference types="vite/client" />
import { useSyncExternalStore } from 'react';
import { defaultSceneConfig, isSceneConfig, type SceneConfig } from '@spatial/shared/scene-config';
import rawConfig from './scene.config.json?raw';

// Raw import lets syntax errors reach our validator instead of Vite's JSON error overlay.
let current: SceneConfig = import.meta.hot?.data.lastValidScene ?? defaultSceneConfig;
const listeners = new Set<() => void>();
function accept(text: string) {
  try {
    const next: unknown = JSON.parse(text);
    if (isSceneConfig(next)) {
      current = next;
      if (import.meta.hot) import.meta.hot.data.lastValidScene = current;
      listeners.forEach(listener => listener());
    }
  } catch { /* Keep the previous valid scene, including on malformed JSON edits. */ }
}
accept(rawConfig);
if (import.meta.hot) {
  import.meta.hot.accept('./scene.config.json?raw', module => { if (module) accept(module.default); });
  import.meta.hot.dispose(data => { data.lastValidScene = current; });
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useSceneConfig() { return useSyncExternalStore(subscribe, () => current); }
