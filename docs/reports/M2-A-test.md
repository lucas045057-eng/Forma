# M2-A 指着说闭环（后端）· Pi 测试报告

- 日期：2026-11-13
- 被测版本：master `f7f31b2`（M2-A 合并）
- 测试代码：`tests/e2e/m2a/`、根级 `playwright.m2a.config.ts`、根 `package.json` 的 `test:e2e:m2a`
- 未修改 `apps/`、`packages/`、`templates/` 实现代码；未装依赖、未改 lockfile
- 证据：`docs/reports/artifacts/M2-A/`

## 结论

**不通过（2 项阻断缺陷，其余 8 项通过）。**

| 项 | 结果 |
| --- | --- |
| 1 主链路（点选 → 任务 → 候选 → 采用 → 回退） | **部分通过**：后端链路全通；**浏览器打开候选预览看不到改动**（缺陷 D1） |
| 2 撤回 | 通过 |
| 3 选中对象校验 | 通过 |
| 4 Agent 沙箱 | **部分通过**：六类越界被拒，**经 junction 逃逸未被拒**（缺陷 D2）；`outOfScope` 记录正确 |
| 5 失败与取消 | 通过 |
| 6 候选上限 | 通过 |
| 7 采用冲突 | 通过 |
| 8 事件补拉 / 重启 seq | 通过 |
| 9 候选预览代理 | 通过（HTTP 语义与 Host 白名单）；浏览器渲染受 D1 影响 |
| 10 进程与资源 | 通过 |
| 11 回归 | 通过（含一条既有单测的偶发失败，见“观察”） |

全程 mock 模型上游（`tests/e2e/m2a/agent-mock.mjs`，可脚本化），Lux3D 指向没人监听的 loopback 端口，后端带出站网络守卫：**没有调用真实模型，也没有调用真实 Lux3D**。

## 运行方式

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
pnpm test:e2e:m2a      # 21 passed + 2 expected failures（见缺陷）
```

`playwright.m2a.config.ts` 自起：mock 编码上游（4011）、后端（3001，`WORK_ROOT` = 真实模板目录、`WORK_DATA_DIR=.data/pi-m2a/work-data`）、Studio（5173）、模板 dev server（5174）。所有会改作品目录的用例都在 `afterAll` 里 `git checkout/clean` 还原并断言干净；跑完 3001/4011/5173/5174 全部释放，**没有残留 Vite/候选预览进程**。

## 缺陷

### D1（阻断）候选预览在真实浏览器里渲染不出内容

- **现象**：直接打开 `/preview/c/<id>/`，`#root` 为空、买按钮不存在；控制台反复输出 `[vite] server connection lost. Polling for restart...`，模块请求出现 `net::ERR_ABORTED`（`flow`、`@react-three/fiber`、`three` 等）。
- **对照**：同一次运行里，用 `page.route` 把 `@vite/client` 换成一个空桩后，同一候选正常渲染：买按钮文字 `马上购买`、`data-src=src/components/Button.tsx:5:5`、`product-scene` 状态 `ready`（见 `candidate preview with stub` 的探测结论与 `09-proxy`/`01-flow` 的断言）。
- **根因**：候选 Vite 仍注入 `@vite/client`，它要连 HMR WebSocket；后端 `/preview/c/<id>/` 代理只转发 GET/HEAD、不升级 WS，客户端连不上就反复重连/刷新，把正在加载的模块 abort 掉。`vite.config.ts` 里 `hmr: false` 并没有阻止客户端注入与重连逻辑。
- **影响**：M2-B 的 Studio 候选预览 iframe 会一直是空白页；M2 “候选对比”无法做视觉验收。
- **建议**（不在本轮修）：候选预览不注入 HMR 客户端（`server.hmr:false` 之外还要让 `@vite/client` 不参与，或把 `/preview/c/:id/` 的 WebSocket 升级也转发），或在代理层为候选禁用客户端。
- 证据：`known-defect-preview-reload.json`；用例 `10-known-defect.spec.ts` 用 `test.fail()` 标成“预期失败”（写的是**应该**正常渲染的断言，修好后会变成意外通过并提醒去掉标记）。

