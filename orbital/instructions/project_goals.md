# 项目目标（初稿）

本项目是「空间化 AI 创作工作台」：一个 React + TypeScript(strict) + Vite 的同源工作台，把网页/模板作品变成可点选、可对话、可修改的空间化创作对象——Studio 提供工作台与选取开关，bridge 负责作品页内的悬停/多实例高亮与消息桥接，vite 插件在开发态注入源码位置标记，server 负责资产与 Lux3D 3D 任务，目标是让 AI 能按用户意图改动真实源码与真实 3D 场景，而不是改一份脱离源码的副本。

- 目标形态：以 `templates/product-page` 这类真实模板为起点，跑通「点选 → 理解 → 修改 → 同源预览」闭环，选取结果要精确到源文件的行列与组件标识。
- 3D 方向：页面内 3D（Lux3D / SpatialModule）可就地放置、所见即所得地确认，并与资产上传、任务幂等打通。
- 完成标志：`pnpm typecheck` / `pnpm build` / `pnpm test` 全绿，且有覆盖真实浏览器行为的 Playwright 验收用例（里程碑按 M0-A、M0-B、M1、M2、M3、M4 递进）。
- 技术约束：Node 24、pnpm 11（lockfile 固定）、TS strict、端口固定且 strictPort；同一源预览链路上不得破坏模板自身交互。
- 工作方式：中文交流，先给结论再给依据；用户常要求「只查不改」，此时严格只读并明确说明未做修改；诊断要有实测证据（连通性探针、构建输出），不靠推测。
- 协作分工：多 agent 并行（codex、dsh、kimi-code、pi），正式的 Playwright 浏览器验收由 pi 负责。
