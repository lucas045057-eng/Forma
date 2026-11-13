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

---

# 回合 3（第二轮整改回归）

日期：2026-11-13。被测版本 `5377b52`（含 `81558a7` 第二轮整改合并）。新用例：`tests/e2e/m2a/14-fix2-regression.spec.ts`。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| **F2 预览源 Host 白名单** | **通过**：`evil.example:5175` / `127.0.0.1:5999`（错误端口）/ `localhost.evil.example:5175` 的 GET 均 **403**，`127.0.0.1:5175` 200；外来 Host 与外来 Origin 的 WebSocket 升级都被断开（无 101 响应） | `round3-f2-preview-host.json` |
| **F3 旧版本库审计** | **通过**：先正常启动建立版本库，再手工把 `src/deploy.pem` 提交进去，重启后端以**退出码 12** 失败且输出包含 `UNSAFE_TRACKED_FILE` | `round3-f3-audit.json` |
| **F4 实例锁** | **通过**：同一 `WORK_DATA_DIR` 起第二个后端失败且错误包含 `INSTANCE_LOCKED`，`events.jsonl` 字节不变；正常关闭后重启 seq 不归零 | `round3-f4-instance-lock.json` |
| **F1 `src/` 自身是 junction** | **未运行**（详见下） | — |
| R6 / D3 | 仍失败（预期，CodeBuddy 在 `.worktrees/m2d3` 修） | `isolation-r6.json` |

### F1 为什么还是没进 e2e（本轮新查清的部分）

- 回合 2 那个“Node 直接崩”的真凶找到了：**本机 `fs.cpSync` 复制含二进制模型（`public/assets/*.glb`）的目录时会以 `0xC0000409` 杀掉进程**；换成 `copyFileSync` 逐文件复制后，作品副本能正常起后端、`GET /version` 也能拿到合法提交。
- 但在**作品副本**上提交任务会在“建候选”阶段失败，API 只回 `TASK_FAILED`（不带底层原因），走不到“采用”那一步；在主工作树上把被 Vite 监视的 `src` 整体换成 junction 也不稳定。
- 结论：F1 的 e2e 仍未验证；它由实现方 `repo.test.ts`（`src/public` 根与子项 lstat+realpath 双重检查、四类写操作 409）覆盖。**附带发现**：任务失败时 API 不暴露建候选失败的具体原因（只有 `TASK_FAILED`），排查这类问题只能靠单测，建议后续在任务事件里带上底层错误码。

---

# 接管后专项（N4 停机排空接点，HEAD `f70f046`）

- 日期：2026-11-13。被测 HEAD：**`f70f046`**（master）。N4 的修法目前只在 `.worktrees/m2fix` 的未提交草稿里，**没有当 master 已修**；D3 由 CodeBuddy 在 `.worktrees/m2d3` 处理。
- 新用例：`tests/e2e/m2a/15-n4-shutdown.spec.ts`。结果标成 **`test.fail`（预期失败）**：当前 master 的关闭路径仍会在 HTTP 排空前关日志/放锁。草稿合并且审查通过后去掉 `test.fail` 重跑，预期它会转为通过（若仍失败则是实现问题，不能改为跳过）。
- 该用例不跑 D3 的 30 秒强杀全套，也不碰主工作树模板；假 key、loopback-only、出站守卫开启，使用独立临时作品/数据目录（`%TEMP%\pi-m2a-n4-shutdown`，跑完删除），未读真实 `.env`、未调用真实模型/Lux3D。

## 用例设计与实测事实（`takeover-n4-shutdown.json`）

1. 用独立作品副本正常启动一次后端建立版本库，再在**作品版本库**里配置 `core.fsmonitor` 为一段脚本：当测试放置 marker 时就阻塞并记录调用，释放后 `exit 1` 让 git 回退到完整扫描。这样不改实现，也能用一个真实 `GET /version` 的自动快照把一条**已被接受的作品操作**挂在 `repo.exclusive` 队列里。
2. 写脏 `src/App.tsx` 后发真实 `GET /version`；fsmonitor 调用记录出现、请求保持未完成（`operationAcceptedAndBlocked=true`）。
3. 触发真实优雅关闭（stdin `close` → `app.close()`），在 marker 仍存在时观察：
   - 实例锁文件在作品操作完成前就消失（`unlock.reason=lock-file-gone`），当时 `headHasMarker=false`、`eventBytes=0`、`hasVersionChanged=false`、`operationCompleted=false`；
   - 同一 `WORK_DATA_DIR` 的第二实例**成功启动**（`secondWhileBlocked.locked=false`），没有被 `INSTANCE_LOCKED` 拦下。