### D2（阻断）沙箱可以用 `src/` 下的 junction 写到作品目录之外

- **做法**：在 `templates/product-page/src/link-out` 建一个指向 `.data/pi-m2a/junction-target` 的 junction，让 Agent 调 `write_file {path:"src/link-out/escape.ts"}`。
- **结果**：写入**没有被拒绝**，候选 diff 里出现了 `src/link-out/escape.ts`（`sandbox-junction.json`：`diff: ["src/App.tsx","src/link-out/escape.ts"]`）。同一次运行里其他六类越界写入（`../`、`package.json`、`vite.config.ts`、`public/`、`src/../../`、非法 `scene.config.json`）都被拒（`sandbox.json`，`calls=9`）。
- **根因**：`apps/server/src/agent/tools.ts` 的路径检查用 `lstat(...).isSymbolicLink()` 判断符号链接；**Windows 上 junction 在 `lstat` 里报成目录**（`isSymbolicLink()` 为 false），所以逐段检查被绕过。
- **说明**：junction 指向的目标目录在这次运行里没有看到落盘文件（`targetEntries: []`，`escaped: false`），具体落点未能在本轮定位；但“路径不得经过符号链接/junction”的校验确实没生效，写入也没有被拒——这已经违反 M2 沙箱的写入边界。
- **建议**：改用 `realpath` 后的路径与作品根比较（而不是逐段 `lstat`），或显式检测 Windows reparse point（`fs.lstat` 的 `isSymbolicLink` 对 junction 无效时用 `realpath`/`fsutil`）。
- 证据：`sandbox-junction.json`；用例 `04-sandbox.spec.ts` 的第三条用 `test.fail()` 标注。

## 逐项结果

### 1. 主链路（`flow-main.json`）
- 点选得到真实 Selection：`src/components/Button.tsx:5:5`，`baseVersion` = 作品版本库当前提交 `305e1483…`（Studio 里补的是仓库 HEAD，测试按 M2-B 的口径换成 `GET /version`）。
- `POST /tasks` 202 → 事件 `task.updated` 多条 → `candidate.ready`（seq 严格递增）→ 任务 `done`，步骤里有“候选目录已创建”。
- 候选：`previewUrl=/preview/c/<id>/`、`diff=[src/App.tsx]`、`checks` 四项全 `not_run`、`outOfScope=[]`（选中的 Button.tsx 的祖先文件是 App.tsx，属于范围内）。
- HTTP 代理 200、候选源码含 `马上购买`；**浏览器渲染见 D1**。
- `adopt` 200 → `version` 305e1483 → eb90a5ba，作品 `src/App.tsx` 变为 `马上购买`，`/preview/main/` 显示 `马上购买`（浏览器断言通过）。
- `revert` 200 → 源码与页面都回到 `立即购买`；事件里 `version.changed`（reason=revert）与 `candidate.closed` 都在；`/events/history?since=0` 序号 1–16 连续。
- 越界记录：选中 `ul.benefits`、Agent 新建 `src/tmp-scope.css` → `outOfScope=["src/tmp-scope.css"]`，候选仍可采用（只记录不拦截）。

### 2. 撤回（`discard.json`、`adopt-once.json`）
`discard` 后候选目录不存在、代理 404、`candidate.closed` 事件 reason 含“撤回”、版本未变、重复 discard 409；采用过的候选再 adopt/discard 都是 409。

### 3. 选中对象校验（`selection-invalid.json`、`selection-stale.json`）
9 种非法输入全部 400（缺 `src/` 前缀、含 `../`、缺行列、行号 0、行号越界、文件不存在、反斜杠、`baseVersion` 不是提交、格式错），期间上游调用次数与任务队列长度都不变；把作品文件改脏后再用旧 `baseVersion` 提交 → **409 `STALE_SELECTION`**，同样不调上游。

