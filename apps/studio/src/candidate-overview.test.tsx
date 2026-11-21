import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Candidate, CheckRun, Task } from '@spatial/shared';
import CandidateOverview from './CandidateOverview.tsx';
import { diffStats, summarizeCandidate, thumbnailSource } from './candidate-overview.ts';

const hash = 'a'.repeat(64);
const candidate = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  id, branch: `candidate/${id}`, baseVersion: 'v1', previewUrl: `/preview/c/${id}/`, candidateCommit: 'c1',
  decision: 'pending', outOfScope: [], checks: [],
  diff: [
    { path: 'src/App.tsx', patch: '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+more' },
    { path: 'src/style.css', patch: '--- a/src/style.css\n+++ b/src/style.css\n@@ -1 +1 @@\n-a{}\n+b{}' },
  ],
  ...extra,
});
const run = (candidateId: string, extra: Partial<CheckRun> = {}): CheckRun => ({
  id: 'run0001', candidateId, candidateCommit: 'c1', baseVersion: 'v1', mainVersion: 'v1', contentDigest: 'd', policyVersion: 'p',
  createdAt: '2026-11-21T00:00:00Z', status: 'completed', outcome: 'failed', checks: [],
  artifacts: [{ name: 'smoke.png', mime: 'image/png', bytes: 10, hash }],
  ...extra,
});
const tasks: Task[] = [{ id: 't1', instruction: '  把按钮改成柠檬绿  ', status: 'done', candidateId: 'cand0001aaaa', events: [] }];

describe('candidate overview summary', () => {
  it('counts files and changed lines without treating diff headers as changes', () => {
    expect(diffStats(candidate('x'))).toEqual({ files: 2, added: 3, deleted: 2 });
  });

  it('uses only a finished, associated run screenshot as the thumbnail', () => {
    const c = candidate('cand0001aaaa', { latestCheckRunId: 'run0001' });
    expect(thumbnailSource(c, run(c.id))).toMatchObject({ runId: 'run0001', key: `run0001:${hash}` });
    expect(thumbnailSource(c, run(c.id, { status: 'running' }))).toBeUndefined();
    expect(thumbnailSource(c, run('someone-else'))).toBeUndefined();
    expect(thumbnailSource(c, run(c.id, { candidateCommit: 'other' }))).toBeUndefined();
    expect(thumbnailSource(c, run(c.id, { artifacts: [{ name: 'smoke.png', mime: 'image/svg+xml', bytes: 10, hash }] }))).toBeUndefined();
    expect(thumbnailSource(candidate('nocheck'), undefined)).toBeUndefined();
  });

  it('summarizes instruction, scope, staleness and check state', () => {
    const c = candidate('cand0001aaaa', { outOfScope: ['src/style.css'], latestCheckRunId: 'run0001' });
    const summary = summarizeCandidate(c, { run: run(c.id), tasks, version: 'v2', ready: true });
    expect(summary).toMatchObject({ shortId: 'cand0001', instruction: '把按钮改成柠檬绿', files: 2, outOfScope: 1, staleBase: true, checkLabel: '检查失败', checkTone: 'bad' });
    expect(summarizeCandidate(candidate('nocheck'), { tasks: [], version: 'v1', ready: true })).toMatchObject({ checkLabel: '未检查', checkTone: 'none', placeholder: 'unchecked', staleBase: false, instruction: undefined });
    expect(summarizeCandidate(c, { run: run(c.id, { status: 'running' }), tasks, version: 'v1', ready: true }).placeholder).toBe('checking');
    expect(summarizeCandidate(c, { run: run(c.id), tasks, version: 'v1', ready: false }).checkLabel).toBe('状态待同步');
    expect(summarizeCandidate(c, { run: run(c.id), tasks, version: 'v1', ready: true, checkIssue: 'x' }).checkLabel).toBe('检查状态不完整');
  });
});

describe('candidate overview render', () => {
  it('renders nothing without pending candidates', () => {
    expect(renderToStaticMarkup(<CandidateOverview summaries={[]} selectedId="" comparing={false} ready onOpen={() => {}}/>)).toBe('');
  });

  it('renders one keyboard-reachable button per candidate with honest placeholders and no iframes', () => {
    const summaries = [
      summarizeCandidate(candidate('cand0001aaaa'), { tasks, version: 'v1', ready: true }),
      summarizeCandidate(candidate('cand0002bbbb', { latestCheckRunId: 'run0001' }), { run: run('cand0002bbbb'), tasks, version: 'v1', ready: true }),
    ];
    const html = renderToStaticMarkup(<CandidateOverview summaries={summaries} selectedId="cand0002bbbb" comparing ready onOpen={() => {}}/>);
    expect(html.match(/data-testid="candidate-card"/g)).toHaveLength(2);
    expect(html.match(/<button type="button" class="candidate-card/g)).toHaveLength(2);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img');
    expect(html).toContain('未运行检查 · 暂无截图');
    expect(html).toContain('data-thumb-state="loading"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('对比中');
    expect(html).toContain('把按钮改成柠檬绿');
    expect(html).toContain('aria-expanded="true"');
  });
});
