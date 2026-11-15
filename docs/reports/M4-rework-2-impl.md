# M4 统一返工二交付（仅开发与静态核对）

日期：2026-11-15。实现角色CodeBuddy；Codex统一冻结，Pi集中验证，Claude核对有限差异。**本批没有运行任何类型检查、构建、测试、collect、浏览器、demo、服务、探针、语法解析或独立审查，没有创建job。开发修改不等于验证通过，M4未验收。**

## 输入、身份与原始失败

- 实现树仅 `.worktrees/m4` / `feat/m4-demo`，起点 `01c85fe18ebcb24c0a010621e53f71f475e7320f`，tracked干净，仅fallback未跟踪。
- 只读根固定交接 `59306d405ce948b33504153eeeb3a7a412e48f66` 的统一返工二任务卡、完整 `M4-rework-1-review.md`、PROJECT_STATE，以及本树完整 `M4-rework-1-impl.md`；没有为读取文档合并主线。
- 集中 `job_9415a4a3` 已结束，整体exit1/14s，受测验收HEAD `eece9e100a2c4a0bcf0e6ff84667d0a2bcea4cdd`，产品与01c85fe一致。typecheck子步骤exit2，`assets/process-worker.ts(8,28)`、`(9,18)`报TS1375：仅动态import的文件没有静态模块声明，顶层await不合法。不是上一轮Buffer错误复发。
- 后续build等13步未执行：0单测、0脚本测试、0 E2E；19+174=193只是已收集的独立用例数，不是通过数。Pi在自己的验收树归档 `docs/reports/artifacts/M4/regression/2026-11-15T12-35-07-124Z-full/`，本实现任务未改那个树或旧原件。
- 原统一复审为0新blocker/0新should-fix、9建议，原八项仅代码层关闭待运行；报告原文保持不动。新交付SHA由最终消息给出，不借D1的547或M3历史成绩覆盖新字节。

## 本批修改

| 文件 | 有限修改 | 未运行的证明要求 |
| --- | --- | --- |
| `apps/server/src/assets/process-worker.ts` | 顶部新增静态 `export {};` 声明模块；没有静态加载process-model、没有ts-ignore/any，不改预算或错误处理 | 集中typecheck/构建及worker生命周期实际运行确认TS1375消除 |
| `apps/studio/src/speech-app.browser.test.ts` | 真实App父页面安装原生window.blur计数监听；点跨源iframe的B之前取基线，点后断言计数确实增加，再保留pending/review/禁用确认/重连/明确B和成功提交后新文字断言；原件输出同时记录基线及最终blur数 | 真实Chromium实际执行。麦克风/HTTP/WS/预览页仍为明确替身，不能代替Pi真实模板与bridge |
| `scripts/demo/body.test.mjs` | CIM身份补command；按命令行含本次测试入口及role参数识别preview/check/asset/frontend-worker各一个，不再要求后代总数等于4；所有实际发现后代仍逐个按PID+创建时间断言退出，无关进程仍必须存活 | 在当前Windows环境执行watchdog与清理断言，不能因conhost等额外进程而漏检或假红 |
| 同上联接点清理 | 核对绝对link路径就是本fixture的`.data`，root/outside祖先未被替换、lstat确为链接且realpath仍指向本fixture的outside；用`unlink`只删链接。身份/删除失败时AggregateError并保留两目录，绝不继续递归进入可能仍在的链接；成功解除后才清普通fixture目录，目录清理错误也不吞 | Windows junction实际删除、外部目标未改与失败现场保留待集中验证；没有递归删除链接目标 |
| `docs/demo/runbook.md` | 明确mock守卫只加载backend/frontends主进程，不覆盖资产/候选预览/检查子进程；写明两条回收限制、Windows测试边界、保存失败持锁/cleanup_failed处理办法 | 全进程树离线与无孤儿不作静态承诺，真实进程链、控制台Ctrl+C仍需Pi实测 |
| `docs/design/M4-plan.md` | 写清任务成功POST后释放语音绑定但保留输入，留下的文字按普通文字草稿再次提交，仍由当前选择/版本/同步门禁控制；提交前或失败未知时原语音绑定保护不变 | 不改产品交互、不自动提交、不清新输入；相关实际路径留集中验证 |

