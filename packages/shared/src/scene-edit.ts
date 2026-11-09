import type { SceneConfig, Vec3 } from './scene-config.ts';

export interface SceneDiff { path: string; oldValue: unknown; newValue: unknown }
export interface SceneChanged {
  type: 'scene.changed'; sequence: number; ts: string; config: SceneConfig; diff: SceneDiff[];
}
export function sceneDiff(before: unknown, after: unknown, path = ''): SceneDiff[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before !== null && after !== null && typeof before === 'object' && typeof after === 'object') {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key =>
      sceneDiff(a[key], b[key], `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`));
  }
  return [{ path: path || '/', oldValue: before ?? null, newValue: after ?? null }];
}

export function temperatureToHex(kelvin: number): string {
  const t = Math.max(2700, Math.min(6500, Number.isFinite(kelvin) ? kelvin : 6500)) / 100;
  // Tanner Helland approximation, intended for UI color temperature controls.
  const channels = [255, 99.4708025861 * Math.log(t) - 161.1195681661,
    138.5177312231 * Math.log(t - 10) - 305.0447927307];
  return `#${channels.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('')}`;
}

export function setSceneKeyframe(config: SceneConfig, at: number, rotation: Vec3, lid?: number): SceneConfig {
  const next = structuredClone(config);
  const position = Math.max(0, Math.min(1, at));
  const near = next.scroll.filter(frame => Math.abs(frame.at - position) <= 0.02 + Number.EPSILON);
  const closest = [...near].sort((a, b) => Math.abs(a.at - position) - Math.abs(b.at - position))[0];
  const frame = { ...closest, at: position, model: { rotation: [...rotation] as Vec3 } };
  if (lid !== undefined) frame.parts = { ...frame.parts, lid: { offset: [0, Math.max(0, Math.min(0.15, lid)), 0] } };
  next.scroll = [...next.scroll.filter(item => !near.includes(item)), frame].sort((a, b) => a.at - b.at);
  return next;
}

export function setSceneHero(config: SceneConfig, hero: SceneConfig['hero'], lid?: number): SceneConfig {
  // An explicit frame at zero otherwise masks hero.rotation in the shared renderer.
  const next = setSceneKeyframe(config, 0, hero.model.rotation, lid);
  next.hero = structuredClone(hero);
  return next;
}
