# M2-A 审查整改实现报告

日期：2026-11-13。工作分支 `feat/m2b-studio`，起点 `13274c4`；未合并 master，未复制真实 .env，全部上游测试使用 mock。

审查报告未包含在本工作树中；本轮只读核对主工作树 `docs/reports/M2-A-review.md`，按本工作树 `docs/design/M2-plan.md` 的 M2-A-fix 实施。

## 逐项结果

| 项目 | 状态 | 实现与边界 |
|---|---|---|
| B1 预览同源越权 | 已修 | 生产开发入口新增独立预览监听，主作品与候选 iframe 均指向该来源。API 后端删除候选内容路由，Studio 删除全部预览代理。跨来源 API 请求在 onRequest 被拒。Studio Vite 关闭 CORS 并加 CORP same-origin，防止预览再绕到 Studio 的开发文件端点。 |
| B2 Vite 文件范围 | 已修 | 主作品及候选共用显式 fs.allow：作品/候选根、逐包真实依赖路径、pnpm 依赖存储目录和链接到的受信 workspace 包；没有允许主仓库根。另 deny 环境文件、证书/密钥、git、备份和临时文件。真实 Vite 的两组哨兵验证均通过。 |
| R1 快照泄露 | 已修 | 不再 add -A。只收 src/public 及四个根配置文件，跳过隐藏/secret/credential/private-key/backup 名称及敏感扩展，提交前审计整个暂存区。已跟踪的禁用文件使操作失败，不继续复制到候选；不会自动改写已存在的秘密历史，需人工迁移干净版本库。 |
| R2 并发/崩溃窗口 | 已修 | WorkRepo 使用可重入互斥队列；版本、采用、撤回、回退和自动候选清理在队列内重检状态。HTTP 场景读取、写回、撤回、采用资产也走该队列。采用/回退/撤回先持久化 intent，再做 git/目录操作；恢复时检查父提交、候选提交及提交消息身份，补齐 JSON 状态。作品数据目录增加实例锁。 |
| R3 断尾/序号 | 已修 | 启动按字节截去未换行的尾记录；完整行损坏则拒绝启动。事件完整写入并 fsync 成功后才更新序号和广播。写失败抛错并禁止继续发布，需重启修复，不静默吞掉错误或向客户端宣布未持久事件。 |
| R4 总预算 | 已修 | 任务级超时/取消 signal 交给沙箱及模型请求；步骤、工具后与 finish 前检查 deadline。模型响应流最多 1 MB，每轮最多 16 工具调用，累计文件读写最多 2 MB，上下文请求最多 4 MB；响应体中止保留超时/取消语义。 |
| R5 Windows 路径 | 已修路径规则 | 场景配置特判大小写不敏感；拒绝设备名、尾随点/空格、ADS。list 的 src 根也校验链接；写入前再查路径并使用原子临时文件。**不是 OS 沙箱**，不承诺抵御其他本机进程在检查后恶意替换目录的 TOCTOU 攻击。 |
| R6 回收 | 已修本版生命周期 | worktree 创建及依赖链接任一步失败均回滚；重复已有候选分支不误删。预览监听 error/close，不再只等 exit。新 preview-worker 与后端保持 IPC，父进程强制结束时自动退出，避免遗留新预览进程；启动清理没有待定候选归属的目录。旧版无 IPC、无持久所有权信息的遗留 PID **不自动猜测并终止**，仍需按实际进程归属人工清理。 |
| S1 代理边界 | 部分 | HTTP 请求只转发 Host/Accept 等必要头，响应只保留内容类型/缓存头；不转发 Cookie、Set-Cookie、Authorization、Location，HTTP 总时限 30 秒。HMR 单独只允许指定路径及来源。尚未引入全面 CSP/外部网络策略及预览启动随机挑战认证。 |
| S2 容量/分页 | 未修 | JSONL 仍持续追加、启动整文件读取，任务与候选历史无分页/总量上限。内存补拉窗口仍 2000 条；客户端已有 seq 回退后重载处理，但没有新 epoch 协议。 |
| S3 Selection/git 环境 | 部分 | git 子进程清理 GIT_* 宿主变量，禁用全局/系统 git 配置与 hooks。完整 Selection 运行时校验、列号/开标签验证及 baseVersion 主线祖先要求仍未补。 |

互斥只协调本服务管理的操作；外部编辑器/命令行直接更改作品仍属于操作员控制。历史提交身份不匹配时返回 RECOVERY_CONFLICT，保留意图供人工核对，不猜测性回退或覆盖内容。

## 端口与启动行为（Pi 需要更新）

