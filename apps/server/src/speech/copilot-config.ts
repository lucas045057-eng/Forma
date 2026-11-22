import type { VoiceCopilotConfigView, VoiceCopilotMode, VoiceCopilotPreset, VoiceCopilotVendor } from '@spatial/shared';
import { maskSecret, updateEnvFileSafe } from '../agent/model-config.ts';

export const VOICE_COPILOT_PRESETS: VoiceCopilotPreset[] = [
  {
    vendor: 'gemini_live',
    name: 'Google Gemini Live（推荐）',
    badge: '原生多模态 · 延迟低',
    defaultModel: 'models/gemini-3.8-live',
    models: [
      'models/gemini-3.8-live',
      'models/gemini-2.5-flash-native-audio-latest',
      'models/gemini-3.1-flash-live-preview',
      'models/gemini-3.8-live-extended-thinking',
    ],
    defaultVoice: 'Aoede',
    voices: ['Aoede', 'Puck', 'Charon', 'Kore', 'Fenrir'],
    defaultUrl:
      'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent',
    keyPlaceholder: 'AIzaSy...',
    docHint:
      '使用声网国际版 MLLM 原生音视频流直连 Google Gemini Live（https://aistudio.google.com/apikey 获取 API Key），对话自然、延迟亚秒级。',
  },
  {
    vendor: 'openai_realtime',
    name: 'OpenAI Realtime API',
    badge: 'GPT 实时语音',
    defaultModel: 'gpt-realtime',
    models: ['gpt-realtime', 'gpt-4o-realtime-preview'],
    defaultVoice: 'alloy',
    voices: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
    defaultUrl: 'wss://api.openai.com/v1/realtime',
    keyPlaceholder: 'sk-proj-...',
    docHint:
      '使用 OpenAI Realtime API WebSocket 节点（或兼容 OpenAI Realtime 协议的服务），需要具备 Realtime 模型调用权限的 API Key。',
  },
];

export interface VoiceCopilotRuntimeConfig {
  vendor: VoiceCopilotVendor;
  model: string;
  voice: string;
  url: string;
  agoraAppId: string;
  agoraAppCertificate: string;
  agoraCustomerId: string;
  agoraCustomerSecret: string;
  mllmApiKey: string;
  agoraRestBaseUrl?: string;
}

export function getVoiceCopilotPreset(vendor: VoiceCopilotVendor): VoiceCopilotPreset {
  return VOICE_COPILOT_PRESETS.find(item => item.vendor === vendor) ?? VOICE_COPILOT_PRESETS[0];
}

export function normalizeVoiceVendor(raw?: string): VoiceCopilotVendor {
  return raw?.trim() === 'openai_realtime' ? 'openai_realtime' : 'gemini_live';
}

export function validateCopilotUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('MLLM 服务地址不是合法 URL');
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (parsed.username || parsed.password) {
    throw new Error('MLLM 服务地址不能包含用户名或密码');
  }
  if (!['wss:', 'https:'].includes(parsed.protocol) && !(isLoopback && ['ws:', 'http:'].includes(parsed.protocol))) {
    throw new Error('MLLM 服务地址仅支持 wss:// 或 https:// 协议');
  }
  return trimmed;
}

export function loadVoiceCopilotRuntimeConfig(
  overrides: Partial<VoiceCopilotRuntimeConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): VoiceCopilotRuntimeConfig {
  const vendor = normalizeVoiceVendor(overrides.vendor ?? env.VOICE_COPILOT_VENDOR);
  const preset = getVoiceCopilotPreset(vendor);
  const fallbackKey =
    vendor === 'openai_realtime' ? (env.OPENAI_API_KEY ?? '') : (env.GEMINI_API_KEY ?? '');

  return {
    vendor,
    model: (overrides.model ?? env.VOICE_COPILOT_MODEL ?? '').trim() || preset.defaultModel,
    voice: (overrides.voice ?? env.VOICE_COPILOT_VOICE ?? '').trim() || preset.defaultVoice,
    url: (overrides.url ?? env.VOICE_COPILOT_URL ?? '').trim() || preset.defaultUrl,
    agoraAppId: (overrides.agoraAppId ?? env.AGORA_APP_ID ?? '').trim(),
    agoraAppCertificate: (overrides.agoraAppCertificate ?? env.AGORA_APP_CERTIFICATE ?? '').trim(),
    agoraCustomerId: (overrides.agoraCustomerId ?? env.AGORA_CUSTOMER_ID ?? '').trim(),
    agoraCustomerSecret: (overrides.agoraCustomerSecret ?? env.AGORA_CUSTOMER_SECRET ?? '').trim(),
    mllmApiKey: (overrides.mllmApiKey ?? env.VOICE_COPILOT_MLLM_API_KEY ?? fallbackKey).trim(),
    agoraRestBaseUrl: overrides.agoraRestBaseUrl,
  };
}

