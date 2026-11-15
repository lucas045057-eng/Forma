# M4 统一返工七：原生指针捕获前提与取消路径（未运行验证）

日期：2026-11-15。仅实现树 `.worktrees/m4` / `feat/m4-demo`，基 `7f300f120c7b7e8947979f008bb19923d36077f3`，原tracked干净、fallback未跟踪。只做静态诊断和开发，不merge主线，不改Pi树。

**本批没有运行typecheck/build/test/collect/browser/服务/探针或审查，没有创建job。新事件前提及取消断言仍须集中实测，不把源码判断当运行通过。**

## 原件关联与实际失败位置

只读Pi原run：`docs/reports/artifacts/M4/regression/2026-11-15T15-25-23-020Z-full/`，job_fde9d7f2已结束。交接记录为类型/构建通过、server378全过、Studio141过/1败，后续demo脚本/E2E未运行；不把单测进展写成M4通过。

唯一失败确切对应 **`d2-browser/component/6.json` 与 `6.png`**，JSON的test字段就是 `abnormal native pointer-capture loss cancels without uploading`，不是按截图位置猜测序号。

- unit.log完整失败段为 `Matcher did not succeed in time`，原 `speech-browser.test.ts:140:104`，cause为 `AssertionError: expected 1 to be +0 // Object.is equality`。发生在mouse.move之后、mouse.up之前等待`liveTracks===0`，没有运行到该例最后的正常鼠标松开。
- 6.json：bootstrap为interaction/ready=true，errors/resources/pageErrors/denied/cleanup全空；beforeUnmount中streams=1、liveTracks=1、recorderStarts=1、recorderStops=0、parentBlurs=0。posts/deletes/tasks均空。
- afterUnmount中liveTracks=0、recorderStops=1。这只说明测试清理阶段最后释放了资源，不证明异常失捕获已取消。
- 6.png显示“松开结束录音”“取消语音”“正在录音，松开结束”，没有review。与JSON仍在录音吻合，不是模块启动失败或已完成上传。

旧原件未记录got/lost捕获事件，**不能从它证明native lostpointercapture已经派发并被产品忽略**；同样不能把“没有上传”当成取消已生效。

## 静态根因与归属

原测试在pointerdown后只等待liveTracks=1，就调用releasePointerCapture，之后才第一次移动鼠标。`setPointerCapture`建立的是pending capture target；录音权限Promise/recorder就绪并不会替代浏览器处理下一次指针事件、激活capture。**原用例缺少“原生捕获已经生效”的必要前提**：既没驱动/观察gotpointercapture，也没记录实际lost事件。

在capture仍pending时释放会撤销待生效捕获，而非保证产生一次active capture的lost通知；随后移出按钮也不能补造那次lost。这条静态事件顺序可以解释原件里录音继续、没有停止或上传。历史原件没有事件trace，故不冒称已用原数据证明每一个浏览器内部事件，后续须由新增trusted事件记录确认。

本批归属为**实现侧浏览器夹具前提/证据不足**，不是已经证明的生产取消缺陷。静态核查生产分支后没有发现需要改写的取消条件；不为让用例绿而改变正常松开语义，也不声称生产路径已重新运行验证。

## 唯一测试文件的修改

修改 `apps/studio/src/speech-browser.test.ts`，生产组件、控制器和手势helper均不改。

1. 只在正常松开对照与异常失捕获两例安装被动的原生事件观察：pointerdown/gotpointercapture/lostpointercapture/pointercancel/pointerup，记录type、isTrusted、pointerId、buttons、hasPointerCapture与当时轨道数。没有dispatchEvent或合成PointerEvent。
2. 异常例仍用真实Chromium鼠标down开始录音，保留liveTracks=1并确认recorder已启动；在按钮实际边界内进行一次真实mouse.move，等待trusted gotpointercapture且capture有效，再核原生pointerdown的同一ID及hasPointerCapture。
3. 只有这些前提成立才调用真实DOM releasePointerCapture，接着真实mouse.move出按钮；必须观察同ID、仍按住时的trusted lostpointercapture，且在此之前没有pointerup。不能把正常松开后的lost当异常。
4. 保留原liveTracks必须归0、posts必须为0的断言，并增加recorderStops=1、取消文案明确来自“录音指针捕获已丢失”、随后真实mouse.up也不上传、不进入review、不建任务。
5. 正常松开对照仍沿原record()的真实down/up路径，确认trusted pointerup，原final音频5字节、POST恰好1次、review显式B确认后才生成等断言不删。
6. 在afterEach卸载之前读取指针trace，附入同一component JSON，沿原截图/primary/bootstrap/指标/请求/清理证据写入。观察器不阻止默认行为、不停止冒泡、不调用产品事件处理器；页面/元素销毁后自然释放。

