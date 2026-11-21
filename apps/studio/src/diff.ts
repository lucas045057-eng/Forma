export type DiffLine = { kind: 'add' | 'delete' | 'hunk' | 'meta' | 'context'; text: string };

const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Classifies unified-diff lines. Inside a hunk the header's line counts decide what is
 * content, so a changed line such as `-- old` → `++ new` (rendered `--- old` / `+++ new`)
 * is a deletion/addition, not a file header. `exact` is false when a body disagrees with
 * its hunk counts or changes appear outside any counted hunk.
 */
function scan(patch: string) {
  let oldLeft = 0;
  let newLeft = 0;
  let exact = true;
  const lines = patch.replace(/\n$/, '').split('\n').map((text): DiffLine => {
    if (oldLeft > 0 || newLeft > 0) {
      if (text.startsWith('-') && oldLeft > 0) { oldLeft--; return { kind: 'delete', text }; }
      if (text.startsWith('+') && newLeft > 0) { newLeft--; return { kind: 'add', text }; }
      if (text.startsWith('\\')) return { kind: 'meta', text };
      if ((text.startsWith(' ') || text === '') && oldLeft > 0 && newLeft > 0) { oldLeft--; newLeft--; return { kind: 'context', text }; }
      // The body disagrees with the header: leave the hunk and classify the line on its own.
      exact = false;
      oldLeft = 0;
      newLeft = 0;
    }
    const header = hunkHeader.exec(text);
    if (header) {
      oldLeft = header[1] === undefined ? 1 : Number(header[1]);
      newLeft = header[2] === undefined ? 1 : Number(header[2]);
      return { kind: 'hunk', text };
    }
    if (text.startsWith('\\')) return { kind: 'meta', text };
    if (text.startsWith('@@')) { exact = false; return { kind: 'hunk', text }; }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) return { kind: 'meta', text };
    if (text.startsWith('+')) { exact = false; return { kind: 'add', text }; }
    if (text.startsWith('-')) { exact = false; return { kind: 'delete', text }; }
    return { kind: 'context', text };
  });
  if (oldLeft > 0 || newLeft > 0) exact = false;
  return { lines, exact };
}

export function parseDiff(patch: string): DiffLine[] {
  return scan(patch).lines;
}

/** Added/deleted line counts, or `null` when the patch cannot be counted reliably. */
export function countDiff(patch: string): { added: number; deleted: number } | null {
  const { lines, exact } = scan(patch);
  if (!exact) return null;
  let added = 0;
  let deleted = 0;
  for (const line of lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'delete') deleted++;
  }
  return { added, deleted };
}
