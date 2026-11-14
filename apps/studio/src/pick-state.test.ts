import { expect, it } from 'vitest';
import type { Selection } from '@spatial/shared';
import { canSubmit, pickHint, retrySelection, submittedSelection, type PickState } from './pick-state.ts';

const selection = { src: 'src/App.tsx:3:5', baseVersion: 'abc' } as Selection;
it('retries with the original scope instead of the currently picked element', () => {
  const other = { ...selection, src: 'src/Other.tsx:1:1' };
  expect(retrySelection(selection, { kind: 'ready', selection: other }, 'abc').selection).toBe(selection);
  expect(retrySelection(selection, { kind: 'none' }, 'abc').selection).toBe(selection);
  expect(retrySelection(undefined, { kind: 'ready', selection: other }, 'abc').selection).toBeNull();
});
it('requires a same-source repick after version change and never silently retries the whole page', () => {
  expect(retrySelection(selection, { kind: 'none' }, 'new').allowed).toBe(false);
  expect(retrySelection(selection, { kind: 'none' }, 'new').reason).toContain('重新点选');
  expect(retrySelection(selection, { kind: 'ready', selection: { ...selection, src: 'src/Other.tsx:1:1', baseVersion: 'new' } }, 'new').allowed).toBe(false);
  const fresh = { ...selection, baseVersion: 'new' };
  expect(retrySelection(selection, { kind: 'ready', selection: fresh }, 'new')).toEqual({ allowed: true, selection: fresh, reason: '' });
  expect(retrySelection(selection, { kind: 'pending', src: selection.src }, 'new').allowed).toBe(false);
});
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
