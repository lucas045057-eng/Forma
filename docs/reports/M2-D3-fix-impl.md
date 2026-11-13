# M2 D3 实现记录（进行中，未验收）

## 基线与边界

- 工作目录 `.worktrees/m2d3`，分支 `fix/m2-d3`。
- 初始工作树干净，HEAD 为 `5d02dc2`。先快进至冻结 `f70f046`，再合并 `d79c467`，合并提交 `b2d74ae`，保留双方历史，无冲突。
- 未修改主工作树或 `.worktrees/m2fix`，未合并 master；未读取真实 `.env`，未调用真实模型/Lux3D，未更改账号配置。
- 已读主工作树设计、Pi 两份报告及审查“复核（补修）”。本报告不是最终修复交付。

## 初步静态发现（不是复现结论）

- Pi `tests/e2e/m2a/zz-kill.spec.ts:11` 通过全局 `vite.js` 与 `preview-cache` 命令行交集统计进程，没有绑定数据目录、候选 ID、创建时间或父子关系。历史证据只有总数，尚不能确定所计进程是否属于被杀后端。
- 当前 `PreviewManager.start` 实际启动参数为 `node preview-worker.ts <vite.js>`；缓存目录通过环境变量传递，不在参数里。因此这个全局统计也可能漏掉当前 worker。需要实测列出匹配进程，不能直接推翻 Pi 结论。
- worker 在同一进程动态 import Vite CLI；需验证 import 之后的实际 OS 拓扑、IPC 断开及 Vite 监听 PID，不能从接线推断强杀回收已成立。
- 未开始修改实现；尚无本轮父子 PID、创建时间、端口或强杀对照证据。

## N4 接口与合并注意事项

`d79c467` 的资源所有权顺序是 work → assets → scene → events → unlock。D3 的预览停止必须可等待，完成回收后才能让 work.close 返回；重启孤儿清理应在 work-data 实例锁内、候选目录清理之前执行。N4 的请求/作品队列排空和失败时锁保持由 `.worktrees/m2fix` 承载，本分支不重复实现。后续若双方修改 WorkService.init/close，合并须保留队列屏障及预览回收等待，不能仅保留调用而丢失 await/错误语义。

## 当前验证状态

续作已核验：HEAD 为 `fc5c9ff`，分支 `fix/m2-d3`，工作树起始干净，冻结基线均已包含。调度安装后根与 server 的 node_modules 已存在；Node v24.14.1、pnpm 11.17.0，按模板/server package.json 分别解析 Vite/Fastify 成功。首次从根 eval 使用 import.meta.resolve 的 parent 参数解析 Vite 失败，改用包内 createRequire 验证成功；这不是安装缺失。

新增实现诊断入口 `apps/server/d3-diagnostic.mjs`（不属于 Pi 正式 E2E）：通过真实 createApp、loopback mock 模型、独立作品副本/数据目录和动态端口生成候选；逐文件复制 Git 跟踪模板，跳过环境文件，不读取服务 .env。分别强杀实际 backend node PID 和外层 launcher 树，记录 CIM PID/PPID/创建时间/命令行、监听归属、实际候选 HTTP 200、1 秒与 30 秒后快照，并保存 Pi 全局匹配结果用于核对统计口径。finally 仅结束本轮树内且 PID/创建时间/命令行仍一致的进程；保存清理后快照。证据落在本 worktree `.data/d3-diagnostic-<时间>/evidence.json`，不覆盖 Pi 正式证据。

脚本已通过 `node --check`、包内依赖解析及 `git diff --check`。拟通过指定 bg.cmd 启动真实复现；作业 ID/输出/停止命令以启动返回值和交回消息为准，启动不等于复现完成。重启回收及异常启动/取消对照仍待基线结果后接续。

- D3 两种真实 OS 强杀与重启回收：未运行。
- service.test.ts / lux3d.test.ts 偶发失败根因：未证实；目前看到相关 mock 使用动态端口，不能据此声称共享端口是根因。
- typecheck / build / 全量单测连续五次：未运行。
- 正式 E2E：交 Pi 执行，本分支未修改其用例或正式证据。
- 本轮尚未启动项目服务或候选进程，无本轮服务树待清理。