### 4. 沙箱（`sandbox.json`、`sandbox-junction.json`）
见 D2。六类越界全部被拒且候选 diff 只有 `src/App.tsx`；`candidateDirEntries` 里没有越界产物；Agent 被拒后仍完成了正常改动（9 轮工具调用）。

### 5. 失败与取消（`failure-*.json`）
`AGENT_UPSTREAM`（500）、`AGENT_PROTOCOL`（只回文本）、`AGENT_TIMEOUT`（4.8 s 结束，后端总时限 4 s）、`TASK_CANCELLED`（600 ms 后取消）、`NO_CHANGES`（只读不改）——五种终态都清晰，**候选目录与预览都没有残留**（轮询确认目录消失、代理 404），已结束的任务再取消返回 409。

### 6. 候选上限（`candidate-limit*.json`）
先清掉遗留待定候选，再连续产生 4 个：最早的自动撤回（目录删除、预览 404、`candidate.closed` reason 含“3”），其余 3 个仍 `pending` 且预览可访问。

### 7. 采用冲突（`adopt-conflict.json`）
两个候选同一 `baseVersion`（`dea5a40c…`），先采用 A 成功；再采用 B → **409 `MERGE_CONFLICT`**，作品文件与 A 采用后完全一致、`git status` 干净、没有 `MERGE_HEAD`，B 仍可为 `pending` 并可撤回；回退后源码恢复。

### 8. 事件补拉（`events-replay.json`、`events-restart.json`）
断开 WS 期间的两次 `PUT /scene` 用 `since=233` 补到 `[234,235]`，连续、`current=235`、`truncated=false`；独立沙箱后端重启后 `seq` 从 2 接续到 3，历史仍在（`oldest=1` 不变）。

### 9. 代理（`proxy.json`）
`GET /preview/c/<id>/` 200、`HEAD` 200（无 body）、`POST` 404（路由只注册 GET/HEAD，未转发）、未知 id 404 `PREVIEW_NOT_RUNNING`、`Host: evil.example:3001` + 伪造 Origin → 403 `HOST_DENIED`；响应里没有 `mock-only`、没有 `authorization` 头。

### 10. 进程与资源（`resources.json`）
候选 `node_modules` 是逐包 junction；`discard` 后候选目录完整删除，作品 `node_modules` 条目数 9→9、`node_modules/.pnpm` 252→252、`vite` 包仍在；跑完整套件后没有残留 `vite.js` 进程，3001/4011/5173/5174 全部释放。

### 11. 回归
| 套件 | 结果 |
| --- | --- |
| `pnpm test` | shared 68、插件 20、scene-renderer 5、bridge 1、后端 108 → **202**；第一次跑时后端 `service.test.ts` 的“并发/重启用例”偶发 `submit_unknown` 失败，单独重跑 108/108 通过（见观察 1） |
| `pnpm test:e2e`（M0-B） | 24 |
| `pnpm test:e2e:m0a` | 27 |
| `pnpm test:e2e:m1a` | 7 |
| `pnpm test:e2e:m1b` | 23 |

## 观察（非阻断）

1. **后端单测偶发失败**：`service.test.ts > concurrent and restarted submissions use one paid task` 在一次全量运行中报 `submit_unknown`（上游创建未确认），单独重跑通过。看起来是该用例自身的时序/端口竞争，不在本轮改动范围内，但值得后续排查（它涉及“重启后幂等”这条关键路径）。
2. **测试配置自纠**：M0-B 的 `playwright.config.ts` 只 ignore 了 `m0a/m1a/m1b`，新增的 `m2a/` 会被默认套件收进来（第一次跑 M0-B 多跑了 M2-A 用例并报错）。已补 `'**/m2a/**'`，属测试配置问题。
3. **任务结束后清理是异步的**：`cancel`/失败先把状态置为终态，候选目录与预览的删除在其后发生，测试里必须轮询而不是立即断言（已在用例中处理）。
4. **`outOfScope` 的口径**：选中 `Button.tsx` 而改动 `App.tsx` 时 `outOfScope` 为空，因为 `App.tsx` 是该元素的祖先文件——这符合实现（选中文件 + 祖先文件算范围内），已在用例里注明，避免被误读成“越界没记录”。
5. **偶发 Babel 解析报错**：模板 dev server 扫描到候选里 `src/link-out/escape.ts`（内容不是合法 TS）时会在日志里打 parse error，不影响页面。

