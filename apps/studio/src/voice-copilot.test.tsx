import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Selection, VoiceCopilotConfigView, VoiceCopilotSession } from '@spatial/shared';
import VoiceCopilotConfigModal from './VoiceCopilotConfigModal.tsx';
import VoiceCopilotHud from './VoiceCopilotHud.tsx';
import {
  buildCanvasThinkPayload,
  initialVoiceCopilotState,
  parseAgoraStreamPacket,
  reduceVoiceCopilotState,
} from './voice-copilot-state.ts';

function encodeUtf8Base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const sampleSession: VoiceCopilotSession = {
  sessionId: 'sess-001',
  mode: 'mock',
  vendor: 'gemini_live',
  model: 'models/gemini-3.8-live',
  voice: 'Aoede',
  agentId: 'mock-agent',
  appId: '',
  channel: 'forma_room',
  userUid: 1001,
  agentUid: 2001,
  rtcToken: '',
  rtmToken: '',
  createdAt: '2026-11-22T12:00:00Z',
  notice: '当前处于 Mock 演练模式',
};

describe('Studio voice copilot state, decoder, and UI', () => {
  it('merges streaming transcript turns cleanly without duplicating chunks', () => {
    let state = reduceVoiceCopilotState(initialVoiceCopilotState, { type: 'connecting' });
    state = reduceVoiceCopilotState(state, { type: 'connected', session: sampleSession });
    expect(state.active).toBe(true);
    expect(state.agentState).toBe('listening');

    state = reduceVoiceCopilotState(state, {
      type: 'upsert-transcript',
      item: { id: 'agent-1', turnId: 1, role: 'agent', text: '正在', status: 'in_progress', timestamp: 1 },
    });
    state = reduceVoiceCopilotState(state, {
      type: 'upsert-transcript',
      item: {
        id: 'agent-1',
        turnId: 1,
        role: 'agent',
        text: '正在为你打开对比视图',
        status: 'completed',
        timestamp: 2,
        actions: [{ type: 'switch_candidate', mode: 'compare' }],
      },
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0].text).toBe('正在为你打开对比视图');
    expect(state.transcript[0].status).toBe('completed');
    expect(state.transcript[0].actions).toEqual([{ type: 'switch_candidate', mode: 'compare' }]);
  });

  it('decodes plain JSON and chunked Agora v2 base64 stream-message packets with actions', () => {
    const encoder = new TextEncoder();
    const assembler = new Map<string, string[]>();

    const plainPacket = JSON.stringify({
      object: 'assistant.transcription',
      turn_id: 7,
      turn_status: 1,
      text: '收到，切到对比看看[FORMA_ACTION]{"type":"switch_candidate","mode":"compare"}[/FORMA_ACTION]',
    });
    const plainParsed = parseAgoraStreamPacket(encoder.encode(plainPacket), assembler);
    expect(plainParsed?.transcript?.text).toBe('收到，切到对比看看');
    expect(plainParsed?.actions).toEqual([{ type: 'switch_candidate', mode: 'compare' }]);
    expect(plainParsed?.transcript?.status).toBe('completed');

    const chunkPayload = JSON.stringify({
      object: 'assistant.transcription',
      turn_id: 8,
      turn_status: 1,
      text: '好的，帮你出两个方向[FORMA_ACTION]{"type":"submit_edit","instruction":"优化卡片圆角","variantCount":2}[/FORMA_ACTION]',
    });
    const b64 = encodeUtf8Base64(chunkPayload);
    const mid = Math.floor(b64.length / 2);
    const part1 = parseAgoraStreamPacket(encoder.encode(`msg99|1|2|${b64.slice(0, mid)}`), assembler);
    expect(part1).toBeNull();
    const part2 = parseAgoraStreamPacket(encoder.encode(`msg99|2|2|${b64.slice(mid)}`), assembler);
    expect(part2?.transcript?.text).toBe('好的，帮你出两个方向');
    expect(part2?.actions).toEqual([
      { type: 'submit_edit', instruction: '优化卡片圆角', variantCount: 2 },
    ]);
    expect(assembler.size).toBe(0);
  });

  it('builds structured context payloads from canvas Selection', () => {
    const selection: Selection = {
      src: 'src/components/Button.tsx:5:5',
      cid: 'Button',
      text: '立即购买',
      bbox: [10, 20, 120, 40],
      styles: {
        display: 'inline-flex',
        position: 'relative',
        color: '#fff',
        backgroundColor: '#1e6b4b',
        fontSize: '14px',
        fontFamily: 'sans-serif',
        fontWeight: '600',
        lineHeight: '20px',
        padding: '8px 16px',
        margin: '0px',
        borderRadius: '8px',
        width: '120px',
        height: '40px',
      },
      instances: 3,
      ancestors: ['src/App.tsx:10:3'],
      baseVersion: 'v1',
    };
    const payload = buildCanvasThinkPayload({
      kind: 'selection',
      text: '用户点选了 Button',
      workName: '木间香薰',
      selection,
    });
    expect(payload.selection).toEqual({
      src: 'src/components/Button.tsx:5:5',
      cid: 'Button',
      instances: 3,
      text: '立即购买',
    });
  });

  it('renders VoiceCopilotHud and VoiceCopilotConfigModal cleanly', () => {
    let hudState = reduceVoiceCopilotState(initialVoiceCopilotState, { type: 'connecting' });
    hudState = reduceVoiceCopilotState(hudState, { type: 'connected', session: sampleSession });
    hudState = reduceVoiceCopilotState(hudState, {
      type: 'upsert-transcript',
      item: { id: 'agent-1', turnId: 1, role: 'agent', text: '我在，请讲。', status: 'completed', timestamp: 1 },
    });

    const mockConfig: VoiceCopilotConfigView = {
      configured: false,
      mode: 'unconfigured',
      vendor: 'gemini_live',
      model: 'models/gemini-3.8-live',
      voice: 'Aoede',
      url: 'wss://generativelanguage.googleapis.com/ws',
      agoraAppId: '',
      hasAppCertificate: false,
      appCertificateMasked: '',
      hasCustomerId: false,
      customerIdMasked: '',
      hasCustomerSecret: false,
      customerSecretMasked: '',
      hasMllmApiKey: false,
      mllmApiKeyMasked: '',
      presets: [],
    };

    const hudHtml = renderToStaticMarkup(
      <VoiceCopilotHud
        state={hudState}
        config={mockConfig}
        micRecognizing={false}
        supportsDictation={true}
        onToggleMute={vi.fn()}
        onToggleTts={vi.fn()}
        onToggleExpanded={vi.fn()}
        onInterrupt={vi.fn()}
        onDisconnect={vi.fn()}
        onOpenConfig={vi.fn()}
        onSendText={vi.fn(async () => {})}
        onStartDictation={vi.fn()}
      />,
    );
    expect(hudHtml).toContain('data-testid="voice-copilot-hud"');
    expect(hudHtml).toContain('本地 Mock 演练');
    expect(hudHtml).toContain('我在，请讲。');
    expect(hudHtml).toContain('data-testid="voice-dictation-btn"');

    const modalHtml = renderToStaticMarkup(
      <VoiceCopilotConfigModal onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(modalHtml).toContain('data-testid="voice-config-modal"');
    expect(modalHtml).toContain('console.agora.io');
    expect(modalHtml).toContain('Google Gemini Live');
    expect(modalHtml).toContain('OpenAI Realtime API');
  });
});
