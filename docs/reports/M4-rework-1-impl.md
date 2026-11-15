# M4 统一返工一实现交付（未运行集中验证）

日期：2026-11-15。CodeBuddy 实现，Codex 冻结/集成，Pi 集中测试，Claude 统一复审。

**本轮完成统一返工代码和测试代码，不表示编译、运行或验收通过。** 全程没有运行 typecheck、build、单测、Chromium、collect、demo、服务、探针或独立审查；没有新增 job，没有逐项补测。阿里云百炼仍为正式语音主链，没有读取真实 `.env`、ASKS 或秘密，没有调用阿里/浏览器厂商识别/编码模型/Lux3D。

## 基线、范围与旧事实

- 仅操作 `.worktrees/m4` / `feat/m4-demo`，起点 `9d717fc396cc4315f6ffcc636510868e8147dc82`，tracked 干净、fallback 未跟踪。只读根统一任务和审查，没有为读文档强合主线合同 `decd532aca3db8d0e5b439723104f51bdefe345e`。
- 原完整实现 `fd38840`、D1 原件、D2 两轮原件、Pi 树与所有历史报告/证据均保留，不改独立 Pi E2E、不改像素阈值/skip/retry、不新加依赖或改锁。
- Pi 第一集中轮 `job_6fd1b6c2` / 受测测试提交 `ed53e14` / 归档 `2f86b73`：server typecheck TS2322，子步骤 exit2、整体 exit1；Studio typecheck、build、所有单测/脚本测试/13 新 E2E/旧174均未执行。不是“测试失败1例”。原件仍在验收树 `docs/reports/artifacts/M4/regression/2026-11-15T09-15-07-076Z-full/`。
- 原 `M4-final-review.md` 针对 `9d717fc`：2 blocker、6 should-fix、10建议；不改写审查原文。F1 的“假绿”只指旧夹具的静态拓扑缺口，本轮从未有旧浏览器测试已绿的事实。
- 本报告随完整返工提交；完整固定 SHA 由交付消息给出。新提交没有运行成绩，不能借 D1 的547或历史174抵扣。

## B1/B2/F1–F6 逐项回应

| 项 | 已修改的实现/接口语义 | 已补测试代码及边界（全部未运行） |
| --- | --- | --- |
| B1 / Pi P1 | `scene/service.ts` 将 `provenanceBytes` 明确标注 `Buffer`，接纳 `readPlainFile` 的正常返回泛型；不做UUID/Buffer断言绕过、不改变读取/冲突逻辑 | 新冻结版本必须从头跑全仓类型、构建和单测，当前不宣称TS2322已经运行验证消除 |
| B2 | `scripts/demo/launch.mjs` 生成端口后统一把 `PREVIEW_ORIGIN_PORT=String(ports.preview)` 放入 backend 环境，mock/real 共用；前端仍无提供商key；候选 PreviewManager 原门禁不动 | `body.test.mjs` 在临时仓库使用替身 backend/frontends 调真实 launch，核两模式传递本轮preview端口。真正候选Vite/HMR、5175占用对照和10秒无循环导航须Pi集中实测，替身env断言不冒称HMR已通 |
| F1 | `speechInflight` 区分 permission/recording/transcribing 与完成review。失焦、allowed关闭仍立即取消在途；review遇真实iframe blur/pick pending、短暂同步/任务锁、场景面板hidden时保留，ready前不能确认。document真正hidden或卸载仍明确放弃review。未删除任何最终提交/选择/版本门禁 | 原组件套件新增sandbox跨源iframe焦点+pending链；另加 `speech-app.browser.test.ts` 加载真实App/EventCenter/消息来源校验与pick handler，使用不同loopback源预览、受控version等待和WS重连。录音/HTTP/WS/预览页面是明确替身，非真实厂商/后端或完整bridge验收；不能只拿原同文档fixture-B作证 |
| F2 | `/tasks` POST返回成功后立即清 `latestBinding`/`binding`，随后reload失败也不恢复旧绑定；POST失败或响应不明仍保留。放弃旧绑定时仅当输入仍等于原语音文字才清空，后来新手输内容保留；提交前改选仍需再次确认，不自动套B | 组件成功提交→版本/选择变化→新文字可生成；失败提交仍保留绑定；放弃旧绑定不清新文字。真实App路径也覆盖提交→版本刷新→新纯文字 |
| F3 | `ownedLifetime` 父IPC断开即失败态并启动50秒不续命watchdog；先正常close，若句柄仍活则按本进程父子链、后代创建时间与PID再校验后从深至浅终止自有后代。最多三次各5秒OS身份扫描，写每进程 `orphan-cleanup-<pid>.json`、exit1；身份读取/杀失败/残留明确记录，绝不冒称正常清理。正常信号先IPC报告intent；launch辨别normal vs unexpected，任何非零/信号/forced仍失败 | `body.test.mjs` 用实际硬杀父进程造成IPC断开，测试挂起close及四类替身孙进程、PID+创建时间、无关进程对照。另有真实资产process-worker的disconnect测试。正常SIGINT控制流测试由IPC触发进程SIGINT事件，**不是Windows真实控制台信号实测**；完整backend/frontends/实际检查Chromium/预览/资产链和Ctrl+C仍由Pi集中核验 |
| F4 | sidecar坏JSON明确转为安全 `SceneError(ASSET_NAME_CONFLICT,409)`；过大和有效但来源字段不同沿同样409拒绝。检查在GLB/parts/sidecar/config写入之前；链接仍保留403安全拒绝 | `scene/service.test.ts` 通过HTTP实际adopt后分别写坏JSON、16385字节、合法但不同来源，逐次断言409、安全码及GLB/parts/config/sidecar四份字节不变 |
| F5 | 保留固定preset、32MiB、单句柄安全读、真实hash/GLB头检查。save写失败现在粘性记录jobFailure，使直接准入阶段/后台更新失败都不能被idle/close吞掉。重启持资产锁时清理明确 `.model-stage-*` 目录（不跟链接）。process-worker先安装disconnect监听再动态加载模型库，缩短启动孤儿窗口 | `fallbacks.test.ts` 补真实UI空对象POST→202、恰32MiB/+1、GLB版本/声明长度、无fingerprint拒覆盖、LOCAL_IMPORT_INTERRUPTED显式重导、持久失败idle/close拒绝且第二实例仍被锁拒。新增父死测试保留完整raw、不发布model，重启标中断并清staging |
| F6 | prepare/readPlan/launch增加仅代码内部的临时仓库/替身角色参数，CLI/HTTP/env不提供覆盖；正式默认repository与入口不变。`safety.test.mjs` 显式导入 `body.test.mjs`，Pi原集中入口已执行该node --test命令，不重复修改标准脚本 | 临时git跟踪模板+诱饵.env跳过/旧run保留、目标祖先junction拒绝、plan越界/端口重复/越界/额外字段、native边界DNS/TCP/fetch拒绝与纯IP本地lookup/loopback正例、两模式launch env/正常关闭、父死失败退出和无关PID对照 |

