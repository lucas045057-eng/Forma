# M4 D2 录音与可编辑转写 UI 实现记录

状态：D2开发已纳入统一D2–D5交付。先前job_26bba71c实际在Studio类型阶段TS2322失败，后续单测/Chromium未执行；夹具类型已静态修正，按用户新流程不复跑。下文保留开发当时的RED/草稿/原拟验证记录，旧逐卡验证安排由末节统一流程取代。D2未独立审查或正式验收，本文不代表通过结论。

## 固定交接与范围

在既有 `.worktrees/m4`、`feat/m4-demo` 工作。先确认aa43c2a31d5236d1ba1228b63647384c6a4ceb39 tracked干净，再 `git -c core.longpaths=true merge --ff-only 9112c4f9a21ae1f1ccd9f3a51eaa21b73893dce8`，实际快进成功。相对aa43的apps/packages/templates/tests/依赖/锁零差异；没有新建工作树、回退或改主树/旧树。

已全文读取D2任务卡、M4-plan §4/§8/§11、M4-D1-review/integration、根PROJECT_STATE与project_goals。D1独立审查0 blocker/0应修，547标准验证已归档，不重复安装或D1/全仓基线。GET/POST/DELETE代理已有验证，D2不新增重复代理断言，不改D1后端错误码或配置快速失败行为。

仅允许SpeechInput、录音/识别控制器、review/选择绑定helper、PointSpeak、必要局部CSS/API安全错误处理与实现单测。D3资产、D4视觉、D5脚本均未启动，不碰Pi tests/e2e或历史证据。

## 首批失败验证（已实际返回）

新增 `apps/studio/src/speech-render.test.tsx`，3条合同针对真实现有PointSpeak：

1. 保留原instruction-input/generate-candidate，同时提供speech-record/speech-provider及阿里来源/确认后提交说明。
2. blocked状态下录音按钮真实disabled，文字textarea仍可编辑，原生成门禁不放宽。
3. 纯静态序列化不调用HTTP或获取任务锁，明确不是挂载后资源/交互验证。

使用本地React renderToStaticMarkup和EventCenter替身，不新增DOM依赖，不引用尚不存在的SpeechInput来制造导入/收集错误。第一条目标失败成立即可进入实现；bail之后未执行的条目不计failed，测试入口/夹具错误单独定性。

`.data/d2-red.mjs` 仅启动 `pnpm --filter @spatial/studio exec vitest run src/speech-render.test.tsx --bail=1 --reporter=verbose --reporter=json --outputFile=<新run>`，使用已验证D1新loopback守卫（纯IP本地lookup放行、域名DNS/外联拒绝），校验其哈希与归档validated证明。环境显式白名单/fake keys/loopback，不读真实.env/ASKS/凭据，不跑dev/env-file、服务或真实麦克风/阿里/浏览器厂商识别/模型/Lux3D。按根bg-root首次沙箱外启动，拿job立即结束并冻结文件，不poll或加监视作业。

原件 `.data/d2-red-2026-11-15T07-24-09.396Z/` 保留未改写，job_1053e7a9 exit1。原JSON/日志：3条收集，首条真实PointSpeak静态渲染缺少data-testid=speech-record断言失败；余2 pending因bail未运行，没有导入/收集/夹具错误，identityUnchanged=true。不是3 failed，不代表挂载、S5资源释放或录音交互已经验证；未重复该RED、安装或D1基线。

## 新增边界目标（已写，定向验证尚未执行）

- 控制器替身：权限pending松开/blocked、晚到权限stop tracks；正常最后dataavailable上传一次；异常capture取消、正常pointerup/lostcapture不误杀；Space repeat/合成click不双录；60秒/4MiB/MIME交集；门禁/hidden/blur/unmount清理；DELETE失败仍立即本地取消并忽略迟到；499按code取消；每次重试新UUID。浏览器备用只在明确选择后运行，模拟识别回调不调用厂商网络。
- review/绑定：独立可编辑草稿；文字revision变化时显式替换；A→B、无↔有同时显示身份并确认；基线变更重选；确认后再次改选仍在真正submit处阻止，所有入口保留原EventCenter任务锁与选择门禁。识别完成绝不自动POST/tasks。
- 组件/真实浏览器：现有本地React/Playwright工具可用于仅loopback测试页，所有录音/识别API用可控替身；验证实际按键/指针、模式hidden、review编辑、显式确认、生成与重试接线，不能只凭控制器纯函数通过宣称UI可用。Pi独立E2E另做，本卡不代写。

## 当前生产草稿

