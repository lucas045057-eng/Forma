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
