import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createMockCheckOptions } from '../test-support/check-executor.ts';
import { AgoraCopilotClient, buildAgoraMllmJoinPayload } from './copilot-agora.ts';
import { loadVoiceCopilotRuntimeConfig, persistVoiceCopilotConfig } from './copilot-config.ts';
import { VoiceCopilotService } from './copilot-service.ts';

const SAMPLE_APP_ID = '0123456789abcdef0123456789abcdef';
const SAMPLE_CERT = 'fedcba9876543210fedcba9876543210';

describe('voice copilot backend & Agora v2 integration', () => {
  it('generates valid Agora v2 RTC/RTM tokens and constructs Gemini Live / OpenAI Realtime join payloads', () => {
    const geminiCfg = loadVoiceCopilotRuntimeConfig({
      vendor: 'gemini_live',
      agoraAppId: SAMPLE_APP_ID,
      agoraAppCertificate: SAMPLE_CERT,
      agoraCustomerId: 'cust_id_123456',
      agoraCustomerSecret: 'cust_sec_987654',
      mllmApiKey: 'AIzaSyTestSecretKey123456',
    });

    const client = new AgoraCopilotClient(geminiCfg);
    const tokens = client.generateTokens('forma_room_01', 1001, 2001);
    expect(tokens.userRtcToken.startsWith('007')).toBe(true);
    expect(tokens.agentRtcToken.startsWith('007')).toBe(true);
    expect(tokens.userRtmToken.startsWith('007')).toBe(true);

    const geminiPayload = buildAgoraMllmJoinPayload(geminiCfg, {
      name: 'jarvis_1',
      channel: 'forma_room_01',
      agentRtcToken: tokens.agentRtcToken,
      agentUid: 2001,
      userUid: 1001,
      systemPrompt: 'You are Jarvis.',
    });
    expect(geminiPayload.properties.advanced_features.enable_mllm).toBe(true);
    expect(geminiPayload.properties.parameters.data_channel).toBe('datastream');
    expect(geminiPayload.properties.mllm.vendor).toBe('gemini');
    expect(geminiPayload.properties.mllm.model).toBe('models/gemini-2.5-flash-native-audio-preview');
    expect(geminiPayload.properties.mllm.transcribe_agent).toBe(true);
    expect(geminiPayload.properties.mllm.transcribe_user).toBe(true);
    expect(geminiPayload.properties.mllm.params.voice).toBe('Aoede');

    const openaiCfg = loadVoiceCopilotRuntimeConfig({
      vendor: 'openai_realtime',
      agoraAppId: SAMPLE_APP_ID,
      agoraAppCertificate: SAMPLE_CERT,
      agoraCustomerId: 'cust_id_123456',
      agoraCustomerSecret: 'cust_sec_987654',
      mllmApiKey: 'sk-proj-test123456',
    });
    const openaiPayload = buildAgoraMllmJoinPayload(openaiCfg, {
      name: 'jarvis_2',
      channel: 'forma_room_02',
      agentRtcToken: tokens.agentRtcToken,
      agentUid: 2001,
      userUid: 1001,
      systemPrompt: 'You are Jarvis.',
    });
    expect(openaiPayload.properties.mllm.vendor).toBe('openai');
    expect(openaiPayload.properties.mllm.model).toBe('gpt-realtime');
    expect(openaiPayload.properties.mllm.params).toMatchObject({ turn_detection: { type: 'server_vad' } });
  });

  it('flags Vertex AI Express AQ. keys clearly after verifying Agora credentials', async () => {
    const vertexKeyCfg = loadVoiceCopilotRuntimeConfig({
      vendor: 'gemini_live',
      agoraAppId: SAMPLE_APP_ID,
      agoraAppCertificate: SAMPLE_CERT,
      agoraCustomerId: 'cust_id_123456',
      agoraCustomerSecret: 'cust_sec_987654',
      mllmApiKey: 'AQ.SampleVertexExpressKey123',
    });
    const client = new AgoraCopilotClient(vertexKeyCfg, {
      fetchImpl: async () => new Response(JSON.stringify({ agents: [] }), { status: 200 }),
    });
    const result = await client.probeConfig();
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('real');
    expect(result.message).toContain('AQ.');
    expect(result.hint).toContain('AIzaSy');
  });

  it('persists Agora keys to .env without clobbering existing keys and masks secrets in config view', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forma-copilot-env-'));
    const envPath = path.join(dir, '.env');
    await writeFile(envPath, 'CODING_AGENT_MODEL=qwen3-coder-plus\r\n', 'utf8');

    try {
      const cfg = loadVoiceCopilotRuntimeConfig({
        vendor: 'gemini_live',
        agoraAppId: SAMPLE_APP_ID,
        agoraAppCertificate: SAMPLE_CERT,
        agoraCustomerId: 'cust_id_abcdef',
        agoraCustomerSecret: 'cust_sec_zyxwvu',
        mllmApiKey: 'AIzaSySecretKey000111222',
      });
      persistVoiceCopilotConfig(envPath, cfg);
      const written = await readFile(envPath, 'utf8');
      expect(written).toContain('CODING_AGENT_MODEL=qwen3-coder-plus');
      expect(written).toContain(`AGORA_APP_ID=${SAMPLE_APP_ID}`);
      expect(written).toContain('VOICE_COPILOT_VENDOR=gemini_live');

      const service = new VoiceCopilotService({ config: cfg, envFilePath: envPath });
      const view = service.getConfigView();
      expect(view.configured).toBe(true);
      expect(view.mode).toBe('real');
      expect(JSON.stringify(view)).not.toContain('AIzaSySecretKey000111222');
      expect(JSON.stringify(view)).not.toContain('cust_sec_zyxwvu');
      expect(JSON.stringify(view)).not.toContain(SAMPLE_CERT);
      expect(view.mllmApiKeyMasked).toBe('AIza****1222');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports mock Jarvis rehearsal mode with canvas context injection and structured actions', async () => {
    const service = new VoiceCopilotService({
      config: loadVoiceCopilotRuntimeConfig({}, {} as NodeJS.ProcessEnv),
    });
    const session = await service.startSession({ workName: '木间香薰' });
    expect(session.mode).toBe('mock');

    const pickReply = await service.think(session.sessionId, {
      kind: 'selection',
      text: '选中了组件 Button',
      selection: { src: 'src/components/Button.tsx:5:5', cid: 'Button', instances: 3, text: '立即购买' },
    });
    expect(pickReply.mode).toBe('mock');
    expect(pickReply.replyText).toContain('Button');
    expect(pickReply.replyText).toContain('3 处实例');

    const editReply = await service.think(session.sessionId, {
      kind: 'user_text',
      text: '把这个主按钮改成高级暖金色，出 3 个方案',
      selection: { src: 'src/components/Button.tsx:5:5', cid: 'Button', instances: 3 },
    });
    expect(editReply.actions).toEqual([
      { type: 'submit_edit', instruction: '把这个主按钮改成高级暖金色，出 3 个方案', variantCount: 3 },
    ]);

    const compareReply = await service.think(session.sessionId, {
      kind: 'user_text',
      text: '打开并排对比看看效果',
    });
    expect(compareReply.actions).toEqual([{ type: 'switch_candidate', mode: 'compare' }]);
    await service.stopSession(session.sessionId);
  });

  it('exposes /speech/copilot HTTP lifecycle, probe, and real Agora API roundtrip through Fastify', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'forma-copilot-api-'));
    const workRoot = path.join(dir, 'work');
    await mkdir(path.join(workRoot, 'src'), { recursive: true });
    await writeFile(path.join(workRoot, 'src', 'App.tsx'), '<button>立即购买</button>\n');

    const agoraCalls: Array<{ method: string; url: string; auth: string | null; body?: unknown }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization');
      const bodyText = typeof init?.body === 'string' ? init.body : undefined;
      agoraCalls.push({
        method: init?.method ?? 'GET',
        url,
        auth,
        body: bodyText ? JSON.parse(bodyText) : undefined,
      });

      if (url.endsWith('/agents') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      }
      if (url.endsWith('/join')) {
        return new Response(JSON.stringify({ agent_id: 'agora-agent-999', status: 'RUNNING' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const { app } = await createApp({
      checks: createMockCheckOptions(),
      workRoot,
      dataDirectory: path.join(dir, 'assets'),
      workDataDirectory: path.join(dir, 'm2'),
      historyDirectory: path.join(dir, 'history'),
      envFilePath: path.join(dir, '.env'),
      voiceCopilot: {
        config: loadVoiceCopilotRuntimeConfig({}, {} as NodeJS.ProcessEnv),
        fetchImpl: mockFetch,
      },
    });

    try {
      const initialCfg = await app.inject('/speech/copilot/config');
      expect(initialCfg.statusCode).toBe(200);
      expect(initialCfg.json().mode).toBe('unconfigured');

      const updateRes = await app.inject({
        method: 'PUT',
        url: '/speech/copilot/config',
        payload: {
          vendor: 'gemini_live',
          agoraAppId: SAMPLE_APP_ID,
          agoraAppCertificate: SAMPLE_CERT,
          agoraCustomerId: 'cid_test_01',
          agoraCustomerSecret: 'csec_test_02',
          mllmApiKey: 'AIzaSyRealKeyForTest999',
          persist: true,
        },
      });
      expect(updateRes.statusCode).toBe(200);
      expect(updateRes.json().config.mode).toBe('real');

      const probeRes = await app.inject({ method: 'POST', url: '/speech/copilot/test', payload: {} });
      expect(probeRes.statusCode).toBe(200);
      expect(probeRes.json().ok).toBe(true);

      const sessionRes = await app.inject({
        method: 'POST',
        url: '/speech/copilot/sessions',
        payload: { workName: '木间香薰' },
      });
      expect(sessionRes.statusCode).toBe(201);
      const session = sessionRes.json();
      expect(session.mode).toBe('real');
      expect(session.agentId).toBe('agora-agent-999');
      expect(session.rtcToken.startsWith('007')).toBe(true);

      const thinkRes = await app.inject({
        method: 'POST',
        url: `/speech/copilot/sessions/${session.sessionId}/think`,
        payload: { kind: 'selection', text: '选中按钮', workName: '木间香薰' },
      });
      expect(thinkRes.statusCode).toBe(200);

      const interruptRes = await app.inject({
        method: 'POST',
        url: `/speech/copilot/sessions/${session.sessionId}/interrupt`,
      });
      expect(interruptRes.statusCode).toBe(200);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/speech/copilot/sessions/${session.sessionId}`,
      });
      expect(deleteRes.statusCode).toBe(200);

      expect(agoraCalls.map(c => c.url.split(`/projects/${SAMPLE_APP_ID}`)[1])).toEqual([
        '/agents',
        '/join',
        '/agents/agora-agent-999/think',
        '/agents/agora-agent-999/interrupt',
        '/agents/agora-agent-999/leave',
      ]);
      expect(agoraCalls[1].auth?.startsWith('Basic ')).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
