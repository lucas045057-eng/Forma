# 语音转文字选型 · 2026-11-09

用户指示：**优先用阿里相关服务**。结论：用阿里云百炼（DashScope）的语音识别，经后端调用；浏览器 Web Speech API 作备用。

## 候选（阿里云百炼）
| 模型 | 形态 | 适配本项目 |
|---|---|---|
| qwen3-asr-flash | 录音文件/短音频识别（HTTP） | **首选**：开发文档是“按住说话”，松手后整段上传识别即可，最简单；转写先显示、可编辑再提交 |
| fun-asr-realtime / qwen3-asr-flash-realtime | 实时流式（WebSocket） | 备选：需要边说边出字时再用；SDK 只有 Java/Python，Node 需直连 WebSocket 协议 |
| paraformer-realtime | 实时流式（WebSocket） | 老一代，仅华北2（北京）地域，不优先 |

## 设计约束（来自开发文档 §安全与权限）
- API key 只在后端：浏览器录音（MediaRecorder）→ `POST /speech/transcribe` 上传音频 → 后端调百炼 → 返回文字。不在浏览器直连百炼 WebSocket。
- 转写结果先显示、可编辑，再提交为指令（应对现场噪音）。
- 界面注明“语音会发送到阿里云百炼”。

## 待验证（M4 语音任务卡前）
- 需要用户提供百炼 API key（DASHSCOPE_API_KEY，放 apps/server/.env）。
- qwen3-asr-flash 的确切调用方式（DashScope 原生 / OpenAI 兼容接口）、音频格式（webm/opus 是否直接支持，否则需转 wav/pcm）、时长上限、单价、典型延迟——以官方文档为准实测。

## 来源
- 百炼语音识别模型选型：https://help.aliyun.com/zh/model-studio/asr-model/
- qwen3-asr-flash-realtime：https://help.aliyun.com/zh/model-studio/qwen3-asr-flash-realtime
- Paraformer 实时 WebSocket API：https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service
