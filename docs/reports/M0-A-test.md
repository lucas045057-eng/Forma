# M0-A Lux3D 调用跑通 · Pi 测试报告

- 日期：2026-11-09
- 首轮被测版本：master `1c6a6e7`（M0-A 实现 `d6bd268`…`e44bc88` + M0-B 测试）；整改回归被测版本：合并 `5275f7c`（`fix/m0a-review`）之后
- 测试代码：`tests/e2e/m0a/`、根级 `playwright.m0a.config.ts`、根 `package.json` 的 `test:e2e:m0a`
- 未修改 `apps/`、`packages/`、`templates/` 的任何实现代码；未安装/升级依赖，未改 lockfile
- 证据：`docs/reports/artifacts/M0-A/`

## 结论

**首轮：过关。** 要求 1–7 全部通过，22 个用例全部通过（0 失败、0 未运行）。没有发现阻断级缺陷；有一条输入校验的观察项（见文末“观察”），不影响 M0-A 验收。

**整改回归（`5275f7c` 合并后）：过关。** 新增 5 个针对审查整改的 e2e 全通过，原 22 项仍全通过，单元测试 67 项（其中 M0-B 的 N1 三条 `it.fails` 属预期失败）全绿；详见文末“整改回归”一节。

| # | 要求 | 结果 |
| --- | --- | --- |
| 1 | 全部走 mock，不打真实接口 | **通过**（三层证据，见下） |
| 2 | 文生提交 → 轮询 0/1/3 → 下载 → 处理 → ready；REST/WS 顺序；model.glb 合法 | **通过** |
| 3 | 幂等：同键两次/并发两次只创建一个任务；结果不明不自动重发 | **通过** |
| 4 | 失败路径：status 4/6、URL 403/404、轮询超时、并发超限 | **通过** |
| 5 | import 已有任务 | **通过** |
| 6 | Studio 3D 视口：画布非空、拖动后画面变化、无运行错误 | **通过** |
| 7 | 路径穿越被拒；响应/事件不含 key | **通过** |

## 运行方式与环境

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
pnpm test:e2e:m0a
```

- 22 个用例，单 worker，耗时 **42.5 s**。Node v24.14.1 / pnpm 11.17.0 / @playwright/test 1.65.0 / Chromium 158。
- **先腾端口**：这轮开始时主工作树里还留着旧的 `pnpm dev`（studio 5173、模板 5174、后端 3001）。按调度给的说明，我先结束了这三个进程（`taskkill /T /F`），再由测试自己起一套；跑完后 3001/4010/5173/5174 都已释放，没有残留。
- 三个服务由 `playwright.m0a.config.ts` 的 `webServer` 自动启动：mock Lux3D（4010）、被测后端（3001）、Studio（5173）、模板（5174，Studio 首页的选取预览 iframe 要用，避免无关的加载错误）。
- 数据目录：`.data/pi-m0a/assets`，每次运行前清空；测试用的都是自己起的服务。

### 一个必要的偏离：后端启动器

`apps/server/src/index.ts` 里轮询间隔固定 15 s、超时 15 min（`createApp` 的构造参数，不是环境变量），真实服务里没法在测试中等到超时。所以测试用 `tests/e2e/m0a/start-backend.mjs` 起后端：**同一条 `createApp()` 代码路径**，只把 `pollMs` 改成 80 ms、`timeoutMs` 按场景取 1.2–30 s。这与实现报告给 Pi 的建议一致。`src/index.ts` 与它只差 logger 和端口来源。

## 要求 1：怎么证明「没打真实接口」

`.env` 里有真实 key，所以这件事必须是**结构上保证**，不能靠自觉。三层证据：

1. **后端进程根本不读 `.env`。** 启动器用 `node start-backend.mjs` 直接跑，不带 `--env-file-if-exists=.env`；`LUX3D_BASE=http://127.0.0.1:4010`、`LUX3D_API_KEY=mock-only` 全部由测试显式注入。全程没有读取也没有输出 `.env` 的内容。
2. **出站网络守卫（每个被测后端进程都 preload）。** `tests/e2e/m0a/no-real-network.cjs` 只放行回环地址：`dns.lookup` / `dns.promises.lookup`、`net.Socket.prototype.connect` 全部挂钩，任何非回环的解析或连接都会被记录进 `PI_NET_GUARD_LOG` 并拒绝。
   - **守卫确实装进去了**：启动器检查 `globalThis.__piNetGuard.ready`，没装就 `exit 9` 拒绝启动；装上后写标记文件。`pipeline.json` 里 `guardMarker = {active: true, pid: 42056, nodeOptions: "--require E:/…/no-real-network.cjs"}`。
   - **守卫确实能拦真实域名**：用例 1 用同一个 preload 另起一个短命进程去 `fetch('https://api.aholo3d.cn/…')`，输出 `BLOCKED ENETGUARD`，日志记到 `{kind: "net.Socket.connect", detail: "api.aholo3d.cn"}`。
   - **整个测试期间后端守卫日志为空数组**。
