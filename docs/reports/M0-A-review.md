# M0-A Lux3D 调用跑通 · Codex 审查报告

- 日期：2026-11-09。
- 结论：**有条件通过**。导入、压缩、独立部件保留和幂等主路径具备继续验收的基础；没有发现当前实现会自动重复付费提交或将后端密钥送到前端的路径。恢复与下载生命周期存在 3 项应修，修复并经 Pi 回归后再最终收口。
- 分级：**阻断 0，应修 3，建议 4**。
- 范围：`d6bd268`、`fa51019`、`a269f1c`、`8cc5743`、`e44bc88`；实现、单元测试、README 和实现报告均从 `git show e44bc88:<path>` 读取最终快照。Pi 的 `35af89a` 及主工作树正在改动的测试不纳入 M0-A 评价；未读取 `.worktrees/m0b-fix`。
- 以下文件行号均对应 **e44bc88**。本次只新增本报告，没有修改实现、测试、既有证据或项目记忆，没有创建提交。
- 未读取或打印 `apps/server/.env`，未读取真实 `.data/assets/index.json`，未调用真实 Lux3D。探针均使用虚拟索引、内存输出、假密钥或本机短时 HTTP 服务。

## 阻断

无。未发现应立即禁止当前单进程本机导入演示的计费、密钥或参数路径逃逸问题。本结论不等同于生产环境安全审计，也不将尚未执行的 Pi 浏览器验收算作通过。

## 应修

### R1 · 崩溃遗留的 model.glb.tmp 会永久阻断该资产的处理重试

- 位置：`apps/server/src/assets/process-model.ts:97`、`:98`、`:103`；恢复入口 `apps/server/src/assets/service.ts:53`、`:169`。
- 问题：输出采用固定临时文件名并以 `open(..., 'wx')` 排他创建。进程若在创建后、rename 前退出，会遗留临时文件。下次执行仍打开同一路径，得到 EEXIST；open 位于 try 之前，不会进入本函数的清理分支。失败后重新导入还是相同路径，无法恢复。
- 为什么要修：原子发布避免了半成品覆盖正式模型，但没有处理“上一次未完成的临时文件”。这会使文档承诺的重启恢复/按原任务重试失效；服务只返回通用处理失败，用户也不知道需要清理什么。
- 证据：使用快照处理函数、真实拆分样本和内存文件系统适配器。首次处理成功；预置输出路径的 `.tmp` 后再处理，得到 `EEXIST`，临时文件仍存在，旧正式输出保持不变。此探针验证恢复分支，不是对真实进程强杀或 Windows rename 的实测。
- 修法：为每次处理使用唯一临时文件名，确保本次失败时只清理自己的临时文件；并在单进程启动恢复时安全清理不再使用的残留。也可在确认无运行中同资产任务后回收固定临时文件。不要直接去掉排他标志而引入并发覆盖。Pi 增加“遗留临时文件 → 重启/重导入 → ready”的回归，同时验证原正式文件在失败时保持完整。

### R2 · 下载只有空闲超时，没有总时限，也不接受服务停止信号

- 位置：`apps/server/src/assets/download.ts:23`、`:38`、`:56`；`apps/server/src/assets/service.ts:147`、`:157`、`:173`。
- 问题：HTTP `timeout: 60_000` 约束连接空闲；对端持续少量发数据就可一直续期。DNS、全部重定向和响应体没有共同的总时限。Service 的截止时间只在轮询顶部检查，进入下载后不再检查；`close()` 的 AbortController 没有传给下载，随后还会等待 jobs 完成。
- 为什么要修：模型 CDN 异常或慢速响应可使资产长时间停在 downloading，重复导入又因已有 job 被直接复用，关闭服务也可能一直等待。100 MiB 是大小上限，不能保证下载在有限时间结束。这里不是要求把生成的 15 分钟轮询预算强行套给整个模型转换，而是要求下载阶段有独立的结束条件。
- 证据：加载快照下载函数，只在 HTTP 适配层把空闲超时从 60,000 ms 缩为 100 ms；本机服务每 20 ms 发送小块 GLB 字节。下载耗时约 665 ms 后成功，明显超过空闲超时而未被终止。结合没有总计时器/传入 signal 的代码可确认该缺口；未运行分钟级慢下载。
- 修法：给下载增加独立总预算及 AbortSignal，覆盖 DNS 等待、连接、重定向和读取响应体；跨重定向沿用剩余预算，不每跳重置。由 service 将停止信号传入，取消时销毁 request/response 并清理临时文件；上游查询也可接收同一停止信号。Pi 增加持续滴流、DNS/重定向预算和下载中 close 能及时返回的用例，且不得在取消/超时后补发付费创建请求。

