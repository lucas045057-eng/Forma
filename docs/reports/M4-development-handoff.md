# M4 剩余开发一次性交付（未集中验证）

日期：2026-11-15。负责人CodeBuddy实施，Codex统一冻结/集成，Pi集中测试，Claude统一独立审查。**本交付表示D2–D5的代码与材料已写完，不表示编译、测试、真实服务或项目验收通过。** 本任务没有运行typecheck/build/单测/浏览器/collect/彩排或服务，也没有启动审查。

## 固定身份与草稿保全

- 完整实现提交：`fd38840d5171ad0651a66daa79a1528b0d522b42`，分支`feat/m4-demo`、工作树`.worktrees/m4`。本报告另以docs-only提交固定最终交付HEAD，完整SHA由交付消息给出；最终HEAD的产品/脚本/测试字节与该实现提交一致。
- 开发起点：D2交接`9112c4f`上的全部dirty/untracked草稿均保留。已确认上游差异只有统一流程文档后，安全ff到`2eadea59a16fb894b31f7f585a93d48460b30554`，没有reset/clean、覆盖草稿或改其它工作树。
- 用户新流程取代旧逐卡RED/GREEN/标准轮/审查：连续完成D2–D5后一次交回。没有新job、没有轮询/睡眠/监视、没有重复安装或旧基线547/47/下载11测试。只进行了静态读代码、Git diff/check、文件复制/哈希和只读进程表核对。
- 无新依赖或锁变更，无Pi tests/e2e/旧断言/阈值修改。锁SHA256仍为`67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960`。没有push或自行merge主线。

## 分模块完成与缺口

| 模块 | 已写入的开发内容 | 尚未满足/缺口 |
| --- | --- | --- |
| D2录音与review | SpeechInput、可注入控制器、原生适配、speech-api/review绑定、PointSpeak真submit/快捷键守门、局部CSS；录音60秒/4MiB、MIME交集、新UUID、499按code、DELETE失败本地先清理、迟到token拒绝 | 新代码未编译/运行；真实麦克风、阿里、浏览器厂商识别质量/延迟无证据 |
| D2对象/文字保护 | A/B/无选择与选择代次、主版本、文字revision；独立可编辑review，显式使用/替换/改用当前对象；确认后再改选重新阻止；原文字/任务retry/EventCenter锁保留，不自动/tasks | 控制器替身、SSR和真实Chromium组件代码已写但单测/浏览器尚未执行；不是Pi E2E |
| D3本地备用 | 三个固定preset、可信哈希与32MiB安全读取、并发幂等、jobs/abort/close屏障、真实处理/hash/parts/webReady；本地CLI读取也纳入同一屏障 | 未执行处理或确定性对照；不同处理版本输出不同仍拒绝同名覆盖，不能先承诺字节确定 |
| D3随作品来源 | Asset可选provenance，GLB/parts/sidecar写入后才推进scene；只读模型来源接口从当前model核GLB hash；header/资产/模型选项持续显示；默认模板sidecar已补 | 新读写/迁移/篡改/回退/新数据目录路径等待集中测试，不能因静态实现声称来源功能已验收 |
| D4视觉与布局 | 深色青色外围/本地字体/焦点/文字状态/reduced motion；作品不透明不加滤镜；保留场景440px列与外层零padding/border；超宽固定画布横向滚动+尺寸提示，不transform缩放；小屏控件可达 | 未打开浏览器看效果，1440×900像素、1280×800和390×844截图/交互由集中阶段核验 |
| D5入口与材料 | 独立mock/real入口、安全模板副本、白名单子进程环境、阿里配置示例、端口/所有权/关闭记录、三条固定mock示例、五分钟脚本、A/B协议与彩排空表 | 启动/关闭/隔离和mock流程均未执行；没有真人实验、3次mock彩排或3次真实完整彩排 |

上述范围没有等待另派小卡的开发模块；仍可能存在需要集中验证发现并返工的类型/运行/交互问题。真实配置有效性、授权额度、真人参与和实际彩排属于外部验证条件，不能以“开发已完成”替代。

## D2开发细节与历史失败

`SpeechController`负责权限/录音/转写/独立review；blocked（场景hidden/影响模式）、同步门禁、visibility/blur/unmount均废弃token并清本地资源，权限晚到停止tracks。正常最后dataavailable只上传一次，正常pointerup先清手势，随后正常lostcapture/自动停止不误取消；异常捕获和Space repeat有独立手势逻辑。转写等待45秒，显式DELETE3秒有界，取消/断网不保证未计费。浏览器备用只显式选择，离线demo禁用厂商备用并持续标注本机固定转写。

