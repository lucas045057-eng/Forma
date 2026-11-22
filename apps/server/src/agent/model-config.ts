import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { codingAgentEndpoint, CodingAgentError, normalizeCodingAgentBaseUrl } from './client.ts';

export interface ProviderPreset {
  id: string;
  name: string;
  badge: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  keyPlaceholder: string;
  docHint: string;
  requiresKey: boolean;
}

export const MODEL_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'dashscope',
    name: '阿里云百炼 (DashScope 通用)',
    badge: '推荐 · 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3-coder-plus',
    models: ['qwen3-coder-plus', 'qwen-max', 'qwen-plus', 'deepseek-v3'],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: '使用阿里云百炼控制台申请的 API-KEY（国内北京节点），Base URL 以 /compatible-mode/v1 结尾。',
    requiresKey: true,
  },
  {
    id: 'dashscope-coding',
    name: '阿里云百炼 (Coding Plan 专享)',
    badge: '编码套餐',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    defaultModel: 'qwen3-coder-plus',
    models: ['qwen3-coder-plus', 'qwen-coder-plus'],
    keyPlaceholder: 'sk-sp-xxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: '适用于开通了阿里云 Coding Plan 套餐的专属编码端点，Base URL 为 /v1。',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek (深度求索官方)',
    badge: '高性价比',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: 'deepseek-chat 对应 DeepSeek-V3；deepseek-reasoner 对应 R1 思考模型（已内置 reasoning_content 多轮工具调用兼容）。',
    requiresKey: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    badge: '开源模型聚合',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    models: ['Qwen/Qwen2.5-Coder-32B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Pro/deepseek-ai/DeepSeek-R1', 'Qwen/QwQ-32B'],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: '注意硅基流动的模型名称区分大小写且带厂商前缀（如 Qwen/... 或 deepseek-ai/...）。',
    requiresKey: true,
  },
  {
    id: 'volcengine',
    name: '火山方舟 (字节豆包 Volcengine Ark)',
    badge: '豆包 / DeepSeek',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-seed-1-6-250615',
    models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115', 'deepseek-v3-250324'],
    keyPlaceholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    docHint: '火山方舟路径以 /api/v3 结尾（不是 /v1）；模型名可填原生模型 ID 或控制台创建的推理接入点 ep-2026xxxx-xxxxx。',
    requiresKey: true,
  },
  {
    id: 'zhipu',
    name: '智谱清言 (BigModel GLM)',
    badge: 'GLM-4 系列',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.xxxxxxxxxxxxxxxx',
    docHint: '智谱开放平台 Base URL 以 /api/paas/v4 结尾（无需加 /v1）。',
    requiresKey: true,
  },
  {
    id: 'kimi',
    name: '月之暗面 (Kimi / Moonshot)',
    badge: '长上下文',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2-0711-preview',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: 'Moonshot Kimi 开放平台兼容接口，推荐使用 kimi-k2 系列以获得更稳定的代码工具调用能力。',
    requiresKey: true,
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI / 第三方兼容中转站 (NewAPI / OneAPI / OpenRouter)',
    badge: '通用 OpenAI 协议',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1',
    models: ['gpt-4.1', 'gpt-4o', 'claude-sonnet-4-5', 'gpt-5.2-codex'],
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    docHint: '支持任意实现 OpenAI /v1/chat/completions + Function Calling (tools) 的第三方聚合中转服务；填写到 /v1 即可，客户端会自动过滤多余的 /chat/completions。',
    requiresKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama / LM Studio (本机私有大模型)',
    badge: '本地免 Key',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:14b',
    models: ['qwen2.5-coder:14b', 'qwen2.5-coder:32b', 'qwen2.5-coder:7b'],
    keyPlaceholder: 'ollama（本地模型可留空或填任意字符）',
    docHint: '本机 http://127.0.0.1:11434/v1（Ollama）或 http://127.0.0.1:1234/v1（LM Studio），无需真实 API Key，请确保所选本地模型支持 Tool Calling。',
    requiresKey: false,
  },
];

