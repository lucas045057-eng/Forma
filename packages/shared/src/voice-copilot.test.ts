import { describe, expect, it } from 'vitest';
import { isVoiceCopilotAction, parseVoiceCopilotActions } from './index.ts';

describe('voice copilot shared contracts', () => {
  it('validates allowed VoiceCopilotAction variants and rejects unsafe payloads', () => {
    expect(isVoiceCopilotAction({ type: 'submit_edit', instruction: '把主按钮改成暖绿色', variantCount: 3 })).toBe(true);
    expect(isVoiceCopilotAction({ type: 'switch_candidate', mode: 'compare', candidateId: 'cand-2' })).toBe(true);
    expect(isVoiceCopilotAction({ type: 'open_surface', surface: 'assets' })).toBe(true);
    expect(isVoiceCopilotAction({ type: 'toggle_picking', active: true })).toBe(true);

    expect(isVoiceCopilotAction(null)).toBe(false);
    expect(isVoiceCopilotAction({ type: 'submit_edit', instruction: '   ' })).toBe(false);
    expect(isVoiceCopilotAction({ type: 'submit_edit', instruction: 'ok', variantCount: 4 })).toBe(false);
    expect(isVoiceCopilotAction({ type: 'open_surface', surface: 'shell' })).toBe(false);
    expect(isVoiceCopilotAction({ type: 'exec_shell', cmd: 'rm -rf' })).toBe(false);
  });

  it('extracts valid [FORMA_ACTION] directives and ignores malformed JSON blocks', () => {
    const raw =
      '好的，我来为你并行生成 2 个暖色风格候选。' +
      '[FORMA_ACTION]{"type":"submit_edit","instruction":"把按钮改成暖琥珀色调","variantCount":2}[/FORMA_ACTION]' +
      ' 并切到并排对比视图[FORMA_ACTION]{bad json}[/FORMA_ACTION]' +
      '[FORMA_ACTION]{"type":"unknown_action"}[/FORMA_ACTION]' +
      '[FORMA_ACTION]{"type":"open_surface","surface":"inspector"}[/FORMA_ACTION]';

    const parsed = parseVoiceCopilotActions(raw);
    expect(parsed.cleanText).toBe('好的，我来为你并行生成 2 个暖色风格候选。 并切到并排对比视图');
    expect(parsed.actions).toEqual([
      { type: 'submit_edit', instruction: '把按钮改成暖琥珀色调', variantCount: 2 },
      { type: 'open_surface', surface: 'inspector' },
    ]);
  });
});
