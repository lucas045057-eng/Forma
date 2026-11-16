# M4 真实语音验收（真实阿里云百炼转写）— Pi

- 日期：2026-11-16（Asia/Shanghai）
- 执行：Pi（测试）；受测提交 **`29d2075b465c2bf42d910f53e2307dddae534981`**（master，M4 已合入）
- 变更范围：**只新增验收侧文件**，产品代码零改动（`playwright.m4-real-speech.config.ts`、`tests/e2e/m4/05-real-speech.spec.ts`、`tests/e2e/m4/fixtures/speech-instruction-48k.wav`、`package.json` 加两条脚本）。产品树与受测提交一致。
- 凭据：用户提供的阿里云百炼 API key，只落在 `apps/server/.env`（gitignored），未写入本报告、证据或任何入库文件。

## 为什么这一轮必要

M4 的正式验收（`docs/reports/M4-final-automation-acceptance.md`）明确把「真实阿里云语音」「真人 A/B」「完整演示彩排」排除在自动化范围外：正式套件里 `SPEECH_BASE_URL` 与 `DASHSCOPE_API_KEY` 被显式清空并挂了 loopback 网络守卫，语音全部走 route stub。本轮补的就是其中**唯一可以自动化的那一项**：真实 provider 的语音转写链路。

## 方法（录音与识别都是真的）

- 浏览器：Chromium 以 `--use-file-for-fake-audio-capture=<fixture>` + `--use-fake-device-for-media-stream` 启动，把一段真实中文指令的 48kHz/16-bit 单声道 PCM 当麦克风输入；`MediaRecorder` 走真采集、真编码（`audio/webm;codecs=opus`）。
- 后端：`tests/e2e/m2a/start-backend.mjs` 起同一份 `createApp()`，`SPEECH_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`DASHSCOPE_API_KEY` 来自 `.env`，**不装网络守卫**；请求真的发往 dashscope。
- 编码 Agent：仍为 loopback mock（4011），Lux3D 仍指死端点 `127.0.0.1:4019`。因此本轮除语音外**不产生任何付费调用**。
- 用例：`pnpm test:e2e:m4:real-speech`（`playwright.m4-real-speech.config.ts`，1 例，单 worker，0 retry，13.6 秒）。

## 断言（互相咬合，单条都能独立失效）

1. 后端 `/speech/config` 报 `enabled=true`、`provider=aliyun`、`model=qwen3-asr-flash`；
2. 页面 `window.fetch` 钩子记录到产品把 **Blob** 交给 `fetch('/speech/transcribe')`，`size > 2000` 且 `type` 匹配 `audio/webm|ogg`（录音真的采到数据，且是浏览器编码产物）；
3. 响应 `provider=aliyun`、`model=qwen3-asr-flash`，且**响应 `requestId` 等于请求头 `X-Speech-Request-Id`**、等于钩子记录的 Blob 请求 id（stub 无法满足这条绑定）；
4. 转写文本必须包含「加入购物袋」「保留原来的购买行为」；
5. 转写可编辑；点确认后只写入指令框、生成候选按钮可用，且 **`POST /tasks` 为 0 次**（确认转写不自动提交）。

## 实测结果（通过）

- 作业：`job_073db6c8`（用仓库内 fixture 复跑）、`job_150b6df5`（同一路径）、`job_a424e998`（首次通过，语料取自 `.data`）。三次均 exit 0。
- 结果：HTTP **200**，**588 ms**（三次分别 678 / 600 / 678 ms），上传 **93,900 字节** `audio/webm;codecs=opus`，requestId 请求/响应一致。
- 转写文本：**把这个按钮的文字改成加入购物袋，保留原来的购买行为。**（与合成语料逐字一致，无重复、无截断）
- 确认后：指令框写入「…，按钮样式保持克制。」，`POST /tasks` 仍为 0。
- 证据：`docs/reports/artifacts/M4/real-speech-20261116/`（`real-speech-transcribe.json` 含 config/请求/响应/耗时/字节/上传记录/编辑后指令；`real-speech-review.png` 为确认面板全页截图）。逐轮退出码与耗时见 `orbital/jobs/job_a424e998`、`job_150b6df5`、`job_073db6c8` 的 `output.log`。

## 复跑方式

1. `apps/server/.env` 需有 `SPEECH_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1` 与非空 `DASHSCOPE_API_KEY`（项目代码里 `SPEECH_BASE_URL` 无默认值，缺了会被判为未配置）。
2. `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright`（Orbital 环境默认指向别处，会报 Executable doesn't exist）。
3. `M4_ARTIFACT_DIR=<本次 run 目录> pnpm test:e2e:m4:real-speech`。

## 覆盖边界（不得外推）

- 语料是 **Windows 中文语音（Microsoft Huihui）合成后重采样的 fixture**，不是人对着麦克风说话；口音、环境噪声、麦克风硬件、真实按键时长未覆盖。
- **编码 Agent 是 mock**：本轮只证明"录音 → 真转写 → 可编辑 → 写入指令"这一段，不证明真实模型改代码（该项已在 M2 真实十题与 M4 D1-D5 的真实模型验收中单独覆盖）。
- **未做真人 A/B、未做完整演示彩排、未验证真实 Windows 控制台 Ctrl+C、仅覆盖 Chromium。**
- 每次运行会真实消耗一次约 6 秒音频的识别额度。

## 本轮两条工程教训

1. **浏览器用 `Blob`/流上传时不发 `Content-Length`**，Playwright 的 `request.postDataBuffer()` 也拿不到请求体——想证明"录音字节数"，只能在页面 `fetch` 钩子里读 `Blob.size`（本轮前两次失败都是断言取错了信息源，不是功能失败）。
2. **Chromium 的 fake audio capture 会循环播放音频文件**：语料 6.34s、按住 7.5s 会在转写尾部多出半句重复；补齐 1.5s 尾部静音并按住 7.0s 后才得到干净整句。
