# M0-A 审查整改实现报告

日期：2026-11-09。
工作树：`E:/空间化AI工作台/.worktrees/m0a-fix`；分支 `fix/m0a-review`，基于 `1c6a6e7`。未合并 master。

## 改动摘要

### R1：残留临时文件不阻断重试

新增 `apps/server/src/assets/atomic-file.ts`，为每次写入生成 `<目标文件>.<UUID>.tmp`，仍用 wx 排他创建，再原子 rename 发布。模型、raw 下载和 JSON 索引共用此写入方式。成功或失败后清理本次创建的临时文件，不删除其他操作或过去崩溃的残留。

固定 `model.glb.tmp` / `raw.glb.tmp` 残留不再发生 EEXIST。回归预置两个旧临时文件后运行完整导入并断言 ready；注入发布失败后，原正式文件仍保持旧内容，当前 UUID 临时文件被清理。

### R2：下载总时限、取消与可恢复停止

- 下载默认总预算 120,000 ms；可通过 `ASSET_DOWNLOAD_TIMEOUT_MS` 或 `createApp({downloadTimeoutMs})` 配置。无效非正数配置启动报错。
- 一个预算信号覆盖 DNS 等待、连接、所有重定向和响应体。跨重定向沿用同一信号，不重新计时；保留 60 秒连接空闲超时作为额外约束。
- 上游创建、getTask、轮询等待及下载接受服务停止信号。下载取消销毁连接/响应体，并清理自己产生的临时文件。
- Fastify 在 preClose 阶段停止服务工作，避免等到所有连接关闭后才取消请求。原 SIGTERM/SIGINT 入口继续调用 app.close。
- 停止时已知远端 taskId 的任务保存为 polling + SERVICE_STOPPED，重启后设置新的查询窗口，继续查询原任务。未知提交结果仍保守保留 submit_unknown，不自动重复创建。
- 明确错误码：DOWNLOAD_TIMEOUT、DOWNLOAD_ABORTED；原 OUTPUT_URL_EXPIRED、MODEL_TOO_LARGE 等错误保留。

### R3：修复 ready 缺文件及前端失败缓存

ready 快速返回前检查模型文件是否为可读非空文件；文件缺失时，使用原 taskId 重新 getTask 获取新 URL，再下载、处理并修复同一条记录，不调用创建接口。启动时发现 ready 文件缺失会转为 failed/MODEL_MISSING，允许用户导入修复。

每次成功发布生成新的 modelUrl revision；Studio 错误边界以 modelUrl 为 key，加载状态绑定 URL。相同资产 id 修复后能重新挂载并绕过 useGLTF 对旧 URL 的失败缓存。

### S1：严格 mock 与失败回归

mock 的 Lux3D 路径校验 raw Authorization，默认仅接受 `mock-only`，工厂 options.key 可指定专用假值；不接受 Bearer 前缀。文/图创建校验路由对应的 prompt/img、互斥输入、G1/G1-Turbo 和 outputFormat=["glb"]，不通过类型转换或删除多余字段放宽规则。part-split 使用独立 glbUrl schema。

新增 mock 场景：response-lost（创建计数增加后断开 socket）、truncated（保留原声明长度但截断 GLB）、drip（持续逐字节发送，连接关闭时停止定时器）。统计接口仍只返回 creates/gets，不回传密钥或请求输入。

### S3：禁止非本机明文上游

LUX3D_BASE 仅允许 HTTPS；HTTP 仅放行显式 localhost、127.0.0.1、[::1] mock。用户信息、query/hash 或其他协议配置拒绝。构造客户端时验证，配置错误不会发请求或发送 key。下载仍逐跳检查公网地址并固定 DNS 解析结果，未削弱 SSRF 防护。

## 新增自动化测试清单

| 文件 | 新增数量 | 覆盖 |
| --- | ---: | --- |
| assets/lux3d.test.ts | 9 | 4 种不安全上游配置拒绝且 fetch 未调用；3 种 loopback 和 HTTPS 正向配置；进行中的 getTask 可取消 |
| assets/mock-server.test.ts | 5 | 假 Authorization 精确校验；错误 version/输入/outputFormat 不增加创建数；正确文生、图生、拆分、列表和查询；截断输出 |
| assets/download.test.ts | 11 | 持续滴流总时限、卡住的 DNS 总时限、重定向不重置预算；重定向私网/IPv6 回环/IPv4-mapped IPv6；公网私网混合 DNS；截断 GLB 与 chunked 超限；默认 100 MiB Content-Length 上限；唯一临时文件失败清理和旧正式文件保留；写入期间取消清理 |
| assets/recovery.test.ts | 7 | 预置临时文件后完整导入；缺失 ready 文件重导入并更新 URL；重启发现文件缺失后修复；接受创建后响应丢失不重提；taskId 写盘失败重启不重提；下载和轮询中 app.close 及重启恢复；截断 mock 结果不发布 |

