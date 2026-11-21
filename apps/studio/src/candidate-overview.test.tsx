import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Candidate, CheckRun, Task } from '@spatial/shared';
import CandidateOverview from './CandidateOverview.tsx';
import { diffStats, summarizeCandidate, thumbnailSource } from './candidate-overview.ts';
import { countDiff, parseDiff, TRUNCATED_MARKER } from './diff.ts';

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
const gate = { ready: true, stale: false, epoch: 3 };
const tasks: Task[] = [{ id: 't1', instruction: '  把按钮改成柠檬绿  ', status: 'done', candidateId: 'cand0001aaaa', events: [] }];
const base = { tasks, version: 'v1', ready: true, epoch: 3 };

describe('diff line classification', () => {
  it('treats ---/+++ inside a counted hunk as content, not file headers', () => {
    const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n--- old\n+++ new';
    expect(parseDiff(patch).map(line => line.kind)).toEqual(['meta', 'meta', 'meta', 'hunk', 'context', 'delete', 'add']);
    expect(countDiff(patch)).toEqual({ added: 1, deleted: 1 });
  });

  it('handles several hunks, omitted counts and the no-newline marker', () => {
    const patch = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n@@ -10,0 +11,2 @@\n+c\n+d';
    expect(countDiff(patch)).toEqual({ added: 3, deleted: 1 });
  });

  it('refuses to count when the body disagrees with the hunk header', () => {
    expect(countDiff('@@ -1,1 +1,1 @@\n-a\n+b\n+extra')).toBeNull();
    expect(countDiff('@@ -1,3 +1,3 @@\n-a\n+b')).toBeNull();
    expect(countDiff('@@\n-a\n+b')).toBeNull();
    // Server cap that happens to end right after a complete hunk.
    expect(countDiff(`@@ -1 +1 @@\n-a\n+b\n${TRUNCATED_MARKER}`)).toBeNull();
    expect(diffStats(candidate('x', { diff: [{ path: 'a', patch: '@@\n-a\n+b' }] }))).toEqual({ files: 1, added: null, deleted: null });
  });

  it('counts files and changed lines without treating diff headers as changes', () => {
    expect(diffStats(candidate('x'))).toEqual({ files: 2, added: 3, deleted: 2 });
  });
});

describe('candidate overview summary', () => {
  it('uses only a finished, associated, current run screenshot as the thumbnail', () => {
    const c = candidate('cand0001aaaa', { latestCheckRunId: 'run0001' });
    expect(thumbnailSource(c, run(c.id), gate)).toMatchObject({ runId: 'run0001', key: `3:${c.id}:run0001:${hash}` });
    expect(thumbnailSource(c, run(c.id, { status: 'running' }), gate)).toBeUndefined();
    expect(thumbnailSource(c, run('someone-else'), gate)).toBeUndefined();
    expect(thumbnailSource(c, run(c.id, { candidateCommit: 'other' }), gate)).toBeUndefined();
    expect(thumbnailSource(c, run(c.id, { artifacts: [{ name: 'smoke.png', mime: 'image/svg+xml', bytes: 10, hash }] }), gate)).toBeUndefined();
    expect(thumbnailSource(candidate('nocheck'), undefined, gate)).toBeUndefined();
  });

  it('withholds the image while unsynchronized, stale or incomplete, and rekeys it per sync epoch', () => {
    const c = candidate('cand0001aaaa', { latestCheckRunId: 'run0001' });
    expect(thumbnailSource(c, run(c.id), { ...gate, ready: false })).toBeUndefined();
    expect(thumbnailSource(c, run(c.id), { ...gate, stale: true })).toBeUndefined();
    expect(thumbnailSource(c, run(c.id), { ...gate, checkIssue: 'x' })).toBeUndefined();
    expect(thumbnailSource(c, run(c.id), { ...gate, epoch: 4 })?.key).not.toBe(thumbnailSource(c, run(c.id), gate)?.key);
  });

  it('never shows a passing state for proof that is no longer current', () => {
    const c = candidate('cand0001aaaa', { latestCheckRunId: 'run0001' });
    const passed = run(c.id, { outcome: 'passed' });
    const current = summarizeCandidate(c, { ...base, run: passed });
    // checkView needs four consistent checks to say "全部检查通过"; the gate fields below are what matter here.
    for (const summary of [
      summarizeCandidate(c, { ...base, run: passed, version: 'v2' }),
      summarizeCandidate(c, { ...base, run: { ...passed, mainVersion: 'v0' } }),
      summarizeCandidate(c, { ...base, run: passed, proofRejected: true }),
    ]) {
      expect(summary).toMatchObject({ checkLabel: '历史检查结果 · 证明已失效', checkTone: 'wait', placeholder: 'stale' });
      expect(summary.thumbnail).toBeUndefined();
    }
    expect(current.thumbnail).toBeDefined();
    expect(summarizeCandidate(c, { ...base, run: passed, ready: false })).toMatchObject({ checkLabel: '状态待同步', placeholder: 'syncing', thumbnail: undefined });
    expect(summarizeCandidate(c, { ...base, run: passed, checkIssue: 'x' })).toMatchObject({ checkLabel: '检查状态不完整', checkTone: 'bad', placeholder: 'incomplete', thumbnail: undefined });
  });

  it('summarizes instruction, scope and staleness', () => {
    const c = candidate('cand0001aaaa', { outOfScope: ['src/style.css'], latestCheckRunId: 'run0001' });
    expect(summarizeCandidate(c, { ...base, run: run(c.id) })).toMatchObject({ shortId: 'cand0001', instruction: '把按钮改成柠檬绿', files: 2, outOfScope: 1, staleBase: false, checkLabel: '检查失败', checkTone: 'bad' });
    expect(summarizeCandidate(c, { ...base, run: run(c.id), version: 'v2' })).toMatchObject({ staleBase: true });
    expect(summarizeCandidate(candidate('nocheck'), { ...base, tasks: [] })).toMatchObject({ checkLabel: '未检查', checkTone: 'none', placeholder: 'unchecked', instruction: undefined });
    expect(summarizeCandidate(c, { ...base, run: run(c.id, { status: 'running' }) }).placeholder).toBe('checking');
  });
});