review绑定src/cid/baseVersion、主版本、文字revision与选择代次，覆盖A→B→A和无↔有；确认后再变更仍在真submit检查。主版本变化保守要求放弃本次转写、重选并录音，不沿用旧对象。原指令后来被编辑时不被迟到结果覆盖；明确替换才进入原输入。任务retry仍用原retrySelection范围，不把新语音绑定默默套给旧任务。

旧结果原封保留：

- `job_1053e7a9`，`.data/d2-red-2026-11-15T07-24-09.396Z/`：3条收集，首条缺speech-record目标断言失败，另外2 pending，非3失败。
- `job_26bba71c`，`.data/d2-green-2026-11-15T07-55-25.687Z/`：Studio typecheck TS2322（speech-browser.test.ts:49 Vite HttpServer联合类型与node:http helper不匹配）；后续单测和Chromium0执行，identityUnchanged=true。
- 已静态修正为直接使用Vite httpServer共同listen(0)/address/error能力，不用any扩大旧helper；**未复跑确认**。以上两轮在`artifacts/M4/D2/prior-development-results/`分目录归档，16个载荷/排除自身的SHA清单，原CRLF字节保留，属性明确识别CRLF。
- 以前D1的547单测和独立审查是历史固定字节基线，不覆盖当前D2–D5或这次等价字段赋值修正。为Node原生TS入口，SpeechError/SpeechService参数属性改为显式字段，原预算/错误码/取消逻辑未改，此处同样未原生导入或运行验证。

## D3接口、来源与迁移

| 接口/数据 | 实现合同 |
| --- | --- |
| GET /assets/fallbacks | 仅列三个代码内固定preset的标题/可用性/安全原因，不接受路径/URL参数 |
| POST /assets/fallbacks/:presetId/import | 仅空对象/无body，不接受路径、URL、来源字段或query覆盖；处理中202 Asset，已有相同ready结果200；缺失/变更/链接/过大安全失败 |
| GET /scene/model-provenance | 不接受参数，从当前scene.model安全派生本地路径，核真实模型与sidecar输出hash；缺失/坏JSON/链接/hash不符/未知旧记录返回unknown，不回显磁盘路径 |
| Asset.provenance | 可选kind/presetId/sourceTaskId/sourceHash/outputHash/importedAt，旧数据unknown；字段仅由服务端可信流程生成，模拟远端资产不冒称真实Lux3D |
| public/assets/:id.provenance.json | schemaVersion1，随作品与GLB/parts保留；不同内容/来源拒绝覆盖。相同来源仅导入时间不同保留原sidecar，不改变历史标记 |

固定文件：diffuser-split→lux3d-split-4969889.glb、diffuser-original→lux3d-4969293.glb、diffuser-alternate→lux3d-4969298.glb。输入固定SHA与真实读取比对，32MiB/祖先与文件无链接/单句柄有界读/读后身份检查都保留。ID为`fallback-<源SHA前24位>`以控制Windows路径长度，完整源fingerprint仍参与同ID冲突拒绝，处理产物完整SHA持久化。ServiceOptions的fixture摘要仅供合成单测内部构造，createApp/HTTP/普通环境不暴露覆盖，正式目录始终用代码内固定SHA。

本地导入已加入准入/submissions/jobs/abort及close等待，默认处理仍是真实隔离管线；父进程断开时处理worker退出，正常结束标记避免误判失败。保存失败不发ready，生产者错误阻止提前放锁；中断本地任务重启记failed，需要明确重新导入，不能假自动继续或ready。

无SceneConfig schema迁移、无SQL迁移。旧资产索引可读但无来源即unknown；旧同名本地ID不能被不同内容覆盖。默认diffuser-4969889.glb没重写，SHA为`ebb7141771059ea8a60e9af0c4dba071ae9a2d83510edf76e7c76098434c7e46`；sidecar根据M1-A-impl“默认资产”和M1-fix-impl处理记录，源split当前SHA为`239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0`，没有捏造远端任务链或生成日期。

已从根只复制上述三份既有GLB到m4/fallback，保持未跟踪、不入库。新测试/验收树若要实际本地导入，由调度显式准备这些材料；缺失/字节不同会如实不可用。内部合成单测独立构造12B夹具和受控processor/hash，不把它叫作真实模型质量。

## D4布局保留点

新增的只是外围、状态与卡片样式，不改renderer/姿态/光照配置或作品iframe透明度。scene-editing列仍minmax(360px,440px)，inspector外层仍padding0/border0，卡留白只作用卡/其wrapper。`scene-canvas-scroll`承载原尺寸画布、真实横向滚动、键盘焦点与提示；测量实际rect左右边界和宽度及scrollWidth，ResizeObserver/scroll清理，不以transform缩放掩盖差异。来源badge断线时先显示待同步，刷新/回退/scene与version事件使迟到来源响应失效。

