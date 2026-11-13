import { expect, it } from 'vitest';
import type { Selection } from '@spatial/shared';
import { canSubmit, pickHint, submittedSelection, type PickState } from './pick-state.ts';

const selection = { src: 'src/App.tsx:3:5', baseVersion: 'abc' } as Selection;
it('blocks every submission while the latest pick has no version, and never falls back to the old object', () => {
  const pending: PickState = { kind: 'pending', src: 'src/App.tsx:9:1' };
  const failed: PickState = { kind: 'failed', src: 'src/App.tsx:9:1' };
  for (const state of [pending, failed]) {
    expect(canSubmit(state)).toBe(false);
    expect(submittedSelection(state)).toBeNull();
  }
  expect(pickHint(pending)).toContain('正在读取');
  expect(pickHint(failed)).toContain('重新点选');
  expect(canSubmit({ kind: 'ready', selection })).toBe(true);
  expect(submittedSelection({ kind: 'ready', selection })).toBe(selection);
  expect(canSubmit({ kind: 'none' })).toBe(true);
  expect(submittedSelection({ kind: 'none' })).toBeNull();
});