### R3 · ready 模型文件丢失后，按界面提示重新导入不能修复

- 位置：`apps/server/src/assets/service.ts:111`；`apps/server/src/app.ts:71`；前端恢复相关 `apps/studio/src/AssetPanel.tsx:8`、`:14`。
- 问题：模型 GET 检查到文件丢失时返回 `MODEL_MISSING` 并提示“请重新导入资产”；但 importTask 对 ready 记录直接返回，不检查模型文件，也不重新查询/下载。init 同样不会检查 ready 文件是否存在。
- 为什么要修：索引与文件分开保存，目录移动、文件清理或磁盘故障后可能留下 ready 记录。此时用户按错误提示操作也无法恢复，必须手工改索引；这不是重复计费问题，但会卡住模型预览。
- 证据：虚拟索引中保留已完成远端资产、没有物理模型文件；调用快照 importTask 后仍返回 ready，上游查询增量为 0。GET 侧缺失检查及提示为静态核对，没有将此探针描述为完整 HTTP/浏览器验收。
- 修法：ready 的快速返回前确认正式模型可读，缺失时重新使用原 taskId 查询下载；或提供明确的修复/强制重新导入入口，保持不创建新付费任务。前端 ModelErrorBoundary 只按资产 id 重置，同 id 重试也需重置错误状态，并检查 useGLTF 对失败 URL 的缓存；可清缓存或使用模型修订号更新 URL。Pi 验证“索引 ready、模型不存在 → 同 taskId 导入 → 模型 GET 200 → 画布恢复”，并断言 creates 不增加。

## 建议

### S1 · 将 crash、下载安全和请求协议补成可长期运行的回归

- 位置：`apps/server/src/assets/service.test.ts:30`、`:50`；`apps/server/src/assets/mock-server.ts:21`；`apps/server/src/app.test.ts:9`。
- 问题：幂等测试的“重启”发生在任务 ready 后；未知结果用一次拒绝的 spy 模拟，没有覆盖提交后响应丢失、taskId 写盘失败或输出临时文件残留。mock 创建路由忽略请求体和鉴权，错误的 outputFormat/Authorization/body 也能成功；现有下载安全测试只直接覆盖一个 loopback URL。
- 影响：现有测试有实际断言，并非整体空转，但“20 项通过”不足以推出这些失败窗口均安全。服务测试用假的 process，不检查正式模型是否存在；app.test 使用真实处理和模型 GET，补上了正常链路的一部分，不能覆盖 R3。
- 修法：让 mock 记录或校验假 Authorization、version、prompt/img、outputFormat，并增加响应丢失/中断场景；补 DNS 私网混答、IPv6、重定向到私网、超限、截断 GLB、写盘失败和 R1–R3 的回归。所有断言使用专用假密钥，不读取真实 `.env`。每个测试隔离数据目录。

### S2 · WebSocket 序号不持久化、无事件补拉，应在任务事件接入时补齐

- 位置：`apps/server/src/assets/service.ts:38`、`:75`；`apps/server/src/app.ts:35`；`apps/studio/src/AssetPanel.tsx:47`、`:52`。
- 问题：asset.progress / asset.ready 有 ts/sequence，但 sequence 重启归零，服务不保存事件历史；ready 握手也不是带序号的资产事件。与开发文档“按最后序号补拉”的完整协议有差距。
- M0 判断：**不要求为本次资产状态展示立刻实现事件日志**。UI 每 3 秒 GET 列表能恢复资产最新状态，实现报告也明确披露了此限制；代价是没有中间事件的可追溯历史。
- 修法：在 M2/M3 的任务步骤、请示和检查依赖事件追溯之前，统一持久事件序号、重连补拉和快照/事件衔接；不要直接沿用本进程内序号作为长期游标。

### S3 · 补充下载来源配置及上游 HTTP 配置的约束