用例30秒预算及其它matcher原预算不增加，不加skip/retry，不删除原安全断言；没有新增测试数量预填或新运行证据。

## 同源事件路径完整静态审计

| 路径 | 源码顺序和异步保护 | 本批处置 |
| --- | --- | --- |
| pointerdown | 左键且未disabled才setPointerCapture，start由PressGesture.begin避免双录，控制器创建新token/UUID后等待权限 | 不改；新异常用例补capture从pending到实际got的前提，不能只等权限 |
| 正常pointerup | PressGesture.end先清有效手势，再controller.finish；finish先设finishing/进入transcribing，再stop录音器并停轨道，最后dataavailable/stop只上传一次 | 不改；正常对照保留恰好1次上传；随后正常lost没有有效手势，不能误取消 |
| 异常lostpointercapture | 同ID且仍有pointer手势时lost清手势；控制器仍处permission/recording则cancel | 不改；新用例必须看到trusted got→trusted lost且尚无up，才要求轨道归0和零上传。若事件确实出现而资源未清，测试仍红并有trace，不忽略事件 |
| pointercancel | PressGesture.lost清同ID手势，调用controller.cancel；native cancel之后的lost/up因手势已清不重复finish | 不改；不是通过一律取消pointerup达成，观察器也记录native cancel用于后续归因。此次没有新增原生pointercancel运行成绩 |
| 显式取消/blur/hidden/门禁/卸载 | clearPress先清手势，再释放已持有capture，之后controller.cancel/dispose；手势先清避免释放capture反过来重复处理 | 不改。S5在途取消、已完成review保留/放弃规则保留 |
| 权限晚到 | cancel先清active并递增token；旧getStream返回时current失败立即stop所有tracks，不建recorder/不上传 | 不改，原晚权限测试保留 |
| 取消与最后音频/stop竞态 | cancel先使current失效，再detach/stop、清timer/chunks/stream及abort；即使stop已排队，回调current/finishing检查不能恢复旧会话或开始上传 | 不改，原控制器资源释放与迟到结果断言保留。新失捕获例松鼠标后仍核零上传 |
| 已经合法finish后的lost | 正常up已清手势；时长上限主动finish已经进入transcribing时，lost不再被当成仍在录音的取消。真正blur/门禁变化仍有独立的在途abort/DELETE路径 | 保留既有完成语义，不为单个夹具把所有正常release变取消；没有新增预算/竞态的运行结论 |
| 已发送转写的取消 | 本地先清资源和abort，有界DELETE；失败只更新同一取消token的提示，迟到success因token/current失效不能重开review | 不改，UUID、取消不保证未计费、无自动重提的合同保留 |

上表是静态源代码审计，不以旧控制器单测通过替代新native事件证据。新记录中capture阶段监听器的tracks取值发生在React事件处理之前；不能把lost事件行里的tracks=1本身误读为处理后仍未释放，需结合后续liveTracks/停止次数和状态断言。

## 静态范围与后续

已静态读取上述源文件、原失败完整堆栈、精确6.json及6.png；只修改一个实现测试文件和本报告。没有修改SpeechInput/Controller/PressGesture、其它已过领域、真实App用例、API替身、依赖/锁、模板模型/来源、Pi独立E2E/runner/阈值、历史原件或旧报告；fallback继续未跟踪、不入库。不merge/push。

本批没有读取真实.env/ASKS/代理或提供商凭据，没有真实语音/厂商识别/编码/Lux3D调用。代码里的指针、capture与浏览器操作均为**未执行的新测试代码**，本轮未启动浏览器/服务/探针，没有job。新固定HEAD交回后由Codex安排统一集中验证与独立复审；Claude复审仍因服务失败欠报告，不当通过。

需要集中证明：trusted capture确实生效、异常lost在up之前发生且直接触发取消、正常up仍只上传一次、其它保护无回归。旧193 E2E及demo脚本本轮未跑到；真实阿里质量/真人A-B/完整彩排、真实Windows Ctrl+C及生产全链等仍按独立证据标未执行或未覆盖。项目与M4未验收。