## 未运行（不要当成通过）

- **真实编码模型的“连续 10 次至少 8 次改对”**：本轮全程 mock，未消耗真实模型额度；这一轮需要单独确认模型额度后执行。
- **M2-B Studio 界面**（指令输入、候选对比、断线补拉 UI）：CodeBuddy 正在 `.worktrees/m2b` 做，不在本轮。
- 真实 Lux3D 生成 / 资产采用与 M2 候选的联动。
- 多进程并发写同一作品（实现方声明单进程）。
- 事件窗口截断（`truncated=true`）与 2000 条上限的真实溢出场景。
- Firefox / WebKit、触屏。

## 产物

`docs/reports/artifacts/M2-A/`：`playwright-results.json`（21 expected、2 expected-failure）、`flow-main.json`、`flow-out-of-scope.json`、`discard.json`、`adopt-once.json`、`selection-invalid.json`、`selection-stale.json`、`selection-valid.json`、`sandbox.json`、`sandbox-junction.json`、`failure-*.json`、`candidate-limit*.json`、`adopt-conflict.json`、`events-replay.json`、`events-restart.json`、`proxy.json`、`resources.json`、`known-defect-preview-reload.json`。

---

# 回合 2（M2-B 界面 + M2-A 整改 + D1/D2 回归）

日期：2026-11-13。被测版本 master `c93286f`。

## 迁移（预览分源）

| 变化 | 测试侧改动 |
| --- | --- |
| 预览改由独立预览源 `127.0.0.1:5175` 提供，Studio 不再代理 `/preview/*` | 作品页/候选预览地址改为 5175；`previewFetch` 指向预览源；M0-B 的配置改为自己起「API + 预览源（`tests/e2e/shared/server.mjs` 调 `createPreviewOrigin`）+ Studio + 模板」 |
| iframe 带 `studioOrigin`，bridge 只接受精确 Studio 来源 | M0-B 消息安全用例按跨源约定重写：Studio 侧伪造消息 `origin=5175`；bridge 侧 `origin=5173`（studioOrigin） |
| Studio 不再读 iframe DOM；画布尺寸由 bridge 上报 `viewport:size` | M1-B 对照模式改为「等 `scene-size` 上报值 ≈ Studio 画布宽度」，backing 尺寸用 `frame.evaluate` 读 |
| 每个后端要额外起预览监听 | m0a/m1a/m1b/m2a 启动器统一走 `listenWithPreview`；沙箱后端 `PREVIEW_ORIGIN_PORT=0` 跳过 |

迁移后：**M0-B 24、M0-A 27、M1-A 7、M1-B 23、M2-A 26、R6 1 失败、M2-B 3**。没有放松任何断言。

## D1 / D2 回归

- **D1 已修复**：去掉 `test.fail`，改为直接打开 `http://127.0.0.1:5175/preview/c/<id>/`。断言：导航 1 次、`#root` 有内容、买按钮 `马上购买`、`data-src=src/components/Button.tsx:5:5`、`[vite] connected` 出现且 `connection lost` 为 0、无 pageerror（`d1-candidate-preview.json`）。
- **D2 按新行为验证**：作品目录 `src/` 下有 junction 时 `POST /tasks` 与 `GET /version` 都 **409 `UNSAFE_WORK_TREE`**、junction 目标为空、作品目录无新增文件、上游未调用（`sandbox-unsafe-work-tree.json`）；候选新增 `src/link-out/escape.ts` 后作品目录该路径变 junction 时采用 **409 `UNSAFE_WORK_TREE`**、主线不变，删链接后同一候选可正常采用并落在作品内（`sandbox-adopt-unsafe.json`）。