3. **每一次上游调用都能对上 mock 的计数。** mock 的 `GET /__stats` 显示 `creates` 只增加了提交次数、`gets` 与轮询次数一致；返回的 taskId 是 mock 的编号（`9000000 + N`），例如 `9000001`。

结论：后端只和 `127.0.0.1:4010` 通信。**限制如实说明**：没有抓包或网络层拦截（Windows 下没有可用的网络命名空间），这个结论来自"守卫已加载 + 守卫拦截有效 + 上游计数可对账"三条合起来。

## 要求 2：主链路（`pipeline.json`）

mock 的下载内容设成真实香薰瓶（`fallback/lux3d-4969293.glb`，13,345,788 字节），所以整条链路处理的是真模型。

| 观察点 | 实测 |
| --- | --- |
| `POST /assets/lux3d` | 202，`status: polling`，`taskId: 9000001`（mock 编号） |
| REST 状态 | `polling → processing → ready`（REST 每 50 ms 轮一次，downloading 太快没采到） |
| WebSocket 状态序列 | `polling → polling → polling → downloading → processing → ready` |
| WS 事件 | 每条都有 `ts`，`sequence` 严格递增且不重复；最后一条是 `asset.ready`；`downloading` 在 `processing` 之前 |
| 处理结果 | 13,345,788 → **983,560 字节**；POSITION 顶点 117,010 → **85,436**；耗时 **497 ms** |
| 归一化 | 包围盒 max-edge = **1.0000**，`min.y = 0`（底面中心在原点），1 mesh / 1 material / 2 textures |
| `GET /assets/:id/model.glb` | 200，`Content-Type: model/gltf-binary`，`Cache-Control: no-cache`；GLB 头合法（magic `glTF`、version 2、长度字段与实际一致） |
| 严谨性 | 不只查文件头：用 `@gltf-transform/core` + Meshopt 解码器**真正解析**（Meshopt 压缩的模型不挂解码器会报 `Missing required extension`），解析出的顶点数与 `metrics.after.vertices` 一致 |

图生 3D（要求内的补充）同样走通：`img` 提交 → 202 → ready，mock `creates` 只 +1。非法输入（同时给 prompt/img、`version: "G2"`、缺幂等键、`http://` 图片）全部 400，且不产生任何创建。

## 要求 3：幂等（`idempotency-*.json`）

| 场景 | 结果 |
| --- | --- |
| 同键顺序提交两次 | 两次都 202，返回同一个资产 id，mock `creates` 只 +1 |
| 同键**并发**提交两次 | 同上，`creates` 只 +1（提交队列串行化生效） |
| 同键不同参数 | 409 `IDEMPOTENCY_CONFLICT`，不产生新任务 |
| 提交结果不明（先杀掉 mock 再提交） | 202 + `submit_unknown` / `UPSTREAM_UNAVAILABLE`，文案含“不要自动重复生成” |
| 是否偷偷重发 | 把 mock 在原端口重新拉起（计数归零）后等 2.5 s：**creates = 0**；同键再提交一次仍是 `submit_unknown`、同一个 id，**creates 仍为 0** |

## 要求 4：失败路径（`failure-*.json`）

每个场景都在独立端口 + 独立数据目录下起一套 mock/后端，失败后还额外等 400 ms 确认**不再继续轮询**。