上述八项均为“实现/测试代码已修改，待集中运行与统一复审”，不是关闭缺陷的验收结论。

## 状态语义与安全保留

1. **语音**：只有同步connected、可提交选择、未blocked/未busy且task:create未锁时能开始。permission/recording/transcribing失焦或门禁关闭的token作废、tracks/recorder/timer/fetch/DELETE规则不回退；权限晚到照常stop。完成review已有资源释放，因此焦点进iframe只保留文字，不能自动用B、不能自动POST任务。document hidden/unmount明确丢review；场景面板仅hidden但document仍visible时保留review并禁用确认。确认后再改选/主版本变化继续最终阻止。设计§4与runbook写明此区别。
2. **提交**：成功POST才释放语音绑定；失败/未知不自动重发、不解除安全确认。后续reload失败不是任务POST失败。手输revision保护、retrySelection范围、原Ctrl/⌘+Enter与生成按钮仍共用submit门禁。
3. **来源/资产**：未知legacy仍unknown，源/输出hash不可从HTTP伪造。同名不同内容/来源不覆盖，坏sidecar不推进scene。`AppOptions.presetDigests`新增内部合成夹具摘要，转发到已有ServiceOptions；没有HTTP/普通环境入口，正式默认仍固定代码SHA，不增加任意路径接口。原报告中“createApp不暴露”属于上一版本事实，本版本仅代码内部测试构造可传，不是生产请求后门。
4. **资产失败所有权**：更新保存失败不发ready；保存错误保留到idle/close，锁不释放。完整原始raw可在硬杀后保留作诊断，它不是半写tmp；不承诺已死进程能在现场删除目录，重启持锁后只清明确管线临时目录，不删用户素材。
5. **演示**：阿里云百炼主链、独立mock/real、白名单env、无env-file、分源/Host/Origin/采用门禁均保留。强制退出/身份扫描失败不算成功，所有历史run保留；原启动器45秒直接句柄兜底保留，父死时子进程自身还有watchdog。OS创建身份扫描失败会失败退出并保留诊断，不宣称跨OS绝对回收保证。

## 新增测试的真实范围

- `apps/studio/src/speech-app.browser.test.ts` + `test-support/speech-app.tsx`：真实React App和EventCenter、真实不同源iframe与父窗口焦点、实际App pending→ready消息链；HTTP/WS/麦克风及预览页面为本机替身，Vite `configFile:false/envFile:false`。原 `speech-browser.test.ts` 保留控制器组件夹具，并增加失败提交、旧绑定放弃、新文字、重连配置等断言。
- `apps/server/src/assets/fallback-process-lifecycle.test.ts` + `test-support/asset-parent.ts`、两个测试loader：真实AssetService状态与真实process-worker IPC处理，**模型模块被测试专用loader挂起**以确定性抓父死窗口；不声称跑了真实模型优化或生产process-isolated完整发布。loader只从测试父进程execArgv使用，生产worker未开放env/HTTP暂停开关。PID+创建时间核查，不做进程名广杀。
- `scripts/demo/body.test.mjs`：真实prepare/readPlan/launch/ownedLifetime控制流，临时仓库和角色替身；网络守卫probe在独立子进程中、真实native函数前放canary。real launch测试仅用假key和替身角色，不连接阿里；hard-kill测试用四类角色替身，不冒称真实检查/Chrome/preview链已经测过。
- 新增文件随标准workspace单测或既有 `node --test scripts/demo/safety.test.mjs` 集中执行，**本轮全部未执行、未收集**。实际数量由新冻结版本日志给出，不预填新通过数，也不拿静态代码条目当覆盖成绩。

