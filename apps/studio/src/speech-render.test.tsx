import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PointSpeak from './PointSpeak.tsx';
import { emptyM2State } from './m2-state.ts';

const center = vi.hoisted(() => ({ state: {} as typeof emptyM2State, syncReady: true, status: 'connected',
  syncEpoch: 1, locked: vi.fn(() => false), acquire: vi.fn(), awaiting: vi.fn(), reload: vi.fn(), subscribe: vi.fn(() => () => {}) }));
vi.mock('./EventCenter.tsx', () => ({ useEventCenter: () => center }));
beforeEach(() => {
  center.state = { ...emptyM2State, version: 'v1', tasks: [], candidates: [], approvals: [], runs: {}, checkIssues: {} };
  center.syncReady = true; center.status = 'connected'; center.locked.mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

it('PointSpeak exposes a press-to-record entry and provider disclosure beside the original typed instruction', () => {
  const html = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
  expect(html).toContain('data-testid="speech-record"');
  expect(html).toContain('data-testid="speech-provider"');
  expect(html).toContain('阿里云百炼');
  expect(html).toContain('转写需确认后提交');
  expect(html).toContain('data-testid="instruction-input"');
  expect(html).toContain('data-testid="generate-candidate"');
});

it('a hidden-by-mode PointSpeak keeps typed input while its speech entry is actually disabled', () => {
  const html = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }} blocked/>);
  expect(html).toMatch(/<button(?=[^>]*data-testid="speech-record")(?=[^>]*disabled="")[^>]*>/);
  const input = html.match(/<textarea(?=[^>]*data-testid="instruction-input")[^>]*>/)?.[0];
  expect(input).toBeDefined();
  expect(input).not.toMatch(/\bdisabled(?:=|\s|>)/);
  expect(html).toMatch(/<button(?=[^>]*data-testid="generate-candidate")(?=[^>]*disabled="")[^>]*>/);
});

it('static serialization invokes no HTTP or browser recording; mounted lifecycle requires separate coverage', () => {
  const transport = vi.spyOn(globalThis, 'fetch');
  const html = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
  expect(html).toContain('data-testid="instruction-input"');
  expect(transport).not.toHaveBeenCalled();
  expect(center.acquire).not.toHaveBeenCalled();
});

it('omits the CodingAgent retry button on failed module placement tasks while keeping it for ordinary agent tasks', () => {
  center.state = {
    ...center.state,
    tasks: [{
      id: '0ba219305def4605bde7b38f2b67bf5a',
      kind: 'module',
      instruction: '放入独立3D模块',
      status: 'failed',
      events: [],
      error: { code: 'STALE_PLACEMENT', message: '作品版本已变化，请重新放置' },
    }],
  };
  const moduleHtml = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
  expect(moduleHtml).not.toContain('data-testid="task-retry"');
  expect(moduleHtml).toContain('独立 3D 模块操作请从左侧资产面板重新发起');

  center.state = {
    ...center.state,
    tasks: [{
      id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      instruction: '把标题改成新文案',
      status: 'failed',
      events: [],
      error: { code: 'TASK_FAILED', message: '任务失败' },
    }],
  };
  const agentHtml = renderToStaticMarkup(<PointSpeak pick={{ kind: 'none' }}/>);
  expect(agentHtml).toContain('data-testid="task-retry"');
});