export function resolveVoiceCopilotMode(cfg: VoiceCopilotRuntimeConfig): VoiceCopilotMode {
  const hasAgora = Boolean(
    cfg.agoraAppId.trim() &&
      cfg.agoraAppCertificate.trim() &&
      cfg.agoraCustomerId.trim() &&
      cfg.agoraCustomerSecret.trim(),
  );
  const hasMllm = Boolean(cfg.mllmApiKey.trim());
  return hasAgora && hasMllm ? 'real' : 'unconfigured';
}

export function buildVoiceCopilotConfigView(cfg: VoiceCopilotRuntimeConfig): VoiceCopilotConfigView {
  const mode = resolveVoiceCopilotMode(cfg);
  return {
    configured: mode === 'real',
    mode,
    vendor: cfg.vendor,
    model: cfg.model,
    voice: cfg.voice,
    url: cfg.url,
    agoraAppId: cfg.agoraAppId,
    hasAppCertificate: Boolean(cfg.agoraAppCertificate.trim()),
    appCertificateMasked: maskSecret(cfg.agoraAppCertificate),
    hasCustomerId: Boolean(cfg.agoraCustomerId.trim()),
    customerIdMasked: maskSecret(cfg.agoraCustomerId),
    hasCustomerSecret: Boolean(cfg.agoraCustomerSecret.trim()),
    customerSecretMasked: maskSecret(cfg.agoraCustomerSecret),
    hasMllmApiKey: Boolean(cfg.mllmApiKey.trim()),
    mllmApiKeyMasked: maskSecret(cfg.mllmApiKey),
    presets: VOICE_COPILOT_PRESETS,
  };
}

export function persistVoiceCopilotConfig(envFilePath: string, cfg: VoiceCopilotRuntimeConfig): void {
  updateEnvFileSafe(envFilePath, {
    AGORA_APP_ID: cfg.agoraAppId,
    AGORA_APP_CERTIFICATE: cfg.agoraAppCertificate,
    AGORA_CUSTOMER_ID: cfg.agoraCustomerId,
    AGORA_CUSTOMER_SECRET: cfg.agoraCustomerSecret,
    VOICE_COPILOT_VENDOR: cfg.vendor,
    VOICE_COPILOT_MODEL: cfg.model,
    VOICE_COPILOT_VOICE: cfg.voice,
    VOICE_COPILOT_URL: cfg.url,
    VOICE_COPILOT_MLLM_API_KEY: cfg.mllmApiKey,
  });
}

/** Builds the Jarvis-style spatial design copilot prompt with strict [FORMA_ACTION] directive syntax. */
export function buildJarvisSystemPrompt(workName?: string): string {
  const projectLabel = workName?.trim() || '当前空间网页作品';
  return [
    `你是 Forma 空间化 AI 工作台的实时语音设计副驾「贾维斯」（Jarvis），正在协助用户编辑「${projectLabel}」。`,
    '你的对话风格：冷静敏锐、干练幽默、像熟悉代码库与设计系统的资深搭档。每次口头回答尽量控制在 1–2 句、清晰自然、绝不念 JSON 或代码块。',
    '核心工作规则：',
    '1. 系统会实时静默注入用户正在点选的元素（组件名、源码位置、实例数）及后台候选/质量门禁状态。当后台生成新候选或完成 4 项检查时，请简短主动向用户汇报。',
    '2. 只有在用户明确要求执行画布或生成动作时，才在回复末尾附带结构化动作标签（前端会自动剥离，不会念出，也不会显示给用户）：',
    '   - 发起网页修改或生成多方案：[FORMA_ACTION]{"type":"submit_edit","instruction":"精确修改需求","variantCount":1}[/FORMA_ACTION]（variantCount 可选 1 / 2 / 3，如用户要“出2个/3个方案”则填对应数字）',
    '   - 切换或对比候选：[FORMA_ACTION]{"type":"switch_candidate","mode":"compare"}[/FORMA_ACTION]（mode 为 current / candidate / compare）',
    '   - 打开工作区抽屉：[FORMA_ACTION]{"type":"open_surface","surface":"assets"}[/FORMA_ACTION]（surface 为 canvas / inspector / scene / assets）',
    '   - 开启或退出元素点选：[FORMA_ACTION]{"type":"toggle_picking","active":true}[/FORMA_ACTION]',
    '3. 若尚未明确改什么或未锁定目标元素且需求有歧义，先口头简短追问确认，不要擅自派单。',
  ].join('\n');
}
