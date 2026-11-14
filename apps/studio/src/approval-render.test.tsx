import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ApprovalCard } from '@spatial/shared';
import { emptyM2State } from './m2-state.ts';
import ApprovalPanel from './ApprovalPanel.tsx';
import CandidatePanel from './CandidatePanel.tsx';

const center = vi.hoisted(() => ({ state: {} as typeof emptyM2State, syncReady: true, status: 'connected', reload: vi.fn() }));
vi.mock('./EventCenter.tsx', () => ({ useEventCenter: () => center }));
const card: ApprovalCard = { id: 'a', taskId: 't', question: '允许修改？', reason: '<script>reason</script>', options: [{ label: '批准', impact: '发布' }, { label: '拒绝', impact: '丢弃' }], affected: ['src/Button.tsx'], evidence: ['<img onerror=alert(1)>'], status: 'pending', ruleCodes: ['shared_component'], ruleVersion: '1', baseVersion: 'v1', contentDigest: 'digest', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
beforeEach(() => {
  center.syncReady = true;
  center.state = { ...emptyM2State, version: 'v1', approvals: [card], tasks: [{ id: 't', instruction: '修改', status: 'awaiting_approval', events: [] }] };
});
const render = () => renderToStaticMarkup(<ApprovalPanel highlightId={null} onHighlight={() => {}} onExit={() => {}}/>);
it('renders escaped evidence and stable entity/test identifiers', () => {
  const html = render();
  expect(html).toContain('data-approval-id="a"');
  expect(html).toContain('data-task-id="t"');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img');
  expect(html).toContain('文件级影响；暂无可确认的页面位置');
  expect(html).toMatch(/data-testid="approval-approve">/);
});
it('uses real disabled attributes while unsynchronized and for terminal cards', () => {
  center.syncReady = false;
  expect(render()).toMatch(/data-testid="approval-approve" disabled=""/);
  expect(render()).toMatch(/data-testid="approval-reject" disabled=""/);
  center.syncReady = true;
  center.state.approvals = [{ ...card, status: 'approved' }];
  expect(render()).toMatch(/data-testid="approval-approve" disabled=""/);
  expect(render()).toContain('候选发布后请运行检查');
});
it('C1 never exposes an enabled adoption entry even for a pending candidate', () => {
  center.state.candidates = [{ id: 'c', baseVersion: 'v1', branch: 'c', previewUrl: '/preview/c/', decision: 'pending', checks: [], diff: [], outOfScope: [] }];
  const html = renderToStaticMarkup(<CandidatePanel selectedId="c" onSelect={() => {}} mode="current" onMode={() => {}}>preview</CandidatePanel>);
  expect(html).toMatch(/data-testid="candidate-adopt" disabled=""/);
});
