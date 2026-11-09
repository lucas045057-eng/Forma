# M1-A 共享 3D 渲染 / 场景配置 / 部件命名 · Pi 测试报告

- 日期：2026-11-09
- 被测版本：master `7a80e73`（合并 `feat/m1a-scene`，实现说明见 `docs/reports/M1-A-impl.md`）
- 测试代码：`tests/e2e/m1a/`、根级 `playwright.m1a.config.ts`、根 `package.json` 的 `test:e2e:m1a`；N3 相关改动在 `tests/e2e/`（`source-model.ts` / `checks.ts` / `lib.ts`）与 M0-B 的用例 8/9、变异验证
- 未修改 `apps/`、`packages/`、`templates/` 实现代码；未装依赖、未改 lockfile
- 证据：`docs/reports/artifacts/M1-A/`

## 结论

**M1-A 测试侧过关。** 要求 1–6 全部覆盖并通过：回归全绿（单元 166、M0-B 24、M0-A 27），一致性 0.29%（阈值 0.5%），滚动开盖位移 33 px vs 期望 33.12 px，回退与非法配置都不白屏不崩，部件命名与 `lid` 分组与人工核定一致，多次重载/HMR 没有 WebGL 上下文堆积。

有 1 项按任务说明记为**部分验证**：Studio 目前用 `defaultSceneConfig`，还没有“读同一份 `scene.config.json`”的接点（属 M1-B），所以「同一配置 + 同尺寸」里，本轮做到的是**同一模型 + 同一套渲染参数 + 同尺寸**。

