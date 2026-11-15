# M4 统一返工二：模块声明与复审收口

用户要求全部开发完成后集中测试审查。本批一次处理完再交回，过程中不运行类型检查、构建、测试、collect、浏览器、服务、探针或新审查，不按单条问题循环验证。

## 固定输入与失败事实

- 实现树 `.worktrees/m4` / `feat/m4-demo`，固定 `01c85fe18ebcb24c0a010621e53f71f475e7320f`；仅本树修改产品和实现测试。
- Pi 受测树 `.worktrees/m4-acceptance`，受测 HEAD `eece9e100a2c4a0bcf0e6ff84667d0a2bcea4cdd`，产品/脚本与 `01c85fe` 一致。不要修改这个树，Pi 单独归档。
- `job_9415a4a3` 已结束，整体 exit 1 / 14s；run `docs/reports/artifacts/M4/regression/2026-11-15T12-35-07-124Z-full/`。
- typecheck 子步骤 exit 2，日志显示 `apps/server/src/assets/process-worker.ts(8,28)` 和 `(9,18)` 两条 TS1375：没有静态 import/export 的文件不是模块，顶层 await 不合法。不是旧的 Buffer 错误复发。
- 0 单测、0 脚本测试、0 E2E；build 等后续 13 步未执行。M4 的 19 + 旧 174 = 193 仍只是收集数。
- 根 `docs/reports/M4-rework-1-review.md`：原 8 项代码层已修，新 blocker/should-fix 均 0；运行确认仍欠缺，不改写旧报告，不把审查通过写成验收通过。

## 一次处理范围

1. 修复 worker 的 TypeScript 模块声明，保持先注册 disconnect、检查已失联、再加载重模块的执行顺序；不得改回加载后才注册，不禁用类型检查，不使用 ts-ignore/any 掩盖。静态检查同批新增入口是否还有同类问题，不启动编译探针。
2. 吸收复审建议 1、4、5、6、7 的文档准确性部分：runbook 明确 mock 网络守卫仅覆盖 backend/frontends 主进程，资产/预览/检查子进程没有该守卫；不能声称整个进程树被强制离线。记录中间父进程先死可能漏遍历、正常 Ctrl+C 超时强杀的已知限制及集中验证要求；记录索引保存失败持锁/cleanup_failed 的处理办法。设计写清成功提交后留下的文字按普通文字再次提交的语义。不要为这些非阻断项扩建另一套进程管理或改产品交互。
3. 吸收建议 2、3、9 的实现测试稳健性：真实 App 用例增加真实父窗口 blur 证据；watchdog 测试按 role/命令行确认必须存在的自有进程，避免 conhost 导致恰好四个总进程的假失败，同时保留所有发现后代退出与无关进程不受影响的断言；junction 清理使用明确的链接删除操作，检查绝对路径和归属，不递归进入链接目标，不吞清理失败。
4. 建议 8 保留为集中验证边界：现有父死测试不经过生产 spawn 接线、Windows 限定；本批不增加 skip 来减少当前 Windows 验证范围。其余建议逐条标处理/保留限制/待运行，不升级成额外项目。

## 范围和交付

完整阅读根复审和原返工实现报告后处理上述整批。补写测试可以，但本批不执行任何验证。不要修改 Pi 独立 E2E、旧断言/阈值、安全预算、依赖/锁、默认 GLB/来源 sidecar 或历史证据；不读真实 .env/ASKS/凭据、不做真实阿里或其他付费调用。真实语音主链仍为阿里云百炼。

静态读取/diff --check/真实字节哈希/Git 核对允许。Git 全程 `-c core.longpaths=true`，精确 add，无 reset/clean；fallback 保持未跟踪，不入库。不要为读取根任务文档强行合并主线。

写 `docs/reports/M4-rework-2-impl.md`，列出本轮 TS1375 事实、改动、复审九建议逐项处置、测试新增但未执行、所有未执行边界；旧失败/审查报告保留。全部完成后提交固定 HEAD、tracked 干净交回，不 merge/push，不启动验证作业。

之后由 Codex 统一冻结，Pi 从头跑同一集中入口，Claude 核对本批有限差异；不拿旧 D1 或 M3 成绩抵扣新字节。