4. 释放 marker 后：被挂住的 `GET /version` 返回 **200**，版本 `5b14d5ce…`；HEAD 与返回版本一致且包含被挂住快照的改动；事件日志出现 `version.changed`（seq 1）；重启实例读到 `current=1`、`oldest=1`（seq 接续，未归零），重启没有改写日志（`logAfterRestartEqualsClose=true`），`writesBeforeUnlock=false`（写入晚于解锁）。
5. 证据同时记录了四个实例的 PID/端口，均已停止：`n4-bootstrap` 46844:6817、`n4-first` 59012:3008、`n4-second-instance` 59636:3015、`n4-restarted` 47624:11397；临时目录已删除，e2e webServer 的 3001/4011/5173/5174/5175 跑完也全部释放。

## 结论与边界

- **N4 在 master `f70f046` 上可稳定复现**：锁/日志在已接受的作品操作完成前就关闭/释放，第二实例可在关闭期间拿到锁。这是验收接点，不是“已修”证据；不能拿 `.worktrees/m2fix` 的草稿代替。
- 用例用 `expect.soft` 记录全部事实再统一失败，因此每次都能产出上面这份对照；合并 N4 后要检查它是否变成“意外通过”（Playwright 会报 unexpectedly passed），并同时扫掉 `test.fail`。
- 本轮未重跑完整 M2-A、`pnpm test`、M0/M1 套件，也未跑 D3 强杀与 F1 根 junction；这些等实现交付、审查通过、合并到同一冻结 HEAD 后统一重跑。

---

# D3 进程归属复核（接管后专项，HEAD `cf8f8df`；首轮正式跑数 HEAD）

- 日期：2026-11-13。测试提交：**`cf8f8df`**（首轮正式跑数 HEAD；上一轮为 `a4b27fc`）；生产代码基线仍是 `f70f046`。`4bfc4c1` 只改诊断脚本/fixture，未改生产 `preview.ts` / `preview-worker.ts`。
- 本轮只改测试/证据/报告：重写 `tests/e2e/m2a/zz-kill.spec.ts`；旧证据 `isolation-r6.json` 保留不覆盖，新证据命名为 `isolation-r6-attributed-*.json`。
- **状态（2026-11-13 更新）：首轮正式专项已由调度执行并通过；扩大覆盖的两条新场景已写入用例，等待调度执行。**
  - `job_c0b6a407`（HEAD `cf8f8df`，exit 0，35 秒）：**3 条真正 passed，无 test.fail/skip** —— backend PID-only、整树强杀、decoy 负向对照。证据归档 `docs/reports/artifacts/M2-A/d3-run-c0b6a407/`（`run.json` + 三份 attributed JSON + 跑数 last-run），顶层 `isolation-r6-attributed-*.json` 保留首轮结果。
  - 本节上一版曾写“用例已就绪、未运行”；以上正式跑数取代该状态，但**不改变**“旧 2→2 是计数自匹配误报、生产 preview 没有被修复”的结论链。
  - 新增两条 R6 覆盖（同一 backend 下 3 个待定候选；worker 已产生但预览尚未 ready 的启动窗口）已写入 `zz-kill.spec.ts`，**本轮未运行**，命令见下。R6/D3 的最终关闭以扩大用例在冻结 HEAD 上（建议重复多次）无残留为准。

## 已固定的对照事实

生产预览代码与旧测试基线逐字相同（`git show <rev>:<file>` 的 sha256）：

| 文件 | HEAD / a4b27fc / 5377b52 / 81558a7 |
| --- | --- |
| `apps/server/src/work/preview.ts` | `08487d8d…ef8fde`（HEAD/cf8f8df/5377b52/81558a7 全部相同） |
| `apps/server/src/work/preview-worker.ts` | `a0ef69aa…df291f`（同上） |

旧 `zz-kill` 的全局口径“命令行含 `vite.js` 且含 `preview-cache`”的三个问题已实测：