export function maskSecret(secret: string | undefined): string {
  const s = (secret ?? '').trim();
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

const KNOWN_ENV_KEYS = [
  'CODING_AGENT_BASE_URL',
  'CODING_AGENT_MODEL',
  'CODING_AGENT_API_KEY',
  'SPEECH_BASE_URL',
  'SPEECH_MODEL',
  'DASHSCOPE_API_KEY',
  'LUX3D_BASE',
  'LUX3D_API_KEY',
  'AGORA_APP_ID',
  'AGORA_APP_CERTIFICATE',
  'AGORA_CUSTOMER_ID',
  'AGORA_CUSTOMER_SECRET',
  'VOICE_COPILOT_VENDOR',
  'VOICE_COPILOT_MODEL',
  'VOICE_COPILOT_VOICE',
  'VOICE_COPILOT_URL',
  'VOICE_COPILOT_MLLM_API_KEY',
] as const;

export function updateEnvFileSafe(envFilePath: string, updates: Record<string, string | undefined>): void {
  const dir = path.dirname(envFilePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const outputLines: string[] = [];
  const written = new Set<string>();

  if (existsSync(envFilePath)) {
    const raw = readFileSync(envFilePath, 'utf8').replace(/^\uFEFF/, '');
    const existingLines = raw.replace(/\r\n/g, '\n').split('\n');

    for (const line of existingLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        outputLines.push(line);
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        outputLines.push(line);
        continue;
      }
      const key = trimmed.slice(0, eq).trim().replace(/^\uFEFF/, '');
      if (Object.prototype.hasOwnProperty.call(updates, key)) {
        const nextVal = (updates[key] ?? '').trim().replace(/[\r\n]/g, '');
        if (nextVal) {
          outputLines.push(`${key}=${nextVal}`);
        }
        written.add(key);
      } else {
        outputLines.push(line);
      }
    }
  }

  for (const key of KNOWN_ENV_KEYS) {
    if (!written.has(key) && Object.prototype.hasOwnProperty.call(updates, key)) {
      const val = (updates[key] ?? '').trim().replace(/[\r\n]/g, '');
      if (val) {
        outputLines.push(`${key}=${val}`);
      }
    }
  }

  while (outputLines.length > 0 && !outputLines[outputLines.length - 1].trim()) {
    outputLines.pop();
  }

  const finalContent = outputLines.length > 0 ? `${outputLines.join('\r\n')}\r\n` : '';
  writeFileSync(envFilePath, finalContent, { encoding: 'utf8' });
}

export interface ModelProbeResult {
  ok: boolean;
  normalizedBaseUrl: string;
  endpoint: string;
  latencyMs: number;
  status?: number;
  toolCallSupported: boolean;
  message: string;
  hint?: string;
}

export async function probeCodingModelConnection(input: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelProbeResult> {
  const start = Date.now();
  const normalizedBaseUrl = normalizeCodingAgentBaseUrl(input.baseUrl);
  const model = input.model.trim();
  let apiKey = input.apiKey.trim();

  if (!normalizedBaseUrl) {
    return {
      ok: false,
      normalizedBaseUrl: '',
      endpoint: '',
      latencyMs: 0,
      toolCallSupported: false,
      message: '请填写模型服务 Base URL',
      hint: '可从上方厂商预设中一键填入标准 Base URL。',
    };
  }
  if (!model) {
    return {
      ok: false,
      normalizedBaseUrl,
      endpoint: '',
      latencyMs: 0,
      toolCallSupported: false,
      message: '请填写或选择模型名称 (Model ID)',
    };
  }

  // Allow local loopback (Ollama / LM Studio) without an API key
  try {
    const u = new URL(normalizedBaseUrl);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!apiKey && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) {
      apiKey = 'ollama';
    }
  } catch {
    // codingAgentEndpoint will throw below
  }

  let endpoint: string;
  try {
    endpoint = codingAgentEndpoint(normalizedBaseUrl);
  } catch (err) {
    return {
      ok: false,
      normalizedBaseUrl,
      endpoint: '',
      latencyMs: Date.now() - start,
      toolCallSupported: false,
      message: err instanceof CodingAgentError ? err.message : 'Base URL 格式不合法',
      hint: '公网模型服务必须使用 https:// 开头；本机 Ollama/LM Studio 可使用 http://127.0.0.1:端口/v1。',
    };
  }

  if (!apiKey) {
    return {
      ok: false,
      normalizedBaseUrl,
      endpoint,
      latencyMs: 0,
      toolCallSupported: false,
      message: '请填写 API Key（或先保存密钥后再测试）',
    };
  }

  const probeTools = [
    {
      type: 'function',
      function: {
        name: 'finish',
        description: 'Confirm connection probe.',
        parameters: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await (input.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a connectivity probe. Call the finish tool or reply OK.' },
          { role: 'user', content: 'Call finish with summary "ok".' },
        ],
        tools: probeTools,
        tool_choice: 'auto',
        max_tokens: 48,
      }),
    });

    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => '');

    if (!res.ok) {
      let upstreamDetail = '';
      try {
        const parsed = JSON.parse(rawText) as { error?: { message?: string; code?: string }; message?: string };
        upstreamDetail = parsed?.error?.message || parsed?.message || '';
      } catch {
        upstreamDetail = rawText.slice(0, 160);
      }

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          normalizedBaseUrl,
          endpoint,
          latencyMs,
          status: res.status,
          toolCallSupported: false,
          message: `鉴权失败 (HTTP ${res.status})${upstreamDetail ? `：${upstreamDetail}` : ''}`,
          hint: '请检查 API Key 是否正确、是否有首尾空格，以及阿里云百炼 Key 与地域节点（北京 vs 海外 vs Coding Plan）是否匹配。',
        };
      }
      if (res.status === 404) {
        return {
          ok: false,
          normalizedBaseUrl,
          endpoint,
          latencyMs,
          status: res.status,
          toolCallSupported: false,
          message: `接口或模型不存在 (HTTP 404)${upstreamDetail ? `：${upstreamDetail}` : ''}`,
          hint: '常见原因：① Base URL 漏写或写错版本后缀（百炼需 /compatible-mode/v1，火山方舟需 /api/v3，智谱需 /api/paas/v4，其余多为 /v1）；② 模型名称拼写有误（硅基流动需带厂商前缀，火山方舟需确认模型或 ep- 接入点已开通）。',
        };
      }
      if (res.status === 400) {
        return {
          ok: false,
          normalizedBaseUrl,
          endpoint,
          latencyMs,
          status: res.status,
          toolCallSupported: false,
          message: `模型请求参数不被支持 (HTTP 400)${upstreamDetail ? `：${upstreamDetail}` : ''}`,
          hint: 'Forma 编码 Agent 需要模型支持 OpenAI Function Calling (tools)。请确认所填模型名称支持工具调用，或更换为 qwen3-coder-plus / deepseek-chat / glm-4-plus 等支持工具调用的模型。',
        };
      }
      if (res.status === 429) {
        return {
          ok: false,
          normalizedBaseUrl,
          endpoint,
          latencyMs,
          status: res.status,
          toolCallSupported: false,
          message: `触发限流或账户额度不足 (HTTP 429)${upstreamDetail ? `：${upstreamDetail}` : ''}`,
          hint: '请检查对应大模型平台的账户余额、免费额度或并发速率限制。',
        };
      }
      return {
        ok: false,
        normalizedBaseUrl,
        endpoint,
        latencyMs,
        status: res.status,
        toolCallSupported: false,
        message: `上游服务返回 HTTP ${res.status}${upstreamDetail ? `：${upstreamDetail}` : ''}`,
      };
    }

    let parsed: { choices?: Array<{ message?: { role?: string; content?: unknown; tool_calls?: unknown[] } }> };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return {
        ok: false,
        normalizedBaseUrl,
        endpoint,
        latencyMs,
        status: res.status,
        toolCallSupported: false,
        message: '服务返回了 200，但响应不是合法 JSON（可能填写了网页地址而非 API Base URL）',
      };
    }

    const msg = parsed?.choices?.[0]?.message;
    if (!msg) {
      return {
        ok: false,
        normalizedBaseUrl,
        endpoint,
        latencyMs,
        status: res.status,
        toolCallSupported: false,
        message: '响应缺少 OpenAI 兼容的 choices[0].message 结构',
      };
    }

    const toolCallSupported = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    return {
      ok: true,
      normalizedBaseUrl,
      endpoint,
      latencyMs,
      status: res.status,
      toolCallSupported,
      message: toolCallSupported
        ? `连接成功（${latencyMs} ms）· 已验证支持 OpenAI 工具调用 (Function Calling)`
        : `连接成功（${latencyMs} ms）· 对话响应正常`,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const isTimeout = controller.signal.aborted || (err as Error)?.name === 'TimeoutError';
    return {
      ok: false,
      normalizedBaseUrl,
      endpoint,
      latencyMs,
      toolCallSupported: false,
      message: isTimeout ? '连接超时（超过 15 秒未响应）' : '无法连接到模型服务地址',
      hint: '请检查网络连接、系统代理设置，或确认本地 Ollama / LM Studio 服务是否已在对应端口启动。',
    };
  } finally {
    clearTimeout(timer);
  }
}
