# M4：视觉、语音、备用资产与演示

状态：设计交审，尚未实现或验收。基线 master `276f0f9`（M3验收归档132a661，产品393fe9f）。Codex设计/集成，CodeBuddy独立工作树实现，Claude Code独立审查，Pi独立验收。用户已授权持续推进；本计划不授权新增真实付费调用、不代替真实凭据或参与者。

## 1. 目标与交付边界

依据 `../dev-doc-v0.1.md` 的M4、数据去向与可编辑转写要求，`../project-brief.md` 的五分钟演示和3–5人交替顺序对照测试，以及M3收口后的四条建议。旧压缩日程 `sprint-plan.md` 已作废，不缩窄原目标或倒推日期。

交付四块：外围全息视觉与可读性；按住说话→可编辑文字→原任务提交；可离线采用且明确标识的备用模型；演示脚本、可复现重置、对照测试材料与三次完整彩排记录。作品区保持不透明，模型/任务/检查显示真实状态，不能把录音、模型生成、候选检查或彩排替身伪装为真实服务成功。

M3准入已满足：501单测+174 E2E，独立审查无阻断/应修。M4保持M0–M3合同：分源预览、精确选择、未保存场景草稿、请示、四真实检查、失效证明与后端采用门禁、任务重试范围及N4关闭。不开任意shell/依赖安装/发布，不做任意网站导入或通用初版生成。当前Demo从既有香薰模板出发，脚本如实注明。

## 2. 分段与依赖

| 卡 | 内容 | 可独立推进 / 后继门禁 |
| --- | --- | --- |
| D1 | 后端语音适配、限额、取消与关闭 | 无真实key也能用本机mock完成；固定提交后交审 |
| D2 | 录音及可编辑转写、显式浏览器备用、来源说明 | 基于D1稳定接口；不能改变原任务提交语义 |
| D3 | 本地备用目录、资产来源与采用标识 | 独立于语音key；仅固定preset入口，不公开文件路径 |
| D4 | 外围视觉、响应式、布局护栏与无障碍 | 保留原画布像素合同；整合D2/D3后固定实现交审 |
| D5 | 演示/对照材料、隔离启动及彩排记录 | Pi先验收mock与完整回归；真实链路有凭据和授权后另跑 |

每卡独立提交，不把下一卡草稿混入当前受测身份。新实现树 `.worktrees/m4`、分支 `feat/m4-demo` 从交审后固定设计HEAD派生；不改旧实现/验收树。实现单测由CodeBuddy负责，独立E2E/正式断言由Pi负责，Codex不代写通过结果。

## 3. D1 后端语音合同

### 3.1 已核对的服务依据

