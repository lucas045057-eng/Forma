# M3-A 实现全量验证核验

日期：2026-11-14。Codex 调度核验 CodeBuddy 实现验证原件；不是 Pi 独立验收或 Claude Code 审查结论。

固定提交：`7fad918c93108d3a2f385ac1b0d836ede614a380`，分支 `feat/m3a-approvals`。后台作业 `job_049bdc52` 退出 0，约 52 秒。锁文件 SHA256：`48263def62ed2028e6f747ea1b08be9b4d77435f1b8c0bd52e3db7ef4a3a527f`。

## 结果

核验 `evidence.json` 的全部 20 个步骤：退出码均为 0、signal 均为 null，各步骤前后 HEAD 与锁文件摘要一致、工作树状态为空；最终 HEAD、锁摘要及干净状态也一致。

| 范围 | 结果 |
| --- | --- |
| 七包 typecheck | 全部通过 |
| 七包 build | 全部通过 |
| shared 单测 | 68 通过 |
| source-tag 插件单测 | 20 通过 |
| bridge 单测（node:test） | 1 通过，0 failed/cancelled/skipped/todo |
| scene-renderer 单测 | 5 通过 |
| server 单测 | 160 通过 |
| studio 单测 | 7 通过 |
| 单测总数 | **261 通过** |

原始验证入口是固定提交中的 `apps/server/scripts/m3a-full-validation.mjs`。按包的现有脚本解析本地 TypeScript/Vite/Vitest/Node 入口，顺序执行类型检查、构建和单测，首败即停；不是重新运行后的替代结果。构建仍有既有 Three 分包体积警告；本轮未将提高警告阈值当作修复。

## 证据

原件位于 `.worktrees/m3a/.data/m3a-validation-1794636746586/`。调度另存独立归档 [implementation-7fad918/evidence.json](artifacts/M3-A/implementation-7fad918/evidence.json)，保留 20 份步骤日志、作业原输出和 SHA256 清单 [manifest.json](artifacts/M3-A/implementation-7fad918/manifest.json)。未覆盖 M2 或 Pi 的历史证据，也未修改被验证的 worktree。

## 当前边界

本轮为 fake/mock 实现验证，不包含正式 E2E、真实模型调用或 Lux3D 付费调用。M3-A 独立审查作业 `job_f1c79be9` 已启动，报告待返回；尚未合并 master、尚未交 Pi 独立验收。M3-B 检查运行器与 M3-C 界面尚未实现，不能据本结果宣布 M3 整体过关。测试后的当前进程/端口是否残留需另行核查，脚本退出本身不等同于该项通过。
