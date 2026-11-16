import { defaultSceneConfig, type Vec3 } from './scene-config.ts';

/**
 * A placed 3D module is identified only by a server-issued instance id. Its model, camera,
 * transform, layout and animation state live in a server-managed configuration file under
 * `src/scene-modules/`; page code never carries the model URL or a replacement configuration.
 */
export const SCENE_MODULE_DIRECTORY = 'src/scene-modules';
export const SCENE_MODULE_RENDERER = 'src/spatial-module.tsx';
export const MODULE_INSTANCE_PATTERN = /^[a-f0-9]{32}$/;
export const MODULE_ASSET_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export type SceneModuleAlignment = 'start' | 'center' | 'end';

export interface SceneModuleConfig {
  schemaVersion: 1;
  instanceId: string;
  assetId: string;
  /** Exactly `/assets/<assetId>.glb`; never an arbitrary URL or filesystem path. */
  model: string;
  camera: { position: Vec3; target: Vec3; fov: number };
  rotation: Vec3;
  scale: number;
  layout: { widthPercent: number; align: SceneModuleAlignment; offsetX: number; offsetY: number };
  animation: { clip: string; playing: boolean; loop: boolean };
}

export class SceneModuleError extends Error {
  readonly code = 'INVALID_SCENE_MODULE';
  constructor(message: string) { super(message); this.name = 'SceneModuleError'; }
}

