# 编码 Agent 模型服务 · 2026-11-10

用户指定：OpenCode Go，`https://opencode.ai/zen/go/v1`，模型 DeepSeek V4.1 Flash。key 在 `apps/server/.env` 的 `CODING_AGENT_API_KEY`（不入库）。

## 实测
- `GET /models` 可用；模型 id 为 **`deepseek-v4.1-flash`**（用户写的是“deepseekV4.1 fresh”，按列表里的 Flash 理解）。同一列表里还有 `deepseek-v4-pro` 等。
- `POST /chat/completions`（OpenAI 兼容）可用，鉴权 `Authorization: Bearer <key>`。
- **必须带请求头 `x-opencode-session: <任意稳定字符串>`**，否则报 `MissingSessionID`。建议同一个任务（Task）全程用同一个值，利于服务端缓存路由。
- 响应里推理内容在 `message.reasoning_content`；`usage.cost` 与 `usage.opencode` 给出计费信息（走 Go 订阅额度）。
- 模型能力（来自 /models）：支持工具调用（tool_choice: auto/none/required/指定）、结构化输出、推理强度 low/high/max；上下文 100 万、输出上限 38.4 万 token；可输入图片。
- 列表价：输入 $0.15 / 百万 token（缓存读 $0.003），输出 $0.6 / 百万 token；工作日 UTC 01–04 点与 06–10 点为 2 倍系数。

## 对 M2 设计的含义
- 后端用 OpenAI 兼容的 chat-completions + 工具调用实现编码 Agent 即可，不需要专用 SDK。
- 工具集按开发文档限制为候选 worktree 内的读文件 / 写文件 / 列目录，不给 shell。
- 测试用 mock 上游（Pi 的做法同 Lux3D），不打真实接口。
