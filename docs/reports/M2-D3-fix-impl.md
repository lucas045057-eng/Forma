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

续作已核验：HEAD 为 `fc5c9ff`，分支 `fix/m2-d3`，工作树起始干净，冻结基线均已包含。调度安装后根与 server 的 node_modules 已存在；Node v24.14.1、pnpm 11.17.0，按模板/server package.json 分别解析 Vite/Fastify 成功。首次从根 eval 使用 import.meta.resolve 的 parent 参数解析 Vite 失败，改用包内 createRequire 验证成功；这不是安装缺失。

新增实现诊断入口 `apps/server/d3-diagnostic.mjs`（不属于 Pi 正式 E2E）：通过真实 createApp、loopback mock 模型、独立作品副本/数据目录和动态端口生成候选；逐文件复制 Git 跟踪模板，跳过环境文件，不读取服务 .env。分别强杀实际 backend node PID 和外层 launcher 树，记录 CIM PID/PPID/创建时间/命令行、监听归属、实际候选 HTTP 200、1 秒与 30 秒后快照，并保存 Pi 全局匹配结果用于核对统计口径。finally 仅结束本轮树内且 PID/创建时间/命令行仍一致的进程；保存清理后快照。证据落在本 worktree `.data/d3-diagnostic-<时间>/evidence.json`，不覆盖 Pi 正式证据。

脚本已通过 `node --check`、包内依赖解析及 `git diff --check`。拟通过指定 bg.cmd 启动真实复现；作业 ID/输出/停止命令以启动返回值和交回消息为准，启动不等于复现完成。重启回收及异常启动/取消对照仍待基线结果后接续。

- D3 两种真实 OS 强杀与重启回收：未运行。
- service.test.ts / lux3d.test.ts 偶发失败根因：未证实；目前看到相关 mock 使用动态端口，不能据此声称共享端口是根因。
- typecheck / build / 全量单测连续五次：未运行。
- 正式 E2E：交 Pi 执行，本分支未修改其用例或正式证据。
- 本轮尚未启动项目服务或候选进程，无本轮服务树待清理。
