# 编码 Agent 模型服务

## 当前配置（2026-11-14）

用户在确认真实十题用途后提供 `https://xfastapi.ai` 和模型 `gpt-6.1-sol`。本轮按切换服务并执行既定十题理解，后端基址设为 `https://xfastapi.ai/v1`；key 仅保存在 `apps/server/.env` 的 `CODING_AGENT_API_KEY`，不入库。

调度仅查询 `GET /v1/models`：HTTP 200，返回列表含精确模型 ID `gpt-6.1-sol`。尚未发送对话请求，也未实测新服务的工具调用兼容性；由 Pi 在固定十题中如实记录，不额外发送付费探针、不放宽失败计数。没有核实单价，不沿用下方旧服务的价格与能力声明。

## 历史配置：OpenCode Go（2026-11-10，已被当前配置取代）

先前用户指定 OpenCode Go，`https://opencode.ai/zen/go/v1`，模型 DeepSeek V4.1 Flash。以下为当时实测，不能作为新服务兼容性的证据。

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
