# M4剩余全部开发：一次性交付，随后集中测试审查

## 用户最新指令优先

2026-11-15：“真实语音用阿里云配置，现在开始等返工回来先完成全部开发，再测试审查，不要再开发一轮测一轮太浪费时间了”。当前返工已交回，旧job_26bba71c已结束exit1，不再等待它、不再冻结草稿、不补跑。**本次任务连续完成D2剩余修正、D3、D4、D5全部开发，完成后一次交回；不分卡向调度索取开工或验证许可。**

本指令覆盖旧卡中的“每卡先RED→GREEN→typecheck→标准→Claude”执行顺序。功能、安全、来源真实性、最终测试审查标准不变；可随实现补测试代码，但此任务不运行typecheck/build/单测/浏览器/collect/彩排或新服务，不安排独立审查，不重跑547/D2 RED。静态读代码、git diff/check和身份/字节核对可做，不是重新启动验证。

## 现状与工作区

- 仅在既有`.worktrees/m4` / `feat/m4-demo`工作；HEAD9112c4f，已有D2未提交草稿和测试，不删除/覆盖重写它们。先记录dirty/untracked具体范围。
- 主线b7160e56d4d5d66177cf30f9edd4d8d0b90be0ef已更改流程，调度可能再提交本卡；以派单给出的最新文档HEAD为准。确认与当前草稿不重叠后可安全fast-forward仅文档；若重叠先保留草稿、不强行reset/clean，读取主线新设计后继续，不因文档合并停住全部开发。
- 已结束D2 job_26bba71c实际停在Studio类型：speech-browser.test.ts:49把Vite `HttpServer`联合类型传给仅接受node:http Server的helper，TS2322。单测/Chromium均未执行，identityUnchanged=true。修正该测试夹具接线（参考既有dev-proxy.test.ts直接监听Vite httpServer），不以any/无证据断言扩大旧安全helper，不补跑。旧日志原件保留，不把失败改成通过。
- 已通过的D1产品/标准/审查作为既有基线，不为本任务再重复。所有Git带`-c core.longpaths=true`，精确add，禁止git add . / reset / clean。

## 开发范围与完成条件

权威细节是最新`docs/design/M4-plan.md` §3–§9/§11，以及D2卡的功能部分。旧卡“只做D2/不做D3–D5”由本统一任务取代。按下面顺序连续完成，不逐段跑验证。

### A. 补完D2录音/确认接线

保留并完善现有SpeechInput、控制器、speech-api/review/PointSpeak和局部CSS；修上述夹具类型。录音/识别后必须可编辑review、显式使用文字才进入原任务输入，不能自动建任务。原文字提交/任务重试与EventCenter锁保留。

S5：blocked（隐藏但未卸载）、场景/影响模式、同步门禁失效、visibility/blur/unmount取消并释放所有track/recorder/timer/fetch；权限晚到立即stop。S6：录音A到当前B/无↔有/版本变化/确认后再改选须显式再次确认，文字revision不覆盖新输入。60秒/4MiB/MIME能力交集、正常结束与异常捕获区别、键盘repeat不双录。DELETE失败也释放本地，499看code，每次重试新UUID，晚结果不能重启review。

正式语音主链阿里云百炼（既有D1）；浏览器识别仅显式备用、有厂商告知、不自动切换。此阶段不请求真实麦克风、识别服务或测试其效果。

### B. D3固定本地备用与随作品保存的来源

复用现有AssetService，完成固定preset列表/GET `/assets/fallbacks`/POST `/assets/fallbacks/:presetId/import`；禁止HTTP传路径/URL。以现有本地2–3份GLB作为输入，无新下载/生成；fallback素材保持未跟踪。可在同workspace安全复制既有fallback到m4，不带.env/其它文件，不移走原件。

本地导入加入准入/jobs/abort/close屏障；复用assertPlainPath/readPlainFile的单句柄有界读取与读后身份核对，拒绝祖先/文件junction，32MiB上限。来源hash/处理hash真实计算，旧数据unknown，指标/parts/webReady实际处理，force不自动批准。相同源并发去重，稳定ID跨重建若产物不同仍保留ASSET_NAME_CONFLICT，不覆盖作品。

Asset可选provenance由服务端生成。scene.adopt把来源sidecar与GLB/parts同放public/assets、失败不推进scene配置；只读`/scene/model-provenance`从当前scene.model派生固定安全本地路径，核真实GLB输出hash，不依赖另一个数据目录的asset index。回退/刷新时标签随实际作品，缺失/损坏/篡改显示unknown；客户端/Agent不能设置来源。

