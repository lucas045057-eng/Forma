import type { Selection } from '@spatial/shared';
import { Sandbox, ToolError, toolDefinitions } from './tools.ts';

export class CodingAgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type ToolCall = { id: string; function: { name: string; arguments: string } };
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

  async run(input: { taskId: string; instruction: string; selection?: Selection; root: string; signal?: AbortSignal }) {
    const sandbox = new Sandbox(input.root);
    const maxRounds = this.options.maxRounds ?? 16;
    const timeoutMs = this.options.timeoutMs ?? 180_000;
    const deadline = Date.now() + timeoutMs;
    const selected = input.selection ? await this.selectedSource(sandbox, input.selection) : undefined;
    const messages: Message[] = [
      { role: 'system', content: '你是网页作品的编码 Agent。先用 list_files/read_file 理解代码，再用 replace_in_file 或 write_file 完成用户指令，最后调用 finish。只能修改候选作品 src/ 下的源码；不要修改依赖、构建配置或 src 之外的文件。没有 shell。尽量做满足指令的最小改动。' },
      { role: 'user', content: JSON.stringify({ instruction: input.instruction, selection: input.selection, selectedFileWithLineNumbers: selected }) },
    ];
    const step = async (message: string) => { await this.options.onStep?.(message); };

    for (let round = 1; round <= maxRounds; round += 1) {
      input.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CodingAgentError('AGENT_TIMEOUT', `编码 Agent 超过 ${timeoutMs} ms 总时限`);
      await step(`请求编码模型（第 ${round}/${maxRounds} 轮）`);
      const message = await this.request(messages, input.taskId, input.signal, remaining);
      messages.push(message);
      if (!message.tool_calls?.length) throw new CodingAgentError('AGENT_PROTOCOL', '编码模型没有调用工具，也未结束任务');
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
        messages.push(this.toolResult(call, result));
      }
    }
    throw new CodingAgentError('AGENT_ROUNDS', `编码 Agent 超过 ${maxRounds} 轮仍未完成`);
  }

  private async selectedSource(sandbox: Sandbox, selection: Selection) {
    const file = selection.src.replace(/:\d+:\d+$/, '');
    const source = await sandbox.read(file);
    return source.split('\n').map((line, index) => `${index + 1}\t${line}`).join('\n');
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
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}`, 'x-opencode-session': taskId },
        body: JSON.stringify({ model: this.options.model, messages, tools: toolDefinitions, tool_choice: 'auto' }),
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
    try { payload = await response.json(); }
    catch { throw new CodingAgentError('AGENT_PROTOCOL', '编码模型服务返回的不是合法 JSON'); }
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
