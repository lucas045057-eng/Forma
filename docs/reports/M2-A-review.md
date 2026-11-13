# M2-A 指着说闭环后端 · Codex 审查

- 日期：2026-11-13。结论：**不通过**。
- 范围：合并快照 **f7f31b2**（7a28519、1ef750c、591d422、656e545、9dc9a3e、e8deaa6），以下行号均对应此快照。
- 分级：**阻断 2，应修 6，建议 3**。正常 mock 闭环可运行，但候选代码与正式版本之间尚无可靠权限隔离，持久化及并发恢复存在缺口。
- 只新增本报告；未改实现、测试、Pi 证据或记忆，未访问真实 key/索引，未操作真实作品 git，也未读取 `.worktrees/m2b`。

## 阻断

### B1 · 候选 JavaScript 与 Studio 同源，可绕过工具沙箱调用正式写入/付费接口

- 位置：`apps/server/src/app.ts:125`、`:130`、`:171`（候选代理及 scene/assets 写接口）；`apps/server/src/work/preview.ts:86`；`apps/server/src/agent/tools.ts:8`。
- 问题：Agent 可以合法写 src/App.tsx，生成的代码会在候选预览中执行。预览经同源路径提供，而后端仅用 Host/Origin 限制外部站点，没有区分 Studio 与候选代码的权限。候选脚本调用同源 `/scene`、`/assets/lux3d` 等接口时，Host 和 Origin 都合法。
- 具体路径：在组件 effect 中执行 `fetch('/scene', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(config)})` 即可尝试修改正式作品；同理可请求付费生成。代理只允许 GET/HEAD 并不能解决它：浏览器直接请求 API，无须让 POST 穿过候选代理。
- 影响：只改候选、采用前不动正式版本、限制外部付费操作的执行边界可被绕过。不能用“模型没有 shell”或“这是自有模板”作为隔离保证。
- 修法：将不可信预览放到独立 origin，并确保其不能调用正式写接口；或采用真正的 iframe sandbox/资源策略并适配 Vite 加载。正式写操作的授权能力只交给 Studio，不得随预览内容或 URL 下发。补恶意候选脚本的隔离回归，用假的写入/计费计数证明请求被拒。
- 证据边界：依据完整调用路径与浏览器同源权限判断，未发起真实写入或付费攻击请求。

### B2 · 候选 Vite 默认文件允许范围覆盖主工作区，绕开 read_file 白名单

- 位置：`templates/product-page/vite.config.ts:10`（defineConfig/server 配置）；`apps/server/src/work/preview.ts:86`–`:95`。
- 问题：候选配置没有显式 server.fs.allow，代理也不限制 Vite 文件读取端点。候选目录默认在主项目的 `.data/work/candidates/` 下；Vite 自动查找 workspace 后，允许范围扩大为整个主工作区。
- 证据：对现有 Vite 的 `searchForWorkspaceRoot(E:\空间化AI工作台\.data\work\candidates\abcdef)` 做只读调用，结果为 **E:\空间化AI工作台**。本地 Vite 配置解析代码确认 fs.allow 未配置时采用该结果。默认 deny 保护若干 `.env`/证书/git 路径，并非保护所有项目文档、运行记录、JSON 或其他秘密副本。
- 影响：模型生成的浏览器代码可尝试通过 `/preview/c/<id>/@fs/...` 读取候选外的文件，再发送出去。工具层拒绝 `.env`、`../` 不等于预览服务器也拒绝；主项目的运行记录尤其不应在允许范围内。
- 修法：显式限制 candidate root、必要且精确的依赖真实路径及受信共享包，拒绝主项目、server、orbital 和数据目录的非必要访问；审查 `/@fs`、raw import、glob 和其他加载端点，不能只过滤单一路径字符串。结合 B1 限制候选网络能力。用无秘密的主仓库哨兵文件验证 HTTP 不能读取。
- 限制：未启动实际候选服务器做文件下载，未读取真实秘密；这是默认权限计算与代理配置的证据，不是声称已实测某个 key 被下载。

## 应修

### R1 · 自动快照使用全量 add，未排除环境文件等敏感内容

