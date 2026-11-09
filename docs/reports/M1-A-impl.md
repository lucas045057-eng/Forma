# M1-A 实现交付

## 续作范围与中断核对

从 `3c67264` 继续，WIP 的 9 个源码文件均在，开始时工作树干净；未发现源码丢失。原有部件命名、隔离转换、SceneConfig 实现全部保留。补齐 shared 依赖，并发现/接通了 AssetService 尚未调用的隔离转换路径。所有安装、编辑、验证和提交限定在 `.worktrees/m1a`，未合并 master，未复制真实 .env，无真实 Lux3D 请求。未开子 agent、未新增或修改 Playwright 测试。

## 实现

- shared 的 `@spatial/shared/scene-config` 子路径导出类型、draft-07 Schema、轻量校验器及默认配置。Ajv 与 guard 对同组合法/非法 fixture 检查；TS 类型断言由 typecheck 检查。严格递增的 scroll.at 是额外语义约束，draft-07 本身不表达此跨项关系，调用者须同时用 isSceneConfig。
- 启动时、恢复任务前清理已知 `index.json`/`raw.glb`/`model.glb`/`parts.json` 的旧 `.tmp` 与 UUID 临时文件；不跟随目录符号链接、不遍历嵌套目录、不删未知文件。仍采用已有单后端进程约束。服务处理模型默认调用可取消/限时的子进程；停机 signal 贯通。
- `packages/scene-renderer` 的 ProductScene 为两处共用组件。集中导出 sRGB、ACES、曝光 1、PCFSoft 阴影、1024 阴影图、DPR 上限 2、1:1 长宽比及背景；灯光只用本地纯灯光，不请求 HDR/CDN。Studio 保留 OrbitControls，后续编辑 UI 属 M1-B。
- 每个视口独立下载/解析 GLB，不共享可变模型或 useGLTF 全局缓存。卸载/换 URL 时取消 fetch、释放 geometry/material/texture/ImageBitmap；迟到的解析结果也释放。Canvas 的 WebGL renderer/context 生命周期由 R3F 管理。URL 改变会重建错误边界。
- rotation 与各部件 offset 是独立关键帧轨道，隐式 0 帧使用 hero.rotation/零 offset；相邻点用 smoothstep，末帧保持。offset 从归一化模型坐标转换到节点父级局部坐标，避免归一化父级缩放放大位移；不累加上一帧位移。
- 作品首屏读取 `scene.config.json?raw`，合法配置经 HMR 接受；非法 Schema 或 JSON 语法错误保留上一份合法配置，首次就非法则使用无模型默认配置。仅进程内/HMR 保存，刷新页面不保存历史，持久历史属 M1-B。
- 首屏固定正方形；加载中、无模型及失败时使用原 CSS 香薰占位。原有按钮/列表/action-status 的 data-testid 保留。
- Studio 同样使用 ProductScene，显示 webReady=false 与未识别部件提示；任务号输入 pattern 与后端正十进制 1–19 位一致。

## 默认资产与命名

输入只读主工作树 `fallback/lux3d-split-4969889.glb`；本轮通过隔离转换重新生成作品 `public/assets/diffuser-4969889.glb` 和 `parts.json`，均已入库，运行无需主工作树 fallback。

| 项目 | 原始 | 输出 |
|---|---:|---:|
| 字节 | 11,192,096 | 987,884 |
| POSITION 顶点 | 123,874 | 86,529 |
| 最大边 | 未归一化 | 1 |

处理耗时 442 ms（子进程内转换计时，不含启动）；webReady=true，recognized=true。底面 Y 约 2.78e-17（浮点误差）。node0→cap，node1–4→reed_1..4，node5→body；lid 的子节点为 cap、reed_1、reed_2、reed_3、reed_4。默认 at=0.6 时 rotation=[0,1.8,0]，lid.offset=[0,0.08,0]。

## 依赖

shared 新增 devDependency：Ajv 8.20.0、Vitest 3.2.7（声明范围 ^8.17.1、^3.2.4，与已有 Vitest 用法一致）。新渲染包复用工作区已有版本：three 0.180.0、fiber 9.8.2、drei 10.7.9；React/React DOM 为 peer 依赖，工作区 19.3.1。类型包复用已有 @types/three 0.180.0、@types/react 19.3.0、@types/react-dom 19.3.0。Studio/作品新增本地 workspace 包依赖，没有引入额外第三方运行库。

## Pi：按渲染状态的原生元素清单