1. **计数脚本自指**：旧写法的 `cmd.exe` 与 `powershell.exe` 自己的命令行里就含这两个关键字。在没有候选预览的干净环境跑同一条命令得到 **2**；用 `-File` 方式（关键字只在文件里）得到 **0**，证明这 2 个就是计数进程自身。
2. **看不见实际 worker**：候选 worker 的命令行是 `node preview-worker.ts <…>/vite.js`，`PREVIEW_CACHE_DIR` 只在环境变量里、不在命令行，所以旧口径对实际 worker `piMatch=false`（与 CodeBuddy 诊断一致）。
3. **无归属**：加入一个无害 decoy（`node -e setInterval … vite.js preview-cache-d3-decoy`）后，旧口径计数从 3 起步（cmd + powershell + decoy），结构化匹配的 `nodePids` 只有 decoy；实际 worker 仍不在其中。

因此回合 2/3 的“杀后端后仍有 2 个带 preview-cache 的 Vite”是**统计口径误报**：这 2 个恰好是计数用的 cmd/powershell，而不是正在测试的候选 worker；当时也没有记录 worker 的 PID/PPID/创建时间/端口，无法证明归属。`job_c0b6a407` 用归属判据正式确认：两场景 `gone=true`、`stillAlive/leftoverIdentities/leftoversAfter` 为空，无关 decoy 存活后由 `decoyCleanup` 单独结束（`gone=true`）；生产 preview 两文件 hash 与旧基线仍相同，所以这是**测试统计口径更正，不是生产 preview 被修复**。

## 新用例的判据（只针对本轮自己启动的进程）

- 独立 fixture：自己的 API 端口与预览源端口、自己的 `WORK_DATA_DIR`（作品目录仍用真实模板，但候选/版本库/预览缓存都在独立数据目录；跑完还原模板）。进程强杀只针对本文件启动的 backend/worker。
- 先取证再判：候选必须 `preview-origin` 200，且 worker **自己的监听端口**也 200；记录 worker 的 PID、PPID（= 本轮 backend）、创建时间、命令行摘要与端口。
- 场景一：`taskkill /F /PID <backend>`（**不带 /T**）→ 只检查该 backend 与其 worker 的“PID+创建时间”身份消失，预览端口不再 200；不要求无关进程退出。
- 场景二：`taskkill /T /F /PID <backend>` → 检查该 backend 与全部后代身份的“PID+创建时间”消失。
- 负向对照：无害 decoy 必须被旧全局口径计入、但不被归属判据当成残留，也不能被清理误杀；`finally`/`afterAll` 只结束自己记录的 decoy PID。
- 时间/快照：每次采样记录单调时钟偏移与采样耗时（见下节“时间证据”）；首轮证据文件名是 `isolation-r6-attributed-{pid-kill,tree-kill,negative-control}.json`，扩大覆盖新增 `-multi-candidate-pid-kill.json` 与 `-startup-window-pid-kill.json`。

## 扩大覆盖：3 个待定候选 + 预览启动窗口（已写入用例，待执行）

独立审查第 5 节要求 R6 至少再覆盖：同一 backend 下 3 个待定候选、以及预览启动中途被杀。两条都用“先证明目标存在，再按身份杀”的方式，不能把“还没创建 worker”当空断言：

- **多候选**：同一 backend 连续生成 3 个待定候选（甲/乙/丙），先按**候选自己的模块内容**把每个候选映射到唯一的 worker PID + 监听端口（矩阵记录 `status/textHasMarker`），并要求 3 个 worker/端口互不重复、3 个 `preview-origin` 都是 200；然后只杀 backend PID（不带 /T），核对 3 个 worker 身份全部消失、3 个端口与 origin 都不再 200、`leftoversAfter=[]`。证据：`isolation-r6-attributed-multi-candidate-pid-kill.json`。
- **启动窗口**：用临时作品副本，把 `node_modules/vite` 换成测试替身——CommonJS 里 `setTimeout` 异步等待 4 秒后才 import 真正 Vite。`preview-worker.ts` 已注册 IPC disconnect 监听、worker 进程已存在，但端口尚未绑定；测试轮询到“worker 存在 + preview-origin 非 200”后立即只杀 backend PID，核对 worker 身份消失、无残留。替身只在临时 fixture 中，生产 `preview.ts`/`preview-worker.ts` 未改。证据：`isolation-r6-attributed-startup-window-pid-kill.json`。
- **时间证据**：改用单调时钟（hrtime）记录每次快照相对“杀命令开始”的偏移，并分别记录 `killCommandDurationMs` 与每次 WMI 采样的耗时；只给“最后一次存活快照 / 首次消失快照”的区间，不再用 `after1s` 当精确退出时间。
- 负向对照同步扩展为检查上述两类场景的 target 身份：旧全局口径仍会被 decoy（以及计数进程自身）骗到，归属判据的 `attributedLeftovers` 必须为空。

