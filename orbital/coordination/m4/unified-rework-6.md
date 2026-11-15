# M4统一返工六：Studio浏览器夹具模块启动

整批开发后集中验证；本批不运行type/build/tests/collect/browser/服务/探针，不起job。实现仅m4/feat/m4-demo基 `17228617b46acb66f1e1d4999328f755fc084aaf`，Pi仅验收树2463dd1归档，不改实现。

## 已有结果

job_49d083b5已结束exit1，受测2463dd1，run `2026-11-15T14-34-18-166Z-full`。类型/构建成功，server378/378通过；Studio首次执行为118通过/24失败（142）。demo-safety与全部193 E2E未执行。不是此前两个资产fixture仍失败。

Studio失败来自两文件：speech-app.browser.test.ts的1例，以及speech-browser.test.ts的23例。后者每页原件均有启动pageerror：React jsx-dev-runtime模块不提供jsxDEV导出；beforeEach等待页面就绪超时，afterEach又发现同一pageerror。日志里的47段错误不等于47独立测试失败，不能把所有超时当产品行为缺陷。真实App首例的具体错误按原文单独核对，不能未核就说全部相同原因。

## 一次修改

两处自建Vite配置均 `configFile:false/envFile:false`，`optimizeDeps.noDiscovery:true`，include只有react/react-dom/client/react/jsx-runtime；静态核对实际开发JSX转换所需的react/jsx-dev-runtime和依赖图，修正两个夹具的完整模块加载，不改生产构建、依赖版本或锁，不给React写虚假jsxDEV替身，不靠切production模式逃避开发入口问题。

两个fixture一起静态核查bootstrap、依赖预构建、跨源iframe、pageerror、页面ready握手、收尾和证据通道。模块启动失败应及时输出原始pageerror/URL/阶段，避免每个beforeEach只等10秒而丢具体错误；保留原预算/全部行为断言/no skip/no retry、真实Chromium和明确录音/API替身范围，不将未进入交互的测试改成通过。不要删parentBlur、pending/reconnect、A-B选择确认、录音取消/晚权限/UUID、提交后新文字、原文字与重试断言。保持端口临时分配、envFile禁用、网络白名单以及自有PID/端口关闭验证。

不因单个报错盲改其它产品组件。先静态理解两个fixture共享的模块启动及错误呈现，再一次交付所需修正。失败诊断与清理失败不互相覆盖，未初始化的page/browser/Vite也必须可安全清理；清理不干净仍失败。

写M4-rework-6-impl.md，分清本轮确证/待运行归因、两fixture实际改动、全部未执行项。精确提交固定HEAD，tracked干净fallback未跟踪，保留生产合同/依赖锁/模板/Pi独立套件/旧阈值/历史原件。不merge/push，不读真实.env/ASKS/代理凭据或付费调用。

Pi同时静态归档本轮unit逐包计数、24条测试与错误关联、47段错误的重复结构、component逐页JSON/PNG、real-app与asset清理诊断、preparedDirs、阶段计时、launcher/身份和资源。旧保留现场不随意删除，SHA排自身复算，不自动补跑。两方全部交回后再集中验证，Claude独立审查仍无报告，不能以server全绿替代M4收口。