describe('candidate overview render', () => {
  it('renders nothing without pending candidates', () => {
    expect(renderToStaticMarkup(<CandidateOverview summaries={[]} selectedId="" mode="current" onOpen={() => {}}/>)).toBe('');
  });

  it('renders one keyboard-reachable button per candidate with honest placeholders and no iframes', () => {
    const summaries = [
      summarizeCandidate(candidate('cand0001aaaa'), base),
      summarizeCandidate(candidate('cand0002bbbb', { latestCheckRunId: 'run0001' }), { ...base, run: run('cand0002bbbb') }),
    ];
    const html = renderToStaticMarkup(<CandidateOverview summaries={summaries} selectedId="cand0002bbbb" mode="compare" onOpen={() => {}}/>);
    expect(html.match(/data-testid="candidate-card"/g)).toHaveLength(2);
    expect(html.match(/<button type="button" class="candidate-card/g)).toHaveLength(2);
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img');
    expect(html).toContain('未运行检查 · 暂无截图');
    expect(html).toContain('data-thumb-state="loading"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('对比中');
    expect(html).toContain('aria-label="候选 cand0001：2 个文件，新增 3 行，删除 2 行，未检查。修改指令：把按钮改成柠檬绿。打开并排对比"');
    expect(html).toContain('aria-expanded="true"');
  });

  it('labels candidate preview and compare differently, and hides uncountable numbers', () => {
    const summary = summarizeCandidate(candidate('cand0001aaaa', { diff: [{ path: 'a', patch: '@@\n-a\n+b' }] }), base);
    const preview = renderToStaticMarkup(<CandidateOverview summaries={[summary]} selectedId="cand0001aaaa" mode="candidate" onOpen={() => {}}/>);
    expect(preview).toContain('候选预览中');
    expect(preview).not.toContain('对比中');
    expect(preview).toContain('行数未统计');
    expect(preview).toContain('增删行数无法精确统计');
    expect(renderToStaticMarkup(<CandidateOverview summaries={[summary]} selectedId="cand0001aaaa" mode="current" onOpen={() => {}}/>)).toContain('已选中');
  });

  it('includes variantLabel badge and spoken prefix when a candidate comes from a batch variant', () => {
    const variantTasks: Task[] = [{
      id: 'tv1',
      batchId: 'b1',
      variantLabel: '方案 B · 对比张力',
      variantIndex: 2,
      variantTotal: 3,
      instruction: '强化对比',
      status: 'done',
      candidateId: 'cand0001aaaa',
      events: [],
    }];
    const summary = summarizeCandidate(candidate('cand0001aaaa'), { ...base, tasks: variantTasks });
    expect(summary.variantLabel).toBe('方案 B · 对比张力');
    const html = renderToStaticMarkup(<CandidateOverview summaries={[summary]} selectedId="cand0001aaaa" mode="compare" onOpen={() => {}}/>);
    expect(html).toContain('data-testid="candidate-card-variant"');
    expect(html).toContain('方案 B · 对比张力');
    expect(html).toContain('aria-label="候选 cand0001（方案 B · 对比张力）：2 个文件，新增 3 行，删除 2 行，未检查，对比中。修改指令：强化对比。打开并排对比"');
  });
});
