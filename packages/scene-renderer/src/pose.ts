import type { SceneConfig, Vec3 } from '@spatial/shared';
import { Matrix3, Matrix4, Object3D, Vector3 } from 'three';

type Point = { at: number; value: Vec3 };
function sample(points: Point[], at: number): Vec3 {
  const right = points.findIndex(point => point.at > at);
  if (right === -1) return [...points[points.length - 1].value];
  if (right === 0) return [...points[0].value];
  const a = points[right - 1], b = points[right];
  const t = (at - a.at) / (b.at - a.at);
  const eased = t * t * (3 - 2 * t);
  return a.value.map((value, axis) => value + (b.value[axis] - value) * eased) as Vec3;
}

// Each property is an independent track; omitted properties do not reset other tracks.
export function scenePose(config: SceneConfig, scrollAt = 0) {
  const at = Number.isFinite(scrollAt) ? Math.max(0, Math.min(1, scrollAt)) : 0;
  const rotation: Point[] = [{ at: 0, value: config.hero.model.rotation }];
  const parts: Record<string, Point[]> = Object.create(null);
  for (const frame of config.scroll) {
    if (frame.model) {
      if (frame.at === 0) rotation.length = 0;
      rotation.push({ at: frame.at, value: frame.model.rotation });
    }
    for (const [name, part] of Object.entries(frame.parts ?? {})) {
      parts[name] ??= [{ at: 0, value: [0, 0, 0] }];
      if (frame.at === 0) parts[name].length = 0;
      parts[name].push({ at: frame.at, value: part.offset });
    }
  }
  return {
    rotation: sample(rotation, at),
    parts: Object.fromEntries(Object.entries(parts).map(([name, track]) => [name, sample(track, at)])),
  };
}

export function partPositions(scene: Object3D) {
  const result = new Map<Object3D, Vector3>();
  scene.traverse(node => result.set(node, node.position.clone()));
  return result;
}

export function applyPartOffsets(scene: Object3D, base: Map<Object3D, Vector3>, offsets: Record<string, Vec3>) {
  for (const [node, position] of base) node.position.copy(position);
  for (const [name, offset] of Object.entries(offsets)) {
    const node = scene.getObjectByName(name);
    if (!node || node === scene) continue;
    // Offsets use normalized model coordinates, regardless of a node's scaled parent.
    const parentMatrix = new Matrix4();
    const parents: Object3D[] = [];
    for (let parent = node.parent; parent && parent !== scene; parent = parent.parent) parents.unshift(parent);
    for (const parent of parents) { parent.updateMatrix(); parentMatrix.multiply(parent.matrix); }
    const localOffset = new Vector3(...offset).applyMatrix3(new Matrix3().setFromMatrix4(parentMatrix).invert());
    node.position.add(localOffset);
  }
  scene.updateMatrixWorld(true);
}