worker执行顺序仍是：模块声明（无重型依赖）→注册disconnect监听→检查启动时已失联→检查路径参数→动态import重型模型库→实际处理。没有改回加载之后才安装监听。

静态检查同批TS入口：`asset-parent.ts`、`speech-app.browser.test.ts`、`speech-browser.test.ts`、`fallback-process-lifecycle.test.ts`均有静态import；原preview-worker有`pathToFileURL`静态import、checks/worker-entry也有静态import。同批`.mjs`入口本身为ES module。这个源码阅读不能代替完整TypeScript检查，未运行编译/解析探针。

## 复审九建议逐项处置

| 建议 | 本批处置 |
| --- | --- |
| 1 守卫继承更正 | 已更新runbook：只有backend/frontends预加载demo守卫。资产worker清空execArgv，候选/检查子进程没有该demo守卫；各自本地处理合同不等于全树强制离线。没有为文档建议扩建一套守卫，也未改原审查报告 |
| 2 真实App父blur | 已增加真实父窗口事件计数与跨源点B后的增长断言，保留原pending、review和重连断言，输出证据字段随之增加；未运行 |
| 3 后代数量脆弱 | 已改为按本次入口命令行/role确认四类必需worker。额外conhost或其他实际后代仍列入全体退出断言；没有只过滤四个role就忽略其它后代 |
| 4 中间父进程先死 | 保留限制并写入runbook：Windows孤儿父PID不重挂，当前树遍历可能漏中间层已死的孙进程，依赖worker自身disconnect。集中需核实际Chromium等全链，不声称静态已保证 |
| 5 正常Ctrl+C超时 | 保留既有45秒直接子进程强杀策略，明确该路径不先触发子进程watchdog、孙进程依赖自身退出；强杀为cleanup_failed/forced，不冒正常stopped。集中需核关闭挂起场景和真实控制台信号，不新增进程管理功能 |
| 6 提交后剩余文字 | 已写入设计：成功POST后的保留文字是普通草稿，用户改选后明确再次生成按当前选择提交；不再重复语音确认。原提交前改选确认、失败未知保守绑定及所有门禁仍保留，不改交互 |
| 7 粘性保存失败 | 已在runbook写明临时EPERM/EBUSY也可能导致idle/close失败与持锁/cleanup_failed。保留原run，核实际PID/端口/占用，原进程退出后由死进程锁恢复或人工核查；不删活锁、不清零错误、不重发未知任务；本批不增加重试 |
| 8 资产父死测试边界 | 保留Windows限定、测试专用父进程/loader而非生产spawn接线的边界；不加skip、不减少当前Windows验证范围。Pi集中仍须真实split GLB处理时硬杀后端并核worker/staging |
| 9 junction清理 | 已改为身份校验后的显式unlink；身份不符/删除失败保留现场、报清理失败，未解除前不递归清理根目录或目标目录；未运行 |

## 静态核对与范围保护

本批仅源码阅读、Git范围/身份核对、`git diff --check`及静态字节核对。没有执行上述任何测试代码里的进程/浏览器/清理操作，没有创建服务或测试目录，也没有kill进程。

不修改Pi独立E2E、旧阈值、skip/retry、安全预算、依赖、锁、默认GLB/来源sidecar、历史证据、历史失败或审查报告。fallback继续未跟踪、不入库。实现树不merge/push主线；验收树由Pi归档，主线与其它工作树保持各自边界。真实语音主链仍阿里云百炼；没有读取真实.env/ASKS/凭据，没有阿里/厂商/编码/Lux3D真实请求。

## 后续集中阶段

固定新交付后由Codex安排Pi从头跑同一集中入口，Claude核对本批有限差异。本轮没有新通过数量，没有新收集数量，不预写编译已过或缺陷验收关闭。需要以实际结果确认所有新增/原有测试及M1-B23像素、demo截图、候选HMR、真实模板iframe、父死全链与真实Ctrl+C。

真实阿里识别质量/延迟、真人A/B、三次完整mock或真实彩排仍未执行，不能把修改完成或独立审查代码层关闭写成M4/全项目已通过。
