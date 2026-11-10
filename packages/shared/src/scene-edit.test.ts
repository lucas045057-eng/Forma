import { expect, it } from 'vitest';
import { defaultSceneConfig } from './scene-config';
import { sceneDiff, setSceneHero, setSceneKeyframe, temperatureToHex } from './scene-edit';

it('diffs fields, additions and removals using JSON pointer paths', () => {
  expect(sceneDiff({ hero: { a: 1 }, scroll: [0, 1] }, { hero: { a: 2 }, scroll: [0] })).toEqual([
    { path: '/hero/a', oldValue: 1, newValue: 2 }, { path: '/scroll/1', oldValue: 1, newValue: null },
  ]);
  expect(sceneDiff({ 'a/b': 1 }, { 'a/b': 2 })[0].path).toBe('/a~1b');
  expect(sceneDiff(defaultSceneConfig, structuredClone(defaultSceneConfig))).toEqual([]);
});
it('maps warm and daylight temperatures with bounded valid channels', () => {
  expect(temperatureToHex(2700)).toBe('#ffa757');
  expect(temperatureToHex(6500)).toBe('#fffefa');
  expect(temperatureToHex(0)).toBe(temperatureToHex(2700));
  expect(temperatureToHex(9000)).toBe(temperatureToHex(6500));
  expect(temperatureToHex(NaN)).toBe(temperatureToHex(6500));
  const blue = (k: number) => parseInt(temperatureToHex(k).slice(5), 16);
  expect(blue(4000)).toBeGreaterThan(blue(2700));
  expect(blue(6500)).toBeGreaterThan(blue(4000));
});
it('overwrites frames within inclusive tolerance and preserves other parts', () => {
  const input = { ...defaultSceneConfig, scroll: [
    { at: 0.58, parts: { cap: { offset: [1, 0, 0] as [number, number, number] } } }, { at: 0.61 }, { at: 0.9 },
  ] };
  const next = setSceneKeyframe(input, 0.6, [0, 1, 0], 0.08);
  expect(next.scroll.map(f => f.at)).toEqual([0.6, 0.9]);
  expect(next.scroll[0].parts?.lid.offset).toEqual([0, 0.08, 0]);
  expect(input.scroll).toHaveLength(3);
  expect(setSceneKeyframe(input, 0.58, [0, 0, 0]).scroll[0].parts?.cap.offset).toEqual([1, 0, 0]);
});
it('setting hero also replaces frame zero so old keyframes cannot mask it', () => {
  const hero = structuredClone(defaultSceneConfig.hero); hero.model.rotation = [1, 2, 3];
  const next = setSceneHero({ ...defaultSceneConfig, scroll: [{ at: 0, model: { rotation: [0, 0, 0] } }, { at: 0.6 }] }, hero, 0.05);
  expect(next.hero).toEqual(hero);
  expect(next.scroll[0].model?.rotation).toEqual([1, 2, 3]);
  expect(next.scroll[0].parts?.lid.offset).toEqual([0, 0.05, 0]);
  expect(next.scroll[1].at).toBe(0.6);
});
it('unwraps handle angles against the preceding rotation so crossing ±π takes the short arc', () => {
  const deg = (value: number) => value * Math.PI / 180;
  const input = { ...defaultSceneConfig, hero: { ...defaultSceneConfig.hero, model: { rotation: [0, deg(179), 0] as [number, number, number], scale: 1 } }, scroll: [] };
  const crossed = setSceneKeyframe(input, 0.5, [0, deg(-179), 0]).scroll[0].model!.rotation[1];
  expect(crossed).toBeCloseTo(deg(181), 10);
  // The reference is the nearest earlier frame that carries a rotation, not just the hero.
  const chained = setSceneKeyframe({ ...input, scroll: [{ at: 0.3, model: { rotation: [0, deg(350), 0] } }, { at: 0.4 }] }, 0.8, [0, deg(10), 0]);
  expect(chained.scroll.at(-1)!.model!.rotation[1]).toBeCloseTo(deg(370), 10);
  // Frame zero has nothing before it, and nearby angles are left untouched.
  expect(setSceneKeyframe(input, 0, [0, deg(-179), 0]).scroll[0].model!.rotation[1]).toBe(deg(-179));
  expect(setSceneKeyframe(input, 0.5, [0, 1, 0]).scroll[0].model!.rotation).toEqual([0, 1, 0]);
});
