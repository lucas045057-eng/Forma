import { createRequire } from 'node:module';
import type * as AgoraTokenTypes from 'agora-token';
import type { VoiceCopilotProbeResult } from '@spatial/shared';
import { resolveVoiceCopilotMode, validateCopilotUrl, type VoiceCopilotRuntimeConfig } from './copilot-config.ts';

const require = createRequire(import.meta.url);
const { RtcRole, RtcTokenBuilder, RtmTokenBuilder }: typeof AgoraTokenTypes = require('agora-token');

const DEFAULT_AGORA_CONVO_BASE = 'https://api.agora.io/api/conversational-ai-agent/v2';
const TOKEN_TTL_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 12_000;

export class AgoraCopilotError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface AgoraClientOptions {
  fetchImpl?: typeof fetch;
  restBaseUrl?: string;
  timeoutMs?: number;
}

export interface AgoraSessionTokens {
  userRtcToken: string;
  agentRtcToken: string;
  userRtmToken: string;
}

export interface AgoraJoinAgentInput {
  name: string;
  channel: string;
  agentRtcToken: string;
  agentUid: number;
  userUid: number;
  systemPrompt: string;
}

function basicAuthHeader(customerId: string, customerSecret: string): string {
  const raw = Buffer.from(`${customerId}:${customerSecret}`, 'utf8').toString('base64');
  return `Basic ${raw}`;
}

export function buildAgoraMllmJoinPayload(cfg: VoiceCopilotRuntimeConfig, input: AgoraJoinAgentInput) {
  const mllmParams =
    cfg.vendor === 'gemini_live'
      ? {
          model: cfg.model,
          instructions: input.systemPrompt,
          voice: cfg.voice,
        }
      : {
          model: cfg.model,
          instructions: input.systemPrompt,
          voice: cfg.voice,
          turn_detection: { type: 'server_vad' },
        };

  return {
    name: input.name,
    properties: {
      channel: input.channel,
      token: input.agentRtcToken,
      agent_rtc_uid: String(input.agentUid),
      remote_rtc_uids: [String(input.userUid)],
      enable_string_uid: false,
      idle_timeout: 300,
      advanced_features: {
        enable_mllm: true,
      },
      turn_detection: {
        type: 'agora_vad',
        interrupt_mode: 'interrupt',
        silence_duration_ms: 480,
      },
      parameters: {
        data_channel: 'datastream',
        output_audio_codec: 'OPUS',
        transcript: {
          enable: true,
          protocol_version: 'v2',
        },
      },
      mllm: {
        enable: true,
        vendor: cfg.vendor,
        url: cfg.url,
        api_key: cfg.mllmApiKey,
        model: cfg.model,
        greeting_message: '我在。你可以直接跟我聊设计想法，或者点中页面元素告诉我怎么改。',
        failure_message: '抱歉，实时语音模型连接暂时遇到一点波动，请稍后再试或使用右侧输入框。',
        input_modalities: ['audio'],
        output_modalities: ['text', 'audio'],
        params: mllmParams,
      },
    },
  };
}

function extractAgentId(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, unknown>;
  if (typeof obj.agent_id === 'string' && obj.agent_id.trim()) return obj.agent_id.trim();
  const data = obj.data;
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).agent_id;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return '';
}

function parseErrorDetail(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as { detail?: string; reason?: string; message?: string };
    return parsed.detail || parsed.reason || parsed.message || '';
  } catch {
    return rawText.slice(0, 180);
  }
}

