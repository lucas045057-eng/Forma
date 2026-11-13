# M2 N4 停机屏障实现（待验证/审查）

## 来源与范围

- 调度正式将 N4 移交本分支 `fix/m2-d3`；基于已包含 d79c467 的现有工作树，不合并 master。
- 只读使用根 `orbital/coordination/m2-takeover/n4-draft.patch` 与 snapshot.json。原草稿 HEAD d79c467，patch SHA-256 为 f04f997f2d1a9257bc0bcdc348f0557540674996a976c5a3b1fbd9f1b82a6fab。`git apply --check` 成功后仅在本工作树应用并改进。没有修改、提交或还原原 m2fix/主工作树。
- Pi 真 HTTP 失败证据 `docs/reports/artifacts/M2-A/takeover-n4-shutdown.json`：operationAcceptedAndBlocked=true 时 lockHeldWhileBlocked=false、第二实例 started=true，version.changed 与作品写入在解锁后发生。它是修复前缺陷证据，不是通过记录。

## 实现

1. Fastify preClose 只关闭 HTTP 新请求准入，不等待作品队列；websocket 插件自身的 preClose 负责关闭升级连接。已接收请求继续运行，包括在请求体解析/作品队列等待阶段的请求。
2. 资源清理移至 onClose，即 Fastify 等待 HTTP 请求完成之后。此时才调用 WorkService.close：取消/等待 Agent 任务收尾，repo.drain 拒绝新的顶层 repo 操作并等待已有队列，然后停止预览、等待状态写盘。
3. WorkRepo 的 AsyncLocalStorage 重入检查早于 closing 检查；已经进入队列的操作运行在既有 scope 中，其内部 snapshot/head 等调用仍可完成。HTTP 准入与 repo 排空是不同阶段，不能在 preClose 一刀切禁止尚未调用 repo 的已接受请求。
4. 正常资源顺序为 work → assets → scene → events → work-data unlock。EventLog.close 后 publish 明确拒绝，这是补充防线，文件写入安全依靠前面的请求/任务/作品/场景屏障。
5. 若任一生产者关闭失败，仍尝试其余生产者清理，但不关闭日志、不释放 work-data 锁；初始化失败也使用同一路径。若仅构造失败且已登记生产者均成功停止，则正常关日志解锁。保守保锁可能需要进程重启恢复，不冒称关闭成功，也不允许第二实例接管仍可能有写入者的数据目录。日志关闭本身失败也不会继续解锁。

## 验证代码

`apps/server/src/events-lock.test.ts` 保留 F4/N3 原有用例，并增加/改进：

- repo 已入队操作阻塞时开始关闭，用可控 drain 信号代替草稿的固定睡眠；排空前锁保持，新顶层 repo 调用拒绝，旧操作的事件写入在关闭前完成。
- 独立临时作品目录、动态端口的真实 HTTP GET /version：暂停 snapshot、启动 app.close、第二实例必须 INSTANCE_LOCKED、新请求 503；释放旧操作后 HTTP 200，真实 Git 快照及 version.changed 完成，关闭后 repo 写入口及日志拒绝，重启 seq 接续。
- 注入 work.close 失败：其他资产生产者仍收到 close，第二实例仍被锁拒绝，日志仍可承载尚未确认停止的生产者。测试 finally 恢复关闭方法并明确停止全部 fixture 生产者后移除临时目录。

这些是实现侧回归，不修改或替代 Pi 正式 E2E。新 HTTP 测试使用 node:http，避免浏览器 fetch 的禁用端口策略干扰动态端口的服务生命周期验证。

## 当前状态与限制

- `git diff --check` 已通过；typecheck、上述测试及原有单测待通知包装后台结果，尚不能宣称 N4 已修复验收。
- 固定实现提交及后台 job id 以交回消息为准。后续仍需 Claude Code 独立审查、Pi 真 HTTP 正式回归和最终冻结 HEAD 验证。
- D3 强杀两种场景未复现，身份/端口与局限已在 M2-D3-fix-impl.md 更新（0049ada）；没有为旧全局数量盲改 preview/worker。重启孤儿回收仍缺独立证据。
- service.test.ts/lux3d.test.ts 偶发失败尚未归因：动态端口上的 Node fetch bad-port 是已复现机制，但未与原失败端口关联，不盲改超时/重试/断言。本轮后台定向运行这两个文件以收集结果；连续五次全量、build/typecheck 最终验证尚待完成。
- 全程不读真实 .env，不安装依赖，不使用真实模型/Lux3D，不修改账号配置。