新增 32 项，后端从 14 项增至 **46 项全部通过**。所有有文件操作的新用例均使用 worktree/.data 下独立 mkdtemp 目录，测试后删除；mock 协议 inject 用例不产生文件且各自创建新 app。现有使用系统 tmpdir 的测试在最终命令中通过 TEMP/TMP 指向 worktree 内目录。

taskId 写盘故障测试实际让索引保留 submitting，随后重建服务；原幂等键返回 submit_unknown，creates 保持 1，手动导入已知 taskId 可恢复。不是只在客户端放置一个拒绝 spy。

DNS 卡住和混答通过 Vitest 模块替换注入；连接、重定向、响应丢失、滴流等均使用真实本机 socket。没有连接真实 Lux3D 或真实 CDN。

## 浏览器恢复验证

使用当前工作树代码、本机 Chrome、mock-only 和随机端口启动隔离后端及 Vite；不占用 3001/5173/5174，不启动模板真实业务服务。

验证顺序：导入 mock 任务 123 → 删除正式模型 → 打开 Studio 3D 资产视口 → 确认加载失败提示 → 在 UI 用相同 taskId 重新导入 → 等待 data-loaded=true 与 canvas 出现。

结果：

- 本地资产 id 始终为 lux3d-123。
- 浏览器先请求旧 revision（404），修复后请求新 revision 并成功恢复画布。
- mock creates=0，无新建付费任务。
- 浏览器请求拦截器只允许本机来源；外部请求记录为空。
- 临时服务、浏览器及测试资产目录均在 finally 中关闭/清理。
- 临时验证脚本保留在 gitignored `.data/m0a-fix-browser.mjs`，未修改 tests/e2e。

## 交付检查

在本 worktree 中执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
TEMP="E:/空间化AI工作台/.worktrees/m0a-fix/.data/test-temp" TMP="E:/空间化AI工作台/.worktrees/m0a-fix/.data/test-temp" pnpm test
```

全部退出 0，git diff --check 通过。构建仍有既有 3D chunk 体积提示，Fastify 仍有既有 disableRequestLogging 弃用提示。

根测试：资产 46 项正常通过，源码插件 runner 报 9 项通过。**插件的 9 项含基线已有的两个 it.fails（M0-B R2 预期失败），不是本分支修复了 M0-B**；未修改这些测试，也未合入 fix/m0b-review。

## 边界与交接

- 未新增/升级依赖，package manifests、pnpm-lock.yaml、pnpm-workspace.yaml 未改变。
- 未复制、读取或使用真实 .env；已确认本 worktree apps/server/.env 不存在。模拟测试仅用 mock-only / test-only-key。
- 所有安装、编辑、测试及提交命令限定 m0a-fix；未编辑主工作树、m0b-fix 或 Pi 的 tests/e2e。
- 旧崩溃临时文件保留但不再阻断；本轮没有添加全目录清理器。
- DNS 底层解析任务本身不保证被操作系统取消，但调用方立即结束等待，后续不再发起下载连接。
- 同步几何/纹理转换仍在主进程内，停止期间若已进入转换会等其返回后保存可恢复状态；转换资源隔离属于 S4/M1。本轮没有声称强制中断转换。
- 已实测 app.close；未单独运行操作系统 SIGTERM 子进程用例。现有 SIGTERM 入口调用同一 app.close 路径。
- S2 事件持久化和补拉、S4 部件命名/体积门槛/转换隔离未做，分别留给 M2、M1。
- 正式 Pi 回归及 Codex 复核待调度执行，未合并到 master。

## 提交

- `67083df` 使用唯一临时文件修复模型发布重试阻塞
- `b8af8ad` 限制上游明文配置并校验模拟服务请求协议
- `fc11845` 贯通下载总时限与停止信号并修复缺失模型重导入
- 分块体积断言、README 和本报告随最终交付说明提交，提交号见 git log。
