import { describe, expect, it } from 'vitest';
import { evaluateSnapshotBudget, SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_FILES, SNAPSHOT_MAX_TOTAL_BYTES } from './snapshot.ts';

describe('snapshot budget preflight (same limits as checks)', () => {
  it('accepts the exact file and total boundaries', () => {
    expect(evaluateSnapshotBudget([{ path: 'public/assets/exact.glb', bytes: SNAPSHOT_MAX_FILE_BYTES }])).toBeUndefined();
    expect(evaluateSnapshotBudget([
      { path: 'public/assets/a.glb', bytes: 25 * 1024 * 1024 },
      { path: 'public/assets/b.glb', bytes: 25 * 1024 * 1024 },
    ])).toBeUndefined();
  });

  it('rejects one byte over the single-file or total limit', () => {
    expect(evaluateSnapshotBudget([{ path: 'public/assets/large.glb', bytes: SNAPSHOT_MAX_FILE_BYTES + 1 }])).toMatchObject({ reason: 'file', limit: SNAPSHOT_MAX_FILE_BYTES });
    expect(evaluateSnapshotBudget([
      { path: 'public/assets/a.glb', bytes: 25 * 1024 * 1024 },
      { path: 'public/assets/b.glb', bytes: 25 * 1024 * 1024 + 1 },
    ])).toMatchObject({ reason: 'total', limit: SNAPSHOT_MAX_TOTAL_BYTES });
  });

  it('rejects more than the file count limit and counts shared paths once', () => {
    const entries = Array.from({ length: SNAPSHOT_MAX_FILES + 1 }, (_item, index) => ({ path: `src/f${index}.ts`, bytes: 1 }));
    expect(evaluateSnapshotBudget(entries)).toMatchObject({ reason: 'count', limit: SNAPSHOT_MAX_FILES });
    const unique = new Map([['public/assets/shared.glb', 10], ['public/assets/shared.glb', 10]]);
    expect(evaluateSnapshotBudget([...unique.entries()].map(([path, bytes]) => ({ path, bytes })))).toBeUndefined();
  });
});
