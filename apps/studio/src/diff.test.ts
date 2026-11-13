import { expect, it } from 'vitest';
import { parseDiff } from './diff.ts';

it('classifies added, removed, hunk and metadata lines without treating file headers as changes', () => {
  const lines = parseDiff('diff --git a/A.tsx b/A.tsx\n--- a/A.tsx\n+++ b/A.tsx\n@@ -1 +1 @@\n-old\n+new\n context\n');
  expect(lines.map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'delete', 'add', 'context']);
  expect(lines.map(line => line.text)).toContain('+new');
});