/** HTTP + token client for Agora International Conversational AI Engine v2 (MLLM mode). */
export class AgoraCopilotClient {
  private readonly cfg: VoiceCopilotRuntimeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly restBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(cfg: VoiceCopilotRuntimeConfig, options: AgoraClientOptions = {}) {
    this.cfg = cfg;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.restBaseUrl = (options.restBaseUrl ?? cfg.agoraRestBaseUrl ?? DEFAULT_AGORA_CONVO_BASE).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  generateTokens(channel: string, userUid: number, agentUid: number): AgoraSessionTokens {
    const appId = this.cfg.agoraAppId.trim();
    const cert = this.cfg.agoraAppCertificate.trim();
    if (!appId || !cert) {
      throw new AgoraCopilotError('AGORA_NOT_CONFIGURED', '请先配置 Agora App ID 与 App Certificate', 400);
    }
    const userRtcToken = RtcTokenBuilder.buildTokenWithUid(
      appId,
      cert,
      channel,
      userUid,
      RtcRole.PUBLISHER,
      TOKEN_TTL_SECONDS,
      TOKEN_TTL_SECONDS,
    );
    const agentRtcToken = RtcTokenBuilder.buildTokenWithUid(
      appId,
      cert,
      channel,
      agentUid,
      RtcRole.PUBLISHER,
      TOKEN_TTL_SECONDS,
      TOKEN_TTL_SECONDS,
    );
    const userRtmToken = RtmTokenBuilder.buildToken(appId, cert, String(userUid), TOKEN_TTL_SECONDS);
    return { userRtcToken, agentRtcToken, userRtmToken };
  }

  private async callAgora(method: 'GET' | 'POST', subPath: string, body?: unknown): Promise<{ status: number; json: unknown; rawText: string }> {
    const appId = encodeURIComponent(this.cfg.agoraAppId.trim());
    const url = `${this.restBaseUrl}/projects/${appId}${subPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: basicAuthHeader(this.cfg.agoraCustomerId.trim(), this.cfg.agoraCustomerSecret.trim()),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const rawText = await res.text().catch(() => '');
      let json: unknown = {};
      try {
        json = rawText ? JSON.parse(rawText) : {};
      } catch {
        json = {};
      }
      return { status: res.status, json, rawText };
    } catch (error) {
      const isAbort = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
      throw new AgoraCopilotError(
        isAbort ? 'AGORA_TIMEOUT' : 'AGORA_UNREACHABLE',
        isAbort ? '连接声网国际版 REST API 超时，请检查本机代理或网络环境' : '无法连接到声网国际版 API（api.agora.io）',
        504,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async joinAgent(input: AgoraJoinAgentInput): Promise<{ agentId: string }> {
    const payload = buildAgoraMllmJoinPayload(this.cfg, input);
    const { status, json, rawText } = await this.callAgora('POST', '/join', payload);
    if (status < 200 || status >= 300) {
      const detail = parseErrorDetail(rawText);
      if (status === 401 || status === 403) {
        throw new AgoraCopilotError('AGORA_AUTH_FAILED', `声网鉴权失败 (HTTP ${status})${detail ? `：${detail}` : ''}`, 502);
      }
      throw new AgoraCopilotError('AGORA_JOIN_FAILED', `启动声网语音 Agent 失败 (HTTP ${status})${detail ? `：${detail}` : ''}`, 502);
    }
    const agentId = extractAgentId(json);
    if (!agentId) {
      throw new AgoraCopilotError('AGORA_INVALID_RESPONSE', '声网 join 接口未返回有效的 agent_id', 502);
    }
    return { agentId };
  }

  async thinkAgent(agentId: string, text: string): Promise<void> {
    const { status, rawText } = await this.callAgora('POST', `/agents/${encodeURIComponent(agentId)}/think`, {
      text,
      on_listening_action: 'inject',
      on_thinking_action: 'append',
    });
    if (status < 200 || status >= 300) {
      const detail = parseErrorDetail(rawText);
      throw new AgoraCopilotError('AGORA_THINK_FAILED', `向语音副驾注入上下文失败 (HTTP ${status})${detail ? `：${detail}` : ''}`, 502);
    }
  }

  async interruptAgent(agentId: string): Promise<void> {
    const { status, rawText } = await this.callAgora('POST', `/agents/${encodeURIComponent(agentId)}/interrupt`, {});
    if (status < 200 || status >= 300) {
      const detail = parseErrorDetail(rawText);
      throw new AgoraCopilotError('AGORA_INTERRUPT_FAILED', `打断语音 Agent 失败 (HTTP ${status})${detail ? `：${detail}` : ''}`, 502);
    }
  }

  async leaveAgent(agentId: string): Promise<void> {
    const { status, rawText } = await this.callAgora('POST', `/agents/${encodeURIComponent(agentId)}/leave`, {});
    if (status < 200 || status >= 300) {
      const detail = parseErrorDetail(rawText);
      throw new AgoraCopilotError('AGORA_LEAVE_FAILED', `关闭语音 Agent 会话失败 (HTTP ${status})${detail ? `：${detail}` : ''}`, 502);
    }
  }

  async probeConfig(): Promise<VoiceCopilotProbeResult> {
    const start = Date.now();
    const mode = resolveVoiceCopilotMode(this.cfg);
    if (!this.cfg.agoraAppId || !this.cfg.agoraAppCertificate || !this.cfg.agoraCustomerId || !this.cfg.agoraCustomerSecret) {
      return {
        ok: false,
        mode,
        latencyMs: 0,
        message: '声网国际版凭证尚未填写完整（需 App ID、App Certificate、Customer ID 与 Customer Secret）',
        hint: '在控制台 console.agora.io 获取项目 App ID/Certificate 与账号级 RESTful API Key 后，即可直连真声网；未配置时可直接点击「开启实时语音」体验 Mock 演练。',
      };
    }
    if (!this.cfg.mllmApiKey) {
      return {
        ok: false,
        mode,
        latencyMs: 0,
        message: `缺少 ${this.cfg.vendor === 'gemini_live' ? 'Gemini API Key' : 'OpenAI Realtime API Key'}`,
        hint: '声网 MLLM 实时语音需要填写对应大模型提供商的 API Key。',
      };
    }
    try {
      validateCopilotUrl(this.cfg.url);
    } catch (error) {
      return {
        ok: false,
        mode,
        latencyMs: 0,
        message: error instanceof Error ? error.message : 'MLLM 地址不合法',
      };
    }

    try {
      this.generateTokens('forma_probe_channel', 1001, 2001);
    } catch (error) {
      return {
        ok: false,
        mode,
        latencyMs: Date.now() - start,
        message: `本地 Token 签发失败：${error instanceof Error ? error.message : '未知错误'}`,
        hint: '请检查 App ID 与 Primary Certificate 是否复制完整（无多余空格）。',
      };
    }

    try {
      const { status, rawText } = await this.callAgora('GET', '/agents');
      const latencyMs = Date.now() - start;
      const detail = parseErrorDetail(rawText);
      if (status >= 200 && status < 300) {
        return {
          ok: true,
          mode: 'real',
          status,
          latencyMs,
          message: `连接声网国际版成功（${latencyMs} ms）· 本地 Token 签发与 Conversational AI v2 权限均已就绪`,
        };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          mode,
          status,
          latencyMs,
          message: `声网鉴权或服务权限校验失败 (HTTP ${status})${detail ? `：${detail}` : ''}`,
          hint: '请确认 Customer ID / Customer Secret 正确，且已在 console.agora.io 为该项目开启 Conversational AI Engine。',
        };
      }
      if (status === 404) {
        return {
          ok: false,
          mode,
          status,
          latencyMs,
          message: `未找到项目或 Conversational AI 端点 (HTTP 404)${detail ? `：${detail}` : ''}`,
          hint: '请核对 App ID 是否正确，并确认账号为声网国际版（console.agora.io）。',
        };
      }
      return {
        ok: false,
        mode,
        status,
        latencyMs,
        message: `声网接口返回 HTTP ${status}${detail ? `：${detail}` : ''}`,
      };
    } catch (error) {
      return {
        ok: false,
        mode,
        latencyMs: Date.now() - start,
        message: error instanceof Error ? error.message : '无法连接声网国际版服务',
        hint: '请检查本机网络与代理设置（需能访问 api.agora.io）。',
      };
    }
  }
}