## 10条非阻断建议处置

| 建议 | 处置 |
| --- | --- |
| S1 badge/demo横幅高度 | 已处理静态已知错误：Studio用纵向flex分配真实剩余高度，workspace不再硬编码减97px；窄屏保留auto堆叠。来源行/横幅不覆盖iframe。1440×900 mock截图、M1-B23原像素/开盖断言仍需集中实测，不能宣称新布局已通过 |
| S2 超宽手柄裁剪 | 滚动容器overflow-y从hidden改auto，保留原尺寸/横滚/焦点，不transform缩放。不改renderer姿态；主光手柄截图可见性留集中确认 |
| S3 装饰层/焦点 | 接受审查结论，保留pointer-events:none、隔离层与reduced-motion，不为建议重写装饰 |
| S4 重复来源hash | 去掉state.version依赖与事件订阅双刷新，并用同一microtask合并一批来源事件；仍每次真实hash，不引入mtime/size缓存掩盖篡改。三个preset打开时完整hash保留为限制，本轮不做性能项目 |
| S5 语音config重连 | connected恢复时只重新GET安全配置，不自动录音/重发转写；组件补只读重取与0上传断言 |
| S6 空浏览器转写 | 新安全本地SPEECH_EMPTY文案“未识别到语音，请重新录音或使用文字输入”，不再误报上游不可用；不扩后端协议 |
| S7 备用错误提示 | 按安全code白名单显示preset不存在/文件改变/路径拒绝/过大/无效GLB/编号冲突等；未知和网络失败仍“结果未确认”，不回显原始message/body/秘密。既有AssetError HTTP400映射暂保留，不做全站错误码重构 |
| S8 默认来源 | 保留已被核实的两个hash与“时间未记录”，模板GLB和sidecar均未改，不虚构任务链 |
| S9 Ctrl+C竞态 | 与F3合并：子进程信号intent+父进程interruptRequested，退出码/forced失败仍保留；本轮没有Windows实际控制台信号成绩 |
| S10 D1等价字段 | 本轮未再改D1 client/service；集中新全仓必须覆盖当前字节，不借旧547成绩 |

## 文件、静态核对与交付

产品修改分布：server app内部夹具接线、assets service/cleanup/process-worker、scene adopt；Studio PointSpeak/SpeechInput/controller/API安全文案、来源badge、资产错误与局部布局；demo launch/runtime/prepare。新增或扩展实现侧测试已按上表列明；没有修改Pi验收树、tests/e2e、package scripts/依赖/锁、模板GLB/sidecar或历史报告/归档。

静态核对的SHA256：锁 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960`；默认模型 `ebb7141771059ea8a60e9af0c4dba071ae9a2d83510edf76e7c76098434c7e46`；默认sidecar `7ee5b28630e81af0e9c60f1b3f9f9c39e4e78320bb4743fd7113ae23c4d26333`，这三份均未修改。

本轮仅进行源码阅读、`git diff --check`、Git范围/身份核对和文件hash；没有执行TypeScript解析/原生导入/语法探针，也没有生成新的运行证据。代码中的测试循环/服务/进程终止均为**待执行测试代码**，不是本轮实际操作。所有fallback文件继续未跟踪、不入库。固定提交与树身份见最终交付消息，最终tracked应干净。

## 集中验证与独立复审交接

由Codex统一冻结后交Pi从头执行新身份的全仓类型→构建→完整单测（含真实App与组件用例）→显式demo脚本安全测试→新M4独立套件→旧九套174（含M1-B23）。实际数随新增测试变化，首败按真实日志记录失败和未执行，不预写通过。Claude统一复审所有修正，不逐项重启小轮。

集中阶段重点：

- F1真实模板/bridge/跨源iframe重新点选B、pending、短暂重连期间review保留且必须明确确认；确认后改选仍拦；F2成功语音提交后新文字不受历史绑定阻塞，失败未知仍保守。
- mock demo实际候选生成/HMR目标与plan端口一致、5175占用对照、无重复导航；不是只测env字段。
- backend/frontends及真实preview/check/Chromium/asset worker的父死整链PID+创建时间/端口回收；真正Windows Ctrl+C正常stopped/forced=false，与强制退出失败区分。
- 坏sidecar三类409前后四份作品字节不变、preset空对象正例与输入边界/旧数据/保存失败持锁。
- 1440×900 demo、1280×800、390×844截图，M1-B23原阈值、主光手柄、横向滚动与键盘焦点、审批/检查/采用/草稿保护。

**未执行外部事项**：真实阿里语音/厂商识别质量和延迟、真实编码/Lux3D、真人3–5人A/B、三次完整mock或真实彩排。开发返工完成不等于M4或全项目完成；不自行merge/push。
