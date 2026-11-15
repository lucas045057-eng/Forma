# D2：录音、可编辑转写与对象确认

CodeBuddy实施，仅.worktrees/m4 / feat/m4-demo。先确认当前aa43c2a干净，再快进合并调度给定的最新主线设计提交（含D1审查/集成记录/本卡），记录身份后开工；不改主树或旧工作树。D1已经代码审查0阻断/0应修，547标准单测通过；不是Pi正式验收。无需重复安装、D1 RED或547 baseline。所有Git使用`-c core.longpaths=true`。

## 先读

根orbital/PROJECT_STATE.md、instructions/project_goals.md；docs/design/M4-plan.md §4/§8/§11、M4-D1-review.md及M4-D1-integration.md。S5 hidden面板取消与S6对象变动明确确认是本卡硬要求。原审查建议5的GET/DELETE代理缺口经Codex核冻结源码已覆盖，**不用再写重复代理断言**；D2仍需自己的控制器与真实浏览器集成证据，不把stub冒称后端完整取消。

## 文件和范围

新增`apps/studio/src/SpeechInput.tsx`、录音/识别控制器与纯状态helper（合理分文件，例如speech-input.ts / speech-review.ts）及有意义单测；修改PointSpeak.tsx及必要api安全错误helper/本组件局部CSS。不得引入新依赖、改锁、改D1后端或增加接口；不碰Pi tests/e2e与历史证据；不抢做D3资产、D4全局视觉、D5彩排。原instruction-input/generate-candidate和任务取消/重试/选择/同步门禁不改名，不以语音禁用正常文字输入。

## 用户流程与生命周期

1. 仅获取GET /speech/config可用性；挂载不能申请麦克风或开始识别。开始按钮需syncReady/connected/未blocked/未task:create锁/有效当前选择，按住鼠标或聚焦录音按钮Space录音，释放结束；键盘repeat和合成click不能造成第二次录音/POST。只限定按钮焦点，不截textarea空格。
2. 纯控制器以注入MediaDevices/MediaRecorder/recognition/时钟/HTTP适配层便于测试，生产连接浏览器原生API；不得设置生产测试后门。session token阻止旧权限/录音事件/HTTP晚到覆盖新会话。权限pending时释放应取消，权限晚到立即stop所有tracks。
3. 开始用pointer capture；正常pointerup先标记正常结束，不把随后正常lostpointercapture误认取消；异常lostcapture/pointercancel应取消。Space释放只完成一次，不借onClick再次开始。60秒自动正常结束并提示上限；定期收chunks限4MiB，超限取消且不上送；不得伪造MIME。
4. blocked=true（含场景/影响模式）、可写门禁失效、document hidden、窗口blur或unmount任一发生，立即废弃token、stop所有tracks/recorder、清timer/监听器、清chunks。PointSpeak只是hidden不是卸载，必须观察blocked，转写中变blocked不进入review。取消后权限才返回也必须释放。
5. 已发POST的显式取消要有界发DELETE取消该UUID并abort本地POST等待；即使DELETE丢失或网络失败，麦克风/本地资源必须立即释放，晚到成功丢弃。状态提示“取消/断网不保证未计费”。HTTP499按error.code=SPEECH_CANCELLED判断，不靠状态码当通用失败或成功。不要让取消过程锁死UI；监听与promise各自finally安全清理。
6. 每次新录音/用户明确重试用crypto.randomUUID新ID。D1旧失败/取消结果缓存5分钟，不复用ID，不自动retry/切服务。支持MIME取D1集合与MediaRecorder.isTypeSupported交集，兼容带codecs；无API/不安全上下文/拒绝权限/无设备/缺key/上游失败均安全提示并保留文字入口，不在无效配置下暗中发送。

## review、文字与选择绑定

