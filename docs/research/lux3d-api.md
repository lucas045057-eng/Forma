# Lux3D（Aholo）接入调研 · 2026-11-09

## 结论速览
- Key 在 `apps/server/.env` 的 `LUX3D_API_KEY`（已被 .gitignore 忽略，不要写进任何入库文件）。
- 该 key **国内与国际两个端点都可用**（实测 task/list 均返回 c="0"）。默认用国内：`https://api.aholo3d.cn/lux3d/v1/...`；国际为 `https://api.aholo.ai/global/lux3d/v1/...`（国内域名不带 `/global` 前缀，带了会 404）。
- 鉴权：请求头 `Authorization: <key>`，**不加 Bearer**。
- 实测耗时与费用（账号历史任务）：text-to-3d **G1-Turbo 约 80–90 秒、13 credits**；**G1 约 5 分钟、20 credits**；image-to-3d G1-Turbo 约 97 秒。剩余额度未知。
- 输出：GLB 可直接下载（glTF 2.0，trimesh 导出，约 5.9 MB，单 mesh，PBR：baseColor + metallicRoughness 贴图，未压缩）。**结果 URL 2 小时过期，必须立刻下载落盘。**
- **生成结果没有部件拆分**（单 mesh），“瓶盖打开”需要额外调用 part-split 接口（`POST .../lux3d/v1/part-split/task/create`，入参 glbUrl），可用性待 M0-A 验证；不可用则按开发文档降级为旋转关键帧。

## 接口（来源：官方 OpenAPI `labs.aholo.ai/api-docs/specifications/services/lux3d/openapi.en.yaml`）
| 用途 | 方法 路径（国内域名，无 /global） |
| 文生 3D | POST /lux3d/v1/generate/text-to-3d/task/create |
| 图生 3D | POST /lux3d/v1/generate/img-to-3d/task/create |
| 查任务 | GET /lux3d/v1/generate/task/get?taskid=<id> |
| 任务列表（不耗额度） | GET /lux3d/v1/generate/task/list |
| 部件拆分 | POST /lux3d/v1/part-split/task/create（入参 glbUrl） |

- 文生 3D 请求体：`prompt`（必填）、`style`（photorealistic 默认 / cartoon / anime / hand_painted / …）、`version`（`G1` | `G1-Turbo`）、`faceCount`（10000–300000）、`outputFormat`（`["glb"]`；G1-Turbo 不传默认只给 zip）、`enablePbr`（G1-Turbo）。
- 图生 3D：`img`（公网 URL）或 `imgs`，二选一；本地图片需先上传到公网。
- 创建返回 `{"c":"0","d":<taskId>}`；并发超限 `c:"GENERATION_CONCURRENCY_LIMIT_EXCEEDED"`；参数错 `c:"-1"`。被拒的请求不产生任务、不扣额度。
- 查任务 `d.status`：0 初始化、1 运行中、3 成功、4 失败、6 取消；`d.outputs[].content` 为结果 URL。建议 10–15 秒轮询一次。
- 并发：免费档同时 2 个进行中任务、Pro 10 个（ClawHub 说法，未核实）。

## 已下载的样本
- `.data/lux3d-probe/4868277.glb`（账号历史任务 4868277 的输出，不知道当时的 prompt；只用于验证加载链路，不当作备用资产）。

## 待验证（M0-A）
- ~~实际生成一次“木盖香薰瓶”~~ 已完成（G1-Turbo 4969293、G1 4969298）。
- ~~part-split 能否拆出瓶盖~~ 可以，见下节；部件名需自行按包围盒推断。
- gltf-transform 压缩后的体积与视觉损失。
- 参赛使用条款、额度余量（未查到官方定价页内容：`lux3d.aholo.ai/lux3d/home?view=pricing`）。

## part-split 实测（2026-11-09）
- 提交：`POST /lux3d/v1/part-split/task/create`，body `{"glbUrl": "<生成结果 URL>"}`，约 1.5 分钟完成。**查询用 `GET /lux3d/v1/generate/task/get?taskid=`**（`/part-split/task/get` 不存在，404）。输出 `outputs[0].content` 为重建后的 GLB。
- 结果：G1-Turbo 模型（任务 4969293 → 拆分任务 4969889）拆成 6 个 mesh；G1 模型（4969298 → 4969891）拆成 8 个。**节点和 mesh 都没有名字**，accessor 也没有 min/max，只能按包围盒推断部件。
- 4969889 的部件（Y 轴向上，按包围盒判断）：
  | node | 推断 | Y 范围 | 顶点 |
  |---|---|---|---|
  | 5 | 瓶身 | -0.140 ~ -0.033 | 44k |
  | 0 | 瓶盖（原木盖/瓶口套） | -0.036 ~ 0.010，宽约 0.054 | 28k |
  | 1–4 | 扩香藤条 | 约 -0.03 ~ 0.14，细长 | 6k–29k |
- 4969891 同理：node 5 瓶身、node 0 瓶盖、其余 6 个为藤条。
- 结论：“滚动时瓶盖打开”**可做**——把瓶盖 + 藤条作为 `lid` 组整体上移即可。处理管线需要按包围盒自动命名（最低且最宽 = body；紧贴 body 顶部的小块 = lid；细长高 = reed_*），或在 assets 元数据里人工标注一次。
- 文件：`fallback/lux3d-split-4969889.glb`（11.2 MB）、`fallback/lux3d-split-4969891.glb`（13.5 MB），原始生成在 `fallback/lux3d-4969293.glb`、`fallback/lux3d-4969298.glb`。
