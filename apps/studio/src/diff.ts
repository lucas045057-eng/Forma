export type DiffLine = { kind: 'add' | 'delete' | 'hunk' | 'meta' | 'context'; text: string };

export function parseDiff(patch: string): DiffLine[] {
  return patch.replace(/\n$/, '').split('\n').map(text => {
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ')) return { kind: 'meta', text };
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'delete', text };
    return { kind: 'context', text };
  });
}