- 位置：`apps/server/src/assets/download.ts:19`、`:26`；`apps/server/src/assets/lux3d.ts:14`。
- 现状：下载限制公网 HTTPS，并非 Lux3D/CDN 域名白名单；DNS 检查、地址固定及每跳重新校验有效降低私网访问和 DNS rebinding 风险。HTTP 下载仅对配置的 loopback mock 放行。未发现靠请求参数覆盖 mockBase 的入口。
- 建议原因：客户端的 LUX3D_BASE 则允许任意主机使用 HTTP；若配置错成公网 HTTP，会明文发送 Authorization，虽然默认 HTTPS 且没有远端用户可修改该配置的接口。自写公网地址规则还需随部署需求维护。
- 修法：将上游 HTTP 也限制到显式本地 mock；对真实输出的已知 CDN 可提供可配置的域名及端口白名单，并保留 DNS/IP 和重定向检查。不要为了白名单猜测当前 CDN 域名或删除已有防内网逻辑。此项为配置加固，没有将它认定为当前真实密钥已泄露。

### S4 · 保留部件后的稳定命名、体积验收和转换隔离仍需落实

- 位置：`apps/server/src/assets/process-model.ts:56`、`:83`、`:93`；`apps/server/src/assets/service.ts:169`。
- 现状：按当前顶点数设简化比例，误差上限逐轮提高，达不到 <100,000 顶点就失败；没有将部件 join/flatten。输出大小有指标但没有统一 <3 MB 的验收门槛；转换在后端进程内执行，100 MiB 输入上限也不等于图像解码或几何处理中内存/耗时的上限。
- 影响：本次真实拆分样本保留独立节点，但它们仍无 body/lid/reed 稳定名字，不能直接用同名的 asset-normalization 包装节点作为部件标识。对更大、多贴图资产，当前两份样本的数据不能代表体积和转换时延始终达标。
- 修法：M1 给部件添加稳定命名或元数据，明确场景配置 offset 的坐标系/缩放；加入分部件移动的回归。按任务卡确定超出体积目标时是失败还是提示，避免无条件标为适合网页。需要处理更大输入时，将转换放入可限时终止的 worker/子进程，并对资源规模设限。

## 七项重点核对

| 重点 | 结论与证据边界 |
| --- | --- |
| 密钥去向 | 环境读取在 `app.ts:15`；客户端私有字段用于 Authorization，下载请求不携带 key。源码扫描只在后端 app/lux3d 文件发现 LUX3D_API_KEY 名称，无前端引用。上游网络异常、HTTP 500、坏 JSON、拒绝 envelope 四个假密钥探针均返回固定错误，不包含假密钥。服务只把 AssetError 的既定 code/message 对外发送，其余异常转换为通用文本；请求自动日志关闭，没有显式记录上游 body/URL/key。未执行真实日志或前端 bundle 的实物扫描。 |
| 持久化及计费 | 提交队列串行，先写 submitting 和 keyHash/fingerprint，再调用 create；同键同参数返回旧记录，不同参数冲突。内存文件系统探针中并发两次只调用 create 一次，调用前索引已含 submitting；模拟崩溃残留 submitting 后重启转 submit_unknown，再用原键不会再创建。进程在 taskId 持久化前后两个窗口分别保守停在 unknown 或恢复查询，符合不确定时不重提的策略。JSON 串行 rename 仅保证单进程约定，不提供跨进程锁或断电 fsync 保证。 |
| index/响应内容 | RecordEntry 不含 API key、prompt 明文或输出 URL；含幂等键哈希、参数指纹、任务与状态/指标。publicAsset 去掉内部 hash/deadline；REST/WS 复用该结果。持久化证据采用虚拟索引，没有打印真实 index.json。原始输入只保留指纹，尚不满足完整任务输入追溯，M2 如需追溯应单独设计。 |
| 轮询和 URL 过期 | 默认 15,000 ms / 900,000 ms；0/1 等待，3 立即下载，4 failed，6 cancelled，其他状态报 UNKNOWN_STATUS。deadline 在查询前检查，单次查询有独立 30 秒预算，故不是精确到毫秒的 15 分钟硬中断。403/404 提示 OUTPUT_URL_EXPIRED，URL 不落盘，失败后 importTask 重新 getTask 取新 URL，不 create。part-split 创建用专用端点，查询复用 generate/task/get，符合本地接口调研。下载生命周期另见 R2。 |
| 下载与路径安全 | 默认 HTTPS、公网地址检查、固定已解析地址，最多跟随 3 次且逐跳检查；无 API key 转发。响应实际读入超过 100 MiB 就终止，验证 GLB 头/版本/声明总长。原始下载先 `.tmp` 后 rename；模型解析失败不发布半成品。id 正则拒绝路径分隔符，远端 taskId 在 API 与客户端限制为数字，正常输入链路未发现 :id 路径逃逸。init 对持久索引只验证 id，仍以本机索引可信为前提，不将手工篡改 taskId 的情形当作远端可利用漏洞。 |
| GLB/sharp 安全与错误 | 在调用 NodeIO 前检查 GLB JSON 的 buffer/image URI，非 data URI 拒绝；随后 readBinary 解码同一份已校验字节，避免检查文件与实际解码文件不一致。sharp/编解码/写盘异常被服务转换为 failed 和通用错误，未直接泄露路径/原异常。原子输出的异常清理不覆盖上次崩溃遗留，见 R1；没有执行恶意文件模糊测试。 |
| 接口/事件/复用测试 | 文生/图生二选一、版本与幂等键校验、导入、状态和模型接口齐全；新增列表接口用于恢复状态，返回本地资产 id 与远端 taskId。mock 可作为工厂导入，支持随机端口、fixture、7 种场景、creates/gets；app 工厂提供短轮询与独立数据目录，Pi 可不接真实 Lux3D 测试。事件名称与 AssetEvent 结构吻合，补拉差异见 S2。 |

