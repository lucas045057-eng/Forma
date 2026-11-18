import type { Selection } from '@spatial/shared';
import { Sandbox, ToolError, toolDefinitions } from './tools.ts';

export class CodingAgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type ToolCall = { id: string; type?: 'function'; function: { name: string; arguments: string } };
type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export interface CodingAgentOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxRounds?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  onStep?: (message: string) => void | Promise<void>;
}

function isLoopback(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function codingAgentEndpoint(base: string) {
  let url: URL;
  try { url = new URL(base); } catch { throw new CodingAgentError('AGENT_CONFIG', 'CODING_AGENT_BASE_URL 不是合法 URL'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))) {
    throw new CodingAgentError('AGENT_CONFIG', '编码 Agent 上游除本机 mock 外必须使用 HTTPS，且 URL 不得含凭据');
  }
  return `${base.replace(/\/+$/, '')}/chat/completions`;
}

/** Runs the model/tool protocol. The model never receives process or shell access. */
export class CodingAgent {
  private readonly options: CodingAgentOptions;
  private readonly endpoint: string;
  private readonly key: string;
  constructor(options: CodingAgentOptions) {
    this.options = options;
    this.endpoint = codingAgentEndpoint(options.baseUrl ?? '');
    this.key = options.apiKey ?? '';
    if (!this.key) throw new CodingAgentError('AGENT_CONFIG', '未配置 CODING_AGENT_API_KEY');
    if (!options.model) throw new CodingAgentError('AGENT_CONFIG', '未配置 CODING_AGENT_MODEL');
  }

