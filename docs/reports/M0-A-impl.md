# M0-A Lux3D 调用跑通 · 实现报告

日期：2026-11-09。范围：M0-plan.md 的 M0-A 实现 1–6 步及本轮补充要求。未修改 docs/design、docs/research、orbital/；未新增 Playwright 测试。本轮没有创建真实付费生成或拆分任务，使用既有任务导入和离线样本完成验证。

## 实现内容

- `apps/server/src/assets/lux3d.ts`：封装 createTextTo3d、createImgTo3d、getTask、listTasks、createPartSplit。国内 base 默认不含 /global；Authorization 直接使用后端 key；part-split 查询复用 generate/task/get。
- `service.ts`：持久化幂等记录、提交状态机、15 秒轮询与 15 分钟截止、任务导入、立即下载、处理和事件推送。原始文件为 `.data/assets/<taskId>/raw.glb`，输出 `model.glb`；离线资产目录使用本地 id。
- `download.ts`：下载不转发 API key；处理 403/404 的 URL 过期提示；检查 GLB 完整性与 100 MiB 上限；对公网 HTTPS 下载校验 DNS、固定已验证地址并逐跳检查重定向；仅为配置的本地 mock 放行 loopback HTTP。
- `process-model.ts`：焊接、误差受限简化、1024 WebP 贴图、Meshopt 压缩、世界包围盒归一化。拒绝 GLB 对本地文件的外部 buffer/image 引用，输出先验证再原子发布。
- `app.ts`：可被测试实例化的 Fastify 应用，REST 与 WebSocket，同源请求校验和固定可读错误；不记录请求头、key、上游响应体或签名下载 URL。
- `mock-server.ts`：可独立启动或作为测试工厂导入，支持成功、失败、取消、超时、未知状态和下载过期。
- `process-cli.ts`：在服务未启动时处理本地 GLB 并登记为可选资产。
- `AssetPanel.tsx`：按需加载的 fiber/drei 视口、OrbitControls、资产列表、任务导入、状态及指标展示；Meshopt 解码器随前端打包。原有 M0-B 点选界面保持默认入口。

## 持久化及幂等决定

采用 `.data/assets/index.json`，因为 M0 是单进程本机演示，JSON 足以保存资产状态且避免引入数据库依赖。写入串行执行，先写临时文件再原子替换；模型输出同样原子发布。

同一幂等键先写本地记录，再调用真实创建接口；并发请求经同一提交队列处理。相同参数返回原记录/远端 taskId，不重复创建；同键不同参数返回 409。创建请求结果不明或进程在提交确认前退出时保留 submit_unknown，需查询远端任务列表后导入，禁止自动重发付费创建。成功写入 taskId 后，重启可恢复轮询。

失败/超时后用 importTask 重新查询已有远端任务状态，不新建任务。相同幂等键本身不清空失败记录。下载 URL 不持久化，重新导入时重新向上游查询。

M0 限制为单后端进程；离线 CLI 不可与后端并发写同一目录。未实现跨进程锁、数据库事务和分布式队列。

## 真实模型处理数据

以下为本机离线处理实测；MB 使用十进制 1,000,000 字节。

| 样本 | 原始字节 | 处理后字节 | 原始 POSITION 顶点 | 处理后 POSITION 顶点 | 处理耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4969293 / G1-Turbo | 13,345,788 | 983,560（0.984 MB） | 117,010 | 85,436 | 476 ms |
| 4969298 / G1 | 11,107,988 | 940,352（0.940 MB） | 121,386 | 86,014 | 430 ms |

两份样本均满足 <3 MB 和 <100,000 顶点。Turbo 体积减少约 92.6%，G1 约 91.5%。耗时为读取、优化、输出及结果检查，不含远端生成或网络下载；真实 API 导入时分别测得处理 494 ms、433 ms。

注意统计口径：之前约 59–62 万的数字是索引数量，不是 POSITION accessor 中的顶点数。Turbo 原始索引 589,434，对应 196,478 个三角形；实际 POSITION 顶点是 117,010。报告及 UI 使用 POSITION 顶点计数（共享 accessor 不重复计数）。

Turbo 保留单 mesh、一个材质及两张 PBR 贴图；两张 2048² PNG 改为 1024² WebP。Meshopt 对网格压缩，简化每轮按当前顶点数设比例，误差上限依次 0.001 / 0.005 / 0.02；若仍不能低于 10 万顶点，明确失败，不无限牺牲几何质量。

输出世界边界：

- Turbo：min `[-0.1589556566, 0, -0.1647541734]`，max `[0.1589556566, 1, 0.1647541734]`。
- G1：min `[-0.1714072085, 0, -0.1757408368]`，max `[0.1714072085, 1, 0.1757408368]`。

最大边为 1，底面中心为原点；归一化保留原场景层级与材质。

## 验证结果

