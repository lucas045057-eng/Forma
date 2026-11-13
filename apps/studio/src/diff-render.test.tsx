import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { Candidate } from '@spatial/shared';
import { Diff } from './CandidatePanel.tsx';

it('renders unified diff with change classes and escapes generated HTML', () => {
  const candidate: Candidate = {
    id: 'example', branch: 'candidate/example', baseVersion: 'abc', previewUrl: '/preview/c/example/',
    decision: 'pending', outOfScope: [], checks: [],
    diff: [{ path: 'src/App.tsx', patch: '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+<script>alert(1)</script>' }],
  };
  const html = renderToStaticMarkup(<Diff candidate={candidate}/>);
  expect(html).toContain('class="diff-add"');
  expect(html).toContain('class="diff-delete"');
  expect(html).toContain('class="diff-hunk"');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});