模板默认diffuser-4969889.glb补sidecar：用实际当前字节hash及已有M1历史证据，标“预先生成的Lux3D备用模型，时间未记录”。未经原件证明不杜撰4969293→4969889任务链、生成时间或现场来源。不要改GLB/SceneConfig schema凑标记。AssetPanel/SceneEditor/当前预览持续显示来源，不能只一次toast。

### C. D4外围视觉与可操作布局

完成深色全息外围、青色细线/克制光晕和暖色不透明作品的成体系样式；不引入远程字体/图片/追踪/新依赖，不改作品iframe透明度/滤镜。状态有文字/形状，键盘焦点清晰，reduced motion关闭装饰动画，纯装饰pointer-events:none且不入焦点序。

保留1440×900 M1像素对照合同，scene-editing不恢复inspector外层padding/border，卡片留白仅卡自身。超宽画布横向滚动与尺寸提示，不transform缩放，不静默裁边；1280×800与390×844布局代码保持控件可达、作品无装饰遮挡。保留全部testid/选择高亮/审批/候选对比/检查证据/任务/场景/资产行为。最终截图与实际布局验证由集中阶段执行，此时不启动浏览器“看一眼”。

### D. D5演示、配置和隔离入口

交付`docs/demo/runbook.md`、`comparison-protocol.md`、`rehearsal-log.md`及必要的独立启动/副本准备脚本（如scripts/demo/）。脚本开发完成但不执行彩排或开服务。

mock入口必须构造全新白名单环境、假key、固定loopback mock上游和隔离数据/工作副本，禁pnpm dev/server dev及--env-file，禁继承NODE_OPTIONS/代理等注入；实际需要语音mock时用内部构造参数接loopback，而不是给生产env开后门。任一mock上游非loopback拒绝启动。目录安全边界、只复制模板白名单、不带.env/缓存/凭据；重置只创建新run目录，不删用户作品、reset/clean或丢旧产物；统一按创建归属关闭子进程/端口，不广杀。

真实模式独立入口和清晰阿里配置说明（DASHSCOPE_API_KEY/SPEECH_BASE_URL/SPEECH_MODEL及匹配地域），只引用占位符，严禁读现有.env/ASKS或把秘密写报告/日志/前端；不换厂商、不调用真实服务验证。可添加专用不含key的示例文件，不能复制真实配置。记录D1非法语音配置会使后端快速失败、35秒不含上传及安全排查办法。

五分钟脚本从当前模板出发，覆盖按钮→候选→真实检查→采用、标题→撤回、备用标识/模型采用、3D写回、共享请示/三处高亮→批准→检查。现场生成仅真实发生且获授权时显示，备用不得冒充现场生成。对照材料保留3–5非程序员/交替顺序/三任务/时间轮数误改难度，提供空白表，不联系参与者或虚构数据。

彩排表开头mode=mock/real、凭据具备与参与者只记布尔、来源/替身/HEAD/hash/环节时间/中断/人为介入/结果/清理字段。开发完成没有执行3次彩排，必须仍写未执行；不以mock或自动化伪装真人结果、真实识别或三次完整彩排。

## 本次交付（开发完成，不是测试通过）

- D2–D5实现与配置/脚本/文档全部写完后一次交回。可按内容精确commit保存开发过程，但不每commit跑测试或停下来交审；不要把已知类型问题留成“等先测一轮再继续”。
- 汇总`docs/reports/M4-development-handoff.md`：固定HEAD、各模块已完成/缺口、接口/迁移/入口、实际改动范围、需最终集中验证清单、旧D2类型失败原件路径及未执行项目。旧报告保留历史，再附新流程说明，不能改写以前未跑为通过。
- 补充必要实现测试代码供最终集中执行，不改Pi E2E或历史判据/证据。完整开发后由Codex统一冻结，再安排Pi集中测试和Claude统一审查；本任务不自行启动该阶段。
- tracked工作树干净、fallback不入库、无新依赖/锁变更（若确实无法避免依赖则先说明最小必要性，不擅自安装）；只读核对无自己遗留服务，但不启动探针/服务作为检验。静态diff/check、文件hash与提交核对可以做，不读/输出秘密。
- 不自行merge主线或宣称M4/项目完成；开发完成、集中测试通过、真实服务/真人/彩排通过三类结论必须分开。