## 多部件模型专项探针

对只读的 `fallback/lux3d-split-4969889.glb` 调用 **e44bc88 的 processModel**。使用现有已安装依赖，文件读取真实，输出 open/write/rename 接口以内存适配器替代，未向 fallback 或 .data 写入。

| 指标 | 本次探针 |
| --- | --- |
| 原始 / 输出字节 | 11,192,096 → **987,852** |
| POSITION 顶点 | 123,874 → **86,529** |
| 处理耗时 | 约 **403 ms**，不含网络 |
| 带 mesh 的节点 | **6 → 6** |
| 世界包围盒 min | `[-0.1714033511, 约 0, -0.1757641799]` |
| 世界包围盒 max | `[0.1714033511, 1, 0.1757641799]` |
| 独立移动 | 改变第一个部件节点的平移，其余 5 个部件的世界矩阵不变 |

因此这份样本没有被压成单一不可分部件，最大边为 1、底面中心为原点；可作为后续开盖链路的输入。探针没有按外观确认第一个节点是否就是 lid，也没有进行 WebGL 视觉对照或动画观感验收；稳定命名及实际“瓶盖 + 藤条”分组仍须 M1 完成。归一化增加包装节点，不能把“仍可独立操作”误解为“所有节点的局部坐标完全未变”。

## 验证边界及收口

本次执行了秒级内存探针：客户端错误脱敏、并发幂等及提交前持久化、submitting 崩溃状态恢复、ready 缺文件重导入分支、滴流下载、真实拆分模型转换/独立部件移动、遗留临时文件分支。代码均从 Git 快照读取并在内存转译；本机 HTTP 服务在 finally 中关闭。没有实际消费 Lux3D 额度。

没有重新安装依赖、启动项目开发服务、执行完整 pnpm build/typecheck/Vitest/Playwright，也没有重写 Pi 的测试或报告。实现报告中的“20 项通过”和浏览器视觉结果是实现方留存声明，本报告没有将它们冒充本次重新执行的结果。尤其未实测强杀恢复、真实 CDN 慢速下载、浏览器恢复缓存或磁盘损坏。

建议调度回派 R1–R3，要求 Pi 除正常 mock 导入、幂等及画布加载外覆盖上述三个恢复场景，再交 Codex 复核。S2 的完整事件补拉可随 M2/M3 实现；M0 当前采用快照轮询恢复资产状态的取舍已明确披露，不单独阻断本轮。

## 复核（整改回合）

日期：2026-11-09。对象：合并提交 **5275f7c**，包括 `67083df`、`b8af8ad`、`fc11845`、`a82958e`。以下新增行号均对应 **5275f7c**。实现、单测和交付说明均通过 Git 快照读取，没有使用 Pi 正在修改的测试，也没有读取 `.worktrees/n1-fix`。