  async run(input: { taskId: string; instruction: string; selection?: Selection; bootstrap?: boolean; root: string; signal?: AbortSignal }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000);
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    try { return await this.execute({ ...input, signal }); }
    catch (error) {
      if (input.signal?.aborted) throw new CodingAgentError('TASK_CANCELLED', '任务已取消');
      if (controller.signal.aborted || (error as Error).name === 'TimeoutError') throw new CodingAgentError('AGENT_TIMEOUT', '编码任务超过总时限');
      throw error;
    } finally { clearTimeout(timer); }
  }

  private async execute(input: { taskId: string; instruction: string; selection?: Selection; bootstrap?: boolean; root: string; signal: AbortSignal }) {
    const maxRounds = Math.min(this.options.maxRounds ?? 16, 16);
    const timeoutMs = this.options.timeoutMs ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    const sandbox = new Sandbox(input.root, { signal: input.signal, deadline });
    const check = () => {
      input.signal.throwIfAborted();
      if (Date.now() >= deadline) throw new CodingAgentError('AGENT_TIMEOUT', '编码任务超过总时限');
    };
    const selected = input.selection ? await this.selectedSource(sandbox, input.selection) : undefined;
    const ancestorSources = input.selection ? await this.ancestorSources(sandbox, input.selection) : undefined;
    const initialAppSource = await sandbox.read('src/App.tsx').catch(() => '');
    const hasProductHeroStage = /\bProductHero\b/.test(initialAppSource);
    const hasSpatialRoot = /\bdata-spatial-page\b/.test(initialAppSource);
    const systemPrompt = input.bootstrap
      ? (hasProductHeroStage
        ? '你是 Forma 空间工作台的首席前端与空间网页设计师。用户正在一句话从零创建首版 3D 空间网页。请先用 list_files/read_file 查看现有结构，再用 write_file 完整设计并重写 src/App.tsx 与 src/style.css（必要时可在 src/components/ 下新建辅助组件），全部修改完成后必须调用 finish。严格遵守：1）App 根元素保持 <main data-spatial-page ...>；2）保留导入并渲染 <ProductHero /> 作为页面主 3D 互动舞台，不要修改 src/spatial-module.tsx、src/scene-modules/* 或在源码中硬编码 /assets/*.glb；3）仅允许 import "react"、"react-dom"、"@spatial/scene-renderer" 或 src/ 下相对路径模块，严禁 import lucide-react 等外部第三方包（图标请手写内联 <svg>）；4）包含清晰的标题层级、空间叙事区块与至少一个可点击且有状态反馈的交互按钮，装饰层使用 pointer-events: none 避免遮挡任何按钮或链接；5）严禁在 JSX 或 CSS 中引用任何 http:// 或 https:// 外网图片、字体或外部请求，视觉效果全部使用现代 CSS、渐变与内联 SVG 完成。'
        : '你是 Forma 空间工作台的首席前端设计师与全栈交互工程师。用户正在一句话自由创建全新网页。请先用 list_files/read_file 查看现有结构，再用 write_file 完整设计并重写 src/App.tsx 与 src/style.css（必要时可在 src/components/ 下新建辅助组件），全部修改完成后必须调用 finish。严格遵守：1）App 根元素保持 <main data-spatial-page ...>；2）页面无需强制渲染 3D 舞台（除非用户明确要求），但切勿修改或删除 src/spatial-module.tsx 与 src/scene.config.json，以便用户后续随时拖入 3D 模块；3）仅允许 import "react"、"react-dom" 或 src/ 下相对路径模块，严禁 import lucide-react、framer-motion 等未安装的外部包（图标与插画请手写精美内联 <svg>，动效使用现代 CSS）；4）打造兼具高审美排版、真实可交互状态（如标签切换、筛选、抽屉、计数器或表单反馈）的完整网页，装饰层设置 pointer-events: none 确保所有按钮/链接/输入框不被遮挡；5）严禁在 JSX 或 CSS 中引用任何 http:// 或 https:// 外网图片、字体或脚本，全部视觉使用本地 CSS 与内联 SVG 实现。')
      : `你是 Forma 空间工作台的网页编码 Agent，负责精准修改用户创建的网页或外部拉入的已有网页。请先理解代码（若已有 selectedFileWithLineNumbers 可直接定位，必要时调用 list_files/read_file），再用 replace_in_file 或 write_file 完成用户指令，最后必须调用 finish 汇报中文摘要。严格遵守：1）只能修改 src/ 下的 .tsx/.ts/.css/.json/.svg 文件，严禁修改 src/spatial-module.tsx、src/scene-modules/* 或硬编码 /assets/*.glb；2）仅允许 import "react"、"react-dom"、"@spatial/scene-renderer" 或 src/ 内的相对模块，严禁引入外部 npm 包；3）严禁写入任何 http:// 或 https:// 外网图片、字体或脚本链接（保留已有的 import.meta.env.BASE_URL 本地资源路径，新增图形请用 CSS 或内联 <svg>）；4）${hasSpatialRoot ? '保持根元素上的 data-spatial-page 属性不变；' : ''}确保所有按钮与链接可点击且不被遮挡；5）若提供了局部选中元素 selection 且只需改动局部文案、结构或内联样式，优先只在选中文件内做最小改动；确实需要调整全局样式时再修改 src/style.css。`;
    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          instruction: input.instruction,
          ...(input.bootstrap ? { mode: hasProductHeroStage ? 'bootstrap-spatial-3d-webpage' : 'bootstrap-free-webpage' } : {}),
          selection: input.selection,
          selectedFileWithLineNumbers: selected,
          ...(ancestorSources && Object.keys(ancestorSources).length > 0
            ? { relatedAncestorFilesWithLineNumbers: ancestorSources }
            : {}),
        }),
      },
    ];
    const step = async (message: string) => { check(); await this.options.onStep?.(message); check(); };
    let nudgedForTools = false;

    for (let round = 1; round <= maxRounds; round += 1) {
      input.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CodingAgentError('AGENT_TIMEOUT', `编码 Agent 超过 ${timeoutMs} ms 总时限`);
      await step(`请求编码模型（第 ${round}/${maxRounds} 轮）`);
      const message = await this.request(messages, input.taskId, input.signal, remaining);
      check();
      if ((message.tool_calls?.length ?? 0) > 16) throw new CodingAgentError('AGENT_LIMIT', '单轮工具调用超过 16 次');
      messages.push({
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              })),
            }
          : {}),
      });
      if (!message.tool_calls?.length) {
        if (sandbox.written.size > 0) {
          const summary = (typeof message.content === 'string' && message.content.trim())
            ? message.content.trim().slice(0, 240)
            : '编码 Agent 已完成网页修改';
          await step('编码 Agent 已完成修改');
          return { summary, written: [...sandbox.written] };
        }
        if (!nudgedForTools && round < maxRounds) {
          nudgedForTools = true;
          messages.push({ role: 'user', content: '请直接调用工具（list_files / read_file / write_file / replace_in_file / finish）执行操作，不要仅回复纯文本。' });
          continue;
        }
        throw new CodingAgentError('AGENT_PROTOCOL', '编码模型没有调用工具，也未结束任务');
      }
      for (const call of message.tool_calls) {
        input.signal?.throwIfAborted();
        const name = call.function.name;
        await step(`执行工具 ${name}`);
        if (name === 'finish') {
          const args = this.arguments(call);
          if (typeof args.summary !== 'string' || !args.summary.trim()) {
            messages.push(this.toolResult(call, 'finish 需要非空 summary'));
            continue;
          }
          await step('编码 Agent 已完成修改');
          return { summary: args.summary.trim(), written: [...sandbox.written] };
        }
        let result: string;
        try {
          const args = this.arguments(call);
          if (name === 'list_files') result = await sandbox.list();
          else if (name === 'read_file') result = await sandbox.read(args.path);
          else if (name === 'write_file') result = await sandbox.write(args.path, args.content);
          else if (name === 'replace_in_file') result = await sandbox.replace(args.path, args.old, args.new);
          else result = `未知工具：${name}。只能使用 list_files/read_file/write_file/replace_in_file/finish。`;
        } catch (error) {
          result = error instanceof ToolError || error instanceof CodingAgentError ? error.message : '工具执行失败，请检查路径与参数';
        }
        check();
        messages.push(this.toolResult(call, result));
      }
    }
    throw new CodingAgentError('AGENT_ROUNDS', `编码 Agent 超过 ${maxRounds} 轮仍未完成`);
  }

  private formatNumbered(source: string) {
    return source.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
  }

  private async selectedSource(sandbox: Sandbox, selection: Selection) {
    const file = selection.src.replace(/:\d+:\d+$/, '');
    const source = await sandbox.read(file);
    return this.formatNumbered(source);
  }

  private async ancestorSources(sandbox: Sandbox, selection: Selection): Promise<Record<string, string>> {
    const primary = selection.src.replace(/:\d+:\d+$/, '');
    const seen = new Set<string>([primary]);
    const result: Record<string, string> = {};
    for (const raw of selection.ancestors ?? []) {
      if (Object.keys(result).length >= 2) break;
      const file = raw.replace(/:\d+:\d+$/, '');
      if (!file || seen.has(file)) continue;
      seen.add(file);
      try {
        const source = await sandbox.read(file);
        result[file] = this.formatNumbered(source);
      } catch {
        // Optional ancestor hint may be absent or unreadable; never fail the primary selection.
      }
    }
    return result;
  }

  private arguments(call: ToolCall): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
      return parsed as Record<string, unknown>;
    } catch { throw new CodingAgentError('AGENT_TOOL_ARGUMENTS', '工具参数必须是 JSON 对象'); }
  }

  private toolResult(call: ToolCall, content: string): Message {
    return { role: 'tool', tool_call_id: call.id, name: call.function.name, content };
  }

  private async request(messages: Message[], taskId: string, signal: AbortSignal | undefined, remaining: number): Promise<Message> {
    const timeout = AbortSignal.timeout(remaining);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const body = JSON.stringify({ model: this.options.model, messages, tools: toolDefinitions, tool_choice: 'auto' });
    if (Buffer.byteLength(body) > 4_000_000) throw new CodingAgentError('AGENT_LIMIT', '任务上下文超过 4 MB');
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, 'x-opencode-session': taskId },
        body,
      });
    } catch (error) {
      if (signal?.aborted) throw new CodingAgentError('TASK_CANCELLED', '任务已取消');
      if (timeout.aborted || (error as Error).name === 'TimeoutError') throw new CodingAgentError('AGENT_TIMEOUT', '编码模型请求超时');
      throw new CodingAgentError('AGENT_UPSTREAM', '无法连接编码模型服务');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CodingAgentError('AGENT_UPSTREAM', `编码模型服务返回 HTTP ${response.status}`);
    }
    let payload: unknown;
    const reader = response.body?.getReader();
    if (!reader) throw new CodingAgentError('AGENT_PROTOCOL', '编码模型响应为空');
    const cancel = () => { void reader.cancel().catch(() => {}); };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      const chunks: Uint8Array[] = []; let bytes = 0;
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read();
        combined.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_000_000) throw new CodingAgentError('AGENT_LIMIT', '模型响应超过 1 MB');
        chunks.push(value);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      combined.throwIfAborted();
      if (error instanceof CodingAgentError) throw error;
      throw new CodingAgentError('AGENT_PROTOCOL', '编码模型服务返回的不是合法 JSON');
    } finally { combined.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
    const message = (payload as { choices?: Array<{ message?: Message }> }).choices?.[0]?.message;
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls) && message.content === undefined) {
      throw new CodingAgentError('AGENT_PROTOCOL', '编码模型响应缺少 assistant message');
    }
    for (const call of message.tool_calls ?? []) {
      if (!call || typeof call.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') {
        throw new CodingAgentError('AGENT_PROTOCOL', '编码模型返回了不完整的工具调用');
      }
    }
    return message;
  }
}