- 转写先到独立可编辑review，绝不自动POST /tasks。开始记录指令revision及完整对象src/cid/baseVersion（无选择也是身份），显示来源，React文本输出，不渲染HTML。转写超过4000字符/空白安全拒绝，不截成另一条指令。
- 原指令后来被编辑时，review保持独立；“使用此文字”变为显式替换/取消，不覆盖用户的新输入。录音结果、浏览器备用都走同一确认路径。
- 录音A、当前B（含无选择↔有选择）时同时显示两者且阻止普通确认，要求用户选“用于当前对象B”或“放弃并重新点选A”；不能偷偷恢复A或默认用B。base改变必须重选，不能授权沿用过期对象。确认后到真正生成前再换对象，重新阻止并确认，不丢绑定。
- recording/transcribing或未解决review冲突期间阻止生成按钮与Ctrl/⌘+Enter，并在真正submit函数里再次检查；普通文字入口/原任务重试默认行为保持，确认文字后仍使用原选择版本门禁和EventCenter任务锁，不制造自动提交。

## 浏览器备用与披露

Web Speech API仅在用户显式选择后可用；先说明可能发送到浏览器厂商服务，不在阿里失败后自动启用，不申请权限或联网探测可用性。API不支持就只留文字，浏览器备用不能冒称阿里成功。中间转写可只做状态提示，最终结果进入review；取消/hidden/blur/unmount时stop/abort并清回调，迟到忽略。服务商变更取消当前会话。

录音按钮旁显示“录音会发送到阿里云百炼识别，转写需确认后提交”，生成指令处显示“指令、选中对象与必要源码发送到已配置编码服务”。不展示key/URL或原始错误payload；支持role=status/alert和清晰键盘焦点。优先testid speech-record/cancel/status/error/review/use/provider/fallback；文字区原testid保持。

## 先失败再实现的关键负例

- 阶段/迟到：权限promise晚到；权限pending时松开/blocked；正常onstop最后dataavailable能完整上传一次，取消丢弃；正常lostcapture不误杀/异常会取消；键盘repeat不重复；60秒/4MiB；没有MIME交集。
- S5：录音切场景后所有tracks ended、无活跃timer/recorder；转写进入影响模式即DELETE/abort且晚到无review；卸载/blur/hidden及门禁失效同样清理。
- S6：A→B、无→有、有→无、基线更新、确认后再改选；未经明确选择不提交B。指令revision变动不覆盖已有输入；最终review编辑才进入原提交函数。
- 错误：503/429/499/5xx、安全错误/坏响应、空/超长转写、DELETE失败，文字入口可用、无自动重发；两次明确重试两个新UUID。
- 浏览器备用未明确选择不启动，选择后的厂商提示可见、结果同样可编辑/冲突确认/无自动任务；不支持时降级文字。
- integration：保留原PointSpeak typed submit、task retry/current selection及mutation lock行为；以可控浏览器API替身验证组件事件（如需真实Chromium只跑本机测试页，不能调用真实麦克风/厂商/阿里服务），不只测一个镜像实现的纯函数就宣称UI已接线。Pi将独立建浏览器E2E，不代写其验收断言。

现有无DOM测试依赖，可复用已有本地React渲染/Playwright工具而不加新包；必要真实浏览器测试须纳入定向runner并真实回收自有PID/端口，fixture失败也要诊断。测试分类明确控制器替身/组件/真实HTTP/mock服务，不能称实机语音质量已测。

## 验证与交付

先针对性RED、再实现及定向typecheck/单测/必要组件连接验证。不要在RED入口加bail后把未执行项记成failed；入口/夹具失败与目标断言失败分开。首个负例成立后无需循环跑到一片红。源/test/runner/guard/HEAD/hash纳入身份，失败先定性后修，不放宽旧阈值/预算或吞cleanup。

所有测试/build/服务/安装等长命令必须从根首次即沙箱外经通知包装`orbital/coordination/m2-takeover/bg-root.cmd`，ASCII相对命令，拿job立即交回，不poll/sleep/第二监视作业，测试期间冻结。使用已验证D1新loopback守卫，不能回退只允许loopback DNS从而破坏IP字面量负例；fake key/白名单env，绝不运行dev/env-file或读取.env/ASKS/真实凭据，无真实录音、阿里、浏览器识别服务、编码模型或Lux3D调用。

本卡定向通过后固定提交再交标准验证（调度安排），不自行重复全仓547或旧E2E。归档新run，SHA清单排除自身，旧失败不覆盖，清理核对真实PID/端口与默认模板/配置。报告M4-D2-impl.md区分已跑/未跑、替身/mock/真实浏览器，未有结果不写通过；精确git add/提交、tracked干净交Claude独立审查，不merge、不标D2/M4正式验收或全项目完成。