**最新代码审查结论：可转为“通过”。** 本轮要求的 R1、R2、R3、S1、S3 均已修复；未发现新增阻断、应修或需另行登记的建议项。这里是本轮代码审查结论；Pi 正在执行的合并后正式回归仍是里程碑最终验收的一部分，本报告没有提前宣告其通过。原 S2 的事件补拉及 S4 的命名/体积门槛/转换隔离继续按 M2、M1 的既定安排落实。

### 逐项复核

| 原项 | 状态 | 文件位置与证据 |
| --- | --- | --- |
| **R1 · 遗留 tmp 阻断重试** | **已修复** | `apps/server/src/assets/atomic-file.ts:6`、`:7`、`:14`：每次使用目标文件加随机 UUID 的独占临时路径；只有 open 成功才进入清理，finally 只 rm 该次路径。模型、raw 下载和索引均改用此函数。内存文件系统探针预置固定旧 tmp 与另一个任务的 tmp，发布和写入取消后两者均保留；本次取消没有发布正式文件，自己的临时文件已移除。未增加目录扫描或按通配符删除，旧残留不再阻断后续写入。 |
| **R2 · 下载总时限与停止信号** | **已修复** | `apps/server/src/assets/download.ts:26`、`:30`、`:43`、`:56`、`:103`：默认 120,000 ms 的同一个预算贯穿 DNS 等待、所有重定向、连接及响应体，结束时清 timer、销毁 response；停止信号通过 AbortSignal.any 合并。`service.ts:119`、`:173`、`:183`、`:201` 将停止信号传入创建、查询、下载及轮询，并等待提交队列和 jobs 收尾；`app.ts:76` 从 preClose 开始停止，避免只在 onClose 才取消。真实本机滴流探针使用 80 ms 预算，约 91 ms 得到 DOWNLOAD_TIMEOUT，未发布 raw；另一个下载中 service.close 探针约 1 ms 返回，记录变为 polling/SERVICE_STOPPED，重启可完成原任务。 |
| **R3 · ready 缺文件无法修复** | **已修复** | `apps/server/src/assets/service.ts:53`、`:93`、`:133`：启动及 ready 快速返回前检查模型是否为可打开的非空普通文件，缺失时允许重新 getTask、下载、处理同一记录；`service.ts:198` 为新发布结果生成 revision。探针中删除 ready 模型后重新导入：资产 id 不变、只增加 1 次查询、恢复 ready 和正式文件、revision 改变、creates 仍为 0。前端 `AssetPanel.tsx:29`、`:31`、`:71`、`:78` 以完整 URL 识别加载状态并重置错误边界，新 URL 绕过旧 URL 的加载失败缓存。此处前端是代码与实现方浏览器证据核对，本次未重新运行 WebGL 恢复验收。 |
| **S1 · mock 协议与故障回归** | **已修复（本轮任务范围）** | `apps/server/src/assets/mock-server.ts:11`、`:13`、`:32`、`:35`：关闭类型强转与额外字段删除，严格 raw Authorization、路由对应输入、版本、outputFormat、互斥字段和 part-split schema。新增 response-lost/truncated/drip。直接加载快照 mock 工厂做 inject：Bearer 假 key 得 401，错误 outputFormat 得 400，正确请求得 200，最终 creates 仅为 1。核对 download/recovery/lux3d/mock-server 单测，新增断言覆盖真实连接滴流/中断、提交后丢响应、taskId 写盘失败、旧 tmp、重启及缺文件修复，不再只对 happy path 或拒绝 spy 自证。完整 46 项单测未由本次复核重新执行。 |
| **S3 · 非本机 HTTP 上游配置** | **已修复（HTTP 配置限制）** | `apps/server/src/assets/lux3d.ts:14`–`:17`：HTTPS 之外只允许显式 loopback HTTP，带用户信息、query/hash 也拒绝。探针核验公网 HTTP、内网 HTTP、带用户信息及 query 的配置，4 个均在构造阶段拒绝，fetch 调用数为 0；loopback HTTP 正常接受。下载仍逐跳检查地址及固定 DNS，额外要求本地 mock 的解析结果确实为 127.0.0.1/::1。CDN 域名白名单未新增，仍沿用原审查允许的公网 HTTPS + DNS/IP 检查策略。 |

### 重点安全与恢复判断