| 配置 | 默认 | 用途 |
|---|---|---|
| Studio | 127.0.0.1:5173 | UI 和代理后的 API；不再代理 /preview/* |
| PORT | 3001 | 后端 API，无预览内容路由 |
| MAIN_PREVIEW_PORT | 5174 | 独立预览监听转发到的主作品 Vite 端口 |
| PREVIEW_ORIGIN_PORT | 5175 | 后端 index.ts 同时启动的预览专用监听；主作品 Vite 也需此值配置 HMR clientPort |
| STUDIO_ORIGIN | http://127.0.0.1:5173 | 预览静态资源允许的精确 CORS 来源，用于 Studio 的 3D 渲染器读取作品模型 |
| VITE_PREVIEW_ORIGIN | http://127.0.0.1:5175 | Studio iframe 与模型/metadata 请求的预览来源 |

- 启动完整 `src/index.ts` 会同时开启 API 和预览监听。测试若直接调用 `createApp()`，需自行调用 `createPreviewOrigin(work.previews, {mainPort,studioOrigin})` 并 listen/close；该工厂位于 `apps/server/src/work/preview-origin.ts`。
- 预览监听只服务 GET/HEAD `/preview/main/*` 与 `/preview/c/<id>/*`，没有任何 API 路由。API 路径在此端口一律 404。
- 主作品 HMR 通过预览源 `/preview/main/hmr` WebSocket 转发。关闭完整入口时同时关闭预览 HTTP 连接及升级后的 WebSocket 连接。
- 不同环境端口必须配套设置。若使用 localhost 而非 127.0.0.1 打开 Studio，STUDIO_ORIGIN 也必须与浏览器实际来源一致。
- 本次验证使用 Studio 5273、作品 5274、预览源 5275、API 3101、mock 4012，未动其他 Agent 的默认端口。

## 跨源桥接约定

iframe URL 示例：`http://127.0.0.1:5175/preview/main/?studioOrigin=http%3A%2F%2F127.0.0.1%3A5173`。

- Studio 给所有 iframe 加 `studioOrigin` 查询参数。bridge 只接受精确 HTTP(S) origin；消息还必须来自 `window.parent`，回传始终用精确 targetOrigin，不使用 `*`。
- 无参数时保留同源回退，供独立 bridge 单测和单独作品调试使用；正式 Studio iframe 总会带参数。
- Studio 同时校验 `event.origin === previewOrigin` 和 source 为当前主/候选 iframe。候选不接入点选结果。
- 原 pick:start/stop、highlight、pick:result、scroll:progress 保持。
- 新增 Studio → bridge：`scroll:to {at}`，0–1 有限数；`viewport:request`。
- 新增 bridge → Studio：`viewport:size {width}`，有限正数且不超过 10000。bridge 观察实际 canvas 的 ResizeObserver，并在 DOM 变化时重新发现 canvas。
- Studio 不再读取 iframe.contentDocument 或跨源 document/scrollY；同步滚动使用消息，M1 的 previewSize 使用最近一次尺寸上报。
- 旧测试在 Studio page.evaluate 中直接读取 iframe DOM 的方式需要改为 Playwright Frame 对象或监听桥接消息。测试源码不得放宽 origin/source 断言。

## 验证与证据

最终完整 `pnpm typecheck`、`pnpm build`、`pnpm test` 通过：shared 68、源码插件 20、scene-renderer 5、server 117、bridge 1、Studio 6，共 **217 项**。之后只加强了同一版本恢复测试里的并发断言，单独再跑服务端 typecheck 与该测试。

新增/加强测试：

- isolation.test.ts：预览 origin 的 PUT /scene、POST /assets/lux3d、/tasks、候选采用、版本回退均 403；写回/提交/计费/采用函数调用计数均 0；预览端口 API 路径均 404。日志断尾修复、连续序号、磁盘错误不广播。
- agent/limits.test.ts：Windows 设备名与歧义路径、大小写场景特判、src 根 junction；超大响应、超多调用、单轮 finish 已超总预算不能成功。
- work/recovery-fix.test.ts：假 .env/备份/密钥不入库，并发 snapshot；链接故障回滚后同 id 可重建；采用已提交但 JSON 未确认时恢复，之后并发回退/版本请求；并发采用/撤回/读版本只允许一种候选决策。
- work/fs-boundary.test.ts：真实 Vite 对主作品与候选分别启动；自身 src 模块 200，位于作品外 docs/orbital/.data/apps/server 的四个假哨兵全部 403，无内容泄漏。
- work/preview-recovery.test.ts：spawn 失败没有挂起或未处理 error；强杀拥有预览的父进程后 IPC 断开，预览端口关闭。该强杀用例用极简 HTTP 入口代替 Vite CLI；真实 Vite 的正常启动/停止在文件边界测试及浏览器闭环中验证。

实际 Chromium + mock 浏览器结果：

- 点选 → 生成 → 并排 → 采用 → 回退、撤回、取消均通过；两侧 iframe 宽度均 545 px；跨源同步滚动正常。
- 从候选 frame 发起任务、计费、场景、版本写请求全部被浏览器标为 cors-blocked；精确 HTTP 403 和零调用计数由服务端测试确认。
- M1 场景加载、环境光写回、网页 HMR 更新、撤回正常；“匹配作品画布尺寸”的实际值与上报值均为 **403.8125 px**。
- 浏览器 pageerror 为 0。临时驱动脚本在忽略目录 `.data/m2-fix/`，未改 Pi 的 E2E 套件。
- 3D 验证后恢复作品原配置内容及排版。没有调用真实编码或 Lux3D 服务。

## 剩余验证与迁移事项

- 原同源 E2E 必须由 Pi 按本报告更新后重跑；本轮没有宣称它们在旧假设下仍通过。
- 没有真实模型质量测试、Firefox/WebKit、真机性能测试或 OS 级对抗性目录竞态测试。
- 重启后待定候选预览仍不自动重启；状态记录可读，采用/撤回可用，预览需要重新生成。没有把候选存在标成预览在线。
- 旧版版本库若已包含禁用文件，本轮不会篡改其历史；首次快照会拒绝，需要迁移干净版本库。
- 没有自动杀死无法确认所有权的历史 PID。本轮已按进程树清理自启服务和 pnpm 残留；最终隔离端口监听数 0、匹配本工作树的进程数 0。
- R3 使用同步写盘/fsync 以保持原 emit 接口和明确持久化顺序，较高事件频率会增加主线程延迟；长期日志容量优化留 S2。
- 外部网络/CSP、持久化容量与完整 Selection 校验分别仍在 S1/S2/S3 未完成范围。

## D1 / D2（Pi 测试阻断项）· Claude Code 修复（2026-11-13，用户指定“你来修”）

### D1 候选预览在浏览器里渲染不出 —— 已修
- **根因**：Vite 的浏览器客户端无论 `hmr` 设置如何都会建立 WebSocket；连不上时进入“server connection lost → 轮询 → location.reload()”循环，正在加载的模块被中止，`#root` 一直为空。候选原先以 `hmr: false` 启动，而预览源只转发主作品的 HMR 升级。
- **修法**：候选与主作品一律启用 HMR，`clientPort` 指向预览源，路径 `<base>hmr`；预览源转发 `/preview/main/hmr` 与 `/preview/c/<运行中的候选>/hmr` 的 WebSocket 升级到对应 dev server，其他路径、未知候选、外来 Origin 一律断开（`work/preview-origin.ts`）。候选 Vite 进程的环境里传入 `PREVIEW_ORIGIN_PORT`。
- **验证**：单测 `work/preview-origin.test.ts`（主作品与候选的 HMR 升级被转发、其余被拒）。真实浏览器（隔离的作品副本 + mock 模型 + 预览源）直接打开 `http://127.0.0.1:<预览源>/preview/c/<id>/`：`#root` 有内容、购买按钮为“马上购买”、`data-src=src/components/Button.tsx:5:5`、10 秒内只导航 1 次、控制台有 `[vite] connected`、“connection lost” 0 次。

### D2 沙箱“经 junction 写出 src/” —— 根因与 Pi 报告不同，已修真正的风险
- **实测**：本机 Node 建的 junction，`lstat().isSymbolicLink()` 为 **true**，沙箱原有检查能识别它。
- **Pi 用例实际发生的事**：junction 建在**作品目录** `src/link-out`；候选从作品版本库检出，快照本就跳过链接，所以候选里没有这个 junction。Agent 写 `src/link-out/escape.ts` 落在**候选内部**新建的普通目录里，没有逃出（这也是 Pi 看到目标目录为空的原因），只是改动列表多了这个文件。
- **真正的风险**：采用（或回退）时 git 把这个文件合并回作品目录，而作品目录里 `src/link-out` 是 junction —— git 会顺着它把文件写到作品外。
- **修法**：
  1. `WorkRepo.assertNoLinks()`：作品目录 `src/`、`public/` 下出现任何链接（按 lstat 与 realpath 双重判断）时，**快照、建候选、采用、回退一律拒绝**，409 `UNSAFE_WORK_TREE`，提示删除该链接。因为提交任务、读版本都会先快照，所以作品里有链接时 `POST /tasks`、`GET /version` 也会 409。
  2. 沙箱逐段检查在 `isSymbolicLink()` 之外再比较 realpath，任何类型的重解析点都不能经过。
- **验证**：单测 `work/repo.test.ts` 新增用例：作品目录含 junction 时四种操作都 409、目标目录为空；删掉链接后同一采用正常落在作品内。
- **对 Pi 用例的影响**：`04-sandbox` 的 junction 用例原期望“任务完成且候选改动只有 App.tsx”；修复后**提交任务就会被 409 `UNSAFE_WORK_TREE` 拒绝**，需要按新行为改断言（目标目录为空、提交被拒、作品目录不变）。`10-known-defect` 的候选预览地址应改为预览源 `http://127.0.0.1:5175/preview/c/<id>/`（不再经 3001）。

全量：typecheck、build、`pnpm test`（shared 68、插件 20、scene-renderer 5、后端 119、studio 6）全过。