## 诊断入口修正（2026-11-13 续作）

- 核验起点为 `84cf6c0`，工作树干净，没有重新安装依赖或合并基线。
- 已读 `orbital/jobs/job_e9883509/output.log`：两种场景都在 backend 启动时失败，`createApp` 返回 `{ app, service, scene, work, events }`，原脚本错误地在返回集合上调用 listen。本次改为解构 `{ app }`。前次没有进入强杀场景，不能计为 D3 复现，日志中两项 cleanupSurvivors 均为空。
- 全局进程命令行仅用于内存匹配，保存前改为 SHA-256 摘要及 previewWorker/piMatch/diagnosticDirectory 标记；保留 PID、PPID、创建时间、进程名和监听者，不把其他应用完整命令行收进新证据。身份比较继续要求 PID、创建时间、命令摘要一致。
- 启动阻塞：调度指定的 `E:/空间化AI工作台/orbital/coordination/m2-takeover/bg-m2d3.cmd` 读取返回不存在，目录枚举亦无该文件。未自行编造 ORBITAL_SESSION_ID，未退回缺失通知上下文的 bg.cmd；本轮没有新 job id，没有启动真实复现。调度需恢复包装后执行 `E:/空间化AI工作台/orbital/coordination/m2-takeover/bg-m2d3.cmd "node apps/server/d3-diagnostic.mjs"`。
- 本次 `node --check apps/server/d3-diagnostic.mjs` 和 `git diff --check` 均通过；未运行服务或整套测试。
- 本次仅修正诊断入口及证据字段；D3 产品实现、重启回收、偶发单测根因及连续五次全量验证仍未完成。

## 候选 fixture 根因（job_dba348b7 后续）

- `2c99743` 已修正 createApp 接口。调度后续恢复通知包装，job_dba348b7 实际启动后端、POST /tasks 返回 202，但未到模型调用/预览/强杀。原证据 `.data/d3-diagnostic-1794583706868/evidence.json` 保留不覆盖，两种场景 cleanupSurvivors 均为空。
- 本轮对原 backend-pid fixture 直接调用真实 WorkRepo.snapshot/createCandidate，限定探针候选 `diagprobe`。snapshot 返回 `653900a9fe3b668a243c979be44ba9273ac3ff34`；createCandidate 在 linkDependencies 抛 `ENOENT: realpath '<fixture>/work/node_modules/@spatial/bridge'`。失败由生产 createCandidate 回滚；没有启动服务。
- 对照：原模板 `node_modules/@spatial/bridge` 的 lstat 为链接、realpath 成功解析本工作树 packages/bridge；fixture 的 node_modules 整目录 junction 自身 realpath 成功，但经它访问相同包的 realpath 返回 ENOENT。因此本次失败点是 fixture 整目录链接下的相对包链接解析，不是版本审计拒绝；Git 建候选已到链接依赖阶段。此结论不排除修复后后续阶段出现另一个问题。
- 最小修正只在诊断脚本：按 scope 递归，从原模板逐包 realpath，再为 fixture 建绝对目录联接；生产路径、Git、版本审计和 API 脱敏规则均未修改。诊断进程对 repo 的 snapshot/createCandidate/linkDependencies/main/inCandidate 捕获原异常码及替换 fixture/worktree 路径后的消息/堆栈，写入独立 repo-errors.json，不经 REST/WS 暴露。
- 新增 `--smoke`：只运行一个候选到 ready 且实际 worker 监听端口 HTTP 200，记录 readyVerified/mockCalls 后执行本轮进程身份校验清理，不进入两种强杀对照。先通过通知包装运行 smoke；通过后下一轮再启动默认两种强杀。`node --check` 与 `git diff --check` 通过。smoke 结果尚未取得，不宣称候选 ready 或 D3 已复现。
- 包装缺失这一历史阻塞已解除。本轮修正提交及后台作业 ID 以交回消息为准；D3 产品修复及稳定性任务仍待后续。
