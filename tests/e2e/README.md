# M0-B 端到端测试（Pi）

点选 → 源码定位的 Playwright 验收测试 + Codex 审查整改的回归用例。只依赖仓库根级配置与 `tests/`，不改 `apps/`、`packages/`、`templates/` 的实现代码。

## 运行

```powershell
pnpm install
pnpm exec playwright install chromium   # 首次
pnpm test:e2e
```

- 服务由 `playwright.config.ts` 的 `webServer` 自动执行 `pnpm dev` 启动（Studio 5173、模板 5174、后端 3001），跑完自动关闭。
- 结果与证据：`docs/reports/artifacts/M0-B/`，报告见 `docs/reports/M0-B-test.md`。
- `pnpm test:e2e:headed` 可以看着浏览器跑。
- 插件层用例（含 R2 回归）用 `pnpm test`。

## 三个环境开关

| 变量 | 用途 |
| --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | 若你的环境已设置它，浏览器必须装在那个目录；Orbital 默认指向 `%APPDATA%\Orbital\browsers`，而 `pnpm exec playwright install chromium` 装到 `%LOCALAPPDATA%\ms-playwright`。两者不一致时把它指向后者：`$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"` |
| `E2E_DIRECT_WEBSERVER=1` | `pnpm` 不可用（例如并行任务正在装依赖、`pnpm-workspace.yaml` 临时非法）时，直接用 `node node_modules/vite/bin/vite.js` 起模板与 Studio 两个服务 |
| `E2E_REUSE_SERVER=1` | 5173/5174 已被另一个并行任务的 `pnpm dev` 占用时直接复用。**复用前必须确认那个服务就是当前工作树**（否则测的不是你要测的代码） |

## 文件

| 文件 | 内容 |
| --- | --- |
| `lib.ts` | 打开 Studio、枚举 `data-src`、确定性抽样（种子 20261109）、真实鼠标点选、读 Selection、读源文件校验行列、注入探针 |
| `source-model.ts` | **AST oracle**：解析 `templates/product-page/src/**/*.tsx`，算出每个原生 JSX 开标签的 1 基行列。完全不经过插件、不读 DOM 的 `data-src` |
| `checks.ts` | 用例 8/9 与变异验证共用的判定逻辑 |
| `m0b-pick.spec.ts` | 验收用例 1–7 + 行号自检 + 用例 8（AST 确定性锚点）+ 用例 9（应标记节点完整性） |
| `m0b-known-issues.spec.ts` | Codex 审查 R1 的回归（pointer/mouse 按下抬起、单输入框 Enter 隐式提交、右键/双击/Space 激活、链接、退出恢复、悬停与滚动不被误伤）。修复合并后已改为普通断言 |
| `m0b-message-guard.spec.ts` | Codex 审查 S4 的消息安全回归（两端 origin/source 与畸形 payload） |
| `m0b-mutation-check.spec.ts` | 变异验证：同名标签错标、漏标某类元素、列号偏移都会被判定抓到 |
| `../../packages/vite-plugin-source-tag/src/reserved-jsx-r2.test.ts` | Codex 审查 R2 的插件层回归（保留属性内嵌 JSX），只新增测试文件 |
| `../../packages/vite-plugin-source-tag/src/component-name.test.ts` | Codex 审查 S3 的插件层回归（组件名归属），只新增测试文件 |

`playwright.config.ts` 用 `testIgnore: ['**/m0a/**']` 把 M0-A 的用例挡在外面——它们必须用 `playwright.m0a.config.ts`（自带 mock 与专用后端）跑。

## 关于“预期失败”标记

整改回合 1 里 R1a/R1b（`test.fail`）和 R2 两条（`it.fails`）是“已知待修”的钩子；修复合并后（`59824d5`）已全部删除，现在是正常断言。**今后不要再给已修复的问题加这类标记**，它的作用只是把待修项和新回归分开。

容器类元素（`main`）和零尺寸元素（`br`）鼠标无法命中，会退化为在元素自身派发 `click`；每条记录里的 `clickMode` 标明用了哪种方式。