2026-11-15核对阿里官方[Qwen-ASR API参考](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)及[模型选型](https://help.aliyun.com/zh/model-studio/asr-model/)。选择用户指定的 `qwen3-asr-flash`，用后端HTTP兼容协议、单段Data URI音频、`stream:false`，读取返回文字。音频仅作为音频输入，不传选择/源码/作品。官方示例支持WebM，地域与业务空间端点需匹配配置；不把历史公共端点当成凭据已有效的证明。

无需OpenAI SDK或音频转码新依赖，Node内置fetch足够。后端配置 `DASHSCOPE_API_KEY`、`SPEECH_BASE_URL`（完整兼容API base）、`SPEECH_MODEL`（默认上述模型）；不得借用编码服务key。配置只通过后端进程环境传入；不读真实.env做开发/测试，不写入Git。生产HTTPS且无URL用户名/密码/query/hash，服务端校验允许的阿里域名/业务空间子域名；拒绝重定向，不允许HTTP请求覆盖base/model/key。构造参数仅供内部测试允许固定loopback mock，不做HTTP注入后门。

### 3.2 HTTP、预算与生命周期

| 接口 | 合同 |
| --- | --- |
| GET `/speech/config` | 仅返回enabled、provider、model、支持MIME、maxBytes/maxDurationMs及安全提示；不返回key、base、路径或上游错误 |
| POST `/speech/transcribe` | raw音频body，限定 `audio/webm`（可带codecs=opus）、`audio/ogg`（opus）、`audio/wav`；必填UUID `X-Speech-Request-Id`，无URL/文件路径/模型字段；返回 `{ requestId, text, provider:'aliyun', model }` |

局部注册Fastify binary parser和4MiB `bodyLimit`，不放宽全站16KiB JSON限制。非音频/空body/超大body在任何上游请求前拒绝（400/415/413）；缺配置503 `SPEECH_NOT_CONFIGURED`；后端一次只允许一条转写，忙时429 `SPEECH_BUSY`，不排队暗中计费。配置查询缺key返回enabled=false，不能伪返回转写文字。

前端录音上限60秒、字节上限4MiB；后端不信任客户端duration，以上限字节和总35秒wall clock限制资源。无需解码就能确认的格式头做校验，格式损坏/不支持由适配器返回安全错误；不宣称仅MIME即可证明真实时长。上游响应限256KiB，text为非空字符串且≤4000字符（与任务指令上限一致），超限或协议异常失败，不静默截断指令。错误统一为安全码：`SPEECH_INVALID_AUDIO`、`SPEECH_UPSTREAM`、`SPEECH_TIMEOUT`、`SPEECH_CANCELLED`；不回显原始body/headers/上游message，界面不显示key或音频Data URI。

请求ID在进程内做最多32条、5分钟有界去重：同ID同bytes复用同一进行中promise/已结束安全结果，同ID不同摘要409；活跃项不能被LRU挤出后重复发送。缓存满且无可淘汰项拒绝新请求。重启不续跑、不重放；进程内去重不是跨崩溃exactly-once，界面明确“取消/断网不保证未计费”。一次用户动作只发一次上游请求，无SDK自动重试、失败回退或断网自动重传；明确重试是用户新动作。

请求断开、显式前端Abort、35秒预算或app关闭都取消fetch并等待该请求settle；停机先关准入、abort在途、等待全部生产者结束，再沿用既有closeAll顺序关事件日志/放锁。不得在close后发事件或返回成功。原始音频只在内存，完成/取消释放，不写磁盘、EventLog、任务记录、持久缓存或日志；转写只有用户提交任务时才进入既有任务存储。日志仅允许requestId、状态、安全码、耗时/字节量，不打印敏感payload。

### 3.3 文件与失败验证

新增 `apps/server/src/speech/{client,service,routes}.ts`及对应单测；`AppOptions`增加内部speech配置，`createApp`沿用现有Host/Origin/preClose/closers，不新开端口或锁。`apps/studio/vite.config.ts`补`/speech`反代并扩真实代理验证（不能只mock前端fetch）。共享类型放 `packages/shared/src/index.ts`；不更换现有依赖/锁。

先证明失败：格式/大小/空body、未配置、上游401/429/500/坏JSON/空文本/超长响应、请求ID并发/碰撞、取消后迟到成功、超时、close并发、外来Host/Origin、重定向和诱饵凭据不泄露。mock只loopback，用假key和合成音频，不加载后端真实环境文件。

## 4. D2 录音、编辑与提交

在PointSpeak增加独立 `SpeechInput` 与可测试录音控制器。状态为idle→requesting_permission→recording→transcribing→review或error/cancelled；每次会话递增token，旧权限promise/旧转写晚到不能覆盖新会话。按住按钮或Space开始、释放停止；键盘焦点局限于录音按钮，不劫持textarea空格。额外提供明确取消按钮，pointercancel/窗口失焦取消，60秒自动停止并提示上限。组件卸载、模式切换、页面隐藏释放所有MediaStream tracks、录音器、timer与fetch；权限晚到后发现会话已废弃也立即stop tracks。

浏览器API不支持、非安全上下文、权限拒绝、无麦克风时给出可读提示并继续文字输入。录音器MIME从服务支持集合与`MediaRecorder.isTypeSupported`交集选取，不能把不支持的格式改名冒充WebM。录音期间累计chunk体积，越界立即取消，不发送大包；transcribing期间不能开始第二段，不自动创建任务。

**文字保护**：开始录音记下当前指令revision和selection/baseVersion。识别文字先放独立review草稿，展示来源与“使用此文字”按钮；只有用户确认且未发生文字编辑冲突才填入textarea。已有指令被用户改动时，仍展示独立草稿并提供显式替换/取消，绝不覆盖新输入。识别完成不自动生成候选；原生成按钮、Ctrl/⌘+Enter、canSubmit、同步/影响模式/场景模式锁及STALE_SELECTION重选全部保留。录音/转写期间禁止任务提交，review确认后使用**当前**有效选择，旧选择不能被录音器偷偷恢复；基线变化提示重新点选。

按首次录音动作旁说明“录音会发送到阿里云百炼识别；转写需确认后提交”，提交任务处说明“指令、选中对象与必要源码发送到已配置的编码模型服务”，资产处说明Lux3D图片/提示词去向。产品文案不展示调试配置和内部实现术语。

浏览器Web Speech API是用户**显式选择**的备用方式，不在阿里失败后自动开启；先告知“由浏览器提供，可能发送到浏览器厂商服务”，无需/不能借用阿里key，结果同样进入review。浏览器不支持则只保留文字入口，不把其失败算阿里成功；测试无真实麦克风或厂商网络调用，分别标注录音API替身、loopback语音mock及文字降级覆盖。

建议testid：speech-record/cancel/status/error/review/use、speech-provider、speech-fallback；兼容现有instruction-input/generate-candidate，不重命名。单测覆盖状态机/迟到/编辑冲突/所有资源释放；Pi另写浏览器权限、录音HTTP链路与不自动提交的独立断言。

## 5. D3 备用资产来源与离线入口

已有`AssetService.importLocal`可复用，但当前不纳入exclusive/jobs/close屏障，**不得直接把任意路径暴露成HTTP**。先使本地处理与远端处理共享准入、幂等、持久化和按归属取消屏障，失败保存不得冒充ready。沿用实际GLB处理与webReady/parts结果，不伪造指标、不自动勾选force。

提供固定后端目录（默认仓库fallback，内部构造可用临时目录）的**代码内preset列表**：当前已有2–3个香薰模型，ID/相对文件名固定。GET `/assets/fallbacks`仅列preset ID/标题、可用性、来源说明；POST `/assets/fallbacks/:presetId/import`无body路径/URL/文件名，返回202实际资产，异步处理。每个preset以原文件SHA256绑定稳定资产ID，同一内容并发只处理一次；目录缺失/文件变更/校验失败如实失败。客户端不能设置provenance。

读取前审计目录祖先与文件、拒绝junction/symlink/越界，单文件32MiB上限、文件句柄有界读取及读后校验；不能“先检查再copyFile”重新打开竞态路径。写入只在既有数据目录自身资产中。测试用合成GLB和已存在本地素材，fallback大文件保持未跟踪，不复制进Git、不远程重新生成；生成时间未知不能杜撰，用“备用资产，预先生成；时间未记录”。

Asset增加可选持久化provenance：`kind: fallback | lux3d | unknown`，可选presetId、sourceTaskId、sourceHash与实际importedAt；旧数据默认为unknown，不因无taskId就假定备用。远端导入标“已有Lux3D任务”，不标现场生成。所有公开字段不含磁盘绝对路径或key。现有提交生成操作只在真实新task返回后才能标“本次提交”。

AssetPanel卡片与SceneEditor模型选项展示来源；当前采用模型在Studio预览旁持续显示“备用资产”或已知真实来源，不能只在一次toast中显示。用当前scene.model与资产的严格ID映射读取持久来源（`/assets/<id>.glb`），回退/重载重新匹配，找不到数据就“来源未核实”；不猜来源、不修改SceneConfig schema或生成伪模型。采用仍走原`/assets/:id/adopt`并保留FORCE_REQUIRED、同名不同内容、parts降级、版本/撤回与草稿保护。

Pi独立验证离线导入无Lux3D请求、来源跨刷新/服务重启保存、采用/回退标识跟随实际模型、缺文件与路径攻击失败、并发/关闭无孤儿处理进程、体积门槛未绕过。

## 6. D4 视觉与布局合同

暖色作品、深色外围、青色细线/光晕表达全息工作台；作品iframe/画布不加透明度、滤镜或浮层扫描线。复用现有本地字体与CSS，不加远程字体/图片/追踪或新依赖。保留明确焦点、键盘可达、disabled的真实属性、错误/状态语义；prefers-reduced-motion关闭装饰动画。不能仅用颜色区分passed/failed/not_run，正文和证据保持可读。

在1440×900基线保持M1画布与页面像素对照合同；不得再压窄scene-editing内容盒。修复请示卡贴边只作用卡片自身wrapper，不恢复外层inspector padding/border。画布超出可用宽度时用显式横向滚动/尺寸提示，不以CSS transform缩放画布而破坏像素和鼠标坐标；小屏仍能操作，控件不盖住作品交互。布局护栏测量整个比较画布与实际滚动/裁剪容器，不只比较clientWidth，旧阈值与像素断言不放宽。

需Pi在1440×900、1280×800、窄屏至少390×844检视整体布局/焦点与错误长文本，保存可复核截图。新增布局断言由Pi维护，不伪称原174例已经覆盖新视觉。恢复hover/pick/影响高亮、并排对比/滚动、审批/检查证据、场景编辑与资产对话框路径，防止装饰层拦点击。

## 7. D5 演示、对照与彩排

交付`docs/demo/{runbook,comparison-protocol,rehearsal-log}.md`及隔离数据启动说明。五分钟脚本从已知模板开始，演示按钮移动→真实检查→采用、标题改动→撤回、本地备用来源/模型采用、3D角度灯光写回、共享按钮请示/三处高亮→批准→检查。现场生成只在实际获授权且真实启动时加入，不因已有资产冒充现场生成。列常见失败分支、端口、退出方法与恢复办法。

隔离演示工作副本和数据目录，不重置/删除用户工作，不使用git reset/clean，不自动读根.env。若需重置只能新建带run ID的目录，原演示产物保留。CLI参数严格路径边界，模版复制不能带真实.env/缓存/凭据；脚本不得自动提交真实付费任务。

对照协议保留原3–5名非程序员、A聊天+预览/B工作台、同样三任务、交替顺序，记录完成时间/轮数/误改/难度1–5和失败原因。准备空白记录表与统计方法，未招募/未执行就写未执行，不能以代理/合成结果替代真人数据；不擅自联系他人或发布招募。小样本只作方向性描述，无虚构提升百分比。

彩排分两种明确记录：开发阶段mock脚本验证可在无key时连续3次，**不等于完整彩排**；最终真实语音/编码服务/Lux3D或如实标备用、两条核心链路/审批/检查全程无中断的3次完整彩排，需要真实配置及针对该轮的付费调用授权后另做。每次新run目录，记录受测HEAD/素材hash/来源/模式、各环节起止与成功失败/重试/人为介入/证据/资源清理；中断不能算成功，不重跑覆盖失败。真人对照与真实彩排未满足前，M4只可称开发/mock验收完成，项目不能标全部完成。

## 8. 验证与调度门禁

1. Claude先只读审查本设计，重点语音隐私/预算/关闭、重复费用、来源真实性、资产文件边界与布局合同；修完阻断/应修再派CodeBuddy D1，非阻断建议单列。
2. CodeBuddy按D1→D2→D3→D4串行交付固定提交。实现单测先证明目标失败，再验证修复；不用sleep/加重试/放宽旧判据凑绿，不改Pi的历史E2E/证据。每卡交付接口、实际验证与未覆盖表，后续卡不得抢跑未审协议。
3. 各卡先定向验证，最终标准typecheck/build/完整pnpm test；Claude独立审查修后无阻断/应修，Codex先合并冻结。Pi在产品字节一致树上独立执行完整旧九套174例+M4新增套件，新增例数先实际收集，不预编通过数字。0 retry/skip/flaky/expected-failed/errors，每例恰好一次passed result；新增失败必须定性后修，不循环重跑求绿。
4. 任何长命令从根用通知包装 `orbital/coordination/m2-takeover/bg-root.cmd`，首次即沙箱外；ASCII相对命令，拿job立即结束，不轮询/睡眠/另开监视作业。测试期间冻结源码与HEAD。所有Git操作`-c core.longpaths=true`；每轮记录真实产品/测试字节、锁、HEAD、工作区、命令/PID/时间/退出码。
5. 独立证据全部定向新run；旧helper写死路径的产物先归档原字节再按Git对象ID还原，新增未跟踪中间文件也要归档归属，不污染历史目录。SHA清单排除自身，最后生成后再重算所有载荷。收尾核验模板/配置复原、自有PID/创建时间与端口，失败保留诊断，不广杀进程，不用扩大ignore藏变化。

## 9. 尚未满足的外部条件

百炼真实凭据/匹配地域与业务空间配置仍缺；本计划及mock实现不读取或索取已有秘密，也不再次创建重复待办。真实语音质量/延迟、麦克风实机权限、浏览器服务备用质量、真人对照与三次完整彩排尚无证据。它们不是D1–D4开发阻塞，但都是最终交付必须如实交代的边界。M4不自动继承M2真实十题额度；新增付费调用必须在具体方案与预算就绪后按实际授权执行。