| 场景 | 终态 | 错误码 | 耗时 |
| --- | --- | --- | --- |
| 任务失败 status=4 | failed | `GENERATION_FAILED` | 19 ms |
| 任务取消 status=6 | cancelled | `GENERATION_CANCELLED` | 18 ms |
| 结果 URL 过期 403 | failed | `OUTPUT_URL_EXPIRED`（提到 403 与 2 小时） | 198 ms |
| 结果 URL 过期 404 | failed | `OUTPUT_URL_EXPIRED` | 198 ms |
| 轮询超时 | failed | `POLL_TIMEOUT`（提到勿重复生成） | 1,269 ms（`timeoutMs` 设的是 1,200 ms） |
| 未知状态 99 | failed | `UNKNOWN_STATUS` | 18 ms |
| 并发超限（create 返回 `c = GENERATION_CONCURRENCY_LIMIT_EXCEEDED`） | submit_unknown | `UPSTREAM_REJECTED`（文案提到核对参数/额度/并发任务） | 16 ms |
| create 返回 HTTP 500 | submit_unknown | `UPSTREAM_HTTP` | 14 ms |
| 成功但没有 GLB 输出 | failed | `NO_GLB` | 16 ms |

全部满足"错误清晰、不卡死"：都在 25 s 预算内进入终态，错误信息里既没有 key 也没有 `raw.glb` 之类的内部路径。

CodeBuddy 的 mock 没有"并发超限 / create 500 / 无 GLB"三种剧本，所以这三个用 `tests/e2e/m0a/stub-upstream.mjs`（手写 `node:http`，无依赖）补，其余 6 个都跑在它提供的 mock 上。

## 要求 5：导入已有任务（`import.json`）

- `POST /assets/lux3d/import {taskId: "7000001"}` → 202 → ready；**mock `creates` 不变（0）**，`gets` ≥ 2。
- 模型可下载、GLB 合法、能解析，顶点数与 metrics 一致。
- 重复导入同一个任务：返回同一条已完成记录，**不再查询远端**（`gets` 不变）。
- 非法 taskId（`abc` / `-1` / `1.5` / 空格）全部 400。

## 要求 6：Studio 3D 视口（`viewport.json` + 两张截图）

走的是用户路径：打开 Studio → “3D 资产” → 在输入框填任务号 → 点“导入任务” → 等状态变“可查看” → 等 `[data-testid="model-viewport"][data-loaded="true"]`。

| 检查 | 实测 |
| --- | --- |
| 画布非空 | 截图里 **10,522** 种颜色，亮度标准差 **48.6**（纯背景约 1 种颜色 / 标准差 0） |
| 鼠标拖动后画面变化 | 拖 190 px 后像素差异 **11.76%**（阈值 1%） |
| 运行错误 | 0 条 pageerror、0 条 console error |
| 空状态 | 面板没有出现 `.model-empty` |

截图：`docs/reports/artifacts/M0-A/viewport-initial.png`、`viewport-rotated.png`。

## 要求 7：路径穿越与密钥（`security-*.json`）

- **22 个穿越请求**（11 种 id × `/assets/:id` 与 `/assets/:id/model.glb`）：`../`、`%2e%2e%2f`、反斜杠、`%2Fetc%2Fpasswd`、`C:\Windows\win.ini`、`index.json`（资产目录里真实存在）、`a%00b`、超长 id、`lux3d-9000001%2F..%2Findex.json`。
  - 结果：20 个 404、2 个 414（超长 URI），**没有一个 200**，也没有任何一个响应里出现 `root:x:0:0:`、`[extensions]`、`"@spatial/server"`、`[fonts]` 之类的内容。
  - 对照：合法但不存在的 id 返回 404 + `NOT_FOUND`，说明不是整站 404 掩盖问题。
- **key 不泄露**：`GET /assets`、`GET /assets/:id`、`/health`、模型响应头、模型文件头、WebSocket 事件里都没有出现哨兵 key（`mock-only`），响应里也没有 `authorization` 头。
- **跨源 Origin** 被 403 `ORIGIN_DENIED`；同源 Origin 正常 200。
- **幂等键不落盘明文**：`.data/pi-m0a/assets/index.json` 里只有 `keyHash`（sha256），没有提交时的明文幂等键。

## 用例清单（22 个，全通过）

| 文件 | 用例 |
| --- | --- |
| `01-pipeline.spec.ts` | 出站守卫自检；文生 3D 全链路；图生 3D + 参数校验 |
| `02-idempotency.spec.ts` | 顺序同键；并发同键；同键不同参数 409；结果不明不重发 |
| `03-failures.spec.ts` | 9 个失败场景（见上表） |
| `04-import.spec.ts` | 导入、重复导入、非法 taskId |
| `05-security.spec.ts` | 穿越、key 泄露、Origin、幂等键哈希 |
| `06-viewport.spec.ts` | Studio 3D 视口加载与旋转 |

