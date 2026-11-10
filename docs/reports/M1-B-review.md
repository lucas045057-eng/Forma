# M1-B 写回接口与 Studio 3D 面板 · 审查报告（Claude Code）

- 日期：2026-11-10。审查人：Claude Code（用户指定 M1 本次由调度兼做实现与审查，测试仍由 Pi 做）。
- 范围：合并提交 5f5c8ad（4846b27、4c32439、1d7720f、291bd97），读的是 master 上的源码全文：`apps/server/src/scene/service.ts`、`apps/server/src/app.ts`、`apps/studio/src/SceneEditor.tsx`、`apps/studio/src/App.tsx`、`packages/shared/src/scene-edit.ts`、`packages/scene-renderer/src/*`。
- 结论：**有条件通过 → 应修项已在本轮修复（见 `M1-fix-impl.md`），待 Pi 测试后可转通过。** 阻断 0，应修 2（均已修），建议 5（未改，记录在案）。
- 验证方式：读代码 + 修复后跑 `pnpm typecheck`、`pnpm build`、`pnpm test`（182 项全过）与已有三套 e2e（M0-B 24、M0-A 27、M1-A 7 全过）。**M1-B 自身的浏览器端到端验收我没有做，交给 Pi。**

## 应修（已修）

### B1 · 后端只校验“同源”，挡不住 DNS 重绑定
- 位置：`apps/server/src/app.ts` 的 onRequest 钩子（M0-A 起就有，M1-B 新增的写接口让后果变重）。
- 问题：钩子只比较 `Origin` 与 `Host` 是否一致。攻击者域名解析到 127.0.0.1 后，浏览器发来的 `Origin: http://evil.example:3001` 与 `Host: evil.example:3001` 相同，校验通过。于是任意网页可以调 `PUT /scene` 改作品、`POST /assets/:id/adopt` 往作品目录写文件、`POST /assets/lux3d` 花 Lux3D 额度。
- 修法（已做）：增加 Host 白名单，只接受 `localhost`、`127.0.0.1`、`[::1]`，其他主机名须写进 `ALLOWED_HOSTS`（或 `createApp({ allowedHosts })`），否则 403 `HOST_DENIED`。Vite 代理不改写 Host，Studio 经 5173 访问不受影响。有单测。

### B2 · 场景历史文件无上限
- 位置：`apps/server/src/scene/service.ts` 的 `Journal.entries` / `stack`。
- 问题：每次写入追加一条含两份完整配置的记录，且每次提交都重写整个历史文件；拖滑杆保存几百次后文件与写入耗时线性增长。
- 修法（已做）：`entries` 与撤回栈各保留最近 50 条（`MAX_HISTORY`）。有单测（55 次写入后各 50 条，序号仍为 55，撤回正确）。

## 建议（未改）

1. **“记为此处关键帧”会丢掉未保存的灯光/相机草稿**（`SceneEditor.tsx`）：关键帧只写 rotation 与 lid，保存后 `applyConfig` 用服务端配置覆盖草稿，用户刚调的灯光不提示就没了。建议保存关键帧前若 hero 草稿有改动，提示“灯光/相机改动未保存，先点设为首屏”。
2. **色温滑杆初值固定 4000 K**，与配置里的实际颜色无关（实现报告已说明）。建议从 hex 反推最近色温或显示“自定义”。
3. **预览一滚动就重置未保存的旋转/开盖**（`useEffect([at])`）：符合“滚到位置 → 摆姿态 → 记关键帧”的流程，但先摆后滚会丢。可接受，建议在界面提示。
4. **编辑态 OrbitControls 的 `minDistance=0.6 / maxDistance=5`** 会把超出范围的已保存相机拉回；对照模式关闭了 controls，不影响一致性验收。若以后允许更远的相机，需放宽或改为不钳位。
5. **历史文件损坏时 `/scene` 系列接口持续 500**（`load()` 对非 ENOENT 错误直接抛）。建议改为把坏文件改名备份后以空历史启动，并在响应里提示。另：`/health` 仍返回 `milestone: 'M0-A'`，无功能影响。

## 核对过、没有问题的点

- **写入路径**：落盘位置只由 `WORK_ROOT` 决定，请求体不参与；`safeWorkPath` 对词法越界和沿途符号链接/junction 都拒绝；资产 id 走 `^[a-zA-Z0-9_-]{1,80}$`。
- **校验**：`PUT /scene` 先 Ajv（strict、无类型强制转换）再 `isSceneConfig`（关键帧严格递增），M1-A 审查 S3 的要求已满足；`adopt` 的 body 只接受 `{}` 或 `{force: boolean}`。
- **提交语义**：先写持久 intent，再原子替换配置，再确认历史，最后发事件；中断后下次访问重放。事件不会早于文件。
- **串行**：读、写、撤回、采用共用一个队列；失败不会卡死队列（`queue = result.catch(() => {})`）。
- **采用**：只允许 ready；`webReady=false` 必须显式 `force:true`；同名不同内容拒绝覆盖，保证撤回后旧配置引用的模型字节不变。
- **一致性接点**：对照模式下 Studio 用 `GET /scene` 的已保存配置、同一个模型 URL、iframe 的当前滚动位置，并关闭手柄与 OrbitControls——M1-A 审查 R1 的要求由此满足。资产面板（`AssetPanel`）仍用默认配置，它只是看模型的检查器，不参与一致性验收。
- **N5**（任务号输入框与后端规则不一致）：`AssetPanel` 的 pattern 已是 `[1-9][0-9]{0,18}`，与后端一致，无需再改。