旧M1像素/开盖、并排滚动与画布尺寸断言一行未改；是否保持实际效果仍须集中重跑。现有画布尺寸消息依赖bridge上报缓存的合同没有额外扩展，不冒称实现了新的请求回执协议。

## D5入口/配置与执行边界

- `scripts/demo/mock.mjs`：准备独立run，启动受管backend/frontends；所有业务假key、固定127.0.0.1上游、专用network-guard。Speech mock返回固定示例，coding mock只支持三个明示场景。实际检查/资产本地处理仍走原管线，不能伪造passed或webReady。
- `scripts/demo/real.mjs --allow-real-services`：阿里百炼主链，操作者私密进程环境；没有本轮具体调用授权/预算不要执行。启动本身不自动POST付费任务。浏览器厂商识别仅real/普通模式显式备用。
- `prepare.mjs`：只复制Git跟踪src/public与固定根文件、跳过隐藏/敏感/缓存名字和链接，32MiB单文件上限；不复制.env或node_modules内容，依赖只指向当前锁定工作区包。只创建新UUID目录，不删除旧产物、不reset/clean用户作品。
- mock/real不经过pnpm dev/server dev/--env-file。后端才收到提供商配置，前端子进程只有OS白名单与公开plan/模式，无key；Vite configFile=false/envFile=false，预览分源、Host/Origin/fs边界和M3采用门禁保持。
- 源目录、plan路径与schema/端口名字/区间受校验；拒非loopback mock端点，不继承NODE_OPTIONS/代理。启动错误保留安全stage/code；退出仅通知/等待直接自有ChildProcess，超时只终止该自有句柄并记forced，异常退出记interrupted/cleanup_failed，不算成功彩排。
- `docs/demo/runbook.md`含五分钟步骤、固定mock差异、阿里key/地域/base/model配置、非法语音配置整个后端快速失败、35秒不含上传、取消计费局限与恢复操作。`real.env.example`只有占位符，脚本不读取它或任何现有.env。A/B与彩排文档均空白/未执行，不联系真人、不虚构提升。

## 必须集中执行的清单（本任务全部未运行）

1. 新完整字节的typecheck/build/标准pnpm test；不能拿旧D1 547或D2 RED抵扣。计数按集中阶段实际日志与收集，不预填M4新增总数。
2. D2控制器/review/API/SSR与旧pick/retry/lock回归；真实Chromium组件测试（录音/识别API替身、任务HTTP stub）覆盖实际指针/键盘/捕获丢失、hidden/门禁/visibility/blur/unmount、权限晚到、DELETE失败、499/newUUID、A/B/无选择/版本/确认后再改选、文字revision及review编辑确认→原提交。该夹具需要本地已装Chromium，仍不得用真实麦克风/厂商网络。
3. D3固定源hash与32MiB/链接/越界/并发、处理失败/保存失败、close/父死回收；default来源、新数据目录、GLB/sidecar篡改、同名不同来源/内容、采用/撤回/回退。目录源码形态和进程生命周期须真实核验，不能只看最终ready。
4. D4 1440×900的M1全像素/开盖与源范围、1280×800/390×844截图、横向滚动/尺寸提示、焦点/reduced-motion/长错误文案、不遮作品交互、审批三处高亮/单WS/四检查证据与采用门禁。
5. D5脚本解析/安全单测单独纳入（scripts/demo/safety.test.mjs不在当前workspace pnpm test过滤中）；隔离目录/依赖/端口、诱饵.env不被加载、mock非loopback拒绝、子进程白名单、父死/启动中断/关闭/端口和PID创建时间回收；首次mock流程不等真实彩排。脚本本轮没有执行过，不能以静态代码替代启动证据。
6. Pi在完整冻结字节上覆盖旧九套174例及M4新增独立套件，新增数由Pi实际收集，统一Claude审查。旧.data调试runner绑定各自历史HEAD，不应删除其身份门禁后重放为新成品证据，集中阶段需建立新完整身份。
7. 真实阿里协议/业务空间、识别质量/延迟、实机权限、真人3–5人A/B与3次真实完整彩排尚未执行；凭据/本轮付费授权/参与者具备后另做，缺失时如实保留“未满足”。

## 静态清理与最终说明

2026-11-15T08:54:50.3680009Z只读进程表/监听表：m4归属的node/chrome/headless/esbuild进程与端口均为空。本任务未启动过服务/测试或杀任何进程；没有“运行后清理成功”的虚构声明。旁路只进行文件复制、哈希、Git操作和旧证据归档；没有读/输出真实.env、ASKS或凭据，没有阿里/厂商识别/编码/Lux3D请求。

最终tracked应干净，仅fallback/为预先存在材料的未跟踪副本；不入库、不删原件。开发交付后由Codex统一冻结，再集中Pi测试和Claude审查，失败集中返工。**当前不得宣布M4或整个项目验收完成。**