## M1-A（共享 3D 渲染 / 场景配置 / 部件命名）：`m1a/` 子目录

```powershell
pnpm test:e2e:m1a     # = playwright test -c playwright.m1a.config.ts
```

与 M0-A 分开：这里的 mock 供的是 M1-A 的**拆分模型** `fallback/lux3d-split-4969889.glb`，处理后应与作品页里提交的 `public/assets/diffuser-4969889.glb` 一致；同样带出站守卫。

| 文件 | 内容 |
| --- | --- |
| `env.ts` | 端口、数据目录、证据目录、模板配置/模型/parts.json 路径 |
| `visual.ts` | 区域截屏（不触发 Playwright 自动滚动）、归一化比较、带平移对齐的逐像素比较、轮廓包围盒 |
| `viewport.ts` | 导入资产、打开作品页/Studio 视口、等渲染状态、滚到指定 at、**临时改 scene.config.json 并保证还原** |
| `01-consistency` | Studio 视口 vs 作品页首屏同尺寸像素对比 |
| `02-scroll-lid` | 滚动关键帧 / lid 上移量（像素量测）+ 复位 + 中间插值 |
| `03-fallback-config` | 模型失败回退（含回退态 N3 完整性）与非法配置 HMR |
| `04-parts` | 部件命名 / `lid` 分组 / `webReady` / 单 mesh 未识别 |
| `05-resource-release` | 多次重载与 HMR 的 WebGL 上下文堆积 |

**注意**：`02`/`03`/`05` 会临时改写 `templates/product-page/src/scene.config.json`（HMR 验证），结束时按原字节还原并断言文件内容一致。

## M1-B（场景写回 / 编辑面板）：`m1b/` 子目录

```powershell
pnpm test:e2e:m1b     # = playwright test -c playwright.m1b.config.ts
```

主后端以**真实模板目录**为 `WORK_ROOT`（否则写回不会反映到作品页），沙箱用例（采用、路径越界、并发写）用 `.data/pi-m1b/sandbox/*` 的副本。

| 文件 | 内容 |
| --- | --- |
| `env.ts` | 端口、WORK_ROOT、历史/资产目录、模板文件路径 |
| `start-backend.mjs` | 带 `WORK_ROOT`/`SCENE_HISTORY_DIR` 的启动器；createApp 报错以退出码 12 结束（实例锁等）；stdin `close` 优雅停机 |
| `api.ts` | `/scene`、`/scene/undo`、`/assets/:id/adopt`、原始 Host 请求、配置文件快照/还原、沙箱与离线处理 |
| `editor.ts` | 打开编辑面板、`scene-load/match-size/compare` 对照流程、滑杆、滚动、只截对照画布、裁剪公共可见段 |
| `01-consistency` | 三组一致性（出厂 / 改后 / at≈0.6）+ 配置来源断言 |
| `02-writeback` | 写回延迟、无整页刷新、diff 字段 |
| `03-undo` | 撤回恢复、空历史 409 |
| `04-keyframe` | 关键帧写入与像素位移、±0.02 覆盖 |
| `05-api` | 非法配置 / 并发 / 路径越界 / Host 白名单 / 代理 |
| `06-adopt` | 采用落盘、force 门槛、同名冲突、作品页换模型 |
| `07-fixes` | R2 部件标记门控、R3 实例锁、B1 Host、S1 角度展开 |

所有改写 `scene.config.json` 的用例都在 `finally`/`afterAll` 里按快照还原并断言；采用用例会删掉写进 `public/assets` 的产物。

## M2-A（指着说闭环 · 后端）：`m2a/` 子目录

```powershell
pnpm test:e2e:m2a     # = playwright test -c playwright.m2a.config.ts
```

编码 Agent 上游用本机可脚本化 mock（`agent-mock.mjs`，`POST /__script {steps,delayMs,mode}`），Lux3D 指向没人监听的 loopback 端口，后端带出站守卫。主后端 `WORK_ROOT` = 真实模板目录（采用后 `/preview/main/` 才会变），工作数据与作品版本库在 `.data/pi-m2a`；所有改作品目录的用例都 `git checkout/clean templates/product-page` 还原并断言。

