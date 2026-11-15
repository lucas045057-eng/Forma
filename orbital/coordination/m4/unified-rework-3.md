# M4统一返工三：集中单测暴露的三项问题

用户流程不变：先一次完成整批开发，再集中验证审查。本批不运行任何测试、类型检查、构建、collect、服务、浏览器或探针，不逐项试跑。实现仅 `.worktrees/m4` / `feat/m4-demo`，起点 `1aa54500ebab4efd5cd457b94c145e71880990df`。

## 本轮事实

`job_f4565bb7` 已结束，整体exit1/4m56s，受测验收merge `e863f261e0263e857c71cefd785bbed7c42e6f3d`，产品1aa5450。原件在Pi树 `docs/reports/artifacts/M4/regression/2026-11-15T12-48-33-510Z-full/`。typecheck与build均code0；unit code1，server 375 passed/3 failed（378）。Studio单测未启动；demo-safety和全部E2E共11步骤未执行。193仍仅收集数。Pi另行精确核总数和清理，不改产品。

原TS1375和Buffer错误在这次类型检查未出现；不能用这两项成功宣称全仓运行验收完成。Claude返工二复审已保存根提交76aefa4：0 blocker/0 should-fix/3建议。本批不因这些建议扩全仓moduleDetection或无关功能。

## 三项一次诊断修正

1. `assets/fallback-process-lifecycle.test.ts:42`：`Timed out waiting for deterministic model import barrier`。阅读真实worker、测试parent、loader注册及加载器通信，查清屏障实际在哪个线程执行、能否向目标父进程报告、是否早退及stderr被丢失。修复测试接线或真实缺陷，不能仅加超时/skip/删屏障。必须仍证明：worker已进入受控处理中才杀测试父进程；worker自身感知IPC断开退出；raw输入完整、不发布半成品；重启清掉自有staging并标中断。失败清理也必须追踪屏障就绪前已启动的worker归属，不能等取到worker身份才有清理责任。不要在生产HTTP/env新增测试暂停后门，不改变生产execArgv清空或disconnect先注册顺序。
2. `assets/fallbacks.test.ts:67`：真实 `{}` HTTP导入202后，期待fallback来源，但返回 `{kind:'unknown'}`。查明合同和异步阶段：来源是否应在raw接收时存在，还是仅在ready且outputHash验证后可信；不能为了测试把尚未核验的输出宣称可信。若测试错把202受理当处理完成，改为真实等待终态并验证来源/实际模型hash；若生产丢失来源则修生产。保留危险字段400、无副作用、preset固定来源、ready后hash核验等原安全断言，明确受理阶段与成品证明。
3. `assets/recovery.test.ts:85`：`does not resubmit after taskId persistence fails, even after restart` 抛disk full，堆栈来自service.save。新粘性持久化失败会让close拒绝且保留实例锁，旧用例仍无条件await close然后在同活PID重启。审清是既定关闭合同与旧测试前提冲突，还是新实现错误；不得吞生产jobFailure、假close成功、释放活锁或删活锁来绿灯。保留原“上游create恰好一次、未知结果不重复计费提交、显式import可恢复”断言。若需要进程死亡后重启，用受控真实子进程/PID创建时间模拟崩溃，并区分持锁失败与死PID接管；所有fixture有界、只收自有资源。具体方案由实现者结合现有代码确定，报告说明理由。

## 交付约束

三项及必要同源接线一次处理完，允许补写测试但不执行。阅读根 `docs/reports/M4-rework-2-review.md` 和本树返工二报告，保持当前隐私/取消/审批/采用门禁、持久化所有权及不重复计费约束。不要更改Pi独立E2E、旧阈值/skip/retry、依赖锁、默认模型/sidecar、历史证据。原报告和失败原件不改写。

写 `docs/reports/M4-rework-3-impl.md`：逐项根因、产品或夹具归属证据、接口/状态语义、测试新增及未执行清单；没有运行结果不能写验证通过。静态diff/hash/Git检查允许。Git全程longpaths，精确add，无reset/clean；fallback未跟踪不入库，不动验收/主线/旧树。全部完成后固定提交tracked干净交回，不merge/push，不创建验证job。

Pi并行只做当前失败轮归档/身份/精确计数/资源核对，不自动补跑。新批固定后Codex统一安排集中验证和有限差异复审；真实阿里、真人A-B、完整彩排与真实Windows控制台Ctrl+C仍按实际边界列未执行，不读真实.env/ASKS/凭据或付费调用。