以下是源码语义清单，行列应从当前 TSX AST 独立计算，不写死位置和总数量。共同集合 + 对应状态集合构成预期源标记集合。

共同集合：

- App.tsx：main；header.navigation；a.brand 及其 span；关于链接 a；section#home；div.hero-copy；p.eyebrow；h1 及 br；p.intro 及 br；div.price 及 span；div.actions；p.fine-print；section#details；第二个 p.eyebrow；h2；ul.benefits；map 的 li（3 个实例），每项 span.number、h3、p；footer；output.action-status。
- Button.tsx 的原生 button：buy-button、save-button、gift-button 三个实例共享同一源码位置。
- ProductHero.tsx / ProductHero：div.product-scene（data-testid=product-scene）。

3D 成功态（等待 data-state=ready）：

- 共同集合全部出现。
- Placeholder 函数的所有原生元素均不出现。
- ProductScene/R3F 生成 Canvas 容器 div、测量 div 和 canvas；这是依赖组件生成的 DOM，不属于模板 AST。当前插件明确只标记模板 Vite root 内的 JSX，因此这些生成节点没有 data-src；点选归属到带标记的 product-scene。测试应单列该外部 Canvas 子树，保留模板所有源码节点的 missing 检查与锚点检查，不能将整个页面无漏标检查删除。
- scene-renderer 内 group/primitive/color/ambientLight/directionalLight 是 Three 对象，不是 HTML DOM，不应列入模板 DOM 预期。

回退态（无模型，或明确拦截 GLB 请求后等待失败稳定）：

- 共同集合全部出现。
- ProductHero.tsx / Placeholder：div.product-art；div.halo；div.bottle；div.cap；div.label；label 内 span、br、small；span.art-caption。
- 无模型/已失败时 Canvas 子树不出现；加载中会暂时同时存在隐藏 Canvas 与占位，不应在此过渡态做最终集合相等验收。

原 M0-B 测试针对旧静态模板写有锚点、source-model 路径集合等，需由 Pi 按 M1 设计的 N3 要求更新。未改其断言来让旧静态全集检查假通过。

## 验证

最终 `pnpm typecheck`、`pnpm build`、`pnpm test` 通过。测试 166 项：插件 20、shared 63、后端 78、渲染插值 4、既有 bridge 浏览器探针 1；无预期失败。

新增单测覆盖清理保留边界、独立轨道/0帧/钳位/平滑插值、lid 联动、不累积位移、旋转缩放父级下的坐标转换。WIP 已有子进程超时/取消及部件命名单测继续通过。

启动 `pnpm dev` 后通过 Chrome 原生 CDP（一次性命令，无 Playwright 新脚本）实测：

- 1200×900 浏览器，作品首屏 ready，canvas 481×481，脚本异常 0；截图 `.data/m1a-ready.png` 显示香薰瓶、瓶盖和藤条，未见裁切或白屏。
- 读取真实 R3F 场景图：初始 lid.position=[0,0,0]；scrollAt=0.5988372093023255 时 lid.position=[0,0.07999909977644643,0]，符合目标 0.08。lid 子节点确认为 cap+四根 reeds。
- 阻断 GLB 请求后，product-placeholder 存在、state=fallback，buy-button 仍存在。
- 第一次把 reload 与 Runtime.evaluate 紧接调用导致 CDP 的“Inspected target navigated”错误；改为等待 loadEventFired 后重新执行，回退探针通过。此为探针导航同步问题，未改实现。
- 类型构建首次发现 shared .ts re-export 的编译设置问题，统一 rewriteRelativeImportExtensions；bridge 的内联脚本测试不支持运行时 re-export，所以场景配置改为独立子路径，bridge 测试恢复通过，测试文件未改。

## 限制与后续验收

- 未运行/改写 Pi 的 M0-B/M0-A E2E；本轮只运行根单测脚本及上述 CDP 冒烟。正式双视口逐像素对比、HMR 非法配置动态编辑、资源释放压力测试、Firefox/WebKit/触屏由后续测试覆盖，不声称已验证。
- 构建通过但 Three 前端 chunk 超过 500 kB，Vite 给出体积警告。
- 部件识别仅针对符合启发式的直立香薰几何，不保证任意模型。单 mesh 模型仍能显示，但无开盖部件。
- 清理仅针对已知 .tmp 文件；崩溃产生的 .model-stage-* 目录尚无定期清扫，不会阻断新任务。
- M1-B 写回接口、采用资产接口、撤回历史、编辑控件和 diff 尚未实现；M1-A 不提前宣称 M1 里程碑过关。