## 交给调度执行的精确命令

在 `E:\空间化AI工作台` 根目录：

```powershell
orbital\bin\bg.cmd 'set PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright&& node node_modules\@playwright\test\cli.js test -c playwright.m2a.config.ts tests/e2e/m2a/zz-kill.spec.ts --reporter=list --output=docs\reports\artifacts\M2-A\d3-output'
```

等价的直接命令：

```powershell
cd E:\空间化AI工作台
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
node node_modules\@playwright\test\cli.js test -c playwright.m2a.config.ts tests/e2e/m2a/zz-kill.spec.ts --reporter=list --output=docs\reports\artifacts\M2-A\d3-output
```

`--reporter=list` 与 `--output` 保证不覆盖旧 `M2-A/playwright-results.json` 与 `M2-A/output/`。本次会跑 5 条（首轮 3 条会重跑，另加 2 条扩大覆盖）；预期 2–4 分钟。

## 未运行 / 边界（不要当成通过）

- 首轮 `job_c0b6a407` 3/3 已通过并归档；扩大覆盖的 2 条（多候选、启动窗口）**尚未运行**，上面命令未启动（工具环境没有 `ORBITAL_SESSION_ID`，按要求交回调度）。`isolation-r6-attributed-multi-candidate-pid-kill.json` 与 `-startup-window-pid-kill.json` 尚未生成；D3/R6 不能据首轮两场景就宣布关闭。
- 启动窗口用例的 Vite 由临时 fixture 的替身延迟启动，不是真实 Vite 已开始加载的同一瞬间；它验证的是“worker 已存在、尚未 ready 时父进程死亡”的回收路径，覆盖限制要在下轮报告里沿用。若下轮发现真实残留，需记录拥有者 PID/创建时间/端口/候选阶段，不能删断言或跳过。
- 本轮未重跑 `pnpm test`、M0-B/M0-A/M1-A/M1-B、M2-B、完整 M2-A，也未重跑 N4/retry 的已知失败（修复仍在 CodeBuddy 分支，master 仍预期失败）。
- 全程未调用真实模型/Lux3D、未读真实 `.env`；fixture 保持假 key + loopback mock + 出站网络守卫，未安装依赖/改锁文件。

---

# 最终集成回归（`b167907` 合并后，冻结 HEAD `86416ce`）

- 日期：2026-11-14。job **`job_ae81d353`**：exit 0、10m54s；冻结 HEAD **`86416ce080e10f75bea146f6d6b852629555ab79`**；`apps/packages/templates` 与 `pnpm-lock.yaml` 相对 `b167907` 无差异。
- 完整 M2-A：**35/35 passed**，`expected-failed=0`、`skipped=0`、`retries=0`；含 D3 五场景与 N4。单独第二轮 D3 **5/5 passed**（同一五场景重跑，不是新增用例）。
- **N4 按普通断言通过**（`takeover-n4-shutdown-b167907.json`）：被接受操作阻塞时关闭期间锁仍在、第二实例 `INSTANCE_LOCKED`；解锁时 `headHasMarker=true`、`hasVersionChanged=true`、`operationCompleted=true`，重启 seq 接续；`blockedRequest.connection='close'` 只避开 S1 的约 72 秒 keep-alive 排空等待，顺序断言未放宽。
- **D3 五场景两轮均通过**：两轮 `artifacts/e2e-m2a` 与 `artifacts/d3-standalone` 各 5 个 scenario 都是 `gone=true`、`stillAlive=[]`、`leftoverIdentities/leftoversAfter=[]`，decoy 最终 `gone=true`。D3 仍是**旧全局计数自匹配误报的纠正**，生产 `preview.ts`/`preview-worker.ts` 未被修改（hash 与旧基线相同）。
- 单测明细：server 134、studio 7（含在 235 总数内；shared 68、plugin 20、bridge 1（node:test）、scene-renderer 5）。所有 e2e 步骤后已知端口为空，模板已还原。
- 限制不变：本轮全部是 mock 模型门槛；真实模型“10 次至少 8 次改对”未运行；F1 根 junction 无正式 E2E、历史孤儿启动清理、资产偶发单测唯一根因仍未覆盖。
