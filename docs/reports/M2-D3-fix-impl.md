# M2 D3 实现记录（进行中，未验收）

## 基线与边界

- 工作目录 `.worktrees/m2d3`，分支 `fix/m2-d3`。
- 初始工作树干净，HEAD 为 `5d02dc2`。先快进至冻结 `f70f046`，再合并 `d79c467`，合并提交 `b2d74ae`，保留双方历史，无冲突。
- 未修改主工作树或 `.worktrees/m2fix`，未合并 master；未读取真实 `.env`，未调用真实模型/Lux3D，未更改账号配置。
- 已读主工作树设计、Pi 两份报告及审查“复核（补修）”。本报告不是最终修复交付。

## 初步静态发现（不是复现结论）

- Pi `tests/e2e/m2a/zz-kill.spec.ts:11` 通过全局 `vite.js` 与 `preview-cache` 命令行交集统计进程，没有绑定数据目录、候选 ID、创建时间或父子关系。历史证据只有总数，尚不能确定所计进程是否属于被杀后端。
- 当前 `PreviewManager.start` 实际启动参数为 `node preview-worker.ts <vite.js>`；缓存目录通过环境变量传递，不在参数里。因此这个全局统计也可能漏掉当前 worker。需要实测列出匹配进程，不能直接推翻 Pi 结论。
- worker 在同一进程动态 import Vite CLI；需验证 import 之后的实际 OS 拓扑、IPC 断开及 Vite 监听 PID，不能从接线推断强杀回收已成立。
- 未开始修改实现；尚无本轮父子 PID、创建时间、端口或强杀对照证据。

## N4 接口与合并注意事项

`d79c467` 的资源所有权顺序是 work → assets → scene → events → unlock。D3 的预览停止必须可等待，完成回收后才能让 work.close 返回；重启孤儿清理应在 work-data 实例锁内、候选目录清理之前执行。N4 的请求/作品队列排空和失败时锁保持由 `.worktrees/m2fix` 承载，本分支不重复实现。后续若双方修改 WorkService.init/close，合并须保留队列屏障及预览回收等待，不能仅保留调用而丢失 await/错误语义。

## 当前验证状态

当前 worktree 没有根 node_modules，需要先按锁文件离线安装现有依赖。安装将通过主项目 `orbital/bin/bg.cmd` 从本 worktree 根启动；依用户规则，取得 job 信息后结束本轮，不轮询。后台输出位置由交回消息记录。

- D3 两种真实 OS 强杀与重启回收：未运行。
- service.test.ts / lux3d.test.ts 偶发失败根因：未证实；目前看到相关 mock 使用动态端口，不能据此声称共享端口是根因。
- typecheck / build / 全量单测连续五次：未运行。
- 正式 E2E：交 Pi 执行，本分支未修改其用例或正式证据。
- 本轮尚未启动项目服务或候选进程，无本轮服务树待清理。