## 运行方式

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
pnpm test           # 单元 166
pnpm test:e2e       # M0-B 24（会顺带验证 N3 的 3D 成功态）
pnpm test:e2e:m0a   # M0-A 27
pnpm test:e2e:m1a   # M1-A 7（本报告的主角）
```

`playwright.m1a.config.ts` 自己起一套服务：mock Lux3D（4010，下载内容换成本轮默认的**拆分模型** `fallback/lux3d-split-4969889.glb`）、被测后端（3001，独立 `.data/pi-m1a/assets`，带出站网络守卫）、Studio（5173）、模板 dev server（5174）。跑完服务全部回收，没有残留进程。

## 1. 回归（含 N3 按渲染状态分组）

| 套件 | 结果 |
| --- | --- |
| `pnpm test` | **166 项全过**（shared 63、插件 20、scene-renderer 4、bridge 1、后端 78），0 预期失败 |
| `pnpm test:e2e`（M0-B） | **24 项全过** |
| `pnpm test:e2e:m0a`（M0-A） | **27 项全过** |

**N3 的处理**（按 `M1-A-impl.md` 的元素清单，不写死数量、不删检查）：

- `source-model.ts` 现在给每个原生 JSX 节点带上**最近组件名**（与插件 cid 同口径）；`checks.ts` 用 `{ Placeholder: 'fallback' }` 把「只在回退态出现」的组件分组。
- **3D 成功态**（M0-B 用例 9）：期望集合 = 除 `Placeholder` 外的全部 AST 节点；断言 `missing`（该渲染却缺失）、`phantom`（DOM 出现 AST 里没有的位置）、`leaked`（回退态专属节点跑到成功态）、`unmarked`（渲染树有元素没标记）全为空，且 `domUniqueSrcs === expectedUniquePositions`。R3F 生成的 Canvas 子树是**组件输出、不属于模板 AST**，单独统计（`externalElements`）并从漏标检查里排除——排除规则只针对「`product-scene` 下不带 `data-src` 的直接子元素」，模板自身的元素一个都不放过。
- **回退态**（M1-A `03-fallback` 用例）：同样四个集合断言 + 6 个独立锚点全部按 AST 期望命中；实测 **37 个期望位置 = 37 个 DOM 标记位置**、未标记 0、`externalElements = 0`（此时没有 Canvas 子树）。
- **锚点**（用例 8、变异验证）按状态取：3D 成功态 4 个、回退态 6 个（`静静陪伴 · 慢慢散香` 和 `100 mL` 只在占位图里）。变异 A/B 相应改成在 ready 态下做，并把「所有 span 指向同一错误位置（33:82）」作为变异输入。

## 2. 一致性（M1 过关核心的前半）——**部分验证**

| 项 | 实测 |
| --- | --- |
| 两个画布尺寸 | 都是 **588×588** CSS px，backing store 588，`devicePixelRatio = 1`（test 侧把两边都固定到同一整数尺寸，避免小数尺寸引入重采样） |
| 模型 | 后端处理产物与仓库里提交的 `public/assets/diffuser-4969889.glb` **字节完全一致**：987,884 B，`sha256 = b0df0bef…3c6c1` |
| 像素差异（对齐后同尺寸） | **0.295%** 像素「单通道差 > 24」，平均绝对差 2.41/255，最佳平移 (0,0) |
| 像素差异（归一化 512²） | **0.46%**，平均绝对差 2.41/255 |

**阈值与理由**：同尺寸对齐后 **< 0.5%**，归一化后 **< 2%**。

- 理论上两边应当逐像素相同（同一模型、同一相机/灯光/色调映射/DPR）。实测的 0.29%（约 1,020/345,744 像素）集中在模型边缘，来源是两次独立 WebGL 渲染的抗锯齿与纹理采样抖动——它们不可能逐位一致，但也不该超过边缘像素量级。
- 模型轮廓大致占画面 140×414 px，周长约 1 千像素，边缘一圈正好是千级；实测差异量与「只差在边缘」一致，因此 0.5% 既留了 1.7 倍余量，又足以在“换了参数/换了模型”时立刻报警。
- 归一化 512² 会重采样，差异必然略高，所以阈值放宽到 2%，只作为交叉校验。

**为什么是「部分验证」**：Studio 的资产视口传的是 `defaultSceneConfig`，作品页读的是 `templates/product-page/src/scene.config.json`。两者在 `scrollAt = 0` 时的 `camera / hero.model / lights` 逐项相同（同一份默认值），模型又来自同一管线，所以本轮验证的是「同一模型 + 同一套渲染参数」。**M1-B 需要提供**：Studio 侧读取同一份 `scene.config.json`（或经 `PUT /scene` 同步当前值）的接点，以及「改角度/灯光后两边再次一致」所需的参数下发通道；届时同一用例把阈值沿用即可。

## 3. 滚动关键帧（开盖）

| 检查 | 实测 |
| --- | --- |
| 出厂配置滚到 0.6 | `data-scroll-at = 0.6009`；可见画布区域 **12.59%** 像素变化（旋转 + 开盖） |
| 出厂配置关键帧 | `at=0.6` 时 `rotation=[0,1.8,0]`、`lid.offset=[0,0.08,0]`；`at=0` 时 `offset=[0,0,0]` |
| lid 上移量（像素证据） | 模型高 **414 px** ⇒ 期望 0.08 × 414 = **33.12 px**；实测顶边上移 **33 px**（比值 **0.996**） |
| 中间位置插值 | `at≈0.025` 时实测 **17 px**（期望一半 ≈16.6 px，比值 0.513）⇒ 单调且符合 smoothstep |
| 复位 | 回到 `at=0` 后顶边回位（位移 0 px、画面差异 < 0.2%） |

**量测方法（如实说明）**：出厂配置在 `at=0.6` 时会把画布滚出视口 265 px，而且旋转同时从 0.52 变到 1.8 rad，无法把“lid 上移”单独量出来。所以量化这一步临时把关键帧位置改到 `0.05`、冻结旋转（位移量仍是配置里的 0.08），改完测、测完**按原字节还原**（用例里断言还原后文件内容与原文一致，`git status templates/` 干净）。出厂配置的 0.6 行为另有两条证据：`data-scroll-at` 与 12.59% 的画面变化。

## 4. 回退与非法配置

**模型请求失败**（进入页面前就 `route.abort()` 掉 `*diffuser-*.glb*`）：

| 检查 | 实测 |
| --- | --- |
| 占位 | `[data-testid="product-placeholder"]` 可见，`data-state=fallback`，canvas 数量 **0**（确认是“失败后”而不是“加载中”） |
| 未捕获异常 | **0** |
| 按钮可用 | 点「立即购买」后 `data-purchases=1` |
| 标记完整性 | 37 期望 = 37 DOM，`missing/phantom/leaked/unmarked` 全空，6 个锚点全中 |

**非法配置（HMR 改文件）**，三种写法各测一次，每次都按原字节还原：

| 写法 | 整页重载 | canvas | 页面尺寸 | 画面差异 | 还原 |
| --- | --- | --- | --- | --- | --- |
| 截断的 JSON | 否 | 1 | 1440×… | **0.0000** | ✔ |
| Schema 不通过（`fov=999`） | 否 | 1 | 1440×… | **0.0000** | ✔ |
| Schema 不通过（`scroll.at` 非递增） | 否 | 1 | 1440×… | **0.0000** | ✔ |

三种情况都：不白屏（`main` 仍占满宽度、购买按钮可见）、无未捕获异常、3D 画布仍在、**画面逐像素不变**——说明非法内容没有被应用，保留的是上一份合法配置。

## 5. 部件命名与 webReady 门槛

对 `fallback/lux3d-split-4969889.glb` 的处理结果（提交在仓库里的 `parts.json` + 模型场景图 + 后端实测三处交叉验证）：

| 检查 | 实测 |
| --- | --- |
| 命名（按 sourceIndex） | `cap`、`reed_1`、`reed_2`、`reed_3`、`reed_4`、`body` ✅ |
| `lid` 分组 | 场景图里 `lid` 的子节点 = `cap, reed_1, reed_2, reed_3, reed_4` ✅（`parts.json.lid = "lid"`） |
| `recognized` | true |
| `webReady` | **true**；处理后 **987,884 B**（< 3 MB）、**86,529** POSITION 顶点（< 10 万） |
| 与提交模型一致 | 后端处理产物与 `public/assets/diffuser-4969889.glb` sha256 完全相同 |

单 mesh 模型（`fallback/lux3d-4969293.glb`）：

| 检查 | 实测 |
| --- | --- |
| 处理 | `status = ready`，`webReady = true`，不崩 |
| 部件识别 | `recognized = false`，`reason = "Expected body, cap and at least one reed"` |
| 是否编造名字 | 没有：节点保留原名 `geometry_0`，测试断言不存在 `body/cap/reed_n/lid` 这类臆造命名 |
| 模型可用 | 仍能下载到合法 GLB |

## 6. 资源释放（尽力而为）

| 检查 | 实测 |
| --- | --- |
| 整页重载 4 次 | 每次都是 **1 个 canvas、1 次 `webgl2` 上下文创建** |
| HMR 改配置 4 次 | 每次仍是 **1 个 canvas、1 次上下文创建**（改配置不重建 Canvas） |
| 浏览器 WebGL 警告 | **0 条**（含 `Too many active WebGL contexts` / `CONTEXT_LOST_WEBGL` 类） |
| 页面异常 | 0 |

**局限（如实写）**：Playwright 拿不到“当前活跃 WebGL 上下文数量”的精确计数，这里用三条替代证据：控制台无上下文相关警告、每次加载 `getContext('webgl2')` 只调用一次、HMR 不重建 Canvas。真正的 GPU 资源（geometry/texture/ImageBitmap）释放只有实现方的单元测试覆盖，本轮没有做内存压力测试。

## 缺陷列表

**没有阻断级 / 应修级缺陷。** 观察项：

1. **Studio 与作品页还没共用同一份配置**（已知的 M1-B 范围）：Studio 用 `defaultSceneConfig`，所以本轮一致性是“同模型 + 同参数”的部分验证。M1-B 需要给 Studio 一个配置来源接点。
2. **M0-A 的 R3 用例断言按新实现更新了**（不是缺陷）：M1-A 的共享渲染器自己 `fetch` 并捕获模型加载错误，`model.glb` 404 不再抛出未捕获异常，而是直接进入回退提示。原断言「必须出现指向旧 URL 的 pageerror」因此失效，已改成更严的「不许有任何未捕获异常 + 回退提示可见 + 无无关控制台错误」。另外该用例里 `data-loaded` 会被面板自动选中的旧资产提前置真，已改为先等后端 ready、再等 `asset-select` 切到目标资产。
3. **单 mesh 模型未识别时保留了原节点名**（`geometry_0`）并给出 `reason`，符合“不编造部件名”，但 `nodes` 里仍有一条记录——M1-B 若要在 UI 上区分“未识别”与“识别出 1 个部件”，需要依赖 `recognized`/`reason` 而不是 `nodes.length`。
4. **3D chunk 体积警告**（实现方已声明）：构建通过，但 Three 相关 chunk 超过 500 kB 提示仍在。

## 未运行（不要当成通过）

- **改角度/灯光后两边再次一致**、**即时同步耗时**、**Schema 拒绝的 4xx 接口**、**撤回**：全部依赖 `PUT /scene` 与 Studio 编辑面板，属 M1-B。
- 同一份 `scene.config.json` 驱动两个视口的对比（见观察项 1）。
- Firefox / WebKit、移动端、触屏手势、真机性能与 GPU 内存压力测试。
- 真实 Lux3D 生成（本轮 mock 全程，未打真实接口）。
- 视觉质量回归（只有“画布非空 + 一致性 + 位移量”，没有做与原模型的逐像素画质比对）。

## 产物

- `docs/reports/artifacts/M1-A/consistency.json`（含两份模型 sha256、画布信息、两种阈值下的差异）
- `scroll-lid.json`、`fallback.json`、`invalid-config.json`、`parts.json`、`parts-single-mesh.json`、`resource-release.json`
- `playwright-results.json`（7 passed）