- `speech-input.ts`：可注入端口的控制器与原生适配，使用稳定session token和事件订阅。正常stop收齐最后dataavailable再上传，取消先废弃token/清timer/chunks/监听器并释放tracks/recorder/识别器，权限晚到立即stop；取消POST立即abort，DELETE单独3秒有界失败提示而不锁本地。录音60秒与4MiB、上传45秒客户端等待预算；MIME必须由服务集合与原生isTypeSupported交集选出，使用实际recorder.mimeType。499仅按SPEECH_CANCELLED code处理；每次新录音均新UUID，无自动重发或自动切服务。
- `speech-review.ts`：绑定src/cid/baseVersion、主版本、指令revision和选择代次；代次覆盖A→B→A，不因回到同一身份就复活旧确认。无↔有同样显式确认；指令录音后被编辑需明确替换；版本变化采取保守路径，放弃此次转写、重新点选录音，不能沿用过期对象。
- `SpeechInput.tsx`：只挂载GET配置，不自动录音；pointer/Space与取消、来源/厂商披露、独立可编辑review。正常pointerup先结束手势，随后lostcapture不取消；时长自动停止/浏览器自然结束后的失焦不误删结果。blocked/门禁、hidden/blur/unmount均取消并清本地。原生WebSpeech只在用户明确选择后创建并start；不支持则保留文字入口。
- `PointSpeak.tsx`：保持原instruction-input/generate-candidate、任务选择/取消/重试和EventCenter任务锁。识别只到review，使用文字不自动/tasks；采用后记录确认绑定，真submit与Ctrl/⌘+Enter都再检查speech忙态及对象绑定，变化后需再次明确确认；原任务重试仍使用retrySelection的原范围，语音review未完成时禁用。原指令编辑不被迟到结果覆盖，放弃已确认语音绑定会清空其语音指令，避免留下脱离对象的旧文本。
- `speech-api.ts`：GET配置、raw POST/UUID与DELETE，安全码映射，坏响应/错UUID/空或超长文本不接受，不渲染原始错误payload；局部speech-input.css无全局视觉改动。

所有草稿尚未经定向验证；未改D1后端/shared/依赖/锁、Pi tests/e2e或历史证据，没有新增生产测试后门。

## 真实浏览器组件连接范围（已写，尚未运行）

`src/speech-browser.test.ts` 使用已安装Playwright Chromium，Vite显式configFile=false/envFile=false、不运行dev脚本，动态自有loopback端口、独立缓存目录。实际加载PointSpeak/SpeechInput/控制器/API代码及本组件CSS；EventCenter通过仅测试配置的别名替换为可控context，`test-support/speech-harness.tsx` 驱动真实React状态，原任务API走本机HTTP stub。录音MediaDevices/MediaRecorder及浏览器recognition均由页面初始化脚本替换，不调用真实麦克风或厂商服务；浏览器除本测试origin外请求被拦，后台网络特性关闭。

已写交互：实际pointer按住/松开与原生capture丢失；Space repeat/合成click；hidden而不卸载、受控visibility/blur、门禁/unmount取消；权限pending松开后晚到；转写中hidden与DELETE失败；review编辑、A→B/无↔有、版本变化、文字revision显式替换、确认后再改选与Ctrl+Enter；HTTP499与新UUID；显式浏览器备用；原始文字路径和原任务retry范围。截图在卸载前记录实际UI，JSON分开记录before/after unmount及stub请求，不把其当真实D1后端或Pi独立E2E。

夹具真实回收BrowserServer对应PID及子进程，并按OS创建时间排除PID复用；关闭Vite与browser websocket端口后实探不可连接；cleanup记录原件，失败保留缓存并使测试失败，不吞错误。Chromium版本/退出码、源身份、报告及截图均写本轮新run；尚未执行前不宣称零残留或通过。

## 本轮定向入口与未完成事项

`.data/d2-green.mjs` 首先校验交接HEAD与D1已验证新guard SHA，再依次执行：

1. `pnpm --filter @spatial/studio typecheck`。
2. 控制器/review/API/真实组件SSR、既有pick-state及approval-render定向Vitest，不包含D1基线或547全量。
3. 单独的真实Chromium组件连接测试；仅前序全部成功才启动浏览器/测试Vite。

首失败即停，以实际JSON区分passed/failed/pending与夹具错误。白名单环境/fake keys/loopback新守卫，明确本地已安装浏览器目录，不下载、不安装、不读.env/ASKS/凭据。记录源码/测试/入口/守卫/锁/HEAD与工作区、命令/PID/时间/退出、新run日志/JSON/截图及排除自身的SHA清单。拿job立即结束冻结，不poll/监视或边测改文件。

结果返回后才确定定向是否通过及还需修复的边界，再按调度安排标准轮与Claude/Pi独立检查。当前无真实识别质量/延迟结论、不提交为成品、不自行合并或标D2/M4验收完成。

## 用户统一开发指令后的交接更新

job_26bba71c已结束exit1，原件 `.data/d2-green-2026-11-15T07-55-25.687Z/`：Studio typecheck报speech-browser.test.ts:49 TS2322，Vite HttpServer联合类型不能传给只接受node:http.Server的旧helper；其余单测及Chromium0执行，identityUnchanged=true。现将新夹具改为直接使用Vite httpServer的共同listen(0)/address/error能力，未用any强行放宽旧helper，未重新运行类型或浏览器。

旧入口RED和该类型失败分别归档到 `docs/reports/artifacts/M4/D2/prior-development-results/`，16个载荷静态复制并登记SHA，排除清单自身；原.data日志/JSON/manifest均未改写，不把3条收集写成3失败，不把类型失败说成已跑组件测试。

用户要求先完成剩余全部开发再集中测试。已保留全部原草稿，在m4安全快进2eadea59统一文档，连续完成D3–D5，不启动任何新验证/构建/服务/审查，不为每个模块再请求派单。D2完整代码与测试留作集中执行，新增离线demo标识使固定转写不冒充真实阿里识别，离线模式禁用浏览器厂商备用。

最终模块、接口、静态修正、未运行清单及固定交付以 `M4-development-handoff.md` 为准；本报告的历史未运行或失败不会改写为通过。
