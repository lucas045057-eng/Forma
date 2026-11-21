import { describe, expect, it } from 'vitest';
import { isPreviewMessage } from './index';

describe('scroll:progress messages', () => {
  it('accepts plain progress and the non-syncing pick-time report', () => {
    expect(isPreviewMessage({ type: 'scroll:progress', payload: { at: 0.4 } })).toBe(true);
    expect(isPreviewMessage({ type: 'scroll:progress', payload: { at: 0.4, sync: false } })).toBe(true);
    expect(isPreviewMessage({ type: 'scroll:progress', payload: { at: 0.4, sync: true } })).toBe(true);
  });

  it('rejects malformed progress', () => {
    expect(isPreviewMessage({ type: 'scroll:progress', payload: { at: 1.5 } })).toBe(false);
    expect(isPreviewMessage({ type: 'scroll:progress', payload: { at: 0.4, sync: 'no' } })).toBe(false);
  });
});