## M2-A 整改验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| B1 预览不能调用正式接口 | **通过**：候选页面里 `fetch` PUT /scene、POST /assets/lux3d、/tasks、adopt、revert 全部失败（CORS），配置字符串不变、候选数不变、Lux3D 调用计数不变 | `isolation-b1.json` |
| B2 Vite 文件边界 | **通过**：`/preview/main/@fs/<repo>/docs|orbital|.data|apps/server/sentinel-m2.txt` 读不到哨兵内容，自己的 `src/App.tsx` 仍 200 | `isolation-b2.json` |
| R1 快照不收敏感文件 | **通过**：`.env.local`、`src/notes.bak`、`src/secret.pem` 不在 work 仓库 `ls-tree HEAD` 里，`src/App.tsx` 仍在 | `isolation-r1.json` |
| R3 事件序号 | 通过（`08-events`：断线补拉连续、重启 seq 接续不归零） | `events-*.json` |
| R6 后端强杀后预览回收 | **失败（缺陷 D3）**：杀掉 3001 后端后 30 秒内带 `preview-cache` 的 Vite 进程仍为 2（`gone:false`） | `isolation-r6.json` |

## 缺陷（回合 2）

**D3（应修）R6 未达成：后端被强杀后候选预览进程仍在**
- 复现：起候选（预览可用）→ `taskkill /T /F` 杀 3001 后端 → 30 秒内 `vite.js` 且命令行含 `preview-cache` 的进程数仍为 2（`isolation-r6.json`，`gone:false`）。
- 影响：崩溃/强杀后预览 worker 与端口残留，与整改报告“父进程异常退出后预览自动退出”的说法不符。
- 本轮结束已手工结束残留 Vite 进程，3001/4011/5173/5174/5175 全部释放。

## 未运行（回合 2）

- 真实模型“10 次至少 8 次改对”。
- 重启后无主候选目录自动清理、事件容量/截断（S2）、完整 CSP（S1）的端到端。
- 预览源 HMR 转发对**候选**的外来 Origin 负向用例（仅实现方单测覆盖）。

## 回合 2 补测（在 HEAD `81558a7`：F1 修复 + F2/F3/F4/R1 合并之后）

- **重跑**：在 `81558a7` 上重跑了 `pnpm test:e2e:m2a`：**26 通过 / R6（`zz-kill`）仍失败**。
- **其余套件未在 `81558a7` 之后重跑**：M0-B 24、M0-A 27、M1-A 7、M1-B 23、M2-B 3 是合并前 `3faa865` 上的结果；本轮只改了 04-sandbox 与报告，但 F2（预览源 Host 白名单）、F3、F4、R1 的合并可能影响它们，**需要下一轮在前述 HEAD 上重跑**。
- **F1（`src/` 或 `public/` 自身是 junction）e2e 未运行**：本机执行「把作品目录 `src` 整体换成 junction + 复制/删除含 junction 的作品副本」这类 fs 操作时，Playwright worker 与独立 Node 进程（`tests/e2e/m2a/f1-check.mjs`）**都会以 `0xC0000409` 直接崩溃且无输出**；已核查 `node_modules` 未受损（`.pnpm` 252 项、`vite`/`react`/`fastify` 仍在）。该保护路径由实现方 `apps/server/src/work/repo.test.ts` 的用例覆盖（作品目录 `src/public` 根与子项均检查 lstat + realpath，四类写操作 409），本报告不宣称它经过 e2e 验证。
- **D3（R6）仍存在**：在 `81558a7` 上重跑，`taskkill /T /F` 掉 3001 后端后 30 秒内带 `preview-cache` 的 Vite 进程仍不退出（`isolation-r6.json`）。这与整改报告里“父进程异常退出后预览自动退出”的 IPC 生命周期说明不一致，建议排查 `preview-worker` 在父进程被强杀时的 IPC 断开检测。
