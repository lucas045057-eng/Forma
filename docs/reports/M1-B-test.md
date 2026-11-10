# M1-B 写回 / 编辑面板 · Pi 测试报告（M1 收口）

- 日期：2026-11-10
- 被测版本：master `ae0f7d0`（M1-B 合并 `5f5c8ad` + 整改 `ae0f7d0`）
- 测试代码：`tests/e2e/m1b/`、根级 `playwright.m1b.config.ts`、根 `package.json` 的 `test:e2e:m1b`；N3 相关改动在 `tests/e2e/`（`source-model.ts` / `checks.ts` / `lib.ts`）
- 未修改 `apps/`、`packages/`、`templates/` 实现代码；未装依赖、未改 lockfile
- 证据：`docs/reports/artifacts/M1-B/`

## 结论

**M1 过关：通过。** 工作台视口与作品页在三种情形下都是**逐像素一致**（单通道差 > 24 的像素比例 **0.00%**，三组实测 mean abs diff 1.77 / 1.77 / 0.19），写回、撤回、关键帧、采用、Host 白名单、实例锁、角度展开全部按要求通过。8 项要求全绿，回归无退化（单元 183、M0-B 24、M0-A 27、M1-A 7、M1-B 23）。没有阻断级 / 应修级缺陷。

## 运行方式

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
pnpm test           # 单元 183
pnpm test:e2e       # M0-B 24
pnpm test:e2e:m0a   # M0-A 27
pnpm test:e2e:m1a   # M1-A 7
pnpm test:e2e:m1b   # M1-B 23（本报告主角）
```

`playwright.m1b.config.ts` 自己起：mock Lux3D（4010，供拆分模型）、主后端（3001，`WORK_ROOT` = 真实模板目录，历史写 `.data/pi-m1b/history`，带出站守卫）、Studio（5173）、模板 dev server（5174）。写进模板目录的东西**每次用例都还原并校验**；会往作品目录写文件的用例（采用、路径越界、并发写）改用沙箱 `WORK_ROOT`（`.data/pi-m1b/sandbox/*`）。跑完 3001/4010/5173/5174 全部释放，`git status templates/` 干净。

## 1. 完整一致性（过关核心）

用 M1-B 的对照接点：`scene-load` → `scene-match-size` → `scene-compare`。对照模式下 Studio 用 **GET /scene 的已保存配置 + 同一个 modelUrl + 同一个 iframe 滚动位置**渲染，隐藏所有编辑手柄。两边画布固定到同一整数尺寸（378×378，backing 378，dpr 1），逐像素比较前允许 ≤3px 的整体平移对齐。

| 组 | 场景 | 画布 | 差异（>24/255 的像素比例） | 平均绝对差 | 最佳平移 |
| --- | --- | --- | --- | --- | --- |
| ① | 出厂配置 | 378×378（378 行全可见） | **0.00%** | 1.77/255 | (0,0) |
| ② | Studio 改角度/环境光/主光并“设为首屏” + `PUT /scene` 写入不同相机（position `[2.4,1.5,2.4]`、fov 42、主光 `#9fd0ff`）后 | 378×378 | **0.00%** | 1.77/255 | (0,0) |
| ③ | 滚动到 `at = 0.601`（开盖姿态） | 378×378，作品页可见 281 行（画布被滚出上沿 97px，只比公共可见段） | **0.00%** | 0.19/255 | (0,0) |

- **阈值沿用 M1-A**：对齐后同尺寸 < **0.5%**，归一化 512² < **2%**。理由同 M1-A 报告（两次独立 WebGL 渲染只在模型边缘有抗锯齿差异，模型轮廓周长是千级像素）。本轮实测 0.00%，余量很大。
- **配置来源（M1-A R1）**：每组都读了面板的 `scene-config` 与 `GET /scene` 做深度相等断言——Studio 用的确实是作品当前配置；③ 还确认了配置里有 `at=0.6` 关键帧、`scene-scroll-at = 0.601`。
- 另外确认对照画布不是空画布（轮廓像素 > 2000、高度 > 100px）。
- **画布尺寸**：M1-B 的 `scene-match-size` 读到的作品画布是 378.69 px；为了让帧缓冲与截图 1:1，两边都固定到 378（整数），这点与 M1-A 的处理一致，已记录在证据里。

证据：`consistency-default.json`、`consistency-after-edit.json`、`consistency-scroll-06.json`、`consistency-canvas-content.json`。

## 2. 写回即时同步

| 检查 | 实测 |
| --- | --- |
| 滑杆 + “设为首屏” → 作品页画面变化 | **408 ms**（从点击到画面变化，100ms 轮询；②组同类写入 390 ms） |
| iframe 是否整页刷新 | **没有**：`window.__m1bIdentity` 写入前后都是 20261110 |
| 落盘与接口一致 | `scene.config.json` 与 `GET /scene` 深度相等 |
| `scene-diff` 字段路径 | `/hero/model/rotation/1`、`/hero/lights/ambient`、`/scroll/0/model/rotation/1` —— 与本次改动完全对应；逐条回查新值与配置一致，且没有“值没变却出现在 diff 里”的项 |
| 改开盖滑杆 + “记为此处关键帧” | 同样即时反映到作品页，写进的关键帧 `lid.offset=[0,0.13,0]` |

证据：`writeback-hero.json`、`writeback-keyframe.json`。

## 3. 撤回

| 检查 | 实测 |
| --- | --- |
| 界面写入 → 撤回 | 配置恢复到写入前（深度相等），文件内容也恢复；作品页画面退回基线（`changedRatio < 0.002`），**382 ms** 恢复 |
| 历史为空 | 连续撤回 15 次后第 16 次返回 **409 `NO_SCENE_HISTORY`**；界面 `scene-error` 显示“没有可以撤回的场景写入”，文件未被改动 |
| 接口层 | `PUT` 后 `POST /scene/undo` 恢复上一份配置，diff 里出现被改回的字段 |

证据：`undo-ui.json`、`undo-empty.json`、`undo-api.json`。

## 4. 关键帧

| 检查 | 实测 |
| --- | --- |
| 写关键帧 | 预览滚到 `at=0.5504` → 开盖滑杆 0.12 → “记为此处关键帧”：配置里恰好 1 帧（`0.5504`，`lid=[0,0.12,0]`），写入到可见耗时 **161 ms** |
| 该位置姿态与配置一致 | 同位置 Studio 对照视口 vs 作品页：**0.00%** 差异（306 行） |
| 开盖量 | 冻结旋转后量测：旧插值 0.0784 → 新值 0.12，期望顶边上移 **12.0 px**，实测 **11 px**（比值 0.916，模型高 289px） |
| 同 at ±0.02 覆盖 | `at+0.01` 再写一次：±0.02 内仍只有 **1 帧**，`at` 变成新位置、`lid=0.05`，没有新增 |
| 出厂配置 at≈0.6 | 画面确实进入开盖姿态（变化 > 2%，公共可见段） |

证据：`keyframe-write.json`、`keyframe-overwrite.json`、`keyframe-scroll-shipped.json`。

## 5. 接口边界（沙箱）

| 检查 | 实测 |
| --- | --- |
| 8 种非法配置：额外字段、`fov=999`、关键帧乱序、关键帧重复 `at`、模型路径 `../`/`/assets/../../`/`http://`、缺字段 | **全部 400 + `INVALID_SCENE`**，每条都带 `error.fields[]`；配置文件 sha256 前后一致，`GET /scene` 不变 |
| 并发 5 个 PUT | 全部 200，序号严格递增且不重复，最终文件等于最后一次写入的配置 |
| 采用接口路径越界（`../escape`、`..%2F..%2Fetc%2Fpasswd`、`a/../../b`、超长 id 等） | 全部被拒（400/404/409/414），WORK_ROOT 外没有产生文件 |
| 主后端收到非法配置后网页 | 400、配置未变；作品页仍 `data-state=ready`、画布 1 个，**不白屏** |
| Studio 5173 代理访问 | 200（Host 白名单不影响同源代理） |

证据：`api-invalid.json`、`api-concurrent.json`、`api-paths.json`、`api-invalid-page.json`。

## 6. 采用模型

| 检查 | 实测 |
| --- | --- |
| 沙箱：ready 资产采用 | 200；`public/assets/<id>.glb` 与 `<id>.parts.json` 落盘、配置 `model` 更新为 `/assets/<id>.glb`，diff 含 `/model` |
| 主后端：作品页换模型 | `model` 从 `/assets/diffuser-4969889.glb` 变为 `/assets/lux3d-8400001.glb`，作品页在 **343 ms** 内加载了新模型（资源请求命中新 URL、`data-state=ready`）；文件 988,116 B |
| `webReady=false` | 不带 force → **409 `FORCE_REQUIRED`**；带 `force:true` → 200 |
| 同名不同内容 | 预先放一份不同字节 → **409 `ASSET_NAME_CONFLICT`**，且不会覆盖已有文件 |
| 清理 | 采用产物 `lux3d-8400001.glb/.parts.json` 已删除，`scene.config.json` 还原为出厂配置（用例内断言 + `git status templates/` 干净） |

说明：`webReady=false` 靠管线产不出来（处理后总是 <3MB / <10 万顶点），所以沙箱里直接改 `index.json` 构造该状态再起后端——这一步只造服务端状态，不碰实现。

证据：`adopt-sandbox-ok.json`、`adopt-guard.json`、`adopt-primary.json`。

## 7. 审查整改项

| 项 | 做法 | 实测 |
| --- | --- | --- |
| **R2** 识别失败但源模型自带 `lid`/`extras.spatialPart` | 用 gltf-transform 把单 mesh 模型的节点改名 `lid` 并写 `extras.spatialPart='lid'`，过管线处理 | 处理后 `recognized=false`、**所有节点的 `spatialPart` 都被清除**（`markedNodes = []`）；放进作品页滚动到开盖位置时该节点**位移 0 px**（画面 0 变化）；出厂模型同一份临时配置下位移 **32 px**（期望 32.16，比值 0.995）——开盖仍然正常 |
| **R3** 资产目录实例锁 | 同一资产目录起第二个后端 | 第二个以 **退出码 12** 失败，输出含 `INSTANCE_LOCKED`；第一个实例的 `index.json` sha256 未变、模型文件完好、`GET /scene` 仍 200；强制杀掉第一个后锁文件残留，第三个实例**成功接管**（`GET /scene` 200） |
| **B1** Host 白名单 | 原始 `node:http` 请求（可以自定义 Host 头） | `Host: evil.example:3001` → **403 `HOST_DENIED`**；正确 Host 但 `Origin: http://evil.example:3001` → 403；loopback 直连 200；经 Studio 5173 代理 200 |
| **S1** 跨 ±π 的角度展开 | 在 `at=0.5` 把旋转滑杆拉到 **−3.1** 记关键帧 | 写入的角度是 **3.1816**（> π，等于 −3.1+2π），与参考角 0.52 相差 2.66 rad < π ⇒ 走短弧而不是绕一圈 |

证据：`fix-r2-lid-gating.json`、`fix-r3-instance-lock.json`、`fix-b1-host.json`、`fix-s1-unwrap.json`。

## 8. 回归与 N3

| 套件 | 结果 |
| --- | --- |
| `pnpm test` | **183 项全过**（shared 68、插件 20、scene-renderer 5、bridge 1、后端 89） |
| `pnpm test:e2e`（M0-B） | **24 项全过** |
| `pnpm test:e2e:m0a`（M0-A） | **27 项全过** |
| `pnpm test:e2e:m1a`（M1-A） | **7 项全过** |
| `pnpm test:e2e:m1b`（M1-B） | **23 项全过** |

- **N3（条件渲染）**：沿用 M1-A 的分组——`source-model.ts` 给每个原生 JSX 节点带上最近组件名，`checks.ts` 按渲染状态（3D 成功 / 回退占位）分别定义应渲染集合；欠渲染 → `missing`、多余 → `leaked`、未标记 → `unmarked`、未知位置 → `phantom` 四类都保留断言，不写死数量。M0-B 的用例 8/9 跑 3D 成功态，M1-A 的 03 用例跑回退态，两边都通过。
- **M1-A 的出厂模型已重新生成**（987,884 → **988,116** 字节，顶点数 86,529 不变，新增 `extras.spatialPart` 标记）：M1-A 套件的断言都是动态量测（字节上限、顶点上限、两边模型 sha256 对比、轮廓位移），**不需要改断言**，本轮重跑 7 项全过。`parts.json` 内容未变，`lid` 子节点仍为 cap+4 reed。

## 缺陷列表

**没有阻断级 / 应修级缺陷。** 观察项（都不影响过关）：

1. **本次测试自身发现并修掉一个配置问题**：M0-B 的 `playwright.config.ts` 只 ignore 了 `m0a/`、`m1a/`，新增的 `m1b/` 会被默认套件收进来（第一次跑 M0-B 因此多跑了 23 个 m1b 用例、耗时 19 分钟并报错）。已补 `'**/m1b/**'`，属测试配置问题，不是实现缺陷。
2. **对照模式会禁用编辑控件**（by design）：要量“写之前 / 写之后”的画面，必须先退出对照再写入、再进对照取图。已在报告与用例里写明，供后续 M1 验收沿用。
3. **`webReady=false` 无法由管线产生**：采用接口的 force 分支只能在沙箱里改 `index.json` 构造。如果以后管线可能出现不达标输出，需要有对应真实样本。
4. **被拒配置的界面提示带 `Error: ` 前缀**（`scene-error` 直接渲染 `String(cause)`），文案可读性可以再打磨。
5. **采用接口没有“取消采用/回收”**：测试必须自己删产物；M1-B 已声明不清理未引用资产。
6. **at≈0.6 时作品页画布有一部分滚出视口**（可见 281/378 行），一致性只比公共可见段；这是布局事实，不是渲染差异。
7. **S4 Three 分包体积警告**仍未处理（实现方留到 M4）。

## 未运行（不要当成通过）

- 主光球面手柄与 TransformControls 的**真实鼠标拖动**回归（本轮旋转用滑杆、相机用 OrbitControls 拖动验证）。
- Firefox / WebKit、移动端、触屏手势、真机性能。
- 真实 Lux3D 生成（全程 mock）；真实付费额度、part-split。
- 多进程并发写同一作品（实现方声明只支持单后端串行）。
- 事件历史补拉 / 重连同步（M2）。
- 视觉画质回归（一致性是“两边相同”，不等价于与设计稿一致）。

## 产物

`docs/reports/artifacts/M1-B/`：`playwright-results.json`（23 passed）、`consistency-default/after-edit/scroll-06/canvas-content.json`、`writeback-hero/keyframe.json`、`undo-ui/empty/api.json`、`keyframe-write/overwrite/scroll-shipped.json`、`api-invalid/concurrent/paths/invalid-page.json`、`adopt-sandbox-ok/guard/primary.json`、`fix-r2-lid-gating.json`、`fix-r3-instance-lock.json`、`fix-b1-host.json`、`fix-s1-unwrap.json`。