**临时名不会通过清理误删其他任务文件。** `writeAtomic` 的 finally 只持有并清理本次成功创建的 UUID 路径；若 wx 创建失败，尚未进入 finally，也不会删除碰撞路径。成功 rename 后清理同名临时路径是无文件时的 force 操作。旧固定临时文件和旧 UUID 残留保留，未做无所有权依据的清扫。唯一临时名不提供正式模型或 index 的跨进程互斥，**本机单后端、CLI 不并发写同一目录**的既有约束仍有效；本轮不能被解释为已支持多进程幂等。

**停止与重启没有新增付费重提路径。** `service.ts:159` 在已知 taskId 的 job 被停止时保存 polling/SERVICE_STOPPED；`init():49`、`:60` 将没有确认结果的 submitting 转为 submit_unknown，将已有远端任务恢复为查询并重置查询窗口。只有 submit 的新幂等键路径调用 create；import、init 和恢复 job 均不调用 create。实测专项探针：

- 下载中停止后记录 polling/SERVICE_STOPPED；重启查询并处理原 taskId 到 ready，**creates 0 → 0**。
- 上游接受创建后断开连接，提交进入 submit_unknown；重建服务后用同一幂等键返回同一资产记录，**creates 保持 1**。
- 同步模型转换已经开始时仍等待转换返回，再检查停止信号、保存可恢复状态；不会因此调用 create。已进行中的文件写入也只在 await 返回后的检查点响应 signal，并非可强制终止的文件 I/O。网络等待的总预算与这些执行边界应分开理解，转换隔离仍属原 S4。

**过期 URL 的修复失败不会形成后台循环。** `service.ts:173` 每次显式修复先 getTask，获得 status 3 后只下载一次；403/404 转为 OUTPUT_URL_EXPIRED，由 job catch 保存 failed 并移除 job，不跳回轮询。探针模拟“ready 缺文件、最新 getTask 仍给出 403 URL”，结果为 failed/OUTPUT_URL_EXPIRED、查询增量 1、activeJobs 0、creates 0。前端定时器只 GET 资产列表，未自动调用 import。用户可再次手工查询原任务；没有自动新建付费任务，也没有因 URL 失败而无限重导入。

**revision 只用于缓存区分，不参与磁盘路径。** `service.ts:198` 的 revision 来自 randomUUID，`modelPath` 仍以经校验的本地资产 id 查记录，再使用其数字 taskId/本地 id 构造模型路径。`app.ts:70` 的模型路由只消费 `params.id`，query 中的 revision 不拼进文件路径。改变 revision 不能选取其他文件，也不扩大读取范围。`Cache-Control: no-cache` 保留；完整 URL 改变让错误边界重新挂载，并区分 useGLTF 的旧缓存键。revision 是缓存失效标识，**没有实现历史模型版本寻址**，旧 query URL 仍走同一模型文件路由。

### 测试有效性及本次验证边界

新增 `download.test.ts` 不仅检查异常类型，还检查未发布文件、旧正式文件保留、临时文件集合；`recovery.test.ts` 将状态、持久化内容、URL 变化、模型 GET 和 mock creates/gets 对账结合。taskId 写盘失败回归实际让磁盘索引停在 submitting 后重建服务，响应丢失回归使用断开的真实 socket；这些断言能覆盖原审查指出的失败窗口。未知结果仍需要人工确认/导入，没有把“未确认”伪装为可自动重试。

本次从 5275f7c 内存转译 atomic/download/service/client/mock 工厂，使用虚拟文件系统与真实本机短连接执行专项探针；service 状态探针的模型转换用明确的假处理器替代，故只证明状态、发布调用及 revision 流程，不证明本轮重新完成了 GLB 视觉验收。mock 工厂探针去掉文件末尾 CLI 启动段以便内存加载，工厂本体逻辑未改。临时 HTTP 服务在 finally 中关闭，未启动项目 dev server。

没有读取真实 `.env` 或 index.json、复制 key、请求真实 Lux3D、安装依赖、修改实现/测试、覆盖 Pi 证据，也没有运行整套 build/typecheck/test/e2e。实现报告的 46 项和浏览器恢复结果仅作交付证据核对，未冒充本次重跑。没有新增运行脚本或持久化测试产物。

**本轮审查可转“通过”；由调度结合 Pi 的合并后正式回归结果最终关闭 M0-A。** 任务号字符串 `"1e5"` 的既有观察项正在另一条已安排的修复中，本次未修改或把它当成新的整改回归；原 S2/S4 的后续任务边界保持不变。
