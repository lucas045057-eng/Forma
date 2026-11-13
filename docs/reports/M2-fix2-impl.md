# M2 第二轮整改实现说明（Claude Code，2026-11-13，用户指定“你来修”）

依据：`docs/reports/M2-A-review.md`“复核（整改回合）”F1–F4、`docs/reports/M2-B-review.md` R1。分支 fix/m2-review2。
验证：typecheck、build、`pnpm test` 全过（shared 68、插件 20、scene-renderer 5、后端 123、studio 7）。**浏览器端到端验收未做，交给 Pi。**

| 项 | 状态 | 改动 |
|---|---|---|
| F1 src/public 根目录为链接 | 已修（master 92ec0c9，之前单独提交） | 根目录自身做 lstat + 真实路径比对；候选提交前检查候选目录；3D 写回/资产采用的路径检查加真实路径比对。 |
| F2 预览源缺 Host 白名单 | **已修** | `work/preview-origin.ts`：HTTP 与 WebSocket 升级统一校验 Host——主机名须是 loopback（127.0.0.1 / localhost / [::1]）或 `PREVIEW_ALLOWED_HOSTS` / `allowedHosts` 配置的名字，**且端口必须是本监听端口**；否则 HTTP 403、升级直接断开。Origin 只与配置的 Studio origin 和由白名单推出的预览源自身 origin 比较，不再从请求头 `Host` 拼信任值。 |
| F3 已有干净版本库跳过审计 | **已修** | `WorkRepo.auditTree(rev)`：用 `ls-tree -r` 审计整棵提交树（不允许的路径、符号链接 120000、子模块 160000）。在 `init()`、每次 `snapshot()` 返回版本前、`createCandidate()` 检出前无条件执行，违规 409 `UNSAFE_TRACKED_FILE` 并提示人工迁移。 |
| F4 事件日志不完全在实例锁内 | **已修** | `createApp` 先对 work-data 目录取实例锁，再读取/修复事件日志；关闭顺序为 work → assets → scene → 事件日志 → 释放锁；初始化失败按相反顺序释放。`WorkService` 新增 `lockHeld` 选项，避免同一目录重复加锁。 |
| M2-B R1 新点选期间仍可提交旧对象 | **已修** | 新增 `apps/studio/src/pick-state.ts`：点选状态分 none / pending / failed / ready。收到新点选立即进入 pending（旧对象作废）；读取版本失败进入 failed；**pending/failed 时按钮与 Ctrl/⌘+Enter 都不能提交**，也不会退化成无对象的整体修改；只有最新点选拿到版本后才可提交。提示文字 `data-testid="pick-state"`（`data-kind` 为状态）。 |
| M2-B S1–S3 | 未做 | 画布尺寸请求带 requestId、区分“操作成功但刷新失败”、重连交错验收，留待后续。 |

## 行为变化（Pi 需知）
- 预览源（默认 5175）只接受 Host 为 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>` 的请求；其他主机名要写进 `PREVIEW_ALLOWED_HOSTS`。
- 作品版本库若已跟踪不允许的文件，后端**启动即失败**（`UNSAFE_TRACKED_FILE`）。
- 同一 work-data 目录的第二个后端在读事件日志前就会 `INSTANCE_LOCKED` 失败。
- 指令框新增 `pick-state` 提示；读取版本期间“生成候选版本”按钮禁用。

## 新增单测
- `work/preview-origin.test.ts`：外来 Host（含错误端口、`localhost.evil.example`）的 GET/HEAD 403；重绑定的 WebSocket 升级被断开；配置的主机名放行。
- `work/repo.test.ts`：已有干净版本库跟踪了 `src/deploy.pem` 时，快照、建候选、重启初始化都 409。
- `events-lock.test.ts`：第二实例失败且事件日志字节不变；优雅重启后 seq 接续。
- `studio/pick-state.test.ts`：pending/failed 时不可提交且不回退到旧对象。
