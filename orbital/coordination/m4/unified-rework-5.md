# M4统一返工五：Windows测试预加载模块URL

本批整批开发后集中验证，不逐项试跑。CodeBuddy仅实现树m4/feat/m4-demo基 `c79fbfca89e8a04161be42b4b0f9ee4943ab2da5`；Pi仅验收树d6d46e6归档本轮，不改产品或测试。

## 已有运行证据

job_2d4484eb已结束，run `2026-11-15T13-51-08-829Z-full`，受测d6d46e6，产品c79。typecheck/build成功；server376 passed/2 failed（378），Studio单测、demo-safety和全部193 E2E未执行。unit记录preparedDirs D2_RUN_DIR ok=true，两个asset诊断文件实际落盘。审批恢复超时本轮未复现，不能凭单轮通过断言性能根因已证。

两个失败的stderr现在相同：`ERR_UNSUPPORTED_ESM_URL_SCHEME`，默认ESM loader拒绝Windows绝对路径被当作 `e:` 协议，提示必须有效file URL。生命周期worker在加载屏障之前exit1；持久化fixture在preload/entry前exit1。不是worker自主断开失败或产品写盘合同被运行证伪。

## 一次修改范围

静态核对两处已确认错误调用：

- `apps/server/src/test-support/asset-parent.ts` 的fork execArgv：`--import`后把asset-loader-register模块URL用fileURLToPath变成了Windows路径。
- `apps/server/src/assets/recovery.test.ts` 的spawn argv：`--import`后把asset-persistence-register模块URL同样转成Windows路径。

这些预加载参数应保留 `new URL(..., import.meta.url).href` 等有效模块URL，不要先转成本地盘符路径。区分ESM模块标识与spawn/fork入口、文件系统路径，不要把所有路径全局替换成URL。对本批相关loader/preload/注册/动态import再做一次静态调用点核查；修同源问题但不重写加载器、不扩大生产接口。保留精确target匹配、实际模块求值IPC屏障、活锁失败/真死PID接管/create仅一次、ready来源hash、早退stderr/阶段证据及主错误/清理聚合。不得延时、skip、retry或删断言。

仅必要测试接线和交付报告；无生产语义、依赖锁、模板/默认来源、Pi套件/runner/旧像素阈值或历史原件改动。旧worker stderr已保留，不能把这轮明确信息倒写成旧轮也已知原因。

写 `docs/reports/M4-rework-5-impl.md`，一次精确提交固定HEAD、tracked干净交回。开发时不运行type/build/tests/collect/browser/服务/探针或审查，不创建job，不merge/push。静态源码/Git diff/hash允许。fallback未跟踪，不读.env/ASKS/代理配置或凭据，不付费调用。

Pi同步归档本轮日志、manifest、launcher、preparedDirs、两个asset诊断以及审批阶段计时，保留失败现场归属和清理核查，SHA排自身并复算；不重新运行验证。双方交回后再统一冻结集中阶段。Claude独立复审三次ECONNRESET仍欠报告，不能拿新类型/运行成功替代审查，主线不合未验M4。