- 位置：`apps/server/src/work/repo.ts:62`–`:64`、`:80`。
- 问题：exclude 仅含 node_modules/dist/.vite/*.tmp，随后 `add -A`。模板没有自己的 .gitignore；作品根新增 `.env`、备份或本地凭据文件会被自动提交，并复制进候选。主仓库的忽略规则不应被视为这个独立 git-dir 的保证。
- 影响：GET /version 就可能把工作目录中不应版本化的文件固化进作品历史，删除工作文件也不能从历史撤销泄露。
- 修法：按设计允许的作品路径明确建跟踪清单，另设敏感文件排除及暂存区审计；已跟踪的敏感文件也须阻止后续提交。用假 `.env`/备份/临时文件验证首次 init 与后续 snapshot 均不入库。此项针对 WORK_ROOT，并非声称当前 apps/server/.env 已被 add。

### R2 · git/生命周期操作没有统一串行与崩溃日志

- 位置：`apps/server/src/work/service.ts:226`–`:255`；`apps/server/src/work/repo.ts:78`、`:148`–`:164`。
- 问题：taskQueue 只串行执行 Agent 任务，version/snapshot、adopt、discard、revert 以及 POST 提交时的校验不走同一个操作队列。两个请求可同时通过 pending 检查，再竞争 git index、合并或删除同一 worktree。merge 已成功但 tasks.json 尚未保存时崩溃，重启只 abort 未完成的 merge，不会把已完成合并补回 adoption 记录。
- 影响：可能出现 index.lock 错误、状态与 git 不一致、正式内容已变但候选仍显示 pending、无法按记录回退。SceneService 的独立队列也不与快照协调，外部写回期间无法保证 snapshot 对应完整状态。
- 修法：统一作品修改/快照/采用/回退互斥，锁内重检状态；为跨 git/JSON 操作建立意图与完成日志，启动时按提交身份幂等恢复。与 3D 写回协调。测试并发 adopt/discard/version，以及 merge 成功后写盘失败/进程中断，不能只测顺序 happy path。

### R3 · 事件断尾与写失败会导致序号回退和重复

- 位置：`apps/server/src/events.ts:26`、`:28`、`:38`–`:39`。
- 问题：init 跳过损坏尾行，却没有截断/修复尾部。下一次 append 直接连在半行后，新事件也成为坏行。publish 在写入完成前就广播，追加失败被吞掉；重启从磁盘最大 seq 恢复，可能重用客户端已见过的序号。
- 复现：虚拟文件包含完整 seq=1 与半条 seq=2；publish 返回 2，等待写完后重建日志得到 last=1，下一次 publish 又返回 **2**。
- 修法：启动时修复断尾后再接受追加；确认持久化后再通知成功/广播，或建立不会回退的高水位及明确降级协议。写失败不能静默宣称事件持久化成功。补补拉去重、重启与磁盘错误用例。

### R4 · 180 秒预算没有约束单轮工具批次，响应/调用数量也无上限

- 位置：`apps/server/src/agent/client.ts:67`–`:86`、`:143`。
- 问题：deadline 仅在轮次开始检查，工具循环只检查用户取消信号。单个响应可带任意多个工具调用，finish 在超时后仍直接成功；response.json 无大小限制，消息累计和落盘步骤亦无总量预算。
- 复现：假时钟总预算 10 ms，同一响应三次写工具各推进 20 ms，最后 finish；实际 **60 ms、三次写入后仍返回成功**。没有写真实文件或调用真实模型。
- 修法：统一任务级超时 signal，工具前后/finish 前检查剩余预算；限制响应字节、工具调用数、累计文件/写入字节和上下文规模。大响应采用受限读取，取消/超时不能被 JSON 解析错误掩盖。补单轮超多工具和响应体中断测试。

### R5 · Windows 路径策略不完整，大小写可绕过场景 Schema 特判

- 位置：`apps/server/src/agent/tools.ts:8`、`:27`–`:39`、`:66`–`:74`、`:52`。
- 问题：`src/scene.config.json` 用大小写敏感的原始相对路径作特判。Windows 上 `src/SCENE.config.json` 指向同一文件，但只走普通 JSON 校验。保留设备名/尾随点目录也未明确拒绝；lstat 检查与后续 mkdir/write 之间没有针对另一写入者的原子保证。list 的 src 根本身未经过 resolve 的链接检查。
- 复现：虚拟文件系统与始终拒绝的 isSceneConfig 下，小写路径 `{}` 被拒，大写路径 `{}` 成功交给 writeFile。真实 Windows 默认大小写不敏感目录会把它写到同一场景文件。
- 修法：建立与实际平台一致的规范身份并用于特殊文件策略，拒绝 Windows 设备名、尾随点/空格等歧义；list/read/write 统一链接与边界检查。在写入者不可信的条件下使用 OS 隔离或可证明的句柄/目录约束，不能称逐段 lstat 为完整 TOCTOU 防护。
- 正面边界：当前正则确实拒绝冒号 ADS、带 `~` 的 8.3 输入、绝对路径和 `..` 段，已有 junction 路径检查有价值；本次没有证明这些方式能直接逃逸，也没有实施真实 junction 竞态攻击。

### R6 · 预览与候选的部分失败、异常退出缺少完整回收

- 位置：`apps/server/src/work/service.ts:148`–`:149`；`apps/server/src/work/repo.ts:99` 附近的 createCandidate；`apps/server/src/work/preview.ts:45`–`:50`。
- 问题：worktree 创建后若 linkDependencies 抛错，execute 的 created 尚为 false，不清理已创建目录/分支。spawn 只监听 exit，没有 error 的失败处理；stop 等待 exit 的 Promise 对 spawn failure 不可靠。后端崩溃后内存 running 表丢失，没有持久 PID/父进程死亡处理来回收可能仍在运行的 Vite。
- 修法：createCandidate 内部对部分完成回滚；预览统一处理 error/close、退出与取消，记录所有权并在重启恢复/父进程退出时可靠清理。测试缺依赖链接失败、spawn failure、后端强杀及取消启动窗口；验证端口/目录均释放。正常 close 的 stopAll 不等于崩溃清理保证。

## 建议

### S1 · 收紧预览代理的 HTTP 边界

- 位置：`apps/server/src/work/preview.ts:86`–`:95`。
- 固定 loopback + running 表端口，没有直接把用户指定 host 当上游，GET/HEAD 限制也存在。但请求头与响应头全量透传，没有上游总时限；应移除 hop-by-hop/代理凭据头，明确 Cookie、Set-Cookie、Location、CSP 处理及错误/慢响应预算。端口释放到绑定之间的竞争已披露，宜验证探测到的服务确实是所启动候选。此项不能替代 B1/B2 隔离。

### S2 · 状态容量和截断协议需给客户端明确约定

- 位置：`apps/server/src/events.ts:22`、`:44`；`apps/server/src/work/service.ts:74`、`:196` 附近。
- tasks/candidates/步骤无总量上限，事件启动读取整个 JSONL；任务事件每次广播/保存完整 task，长期成本不断增加。events/history 的 oldest/current/truncated 能提示落后窗口，但 since 大于当前值、重置数据目录或 R3 的落盘丢失不能只靠 oldest 判断。增加状态 epoch/重置语义、容量和分页；不要把“已产生候选”与“预览已恢复”混为一谈。

### S3 · 补充 Selection 与 git 环境的防御验证

- 位置：`apps/server/src/work/service.ts:116`–`:128`；`apps/server/src/work/repo.ts:15`、`:41`。
- stale 校验对选中文件变更有效且执行前再次校验，但仅检查行范围，不校验列/开标签，baseVersion 不要求为当前主线祖先；Selection 其他字段、ancestors 的完整类型亦未校验。建议使用共享运行时模型并明确定位有效性的标准。
- 主作品命令明确指定独立 git-dir/work-tree，候选命令依赖 cwd/.git 发现；git 子进程仍继承 GIT_DIR/GIT_WORK_TREE 等宿主环境和全局 hooks/filter 配置。清除影响仓库选择/执行的环境，显式指定候选仓库身份并禁用不需要的 hooks。junction 删除先 lstat 再摘链接的方向正确，但跨平台回收还应真实验证；没有证明当前 removeCandidate 必然遍历真实依赖，不据此报告已删除主仓库。

## 其余判断与验证边界

- **密钥**：CodingAgent 使用 Authorization 和同任务不变的 x-opencode-session；错误用固定文本，不把上游 body 打印。Vite env 为白名单，未复制 provider key 或 NODE_OPTIONS；但是 Vite 仍是当前用户下的文件系统进程，去掉环境 key 不解决 B2 的磁盘读取。没有证据表明现有受信 vite.config 会动态执行 src 文件中的任意 Node 代码；也没有把它宣告为 OS 沙箱。未运行 src payload 的后端执行攻击。
- **工具稳健性**：普通工具参数异常会转工具错误，finish 参数异常可使任务失败但未见必然导致整个服务退出；大型响应、批量工具和设备路径问题需按 R4/R5 补齐。每轮 16 的限制是默认请求轮数，不是总工具数限制。
- **git 恢复**：merge/revert 冲突会尝试 abort，运行/排队任务在重启时标失败，这是合理的保守策略；无法恢复已完成 git 操作与 JSON 的中间窗口。取消在 git 命令边界生效已披露，不等于事务可取消。
- **计费权限**：生成质量的 10 次真实模型测试未执行，本次没有消耗编码模型/Lux3D 额度。不能以 mock 202 项通过代替 B1 的候选权限验收。
- **本次执行**：全部从 Git 快照读取并内存转译；使用虚拟文件系统复现断尾序号重复、单轮超时后成功、场景文件大小写特判绕过；只读计算了 Vite workspace root。未创建候选、未启动项目服务、未安装依赖、未更改测试或作品，未读取秘密文件。未重跑 build/typecheck/完整单测/E2E，未做真实进程强杀、Windows 设备/8.3/TOCTOU 或 HTTP 文件下载攻击。实现方交付测试结果仅作证据核对，不冒充本次重跑。

建议先关闭 B1/B2，再回归 R1–R6；整改报告需分别证明候选浏览器权限、预览文件权限、工具文件权限三层边界，不能仅增加工具路径测试就宣称 Agent 已完全受限。

## 复核（整改回合）

- 复核日期：2026-11-13；快照：**c93286f**。本节行号均对应该快照，覆盖 0865ec3、2beb288、344f014、abe823f 及 5037f65；同时核对 M2-B 接线。
- **结论：仍不通过，不能转为“通过”。** 原 B1/B2 的主要权限缺口已关闭，但 D2 仍遗漏可写区域根目录链接，存在实际越界写路径。另有三项应修。下列结论取代“整改说明已完成”作为过关判断。

### 逐项核对

| 原项 | 状态 | 证据与边界 |
| --- | --- | --- |
| B1 预览脚本调用正式接口 | 已修复（原同源问题） | `apps/studio/src/App.tsx:105`、`:108` 使用独立 preview origin；`apps/server/src/app.ts:73`–`:83` 校验 API Host/Origin，`:123` 不再提供预览；`apps/studio/vite.config.ts:9`–`:10` 关闭跨源读取并设置 CORP。预览向 3001 或经 5173 代理发送写请求时，预览 Origin 与 API/Studio Host 不符；表单 POST、sendBeacon 的 Origin（包括 `null`）同样不匹配，WebSocket `/events` 也受 onRequest 检查。5175 只代理 GET/HEAD，没有正式写入/付费路由。未发现此次配置下绕过该写入边界的路径；这不等于预览不能向外联网，也不等于拒绝所有无 Origin 的 GET。预览监听器另有 F2。 |
| B2 Vite 文件范围 | 已修复（默认 workspace 扩大问题） | `templates/product-page/vite.config.ts:7`–`:29` 显式允许作品/候选根、依赖实际目录、pnpm store 及所需共享包，不再采用整个 workspace 的默认范围；额外 deny 环境文件、证书、git、备份与临时文件。`apps/server/src/work/preview.ts:47` 明确以候选目录为 cwd。受信共享包和依赖源码仍可读取，这是运行所需范围，并非只允许候选 src。没有在本轮下载真实主仓库文件。 |
| R1 快照跟踪清单 | **部分修复** | `work/repo.ts:92`–`:110` 已改为允许清单、逐文件 add 和暂存区链接审计，新文件不再全量入库；但已有干净版本库不一定经过审计，见 F3。 |
| R2 作品操作互斥与恢复 | 已修复（所列并发/意图缺口） | `work/repo.ts:35`–`:50` 的可重入队列覆盖作品 git；`work/service.ts:52`–`:55` 将生命周期决策放入同一队列，`:85`–`:103` 恢复持久意图；`work/repo.ts:152`–`:160` 校验恢复提交的父提交/消息，init 会 abort 未完成 merge/revert。`app.ts:166`–`:173` 将 3D 写回、撤回、资产采用也串行化。外部编辑器不受该内存队列约束；实例锁对事件日志的覆盖另见 F4。 |
| R3 事件断尾与写失败 | 已修复（单持有者日志逻辑） | `apps/server/src/events.ts:20`–`:30` 截到最后一个换行并拒绝损坏完整记录；`:34`–`:49` 写完整字节并 fsync 后才推进 seq、广播，失败后停止发布。内存文件系统探针通过：断尾修复后发布 seq=2，重建后发布 seq=3；注入 fsync 失败没有广播，后续发布继续拒绝。跨实例启动顺序仍有 F4。 |
| R4 任务预算 | 已修复 | `agent/client.ts:55`–`:62` 合并总超时和取消信号，`:72`–`:117` 在工具步骤前后、finish 前检查预算；限制每轮 16 次调用、响应及上下文大小。`agent/tools.ts:29`–`:32`、`:75`–`:97` 限制文件/累计字节并在写入前后检查。不是硬实时中断或操作系统沙箱，但不再允许一轮工具无界越过预算后成功。 |
| R5 Windows 工具路径 | 已修复（原大小写/保留名缺口） | `agent/tools.ts:35`–`:53` 拒绝设备名、尾随点/空格、ADS 等，逐段检查 lstat 与 realpath；`:86` 场景特判不再大小写敏感，`:94` 写前复查，`:57` 检查 list 的 src 根。工具层改进成立，但不能代替所有 Git 写路径的边界检查，D2 见 F1；本地恶意进程的 TOCTOU 仍不在保证内。 |
| R6 预览异常回收 | 已修复（原部分失败/父进程死亡缺口） | `work/repo.ts:170`–`:173` 创建失败内部回滚；`work/preview.ts:51`–`:68` 处理 error/close 并在启动失败时 stop；`work/preview-worker.ts:3`–`:8` 依赖父进程 IPC，断开即退出。运行表移除、无主目录清理已接入。未重新执行 OS 强杀测试；旧版无法确认归属的 PID、重启后待定候选预览不自动恢复仍是已披露限制。 |
| D1 候选 HMR 加载 | 已修复（接线） | `vite.config.ts:30`–`:33` 开启候选 HMR；`work/preview-origin.ts:30`–`:44` 只向主作品或运行表中候选的固定 loopback 端口升级 `<base>hmr`，不是任意端口代理。未发现因该路径放行而直接得到正式 API WebSocket 的路径；Host/Origin 身份判断仍需 F2。浏览器最终回归以 Pi 迁移后的结果为准。 |
| D2 作品树 junction | **部分修复，仍阻断** | 工具真实落点检查及 Git 操作前 `assertNoLinks` 已加入；但 `assertNoLinks` 未检查 src/public 根自身，F1 实证仍可越界。 |
| S1 HTTP/CSP | 部分处理 | `work/preview.ts:90`–`:103` 和 `preview-origin.ts:19`–`:28` 限制方法、固定上游、头白名单及 30 秒预算，不再透传 Cookie/Authorization/Set-Cookie/Location。全面 CSP、预览对外联网限制未实施，保留建议；F2 需先补。 |
| S2 容量与截断 | 部分处理 | 后端保留 oldest/current/truncated，M2-B 会补拉或重载，并处理 ready 序号低于本地的重置。任务/候选记录及磁盘 JSONL 仍无总容量上限、分页或 epoch；继续作为建议，不据此宣称已完成长期容量治理。 |
| S3 Selection/git 环境 | 部分处理 | `work/repo.ts:12`–`:18` 清除 GIT_* 宿主变量，禁用全局/系统配置及 hooks；主作品仍显式绑定独立仓库。完整 Selection 类型、列/标签真实性、主线祖先要求仍未补。候选 git 仍依赖 cwd/.git 发现，不将其描述为绝对仓库身份验证。 |

### 新发现及未关闭问题

#### F1 · 阻断：src/public 根目录链接未检查，Git 合并仍可写到作品之外

- 位置：`apps/server/src/work/repo.ts:118`、`:133`、`:138`、`:168`、`:223`、`:233`。
- 问题：`assertNoLinks` 从 `walk(base/src)`、`walk(base/public)` 开始，只检查其子项，不检查这两个目录自身。如果 src 是指向外部空目录的 junction，readdir 为空，检查直接通过。这不是必须抢在检查之后换目录的竞态。
- 证据：用快照方法的虚拟文件系统探针确认根目录没有被 lstat/realpath 检查。另在系统临时目录建立完全独立的 Git 仓库，候选新增 `src/new.ts`；主作品将 src 换为指向空外部目录的 junction，按现有 snapshot 的 `add -u` 提交旧源码删除，再 merge 候选。实际得到 **merge=ok、outsideWritten=true、rootIsLink=true**。未操作项目作品仓库，临时 fixture 已清理。此证据证明被漏掉的路径确能被 Git 写穿，不是声称模型工具能创建 junction。
- 影响：快照、创建候选、采用/回退之前“作品树无链接”的保证不成立，仍不能关闭 D2。`commitCandidate:205` 也应有候选树检查，而非仅依赖工具写入检查。3D 路由目前只共用互斥，SceneService 自有逐段 lstat 检查；未发现普通 junction 可直接绕过该检查，但尚未统一为真实落点策略。
- 修法：进入每个 src/public 根之前，校验根自身的 lstat、realpath 和预期落点；缺失目录与链接目录分别处理。统一覆盖 init/快照/建候选/候选提交/采用/回退，以及 3D 配置写回、撤回和资产发布目标的路径检查。补根 junction 指向空目录的真实回归，断言外部无文件、git/状态未改变。再次检查可缩短竞态窗口，但不要承诺可防御任意本地进程换目录的 TOCTOU；若要该保证须增加 OS 隔离/句柄约束。

#### F2 · 应修：预览监听器没有 Host 白名单，允许 DNS rebinding 读取作品源码

- 位置：`apps/server/src/work/preview-origin.ts:9`–`:19`、`:35`。
- 问题：HTTP 路径只检查方法和前缀，然后把 Host 改为 loopback 转交 Vite，绕过 Vite 自己看到的原始 Host；升级路径又把未经验证的 incoming Host 直接作为允许 Origin 的依据。
- 证据：独立本机 HTTP fixture 用假的上游源码哨兵；以 `Host: evil.example`、`Origin: http://evil.example` 请求预览源码路径，实际返回 **200 和哨兵内容**。服务器均已关闭，没有读取真实作品文件。攻击域名重绑定到本机预览端口后，读取是浏览器同源行为，`Access-Control-Allow-Origin: studioOrigin` 不能阻止它。
- 影响：任意外部网页可尝试读取作品/候选及允许依赖范围内的源码；升级时也可符合当前 Host 派生的检查。本项没有证明能越过 3001 的 Host/Origin 防护去写入或付费，不能与原 B1 混为一谈。
- 修法：HTTP 和 upgrade 入口统一校验可信 Host（默认仅 loopback，其他显式配置）；Origin 对比配置的 Studio/preview origins，不从未验证请求头构造信任值。补恶意 Host 的 GET/HEAD/WS 拒绝及合法 HMR 对照。

#### F3 · 应修：已有干净版本库可跳过跟踪路径审计

- 位置：`apps/server/src/work/repo.ts:81`–`:90`、`:96`–`:110`、`:137`–`:143`、`:166`–`:172`。
- 问题：审计在 stage 内，但已有仓库 init 不调用审计；snapshot 只有 status 非空才 stage。若旧版本已跟踪假 `.env` 等不允许文件、当前恰好干净，snapshot 正常返回，createCandidate 可从这个版本复制它。
- 证据：快照方法探针令 status 为空、将 stage 改为遇到调用即记录并拒绝，snapshot 仍成功且 **audited=false**。未读取任何真实环境文件。
- 影响：R1 的“拒绝已有危险跟踪内容”仅在有改动时成立；等到 commitCandidate 拒绝已经晚于候选文件产生。历史 base 提交同样需要审计，不能只看工作区待暂存状态。
- 修法：将当前 tracked/index 及待创建候选的目标提交树审计独立出来，在启动、返回快照版本及创建候选前无条件执行；发现不允许路径/链接则拒绝并要求人工迁移。补已有干净仓库含假敏感文件的回归。

#### F4 · 应修：事件日志初始化早于实例锁，退出时又晚于锁释放

- 位置：`apps/server/src/app.ts:43`–`:44`、`:68`、`:175`；`work/service.ts:58`–`:60`、`:297`–`:304`；`events.ts:18`–`:22`。
- 问题：第二实例先读取/可能 truncate 共享 events.jsonl，随后才尝试获取 work 数据锁。即使最终锁失败，也已进入破坏性修复阶段；退出时 work.close 先释放该锁，资产关闭仍可能通过 `assets/service.ts:168` 发布 SERVICE_STOPPED 事件，events.close 更晚。
- 影响：日志修复及最终发布不完整地处于单持有者边界内。启动与追加交错可能删掉有效尾部；新实例若在旧实例最后发布前读取高水位，仍有序号冲突风险。此项依据生命周期静态顺序，未对 Pi 的数据目录实施竞态或截断攻击。
- 修法：由应用层在任何共享日志读写/修复前获取 work-data 锁，持续持有到所有事件生产者停止、日志关闭之后；失败初始化也按相反顺序释放。补第二实例启动期间日志完全不变，以及优雅停机最后事件与下一次启动序号连续的测试。

### 验证范围

本轮从 c93286f 读取实现，未改实现/测试，未读 `.env`、真实资产索引或调用真实模型。使用内存探针检查日志持久化、路径根检查与干净快照审计；独立临时 Git fixture 验证根 junction 写穿，独立短时 HTTP fixture 验证预览 Host 边界；还核对了 diff 的 React 文本转义。没有启动完整项目、重跑构建/整套测试，也没有声称已替 Pi 完成迁移后浏览器验收。F1–F4 关闭并经 Pi 回归后再复核。

## 复核（第二轮整改）

- 日期：2026-11-13。范围：**fix/m2-review2，cc9ea12**（a4523e8、6c59abf、5eff38a、8cc8e55、cc9ea12），包含 master 的 **92ec0c9**。分支尚未合并；下列行号对应 cc9ea12，不能当成当前 master 的运行验收。
- **结论：仍不通过，不能转为“通过”。** 本轮剩余 **阻断 1、应修 2**：F1 的常规路径已补齐，但启动冲突恢复仍可越界写；F3 有制表符文件名解析遗漏；F4 未覆盖所有初始化失败与清理失败路径。F2 可关闭。界面 R1 的剩余问题见 M2-B 报告第二轮复核。

### 逐项核对

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| F1 可写区域根链接 | **部分修复** | `work/repo.ts:134`–`:161` 已检查 src/public 根自身及全部后代；snapshot `:166`、createCandidate `:197`、commitCandidate `:236`、adopt `:254`、revert `:264` 均在相关 Git 操作前调用。`scene/service.ts:27`–`:42` 逐段核对 lstat 和真实落点，覆盖配置写回/撤回/待完成配置恢复，以及 `:137`–`:146` 资产采用的模型与部件元数据目标。src 或 public 链接位于实际写入路径时会拒绝；不要求场景只写 src 时无条件拒绝一个不相关的 public 链接。**遗漏了 init 的 merge/revert abort 恢复写入，见 N1。** |
| F2 预览 Host/Origin | **已修复** | `work/preview-origin.ts:18`–`:26` 要求白名单主机名及本监听端口；`:22`–`:23`、`:51` 的 WS Origin 仅来自配置的 Studio/白名单预览 origins，不再信任任意 Host 推导值。独立短时 HTTP/WS fixture 的边界检查结果见下表，没有发现请求目标或升级绕过。 |
| F3 无条件树审计 | **部分修复** | `work/repo.ts:91` 在 init 末尾审计，`:171` 在每次 snapshot 返回前审计，`:198` 在检出候选前审计指定 base；不再依赖 dirty 状态。120000 链接、160000 子模块及普通敏感路径会被拒。`-z` 记录切分方向正确，但文件名中的额外 tab 被截断，见 N2。 |
| F4 日志实例锁 | **部分修复** | `app.ts:47`–`:51` 先取 work-data 锁再读日志；WorkService 使用 lockHeld 不重复加锁；正常关闭 `:182` 在 work/assets/scene/日志全部停止后释放锁，原启动/退出顺序问题已修。events.init 抛错也会释放。**但构造器、插件注册及清理函数抛错没有统一 finally，见 N3。** |

### F2 请求边界验证

直接从该分支读取并内存转译预览监听器，用独立 loopback 假上游提供无秘密哨兵。使用原始 HTTP 请求行/头，避免客户端自动规范化掩盖边界；全部 fixture socket/server 已关闭。

| 输入 | 实测结果 |
| --- | --- |
| `127.0.0.1:<实际端口>`、`LOCALHOST:<实际端口>`、`[::1]:<实际端口>` | HTTP 200（IPv6 项验证的是 Host 写法，连接实际仍走 IPv4） |
| 显式配置的 `studio.test:<实际端口>` | HTTP 200 |
| 外来域名、错误端口、非默认监听端口下省略端口 | HTTP 403 |
| `localhost.:<端口>`、展开式 `[0:0:0:0:0:0:0:1]:<端口>` | HTTP 403，保守拒绝，没有因此放开外来地址 |
| HTTP/1.0 且无 Host | HTTP 403 |
| 绝对 URI 请求行，Host 合法，目标为恶意域名或 loopback | HTTP 404，不转发该形式的请求目标 |
| WS 同时带恶意 Host/Origin；合法 Host 但恶意 Origin | 连接关闭，上游没有收到升级 |
| WS 合法预览 Host/Origin，`/preview/main/hmr` | 101，上游仅收到这一次合法升级 |
| WS 使用绝对 URI 请求行 | 连接关闭 |

未发现所列 IPv6、大小写、尾随点、无 Host、HTTP/1.0、绝对 URI 或升级路径的 fail-open。普通 HTTP GET 仍可接收合法 Host 下的其他 Origin，响应的 ACAO 只允许 Studio；这是依靠浏览器 CORS 阻止跨源读取，并非声称服务器会拒绝每一种外来 Origin 的 GET。已配置域名属于操作者显式信任范围。

### 剩余问题

#### N1 · 阻断：启动时自动 abort 冲突仍可沿根 junction 写到外部

- 位置：`apps/server/src/work/repo.ts:68`–`:91`，尤其 `:87`、`:88`。
- 问题：init 在任何 assertNoLinks 之前执行 `git merge --abort`、`git revert --abort`。这两条恢复命令可能重新写作品文件，不能当成只清理 Git 元数据。正常采用、回退入口的检查无法保护下一次启动的恢复入口。
- 实证：在系统临时目录创建完全独立的作品仓库（separate git-dir，结构与 WorkRepo 一致），造一次 src/file.ts 合并冲突；随后把整个 src 换为指向空外部目录的 junction，再直接执行**该分支 WorkRepo.init()**。结果 **init=accepted、outsideWritten=true、MERGE_HEAD 已移除**，外部 file.ts 被恢复为主线内容。没有改项目作品仓库或 Pi 的数据，fixture 已清理。
- 影响：无需检查后的竞态，也无需模型能创建链接；有待恢复 Git 状态和预先存在的根链接即可在启动时写出作品目录。F1 的执行边界仍未闭合。
- 修法：在 init 中任何可能改作品文件的初始化/恢复步骤之前检查作品可写树；发现链接时保留 Git 冲突现场，拒绝恢复，不要先 abort 再报错。恢复过程和普通采用/回退共用路径策略。补“冲突 → src/public 根 junction → 重启”的真实 Git 回归，断言外部文件和冲突状态均未改变。原有本地恶意进程 TOCTOU 限制仍不因此消失。

#### N2 · 应修：ls-tree 文件名中的 tab 被截断，整树审计可错误放行

- 位置：`apps/server/src/work/repo.ts:104`–`:109`。
- 问题：`-z` 保留文件名原字节，记录中只有第一个 tab 是元数据与路径分隔符；`line.split('\t')` 后只取第 2 项会丢掉文件名剩余部分。例如 Git 树路径 `src/ok.ts<TAB>credential.pem` 实际只按 `src/ok.ts` 做 permitted 检查。
- 证据：对该分支真实 auditTree 方法注入符合 `ls-tree -r -z` 格式的结果：普通 `src/key.pem` 被拒，带上述 tab 的路径却被接受；带空格、换行的路径按目前允许清单被拒。不是声称这些路径都应支持，而是它们必须以完整名字被检查/拒绝。
- 影响与限制：当前 Windows 常规文件 API 不支持此类控制字符文件名，本轮没有证明可据此在 Windows 检出或泄露凭据；但旧仓库/外部导入的 Git 提交树可以携带该名字，审计的“完整路径检查”本身已被绕过，不应依赖后续 checkout 偶然失败补救。
- 修法：按第一个 tab 的索引切分，剩余整段作为路径；元数据按固定结构校验，路径按当前规则整体拒绝控制字符。错误信息也用完整且可读的转义路径。补 tab/newline/space 以及链接、子模块的树记录回归，保留 `-z`，不要改成按行读取。

#### N3 · 应修：获取锁后的构造/注册失败仍漏释放资源，清理异常也会截断后续释放

- 位置：`apps/server/src/app.ts:48`–`:77`、`:182`；可触发的构造校验位于 `assets/lux3d.ts:11`–`:17`。
- 问题：events.init 有 catch，但其后的 SceneService/AssetService/Lux3DClient/WorkService 构造不在总 try 内；`new Lux3DClient` 的非法 URL/非 loopback HTTP 校验会在 `:75` 的 try 之前抛错。`app.register(websocket)` 等后续初始化也不在这个保护区。现有 catch 和 preClose 又串行 await 清理，没有 finally，前一个 close 抛错会跳过日志和实例锁释放。
- 证据：内存运行该分支 createApp 和真实 Lux3DClient 校验，文件/服务对象使用无 I/O 替身；输入假 key 与 `base=http://192.0.2.10`，得到预期 HTTPS 配置错误，但 **heldAfterFailure=true、release 调用数=0**。没有发出网络请求或创建真实锁文件。即使构造失败不启动服务，也必须归还已取得的实例锁。
- 影响：调用方若捕获初始化错误后在同一进程修配置重试，会误遇 INSTANCE_LOCKED；其他初始化/清理异常还可能保留已启动服务。若整个进程退出，下次启动可按死 PID 接管，这不等于 createApp 的失败路径已正确释放。
- 修法：从获取锁后到完整初始化结束使用统一的资源所有权 try/catch/finally，逐个记录已创建/已启动对象；失败或关闭时停止所有事件生产者、关闭日志，再释放锁，单个清理失败不能中断其余清理；保留首个错误或聚合清理错误。若无法确认生产者已经停止，应保持失败关闭并终止/拒绝重启，不能解锁后让旧生产者继续写。补非法 base 构造失败后立即重试，以及注入 work/assets close 失败后其余清理仍执行、没有存活生产者的回归。

### 本轮验证边界

只读取 master/整改分支快照，最终只追加两份报告。未改实现、测试或主作品，未读取 key/真实索引，未接触 Pi 服务。执行了独立临时 Git 恢复复现、独立短时 HTTP/WS fixture、内存 auditTree/构造失败探针；未重跑构建、全套单测/E2E，也未替代 Pi 在最终合并树上的回归。关闭 N1–N3 后再复核。

## 复核（补修）

- 日期：2026-11-13；快照：**d79c467**（fix/m2-review2，基于已合并的 81558a7）。以下行号对应该快照，补修尚未合并 master。
- **结论：原 N1 阻断、N2 解析问题可关闭；N3 的构造/注册失败清理已修，但正常停机仍未等作品操作队列排空，见新增应修 N4。M2-A 整体调整为“有条件通过”，尚不能转为“通过”。** 另有 Pi 已实测的 D3/R6 强杀后残留预览进程，本提交未改预览生命周期，不予关闭。当前剩余应修为 N4 和 D3，已知阻断不再因本轮 N1 保留。

### 逐项结果与证据

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| N1 启动恢复先查链接 | **已修复** | `work/repo.ts:89` 的 assertNoLinks 在 merge/revert abort 之前。重新执行上一轮完全独立的临时 Git 冲突 + 根 src junction fixture，并调用该快照真实 WorkRepo.init：得到 **UNSAFE_WORK_TREE、外部目录为空、MERGE_HEAD 仍存在**。没有使用项目作品仓库；移除 fixture 链接后清理临时目录。 |
| N1 其他启动/恢复入口 | 未发现另一条相同越界写路径 | `WorkService.init():63` 先完成 repo.init，随后 `:69` 才 recoverIntent；该意图恢复只校验 HEAD、更新任务/采用记录，或清理候选目录，不重放正式作品 merge。无主候选清理限于数据目录内候选及其依赖链接；不属于正式作品写回。snapshot `repo.ts:172`、建候选 `:203`、候选提交 `:242`、采用 `:260`、回退 `:270` 保留检查；SceneService 的 pending 配置恢复仍走 safeWorkPath。新仓库 init 的 stage/commit 写的是版本库，不在检查前恢复正式源码。保持原有“数据目录由本机操作者信任、非 OS 级 TOCTOU 隔离”的边界。 |
| N2 ls-tree 记录解析 | **已修复** | `work/repo.ts:106`–`:116` 用第一个 tab 分隔元数据与完整路径；检查 mode/type/object 的文本格式，并拒绝控制字符；报错 JSON 转义完整路径。内存执行真实 auditTree：正常 src/ok.ts 通过，tab/newline/space 路径、120000 链接、160000 子模块及坏元数据全部拒绝。空格路径被现有允许清单拒绝，不是宣称支持任意文件名。 |
| N3 初始化异常覆盖 | **原缺口已修复** | `app.ts:59` 的 try 覆盖 EventLog 初始化、后续服务构造/init、`:91` 的 websocket 注册及全部路由/钩子注册；对象创建后即登记 close。内存运行真实 createApp 和 Lux3DClient 校验，对构造失败、work.init/asset.init/插件注册/路由注册失败分别注入，均执行已登记资源的逆序清理并释放 work-data 锁。假 key，无网络/真实锁文件。 |
| N3 清理顺序与异常 | **部分修复** | 所有权列表的正常顺序确为 work → assets → scene → events → unlock；注入 work.close 拒绝后，后面的关闭函数仍被调用，正常 close 返回首个错误。初始化失败保留最初错误。**但“调用过 work.close”不代表已接受的作品操作全停，见 N4；该顺序不能单独证明 F4 在并发停机时成立。** |
| M2-B R1 重试遗漏 | **已修复** | 公共 submit 和 retry 按钮均检查 submittable；具体 handler 探针及界面结论见 M2-B 本轮复核。 |

### N4 · 应修：preClose 在作品队列未排空时关闭日志、释放实例锁

- 位置：`apps/server/src/app.ts:51`–`:57`、`:196`；`apps/server/src/work/service.ts:54`–`:56`、`:299`–`:306`；`apps/server/src/work/repo.ts:35`–`:39`；`apps/server/src/events.ts:55`。
- 问题：closeAll 挂在 Fastify 的 preClose 阶段，早于 HTTP server 等待已接收请求完成。WorkService.close 只等 Agent 的 taskQueue/writes、停止预览，没有等 repo.exclusive 的作品操作队列；version/adopt/revert 及场景路由可能已经被接收，仍在该队列等待。closing 也没有在这些入口阻止继续调度。scene.idle 只能等已进入 SceneService 的操作，不能代替排空尚在外层作品队列中的请求。
- 实证：内存运行本提交真实 WorkService 与真实 WorkRepo.exclusive，先用一个可控操作阻塞作品队列，再调用 work.version 排队；**work.close 在该 version 之前返回**。模拟 closeAll 随后关日志、释放锁，再放行队列，真实 version 实现继续 snapshot 并发出 **version.changed，lockHeld=false、logClosed=true**。文件 head/snapshot 使用无 I/O 替身，未改实际作品。另核对本地 Fastify 代码：preClose 完成后才调用 HTTP server.close 等待连接关闭；该阶段不是请求已排空的保证。
- 影响：旧实例可以在失去 work-data 锁后继续改作品、写事件；EventLog.close 只清订阅，不拒绝 publish，因此 F4 所要防止的跨实例高水位/写入交错仍可能出现。它是既有关闭屏障的遗漏，不是本次 N1/N2 修法引入的越界回归。
- 修法：关闭分阶段执行：先停止接受/调度新作品操作，再等待已接收 HTTP handler、Agent 队列、repo.exclusive 作品队列及场景队列结束，然后停止其余事件生产者、关闭日志，最后释放锁。可以使用请求排空之后的关闭阶段配合显式队列屏障，注意先妥善关闭 WS，避免等待连接造成死锁。异常时仍要清理其他资源；无法确认生产者停止时不能无条件释放锁并允许第二实例写入。
- 回归要求：阻塞一个实际写回/采用或产生自动快照的请求，随后启动 app.close；在操作完成前第二实例必须拿不到锁，结束后日志最后序号与重启后的序号连续，且 close 返回后无作品/事件写入。补清理函数失败时的同类边界；本轮没有运行真实 HTTP 并发停机用例，不将内存 probe 说成 E2E。

### R6/D3 状态更正与本轮边界

Pi 后续在 81558a7 上实测了强杀后预览进程未回收（D3）。此前本报告依据 IPC 接线把 R6 标成“已修复”，该静态判断不足以覆盖其真实强杀场景，现以 Pi 的实测缺陷为准，**R6/D3 保持未关闭**。d79c467 未修改 preview/worker，不将本轮通过的启动链接检查或所有权清理作为 D3 已修证据；另一个修复分支须单独回归、复核。

本轮只追加两份报告。未改实现/测试或主工作树的作品，未操作 Pi 服务，未读取凭据/真实索引，也未调用模型。独立临时 Git fixture 和内存故障/handler 探针已结束；未运行构建、完整测试套件或强杀预览验收。补修合并后仍需 Pi 回归，M2 真实模型成功率验收也未由本次代码审查替代。