- `pnpm typecheck`：全部通过，包括新增后端测试的 TypeScript 检查。
- `pnpm build`：全部通过。3D 依赖已按需加载，仍有约 999 kB（gzip 272 kB）的 chunk 大小提示，不影响构建。
- `pnpm test`：20 项通过（M0-B 插件 6 项；资产后端 14 项）。覆盖并发与重启幂等、未知提交结果、0/1/3/4/6/未知状态、超时、403/404、重导入先查询、外部引用阻止、路径检查、材质与世界坐标归一化、HTTP 全处理链路。
- 真实任务 4969293：POST import 返回 202，完成查询→下载→处理→ready。未创建新任务，结果 URL 本次仍有效。
- 真实任务 4969298：经 Studio 同源代理 POST import，WebSocket 实收 `asset.progress`（polling → downloading → processing）及 `asset.ready`，模型文件可获取。
- `pnpm dev`：三服务正常启动；在本机无界面 Chrome 通过 DevTools 协议打开 Studio 的“3D 资产”，加载 Turbo 优化结果，`data-loaded=true`。发送真实鼠标按下/移动/释放事件后截图发生对应视角变化；未捕获浏览器运行异常。
- 同相机、同灯光对照原始归一化模型和优化模型，轮廓、木盖及瓶身纹理未见明显差异。仅是本机固定视角目视比较，不替代正式视觉验收。
- 验证截图保留在 gitignored `.data/m0-a-original.png`、`.data/m0-a-optimized.png`、`.data/m0-a-rotated.png`。
- 浏览器冒烟初次因 DevTools 导航事件竞态中断；改为等待指定 loaderId 的 load 事件后完成验证，应用无对应异常。
- 本轮验证用浏览器及开发服务在交付前关闭。

## 启动与接口

```sh
pnpm install
pnpm dev
```

Studio：`http://127.0.0.1:5173/`；后端：3001；模板：5174。打开顶部“3D 资产”，列表里可选 offline-turbo、offline-g1 以及真实导入的 Lux3D 资产。全新环境需先导入或离线处理，因为模型产物和 index.json 不入 Git。

| 接口 | 说明 |
| --- | --- |
| POST `/assets/lux3d` | prompt/img 二选一，version 必须为 G1 或 G1-Turbo，idempotencyKey 必填；返回本地资产记录和远端 taskId |
| POST `/assets/lux3d/import` | `{taskId}`；无新生成，可对失败资产重新查询 |
| GET `/assets` | 资产列表 |
| GET `/assets/:id` | 状态、错误、modelUrl、处理指标 |
| GET `/assets/:id/model.glb` | 仅 ready 模型，Content-Type model/gltf-binary |
| WS `/events` | `{type, ts, sequence, asset}`，推 asset.progress / asset.ready |
| GET `/health` | 后端健康检查 |

创建请求示例（不含 key）：

```json
{"prompt":"wooden cap amber diffuser bottle","version":"G1-Turbo","idempotencyKey":"demo-bottle-001"}
```

`LUX3D_API_KEY` 只通过后端环境变量读取；`LUX3D_BASE` 可覆盖；part-split 已封装但不接 UI，也未在本轮发起真实拆分。

## 给 Pi 的 mock 使用说明

终端一（Git Bash）：

```sh
pnpm --filter @spatial/server mock
```

终端二（从仓库根）：

```sh
LUX3D_BASE=http://127.0.0.1:4010 LUX3D_API_KEY=mock-only ASSETS_DIR=../../.data/mock-assets pnpm dev
```

此配置覆盖 .env 的真实配置。导入任意数字 taskId，mock 依次返回 0、1、3；默认输出内置三角形 GLB，无外部输入依赖。`MOCK_GLB` 可设为真实香薰 GLB 绝对路径。默认两次轮询后完成；单元测试可用 createApp 的 pollMs / timeoutMs 缩短。

- `MOCK_SCENARIO`：success / failed / cancelled / expired403 / expired404 / timeout / unknown。
- `MOCK_PORT`：默认 4010。
- `GET /__stats`：creates、gets，验证幂等次数。
- `createMockServer`、`createApp` 均可 import，随机端口与临时目录示例见 app.test.ts。
- 测试间使用独立 ASSETS_DIR，避免复用成功缓存。
- 视口 testid：asset-open / asset-close / asset-select / asset-task-id / asset-import / asset-status / model-viewport。加载完成使用 `[data-testid="model-viewport"][data-loaded="true"]`。

## 已知限制与后续验收

- 正式 M0-A Playwright 测试和 Codex 审查尚待后续执行；本实现报告不表示里程碑正式验收通过。
- 仅内嵌 GLB 和本机单进程资产服务；无生产部署、鉴权账号、分布式幂等或多实例同步。
- WebSocket sequence 只在本进程内递增，不保存事件重放；界面每 3 秒读取列表恢复状态。
- 原始模型仍是单 mesh；没有验证部件拆分结果，不能单独开盖。
- 没有真实新生成验证；文生/图生/part-split 创建路径通过 mock 与客户端封装验证，真实验证仅导入查询及下载链路。
- 纹理缩小和有损简化不是逐像素无损；本机对照未见明显损失，仍需正式视觉审查。
- 单次原始下载上限 100 MiB；不支持外部 glTF 文件引用及任意 Draco 输入。模型转换在主进程执行，本次样本约半秒，超大模型后续可迁移 worker。
- 3D chunk 大小有 Vite 提示；当前 Fastify 的 disableRequestLogging 有未来版本弃用提示，均不影响本轮检查结果。
- 离线 CLI 的本地处理中断需要人工以同名失败记录或新 id 重试；无多进程恢复编排。

## 本轮提交

- `d6bd268` 接入 Lux3D 客户端与安全下载及资产协议
- `fa51019` 实现 GLB 简化压缩归一化与安全原子输出
- `a269f1c` 实现持久化幂等资产任务接口与可复用模拟服务
- `8cc5743` 接入三维资产视口与任务导入状态展示
- README 和本报告随“补充 Lux3D 运行说明与实测交付报告”提交，提交号见 git log。

并行的 `35af89a` 为 Pi 的 M0-B 测试提交；本轮保留其测试配置和依赖，未修改其用例或报告。
