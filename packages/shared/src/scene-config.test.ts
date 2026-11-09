import Ajv from 'ajv';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultSceneConfig, isSceneConfig, sceneConfigSchema, type SceneConfig, type Vec3 } from './scene-config';

const validate = new Ajv({ strict: true, allErrors: true }).compile<SceneConfig>(sceneConfigSchema);
const fixture = {
  model: '/assets/models/product.glb',
  hero: {
    camera: { position: [1.6, 1.1, 1.6], target: [0, 0.5, 0], fov: 35 },
    model: { rotation: [0, 0.52, 0], scale: 1 },
    lights: { key: { intensity: 3, color: '#ffd9a8', direction: [3, 5, 4] }, ambient: 1.2 },
  },
  scroll: [
    { at: 0 },
    { at: 0.5, model: { rotation: [0, 1, 0] }, parts: { wheel_front: { offset: [1, 0, 0] } } },
    { at: 1, parts: {} },
  ],
} satisfies SceneConfig;

function withValue(path: string, value: unknown): unknown {
  const result = structuredClone(fixture);
  const keys = path.split('.');
  let node = result as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
  return result;
}

function expectBoth(value: unknown, accepted: boolean) {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(accepted);
  expect(isSceneConfig(value)).toBe(accepted);
}

describe('SceneConfig', () => {
  it('exports a draft-07 schema and a type guard aligned with the public type', () => {
    expect(sceneConfigSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expectTypeOf(defaultSceneConfig).toEqualTypeOf<SceneConfig>();
    expectTypeOf<SceneConfig['hero']['camera']['position']>().toEqualTypeOf<Vec3>();
    const value: unknown = fixture;
    if (isSceneConfig(value)) expectTypeOf(value).toEqualTypeOf<SceneConfig>();
    expectBoth(value, true);
  });

  it('provides the specified fallback scene', () => {
    expect(defaultSceneConfig).toEqual({
      model: '',
      hero: {
        camera: { position: [1.6, 1.1, 1.6], target: [0, 0.5, 0], fov: 35 },
        model: { rotation: [0, 0.52, 0], scale: 1 },
        lights: { key: { intensity: 3, color: '#ffd9a8', direction: [3, 5, 4] }, ambient: 1.2 },
      },
      scroll: [],
    });
    expectBoth(defaultSceneConfig, true);
  });

  it.each(['', '/assets/product.glb', '/assets/models/product-v2.1.gltf'])('allows local model %s', (model) => {
    expectBoth(withValue('model', model), true);
  });

  it.each([
    'https://example.com/model.glb', 'http://example.com/env.hdr', '//example.com/model.glb',
    'data:model/gltf-binary;base64,AA', 'blob:local', '/other/model.glb', '/assets/',
    '/assets/../private.glb', '/assets/./model.glb', '/assets/a/../../model.glb',
    '/assets/%2e%2e/private.glb', '/assets/model.glb?remote=https://example.com',
    '/assets/model.glb#fragment', '/assets/\\example.com/model.glb', '/assets/model.glb\n', '/assets//model.glb',
  ])('rejects nonlocal or ambiguous model %s', (model) => {
    expectBoth(withValue('model', model), false);
  });

  it.each([
    ['hero.camera.fov', 1, 120], ['hero.model.scale', 0.01, 100],
    ['hero.lights.key.intensity', 0, 20], ['hero.lights.ambient', 0, 20],
  ] as const)('checks finite numeric limits for %s', (path, min, max) => {
    for (const value of [min, max]) expectBoth(withValue(path, value), true);
    for (const value of [min - 0.001, max + 0.001, NaN, Infinity, -Infinity, '1', null]) {
      expectBoth(withValue(path, value), false);
    }
  });

  it.each([
    'hero.camera.position', 'hero.camera.target', 'hero.model.rotation',
    'hero.lights.key.direction', 'scroll.1.model.rotation', 'scroll.1.parts.wheel_front.offset',
  ])('requires exactly three finite numbers at %s', (path) => {
    expectBoth(withValue(path, [-2.5, 0, 1e100]), true);
    for (const value of [[], [1, 2], [1, 2, 3, 4], [NaN, 0, 0], [0, Infinity, 0], [0, 0, -Infinity], [0, '1', 0], null, {}]) {
      expectBoth(withValue(path, value), false);
    }
  });

  it('requires six-digit hex colors', () => {
    expectBoth(withValue('hero.lights.key.color', '#A0b1C2'), true);
    for (const color of ['red', '#abc', '#12345678', '123456', '#gg0000', '#123456\n', '', null]) {
      expectBoth(withValue('hero.lights.key.color', color), false);
    }
  });

  it('allows safe part names and rejects unsafe dictionary keys', () => {
    for (const name of ['wheel', '_hinge', 'part-2', 'Part_3']) {
      expectBoth(withValue('scroll.1.parts', { [name]: { offset: [0, 0, 0] } }), true);
    }
    for (const name of ['', '1part', 'wheel.front', '../wheel', 'a/b', 'wheel\n', '__proto__', 'constructor', 'prototype']) {
      expectBoth(withValue('scroll.1.parts', { [name]: { offset: [0, 0, 0] } }), false);
    }
  });

  it.each([
    '', 'hero', 'hero.camera', 'hero.model', 'hero.lights', 'hero.lights.key',
    'scroll.1', 'scroll.1.model', 'scroll.1.parts.wheel_front',
  ])('rejects extra fields at %s', (path) => {
    expectBoth(withValue(path ? `${path}.extra` : 'extra', true), false);
  });

  it.each([
    'model', 'hero', 'scroll', 'hero.camera', 'hero.model', 'hero.lights',
    'hero.camera.position', 'hero.camera.target', 'hero.camera.fov',
    'hero.model.rotation', 'hero.model.scale', 'hero.lights.key', 'hero.lights.ambient',
    'hero.lights.key.intensity', 'hero.lights.key.color', 'hero.lights.key.direction',
    'scroll.1.at', 'scroll.1.model.rotation', 'scroll.1.parts.wheel_front.offset',
  ])('rejects missing required field %s', (path) => {
    const value = withValue(path, undefined);
    expectBoth(JSON.parse(JSON.stringify(value)), false);
  });

  it('rejects invalid objects, optional structures, and scroll ranges', () => {
    for (const value of [null, [], {}, true, 1, 'scene']) expectBoth(value, false);
    for (const path of ['scroll.1.model', 'scroll.1.parts', 'scroll.1.parts.wheel_front']) {
      for (const value of [null, [], 'bad', 1]) expectBoth(withValue(path, value), false);
    }
    for (const at of [-0.1, 1.1, NaN, Infinity, '0.5', null]) {
      expectBoth(withValue('scroll.1.at', at), false);
    }
    expectBoth(withValue('scroll', {}), false);
  });

  it('adds strict scroll ordering as a semantic check beyond draft-07', () => {
    for (const scroll of [[{ at: 0.5 }, { at: 0.5 }], [{ at: 1 }, { at: 0 }]]) {
      const value = withValue('scroll', scroll);
      expect(validate(value)).toBe(true);
      expect(isSceneConfig(value)).toBe(false);
    }
    expectBoth(withValue('scroll', [{ at: 0 }, { at: 0.001 }, { at: 1 }]), true);
  });
});