## 缺陷列表

**没有阻断级或应修级缺陷。** 一条观察项：

1. **`taskId` 数字样字符串会被隐式转换**（`import.json` → `coercedObservation`）：`POST /assets/lux3d/import {taskId: "1e5"}` 返回 202，并把 `taskId` 当成 **100000** 导入；`"1.5"`、`" "`、`"abc"`、`"-1"` 都正确 400。这是 Fastify 默认 `coerceTypes: true` 对 `anyOf[integer]` 分支的转换行为。影响很小（只会把"看起来像数字"的输入当成数字任务号），但如果以后要严格区分"字符串任务号"，建议在路由里显式关掉该字段的类型转换或在 handler 里再校验一次原始字符串。测试里只记录实际行为，没有把它当通过条件。

## 未运行（不要当成通过）

- **没有打真实 Lux3D 接口**：这是本任务的硬约束，所以真实生成、真实 part-split、真实并发额度、真实 2 小时 URL 过期都没有验证。真实接口只做过导入两个既有任务（实现方在 M0-A 交付时做的），本轮未重复。
- **没有验证部件拆分（part-split）**：实现方已声明封装但未接 UI，本轮不在范围内。因此"瓶盖打开"仍未验证。
- 没有验证多进程/多实例下的幂等（实现方已声明只支持单后端进程），也没有验证进程在提交确认前被杀掉后的重启恢复（那是 `service.test.ts` 的单元测试范围）。
- 没有验证 100 MiB 下载上限、DNS 固定、重定向逐跳检查的真实公网情形（只有单元测试覆盖）。
- 没有做视觉质量回归（只有"画布非空 + 拖动有变化"，没有和原模型逐像素比较；实现方在交付时做过固定视角目视对比）。
- 只跑了 Chromium；Firefox/WebKit、移动端、触摸手势未测。
- 模型处理性能只有单次样本（497 ms），没有大模型/多并发压力测试。

## 产物

- `docs/reports/artifacts/M0-A/playwright-results.json` — Playwright 原始结果
- `pipeline.json`、`image-to-3d.json`、`idempotency-*.json`、`failure-*.json`、`import.json`、`security-*.json`、`viewport.json`、`guard-selftest.json`
- `viewport-initial.png`、`viewport-rotated.png` — 视口截图
- 运行说明：`tests/e2e/README.md`

---

# 整改回归（依据 `docs/reports/M0-A-review.md`）

日期：2026-11-09。前置：调度已把 `fix/m0a-review` 合并到 master（`5275f7c`，修复提交 `67083df` / `b8af8ad` / `fc11845` / `a82958e`），内容见 `docs/reports/M0-A-fix-impl.md`：R1 唯一临时名、R2 下载 120 s 总时限 + AbortSignal 贯穿 + 优雅停机可恢复、R3 ready 缺文件用原 taskId 修复、S1 严格 mock、S3 非 loopback 的 http 上游拒绝启动。

## 测试侧怎么适配的（只改 tests/）

| 变化 | 处理 |
| --- | --- |
| `modelUrl` 现在带 `?revision=<uuid>` | `01-pipeline` 里原来断言精确字符串，改为匹配 `^/assets/<id>/model\.glb\?revision=[\w-]+$` |
| mock 现在校验 `Authorization` / `version` / `prompt\|img` / `outputFormat: ["glb"]` | 启动器本来就发 `mock-only`，客户端原本就发 `outputFormat: ["glb"]`，**无需放宽不改 mock 就全绿**（反向证明协议确实对得上） |
| 需要验证“下载中途优雅停机” | Windows 上 `taskkill /F` 拿不到 `app.close()`，给测试启动器加了 stdin 控制通道：收到 `close` 就调 `app.close()`（与 SIGTERM 同一路径） |
| 需要验证“配置错就拒绝启动” | 启动器捕获 `createApp` 抛错后以退出码 **12** 结束并打印原因；harness 新增 `startBackendExpectingRejection` 等退出码 |
| 下载总时限需要调短 | `ASSET_DOWNLOAD_TIMEOUT_MS`（实现本身就支持）由 `startBackend({downloadTimeoutMs})` 透传 |
| 子进程提前退出时启动会等满超时 | `startChild` 现在把“进程已退出”和“等待就绪”赛跑，失败时立刻报 `code=` 与输出 |
| 换 mock 场景时端口可能没释放 | 新增 `waitPortFree` 再重绑同端口 |