export function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function vec3(value: unknown, min: number, max: number, name: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => !isFiniteNumber(item, min, max))) {
    throw new SceneModuleError(`${name} 必须是三个有限数值`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SceneModuleError(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, names: readonly string[], name: string): void {
  const extra = Object.keys(value).filter(key => !names.includes(key));
  if (extra.length) throw new SceneModuleError(`${name} 包含不支持的字段：${extra.join('、')}`);
}

export function isSceneModuleConfig(value: unknown): value is SceneModuleConfig {
  try { parseSceneModuleConfig(value); return true; } catch { return false; }
}

export function parseSceneModuleConfig(value: unknown): SceneModuleConfig {
  const input = record(value, '模块配置');
  only(input, ['schemaVersion', 'instanceId', 'assetId', 'model', 'camera', 'rotation', 'scale', 'layout', 'animation'], '模块配置');
  if (input.schemaVersion !== 1) throw new SceneModuleError('模块配置版本必须为 1');
  if (typeof input.instanceId !== 'string' || !MODULE_INSTANCE_PATTERN.test(input.instanceId)) throw new SceneModuleError('实例编号必须由服务端产生');
  if (typeof input.assetId !== 'string' || !MODULE_ASSET_PATTERN.test(input.assetId)) throw new SceneModuleError('资产编号无效');
  if (input.model !== `/assets/${input.assetId}.glb`) throw new SceneModuleError('模型地址必须指向本站已登记资产');
  const camera = record(input.camera, '相机');
  only(camera, ['position', 'target', 'fov'], '相机');
  const layout = record(input.layout, '布局');
  only(layout, ['widthPercent', 'align', 'offsetX', 'offsetY'], '布局');
  const widthPercent = layout.widthPercent, align = layout.align, offsetX = layout.offsetX, offsetY = layout.offsetY;
  if (!isFiniteNumber(widthPercent, 10, 100)) throw new SceneModuleError('模块宽度须为 10–100%');
  if (!['start', 'center', 'end'].includes(String(align))) throw new SceneModuleError('模块对齐方式无效');
  if (!isFiniteNumber(offsetX, -500, 500) || !isFiniteNumber(offsetY, -500, 500)) throw new SceneModuleError('模块偏移须在 ±500px 内');
  const animation = record(input.animation, '动画');
  only(animation, ['clip', 'playing', 'loop'], '动画');
  const clip = animation.clip, playing = animation.playing, loop = animation.loop;
  if (typeof clip !== 'string' || clip.length > 120 || (clip && !/^[A-Za-z0-9_.-]+$/.test(clip))) throw new SceneModuleError('动画片段名称无效');
  if (typeof playing !== 'boolean' || typeof loop !== 'boolean') throw new SceneModuleError('动画播放开关必须是布尔值');
  const scale = input.scale, instanceId = input.instanceId as string, assetId = input.assetId as string, model = input.model as string;
  if (!isFiniteNumber(scale, 0.01, 100)) throw new SceneModuleError('模型比例须为 0.01–100');
  return {
    schemaVersion: 1,
    instanceId,
    assetId,
    model,
    camera: {
      position: vec3(camera.position, -20, 20, '相机位置'),
      target: vec3(camera.target, -20, 20, '相机目标'),
      fov: (() => { if (!isFiniteNumber(camera.fov, 1, 120)) throw new SceneModuleError('相机视角须为 1–120'); return camera.fov as number; })(),
    },
    rotation: vec3(input.rotation, -1000, 1000, '模型旋转'),
    scale,
    layout: {
      widthPercent,
      align: align as SceneModuleAlignment,
      offsetX,
      offsetY,
    },
    animation: { clip, playing, loop },
  };
}

export function defaultSceneModuleConfig(input: { instanceId: string; assetId: string }): SceneModuleConfig {  return parseSceneModuleConfig({
    schemaVersion: 1,
    instanceId: input.instanceId,
    assetId: input.assetId,
    model: `/assets/${input.assetId}.glb`,
    camera: {
      position: [...defaultSceneConfig.hero.camera.position] as Vec3,
      target: [...defaultSceneConfig.hero.camera.target] as Vec3,
      fov: defaultSceneConfig.hero.camera.fov,
    },
    rotation: [0, 0, 0] as Vec3,
    scale: 1,
    layout: { widthPercent: 100, align: 'center', offsetX: 0, offsetY: 0 },
    animation: { clip: '', playing: false, loop: true },
  });
}

export interface SceneModuleAdjustment {
  layout?: Partial<SceneModuleConfig['layout']>;
  rotation?: Vec3;
  scale?: number;
  camera?: Partial<SceneModuleConfig['camera']>;
  animation?: Partial<SceneModuleConfig['animation']>;
}

/**
 * Merge a user adjustment into an existing instance. Identity fields (instanceId, assetId,
 * model) are never adjustable here; model replacement has its own server-controlled history.
 */
export function adjustSceneModuleConfig(current: SceneModuleConfig, patch: unknown): SceneModuleConfig {
  const base = parseSceneModuleConfig(current);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SceneModuleError('模块调整必须是对象');
  const input = patch as Record<string, unknown>;
  only(input, ['layout', 'rotation', 'scale', 'camera', 'animation'], '模块调整');
  const layout = input.layout === undefined ? {} : record(input.layout, '布局调整');
  only(layout, ['widthPercent', 'align', 'offsetX', 'offsetY'], '布局调整');
  const camera = input.camera === undefined ? {} : record(input.camera, '相机调整');
  only(camera, ['position', 'target', 'fov'], '相机调整');
  const animation = input.animation === undefined ? {} : record(input.animation, '动画调整');
  only(animation, ['clip', 'playing', 'loop'], '动画调整');
  return parseSceneModuleConfig({
    ...base,
    layout: { ...base.layout, ...layout },
    rotation: input.rotation ?? base.rotation,
    scale: input.scale ?? base.scale,
    camera: { ...base.camera, ...camera },
    animation: { ...base.animation, ...animation },
  });
}

export function moduleConfigPath(instanceId: string): string {
  if (!MODULE_INSTANCE_PATTERN.test(instanceId)) throw new SceneModuleError('实例编号无效');
  return `${SCENE_MODULE_DIRECTORY}/${instanceId}.json`;
}

export function moduleComponentPath(instanceId: string): string {
  if (!MODULE_INSTANCE_PATTERN.test(instanceId)) throw new SceneModuleError('实例编号无效');
  return `${SCENE_MODULE_DIRECTORY}/${instanceId}.tsx`;
}

/** Normalize a repository-relative path before comparing it to the managed namespace. */
export function normalizeRepoPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/').toLowerCase();
}

/** Managed paths are server-only: models may reference them but never create, edit, delete or rename them. */
export function isManagedModulePath(value: string): boolean {
  const path = normalizeRepoPath(value);
  return path === normalizeRepoPath(SCENE_MODULE_RENDERER) || path.startsWith(`${normalizeRepoPath(SCENE_MODULE_DIRECTORY)}/`);
}
