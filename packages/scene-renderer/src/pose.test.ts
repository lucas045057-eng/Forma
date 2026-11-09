import { expect, it } from 'vitest';
import { Group, Vector3 } from 'three';
import { defaultSceneConfig, type SceneConfig } from '@spatial/shared/scene-config';
import { applyPartOffsets, partPositions, scenePose } from './pose';

const config: SceneConfig = { ...defaultSceneConfig, scroll: [
  { at: 0.6, model: { rotation: [0, 1.8, 0] }, parts: { lid: { offset: [0, 0.08, 0] } } },
  { at: 1, parts: { cap: { offset: [0.1, 0, 0] } } },
] };
it('interpolates independent tracks with smoothstep and holds final values', () => {
  expect(scenePose(config, 0).parts.lid).toEqual([0, 0, 0]);
  expect(scenePose(config, 0.3).parts.lid[1]).toBeCloseTo(0.04);
  expect(scenePose(config, 0.15).parts.lid[1]).toBeCloseTo(0.0125);
  expect(scenePose(config, 0.6)).toMatchObject({ rotation: [0, 1.8, 0], parts: { lid: [0, 0.08, 0] } });
  expect(scenePose(config, 1).parts.lid[1]).toBe(0.08);
  expect(scenePose(config, 10)).toEqual(scenePose(config, 1));
  expect(scenePose(config, -1)).toEqual(scenePose(config, 0));
  expect(scenePose(config, NaN)).toEqual(scenePose(config, 0));
});
it('respects explicit zero keyframes and empty timelines', () => {
  expect(scenePose(defaultSceneConfig).rotation).toEqual(defaultSceneConfig.hero.model.rotation);
  expect(scenePose({ ...config, scroll: [{ at: 0, parts: { lid: { offset: [0, 0.2, 0] } } }] }, 0).parts.lid).toEqual([0, 0.2, 0]);
});
it('moves cap and reeds together without moving body or accumulating offsets', () => {
  const scene = new Group(), lid = new Group(), cap = new Group(), reed = new Group(), body = new Group();
  lid.name = 'lid'; scene.add(body, lid); lid.add(cap, reed);
  cap.position.y = 0.3; reed.position.y = 0.5;
  const base = partPositions(scene);
  for (let i = 0; i < 3; i++) applyPartOffsets(scene, base, { lid: [0, 0.08, 0] });
  expect(cap.getWorldPosition(new Vector3()).y).toBeCloseTo(0.38);
  expect(reed.getWorldPosition(new Vector3()).y).toBeCloseTo(0.58);
  expect(body.position.y).toBe(0);
  applyPartOffsets(scene, base, {});
  expect(lid.position.y).toBe(0);
});
it('converts normalized offsets through scaled and rotated parents', () => {
  const scene = new Group(), parent = new Group(), cap = new Group();
  parent.scale.setScalar(3); parent.rotation.z = Math.PI / 2;
  cap.name = 'cap'; parent.add(cap); scene.add(parent);
  applyPartOffsets(scene, partPositions(scene), { cap: [0, 0.08, 0] });
  const position = cap.getWorldPosition(new Vector3());
  expect(position.x).toBeCloseTo(0); expect(position.y).toBeCloseTo(0.08);
});