## 新增用例（`tests/e2e/m0a/07-review-fixes.spec.ts`）

| 用例 | 做法 | 实测结果 |
| --- | --- | --- |
| **R1** 残留临时文件不阻断重试 | 在 mock 将要使用的 `9000001/` 目录里预置 `model.glb.tmp` / `raw.glb.tmp`，再跑完整导入 | **ready**，无 `EEXIST`；目录最终为 `model.glb / model.glb.tmp / raw.glb / raw.glb.tmp`（旧残留保留、本次临时文件已清理）；资产根目录无任何 `.tmp` |
| **R2a** 滴流下载被总时限中止 | `MOCK_SCENARIO=drip`（1 字节 / 100 ms）+ `ASSET_DOWNLOAD_TIMEOUT_MS=1500` | **failed / `DOWNLOAD_TIMEOUT`**，提示“模型下载超过总时限”，**1.7 s** 结束，未留 `.tmp` |
| **R2b** 下载中优雅停机 → 可恢复 → 重启续跑 | drip mock + 长时限，等进入 `downloading` 后 stdin 触发 `app.close()`，换健康 mock（同端口）重启 | 停机退出码 **0**；索引里记录为 **`polling` + `SERVICE_STOPPED`**、`taskId=9000001` 保留；重启后自动变 **ready**，新 mock `creates = 0`、`gets = 3`，模型可下载且 GLB 合法 |
| **R3** ready 模型丢失 → 视口报错 → 重导入恢复 | 浏览器里导入 → ready → 删磁盘上的 `model.glb` → 刷新并选中该资产 → 重导入 | 错误边界出现“3D 模型加载失败”；重导入后 `data-loaded=true`、画布 **10,522** 种颜色；`modelUrl` revision 从 `…f42d7d08` 变为 `…0dbb3aed`；mock `creates = 0`；页面唯一异常是旧 URL 的 404（预期内），新 URL 无报错 |
| **S3** 非 loopback 的 http 上游拒绝启动 | 以 `LUX3D_BASE=http://192.0.2.10:4010`（TEST-NET-1）启动后端 | 退出码 **12**，输出 `Invalid LUX3D_BASE: HTTPS required except for loopback mock`；出站守卫**已加载**（marker active）且日志**为空** —— 没带着 key 发过任何请求 |

证据：`docs/reports/artifacts/M0-A/review-r1-leftover-temp.json`、`review-r2-drip-timeout.json`、`review-r2-resume.json`、`review-r3-model-missing.json`、`review-s3-http-base.json`。

## 全量结果

| 套件 | 结果 |
| --- | --- |
| `pnpm test` | **67 项**：插件 20（含 M0-B N1 三条 `it.fails` 预期失败）、资产 **46**、bridge 1 |
| `pnpm test:e2e`（M0-B） | **24 通过** |
| `pnpm test:e2e:m0a`（M0-A） | **27 通过**（原 22 + 新增 5） |
| `pnpm typecheck` | 通过 |

测试期间 `apps/server/src`、`apps/studio/src`、`packages/shared/src` 文件哈希前后一致；跑完 3001/4010/5173/5174 均已释放。

## 本轮未运行 / 限制

- **没有用 OS 级 SIGTERM 子进程验证**：用 stdin 触发的是同一个 `app.close()` 路径（实现的 SIGTERM 入口也是调它）。
- 没有验证“已进入同步模型转换时的强制中断”——实现方已声明转换隔离留给 M1，本轮只验证了“等待转换返回后保存可恢复状态”。
- 100 MiB 下载上限、私网/IPv6 重定向、截断 GLB、DNS 卡死等只在后端单元测试覆盖，e2e 只覆盖了滴流超时与模型缺失。
- S2（事件持久化/断线补拉）、S4（部件命名/体积门槛/转换隔离）按安排未做。
- 仍未打真实 Lux3D 接口（真实生成 / part-split / 真实 2 小时过期都没验证）；"瓶盖打开"仍未验证。
- 只跑 Chromium；Firefox/WebKit、移动端未测。

## 整改回归结论

R1/R2/R3/S3 的回归全部通过，原 22 项无回退。**M0-A 测试侧可以最终过关**，待 Codex 复核整改。