| 文件 | 内容 |
| --- | --- |
| `agent-mock.mjs` | 可脚本化 OpenAI 兼容上游：按轮次返回工具调用，支持 error/text 模式与延迟 |
| `start-backend.mjs` | 带 WORK_ROOT / WORK_DATA_DIR / Agent 配置的启动器，守卫 + stdin 优雅停机 |
| `api.ts` | 任务/候选/事件/`/scene` 接口、WS 收集、点选取 Selection、模板还原、依赖完整性检查 |
| `01-flow` | 主链路（含越界记录） |
| `02-discard` | 撤回与采用后不可重复操作 |
| `03-selection` | 选中对象九种非法输入 + `STALE_SELECTION` |
| `04-sandbox` | 六类越界写入被拒；junction 逃逸（已知缺陷，`test.fail`） |
| `05-failures` | 上游 500 / 只回文本 / 超时 / 取消 / 无改动 |
| `06-limit` | 第 4 个候选挤掉最早的 |
| `07-conflict` | 采用冲突 409 且无半合并 |
| `08-events` | 断线补拉 + 重启 seq 接续（沙箱后端） |
| `09-proxy` | 代理 GET/HEAD、404、Host 白名单、不泄露 key |
| `10-known-defect` | 候选预览在真实浏览器里渲染不出（已知缺陷，`test.fail`） |
| `11-resources` | 删除候选不伤 junction 依赖、目录完整删除 |

**注意**：`test.fail` 标的两条是已知缺陷（junction 逃逸、候选预览空白），修复后会变“意外通过”，届时要删标记。

## M0-A（Lux3D）测试：`m0a/` 子目录

```powershell
pnpm test:e2e:m0a      # = playwright test -c playwright.m0a.config.ts
```

与 M0-B 分开：用的是另一个配置文件，也不需要 `pnpm dev`。跑之前先确保 3001/4010/5173/5174 空闲（它自己会起 mock 4010 + 后端 3001 + Studio 5173 + 模板 5174，跑完自己收掉）。

| 文件 | 内容 |
| --- | --- |
| `env.ts` | 端口、数据目录、证据目录、运行 ID；M0-A 的单一事实来源（配置和测试都从这里取） |
| `harness.ts` | 起/停 mock、后端、剧本 stub 子进程；HTTP/WebSocket 客户端；GLB 解析（带 Meshopt 解码器）；截图统计与像素对比 |
| `no-real-network.cjs` | **出站网络守卫**（preload）：只放行回环地址，其余记录并拒绝 |
| `start-backend.mjs` | 被测后端启动器：与 `src/index.ts` 同一条 `createApp()`，只把 `pollMs`/`timeoutMs` 改成毫秒级；检查守卫是否加载 |
| `stub-upstream.mjs` | 补 CodeBuddy mock 没有的剧本：并发超限、create 500、无 GLB 输出 |
| `01-pipeline` … `06-viewport` | 主链路、幂等、失败路径、导入、安全、Studio 3D 视口 |
| `07-review-fixes` | M0-A 审查整改回归：残留 `.tmp` 不阻断重试、滴流下载被总时限中止、下载中优雅停机后可恢复、ready 模型丢失可修复、非 loopback http 上游拒绝启动 |

启动器还有两个测试专用钩子（`start-backend.mjs`）：

- `createApp` 报配置错时以退出码 **12** 结束（`startBackendExpectingRejection` 等它退出）；
- stdin 收到 `close` 就调 `app.close()`——Windows 上 `taskkill /F` 拿不到优雅停机，用这个模拟 SIGTERM。

下载总时限通过 `ASSET_DOWNLOAD_TIMEOUT_MS` 调短（`startBackend({ downloadTimeoutMs })` 透传）。

**不会碰真实 Lux3D**：后端进程不读 `apps/server/.env`，`LUX3D_BASE` 指向本地 mock，且带出站守卫；`docs/reports/M0-A-test.md` 有完整证据链。
