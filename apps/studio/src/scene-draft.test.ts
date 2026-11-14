import { expect, it } from 'vitest';
import { SceneDraftGuard } from './scene-draft.ts';
it('does not reload a scene draft with unsaved edits', () => {
  const draft = new SceneDraftGuard();
  draft.edit();
  expect(draft.beginLoad()).toBeNull();
  expect(draft.dirty).toBe(true);
});
it('clears the unsaved flag after a successful save and permits reload', () => {
  const draft = new SceneDraftGuard();
  draft.edit(); draft.saved();
  expect(draft.dirty).toBe(false);
  expect(draft.beginLoad()).not.toBeNull();
});
it('rejects a scene GET that arrives after editing or saving', () => {
  const draft = new SceneDraftGuard();
  const beforeEdit = draft.beginLoad()!;
  draft.edit();
  expect(draft.canApply(beforeEdit)).toBe(false);
  const explicit = draft.beginLoad(true)!;
  draft.edit();
  expect(draft.canApply(explicit)).toBe(false);
  draft.saved();
  const beforeSave = draft.beginLoad()!;
  draft.saved();
  expect(draft.canApply(beforeSave)).toBe(false);
});
it('allows explicit read without clearing dirty until it succeeds', () => {
  const draft = new SceneDraftGuard();
  draft.edit();
  const revision = draft.beginLoad(true)!;
  expect(draft.dirty).toBe(true);
  expect(draft.canApply(revision)).toBe(true);
  draft.saved();
  expect(draft.dirty).toBe(false);
});
