# M0-B 点选 → 源码定位 · Codex 审查报告

- 日期：2026-11-09
- 结论：**有条件通过**。指定模板的点选主链路与 Pi 留存的验收证据相符；没有发现阻断当前模板演示的问题。下列 3 项“应修”需修复并由 Pi 回归后，才能将 M0-B 标为最终验收通过。
- 分级统计：阻断 0，应修 3，建议 4。
- 范围：实现 `81d360e` 至 `92fc0ea`，包含首次提交；测试为 `35af89a` 相对其父提交的增量。`d6bd268` 的 Lux3D 实现及后续工作区改动不在本次评价范围。
- 取证方式：实现通过 `git show 92fc0ea:<path>` 读取，测试通过 `git show 35af89a:<path>` 读取；以下行号均对应这两个快照。并行开发期间 Studio 文件发生变化，未将这些变化算入审查对象。
- 本次只新增本报告，没有修改实现、测试、原有证据或 Orbital 记忆，也没有创建提交。

## 阻断

无。未发现当前模板无法完成点选、外部窗口消息绕过现有来源校验、或 M0-B 将密钥带入前端的问题。此结论不包含 M0-A 的密钥及资产服务审查。

## 应修

### R1 · 选取模式仍会执行先于 click 的业务行为及隐式表单提交

- 位置：`packages/bridge/src/index.ts:43`、`packages/bridge/src/index.ts:89`；现有测试只验证 `tests/e2e/m0b-pick.spec.ts:157` 的 onClick 计数。
- 问题：只注册 `click` / `auxclick` 的 capture 拦截。真实鼠标操作的 `pointerdown`、`mousedown` 已先到达业务监听器；只有一个文本输入框且没有提交按钮的表单，回车可以直接触发 `submit`，不经过被拦截的按钮 click。
- 复现证据：在独立 Chromium 页面中加载 **92fc0ea 的 bridge/shared 快照**，开启选取，物理点击有三个事件监听器的按钮，再聚焦单输入框按 Enter。计数为 `{ pointerdown: 1, mousedown: 1, click: 0, submit: 1 }`。表单业务处理器为防止探针导航自行 preventDefault，但仍已执行。相同探针中的普通链接点击被成功阻止，不能将问题概括为“所有键盘操作或链接跳转都未拦截”。
- 为什么要修：文档要求选取时“不触发页面原有行为”。当前模板只有 onClick，因此 Pi 的用例能过；加入 M1 的拖动/3D 交互或表单后，用户只是选择对象也可能改动作品状态。这是已声明限制，但仍是后续集成前应补齐的行为缺口。
- 建议修法：在选取状态下于 capture 阶段拦截会激活业务的 pointer/mouse 按下、抬起等事件，并拦截 submit 及适当的键盘激活/编辑行为；保持滚动和选取所需的移动事件可用。需结合浏览器默认行为确定事件集合，避免只在 click 中补逻辑。由 Pi 增加真实鼠标、单输入框 Enter、链接与退出恢复的用例，确认事件处理器与默认导航都没有副作用。

### R2 · 删除保留属性后继续访问其中的 JSX，可把外层元素错标为内层源码

- 位置：`packages/vite-plugin-source-tag/src/index.ts:36`、`packages/vite-plugin-source-tag/src/index.ts:44`。
- 问题：MagicString 删除已有 `data-src` / `data-cid` 属性时，Babel AST 仍保留属性表达式及其后代。后续访问这些已删除区间内的 JSX 并继续插入标记，会破坏外层标记的插入结果。
- 最小复现，文件 `src/Page.tsx`：

  ```tsx
  const Page=()=> <div data-src={<span/>}/>;
  ```

  对 92fc0ea 的 `tagSource` 做内存调用，实际输出：

  ```tsx
  const Page=()=> <div  data-src={"src/Page.tsx:1:32"} data-cid={"Page"}/>;
  ```

  外层 `<div` 位于 **1:17**，输出却指向原来属性内部 `<span` 的 **1:32**。输出仍可被 Babel 解析，故构建成功也不能发现此类错位。普通字符串保留属性和 spread 后覆盖的探针正常。
- 为什么要修：这直接违反“标记指向该元素原始开标签”的要求，并且发生于用户指定需审查的“已有 data-src 属性”边界。当前模板未触发，但候选代码可以出现合法的 JSX 属性表达式。
- 建议修法：删除保留属性时，同时跳过相应 AST 属性子树的后续注入；或预先记录删除区间，排除位于其中的所有插入。增加含嵌套 JSX 的 `data-src`、`data-cid` 回归用例，验证外层标记准确且不存在对已删除内容的编辑。

### R3 · 随机测试的预期来源依赖插件产物，会漏掉同标签错位及漏标回归

- 位置：`tests/e2e/lib.ts:103`；`tests/e2e/m0b-pick.spec.ts:81`、`:97`、`:119`、`:125`。
- 问题：候选集只枚举 `[data-src]`，`expectedSrc` 和 `expectedCid` 直接读取同一套注入结果。独立的源码读取仅确认目标字符为 `<`、标签名相同，没有证明它就是被点击实例对应的那个源码节点。
- 证据一：按用例 1 的相同判断条件进行内存变异检查，将样本中所有 span 的 DOM 标记与上报位置统一指向 `src/App.tsx:16:45`。样本中原为 `33:82`、`24:40`、`43:15` 的三个不同 span，仍满足 src 相等、`<`、标签 span 和 cid 相等的判断。本次验证的是该断言的盲区，没有改实现或宣称重新运行变异后的整套 E2E。
- 证据二：插件若不再给某类元素注入属性，该类元素直接从抽样池消失。用例只要求候选数大于 20；没有核对全部应标记的 JSX/渲染元素是否都有正确标记。因而固定种子和列号 +1 变异成功，并不能排除漏标问题。
- 为什么要修：现有测试不是整体空转，能抓到无效位置、列号偏移、桥接错误以及 Button 固定位置回归；但不足以支持“每个抽样实例确实映射回自身源码”的完整结论。
- 建议修法：保留随机抽样，并增加独立于 data-src 的少量确定性目标（例如同文件不同位置、不同文本的两个 span），用原始源码 AST 位置或人工核定的位置断言一一对应；另补应标记节点的完整性校验。增加“第二个同名标签被标成第一个”和“漏标某类元素”的变异验证。不要仅把候选总数写死为 46。

## 建议

### S1 · body 观察兜底会观察到自己的覆盖层，产生持续重绘

- 位置：`packages/bridge/src/index.ts:21`、`:30`、`:98`。
- 问题及影响：页面没有 `#root` 时，MutationObserver 观察整个 body，覆盖层也在 body 中；draw 的 replaceChildren/append 又触发 observer，再排下一帧。独立 Chromium 探针无外部 DOM 更新，选取后 250 ms 内记录到 17 次 requestAnimationFrame 调度。当前模板有 `#root`，覆盖层位于其外，因此未触发这个兜底问题。
- 建议修法：让 observer 忽略覆盖层及其后代的 mutation，或明确要求传入独立作品根节点并将 overlay 放在观察范围外。补一个无 `#root` 的空闲重绘上限检查。

### S2 · 大页面高亮会在每次重绘时扫描全部标记节点

- 位置：`packages/bridge/src/index.ts:16`、`:23`、`:79`。
- 问题及影响：每个选取点击扫描一次；选中后每次 pointermove、滚动或 mutation 触发的 draw 又扫描全部 `[data-src]`，并对实例逐一读取布局、创建覆盖框。requestAnimationFrame 合并了同帧调度，但没有消除 O(N) 扫描和 O(K) 布局/DOM 成本。当前 46 个节点未构成可证实的性能失败，不据此阻断。
- 建议修法：在内容 mutation 后失效并重建 src→元素索引，复用覆盖框；限制对不可见实例的布局/绘制。扩大页面规模后再以交互耗时决定是否需要进一步优化。

### S3 · 最近的大写变量不一定是组件，cid 可能误归属

- 位置：`packages/vite-plugin-source-tag/src/index.ts:11`。
- 复现：`const Page=()=> {const Heading=<h1/>; return Heading;}` 输出 `data-cid="Heading"`，但 Heading 是保存 React 元素的变量，最近组件应为 Page。src 行列仍正确，当前模板不受影响。
- 建议修法：识别变量是否绑定组件函数、类或支持的包装调用，区分保存 JSX 值的局部变量；补一个该类 fixture。

### S4 · 消息安全回归和 M2 的版本、路径校验需要补充

- 位置：`packages/shared/src/index.ts:79`；`apps/studio/src/App.tsx:28`；`tests/e2e/m0b-pick.spec.ts:302`。
- 现状及影响：消息校验覆盖类型、必需样式字段、有限 bbox、正整数 instances、最多三个 ancestors。src/cid 仅检查字符串，尚未校验源码路径、行列是否存在。Studio 的 baseVersion 固定为配置加载时的 HEAD，也不代表脏工作区；这些不能替代 M2 后端的版本及文件范围校验。当前 M0 没有文件写入入口，不将其认定为现存路径逃逸漏洞。
- 建议修法：M2 接入写操作前，由后端验证版本、源码位置与候选 worktree 的规范化路径。Pi 另补两端畸形 payload、bridge 错误 source 的拒绝测试，以及真实跨窗口 postMessage 测试。当前 `MessageEvent` 派发可验证过滤分支，但没有覆盖浏览器实际发送目标的行为。`src` 格式检查也不能代替后端文件授权。

## 各重点的审查结果

| 重点 | 结果与边界 |
| --- | --- |
| 行列和语法边界 | 内存探针覆盖 CRLF、首字符 BOM、中文/emoji UTF-16 列、Fragment、条件渲染、map、自闭合、TSX 泛型箭头函数、字符串保留属性及 spread，位置均指向原始 `<`。发现 R2。BOM 结果仅表示插件收到含 BOM 的源码时正确，未扩张为完整 Vite 加载链路验收。 |
| serve、路径 | 插件 `apply: 'serve'`、`enforce: 'pre'`；仅处理 jsx/tsx，排除 node_modules 和 root 外文件。Windows 探针得到 `src/Page.tsx`，使用 Vite 模板 root 而非 monorepo root，与 README 说明一致。 |
| sourcemap / HMR | MagicString 返回 hires map 并包含原始源码。带 CRLF/emoji 的内存探针把注入后原有 title 属性映回原始第 2 行第 12 列（0 基），符合该源码位置。未发现删除 R2 以外的重新格式化漂移。bridge 在模板入口注册 HMR dispose；没有在共享工作树中编辑文件测试实际热更新，因此不能宣称 HMR 全链路回归通过。 |
| 拦截和恢复 | 发现 R1。浏览器探针中选取时 click 计数为 0，普通链接 hash 不变；退出后 click 计数变 1、链接 Enter 可跳转，覆盖框为 0；dispose 后覆盖层为 0。监听器添加/移除函数与 capture 参数逐项匹配，observer 断开、待执行帧取消；停止选取保留一套空覆盖层和待命监听器是安装生命周期设计。 |
| instances / ancestors | instances 按同 src 的 DOM 节点计数，不通过选择器拼接 src；覆盖所有共享实例。ancestors 是向上三个 DOM 层级中有标记的节点，未标记层也消耗层级，与 README/Pi 的口径一致。它不是“继续上溯直到凑满三个有源码的祖先”。列表与共享组件统一表达影响处数，尚不区分语义。 |
| postMessage | Studio 校验同源且 source 为当前 iframe；bridge 校验同源且 source 为 parent；两端使用运行时结构守卫。发送均为精确 origin，无 `"*"`。收到 pick:result 时 Studio 要求正在选取，并在展开 payload 后覆盖 baseVersion。现有设计的来源校验不构成对同源恶意作品脚本的隔离，MVP 自有模板范围内没有发现新增的来源绕过。 |
| 共享模型 / M2 | Selection、Task、Candidate、Check、ApprovalCard 的核心字段与文档一致；PickSelection 正确省略 baseVersion，补充 styles/note；七类消息方向和内容齐全。Check 保留 not_run。TaskEvent/FileDiff 为最小结构，可扩展；M2 必须补服务端校验与版本一致性，不能将当前 TS 类型当作权限控制。 |
| Pi 测试 | 源文件读取、列号 +1 自检、固定 Button 源码断言、反向来源对照有价值；17 次鼠标与 3 次派发点击已如实记录。随机样本不足以覆盖 BOM/泛型等语法边界，应由插件 fixture 补充。存在 R3。运行时错误目前只收集进最后一个用例的证据，建议未来冒烟测试明确断言不允许的 pageerror，而不是把记录等同于检查。 |
| 工程 | M0-B 依赖与任务相称，无须为本次功能引入新包。92fc0ea 的 allowBuilds 仅 esbuild；当前 sharp 白名单属于 M0-A，不计入本次。已实际检查 .env、.env.test、.data/assets 和指定 Orbital transcript 路径命中忽略规则。README 的 Node/pnpm、端口、proxy/HMR、启动和验证命令与快照配置一致；Pi README 补充浏览器安装路径。未重新安装验证全新环境。 |

## 验证说明与收口条件

本次执行的是秒级、无仓库文件写入的取证探针：从 Git 快照读取 TS，用现有 TypeScript 在内存转译，调用插件；以本机 Chromium 加载内存中的 bridge/shared，触发真实鼠标和键盘操作；读取既有 Pi 抽样证据复核断言的盲区。浏览器在 finally 中关闭。插件运行采用现有已安装依赖，没有重新安装 92fc0ea 的独立依赖树。

没有重跑 `pnpm build`、完整 Vitest 或 Playwright 套件，没有启动项目开发服务，也没有覆盖 Pi 的 JSON 证据。故本报告中的 Pi 8/8、20/20 是对其报告和留存证据的核对，不是本次重新执行的通过声明。当前共享工作树包含 M0-A 并行改动，不能用它的整仓构建代替本次提交范围的验证。

建议调度将 R1–R3 回派 CodeBuddy/Pi：先修实现与测试判定依据，再由 Pi 对修复提交执行原 7 项验收及新增回归，并由 Codex 复核。S1–S4 可按后续任务依赖安排；其中 M2 写操作之前的版本和路径校验必须在对应任务卡中落实。

## 复核（整改回合）

日期：2026-11-09。复核对象为合并提交 **59824d5**，包括 `b199954`、`c4f86d9`、`41d508f`；以下行号均对应 **59824d5**。实现与测试逻辑从 Git 快照读取。Pi 正在主工作树移除预期失败标记并跑正式整改回归，本次没有覆盖其文件或证据。

**最新审查结论：暂不能转为“通过”，仍为“有条件通过”。** R1、R2、R3、S1 的整改已核实；S3 修复了原始误归属，但引入可复现的组件名退化，应修 N1 未关闭。新增问题：阻断 0，应修 1，建议 2。原 S2 的大页面性能与 S4 的 M2 后端校验仍按既定后续范围安排，不因此阻断当前整改。

### 逐项复核

| 原项 | 状态 | 证据与判断 |
| --- | --- | --- |
| **R1 · 激活行为拦截** | **已修复** | `packages/bridge/src/index.ts:43`、`:49`、`:101`：新增 pointer/mouse 按下与抬起、dblclick、contextmenu、submit 和 Enter/Space 的 capture 拦截；click/auxclick 继续单独承担选取上报。真实 Chromium、真实同源父子窗口 postMessage 探针中，物理点击得到恰好 1 条 pick:result，src 正确；子页业务 pointer/mouse/click、Enter 提交及 Space 激活计数均为 0。拦截 pointerdown 未使 click 选取失效。 |
| **R2 · 保留属性中的 JSX 错标** | **已修复** | `packages/vite-plugin-source-tag/src/index.ts:30`、`:35`、`:42`：先在原生开标签访问器中删除保留属性、记录属性节点，之后在该 JSXAttribute 自身访问器 skip 整个子树。两个原始复现分别输出外层 div/section 的 `src/Page.tsx:1:17`，只有一组标记，且可重新解析。混合 BOM、CRLF、泛型箭头函数、Fragment、条件、map、保留属性删除及非保留属性内 JSX 的 fixture 也可解析，四个保留下来的原生开标签均指向原始 `<`；未发现其他元素行列被重新计算或移动。 |
| **R3 · 测试判定依据** | **已修复（当前 M0 模板范围）** | `tests/e2e/source-model.ts` 直接解析模板源码，不调用插件；`checks.ts:37`、`:119` 以标签/自身文本的唯一锚点对应 AST 位置，并核对集合与未标记 DOM。复核直接复用 59824d5 的 checks/lib/oracle，在独立浏览器中加载合并快照插件转换的模板：6/6 锚点正确，AST/DOM 均 36 个唯一位置，missing/phantom/unmarked 均为 0。将所有 span 标成第一个 span 后，新判定报出 2 个锚点错误，旧的 data-src 相等条件仍 6/6 放行；随后移除 li 标记，又发现 li 源码位置缺失及 3 个未标记 li。覆盖了原审查指出的两个盲区。原随机抽样仍保留，其角色是补充抽样，不能替代新判定。 |
| **S1 · 覆盖层自触发重绘** | **已修复** | `packages/bridge/src/index.ts:115`：仅来自 overlay/后代的 mutation 不再 schedule，混合业务变更仍安排绘制。无 #root 的真实页面完成点选后，等待 12 个原生动画帧，bridge 调度数保持 **3 → 3**；没有持续自重绘。 |
| **S3 · 大写 JSX 值被误认组件** | **部分修复** | `const Page=()=> {const Heading=<h1/>;return Heading;}` 的 cid 已从 Heading 修正为 Page；现有函数、类、直接变量函数及 memo/forwardRef 绑定的常见写法仍可识别。但组件识别收紧丢失了另外两类原来支持的合法写法，见应修 N1，不能整体标为完成。 |

### 恢复、隔离与清理专项证据

- **Studio 输入不受预览键盘拦截影响**：bridge 安装于子 frame 的 window，没有在父 Studio 注册键盘拦截器；同源也不会让 DOM 键盘事件跨文档冒泡。实际在预览选取开启时操作父页面表单，输入结果为 `a b `（包含空格），Enter 成功触发父表单提交 **1 次**；子页面业务提交仍为 0。
- **退出后恢复**：stop 后真实 pointer/mouse/click 重新到达子页业务监听器；输入框 Enter 使子表单提交计数变为 **1**，链接 Enter 跳至 `#target`，高亮框为 **0**。移动、mousemove、wheel、scroll 在选取中也到达业务监听器；没有为防激活而吞掉移动/滚动。
- **dispose 完整**：逐项核对 `packages/bridge/src/index.ts:121` 之后的移除，匹配函数、target 与 capture；浏览器探针同时跟踪 window 和 documentElement 的注册，主动 schedule 一帧后 dispose，结果为 **剩余 bridge 监听器 0、全部 observer 已 disconnect、待执行 bridge RAF 0、覆盖层 0**。选取停止与 dispose 的生命周期仍有区别：前者保留待命监听器，后者全部清理。
- **删除后的 sourcemap**：带 CRLF 的 fixture 删除 `data-src={<i/>}` 后，原有 title 属性映回原始第 **2 行、第 24 列（0 基）**，与原文一致。MagicString 仍使用原始字符偏移，Babel loc 仍取原始源码；没有通过重新输出 AST 漂移行列。此项是插件映射探针，不是实际编辑文件触发 HMR 的整链路验收。

### 新增应修 N1 · S3 收紧组件识别导致合法组件 cid 退化

- **位置**：`packages/vite-plugin-source-tag/src/index.ts:6`、`:9`、`:19`、`:20`（59824d5）。
- **问题**：componentName 不再识别具名 FunctionExpression；componentValue 只识别直接函数/类和特定 CallExpression，不剥离 TypeScript 的类型包装节点。因而既没有可用变量绑定兜底的具名包装函数，又有类型包装的正常组件，会退化为 Anonymous。
- **复现证据**：同一内存探针分别运行原始实现 92fc0ea 与整改快照 59824d5，输入如下。三条输出都可被 Babel 解析，src 行列保持正确，但 cid 出现回归：

  | 合法 TSX 写法 | 92fc0ea 的 cid | 59824d5 的 cid |
  | --- | --- | --- |
  | `export default memo(function Card(){return <div/>});` | Card | **Anonymous** |
  | `const Page = (() => <main/>) satisfies React.FC;` | Page | **Anonymous** |
  | `const Page = (() => <main/>) as React.FC;` | Page | **Anonymous** |

- **为什么应修**：这些组件有可确定的名称，不能套用“匿名组件无法推断”的已知边界。开发文档约定 cid 为最近组件名；本轮为修局部 JSX 值误归属而丢失原已支持的名称，会使选中对象的组件信息退化。当前香薰模板没有这三种写法，故不列为阻断，但属于修复引入的新功能回归。
- **建议修法**：在判断组件值之前剥离 TSAsExpression、TSSatisfiesExpression 等不改变运行值的包装；在没有合适外部组件绑定时，保留具名函数表达式的名称作为兜底。仍需优先正确处理 `const Page = function PageView(){...}` 的公开绑定名，不能简单恢复“所有大写变量都是组件”的旧逻辑。增加上述三例及原 Heading 例的并列回归，证明兼容性恢复且 S3 不反弹。

### 新增建议

**N2 · 变异 C 的“偏一列”说明与实际偏移不一致**

- 位置：`tests/e2e/m0b-mutation-check.spec.ts:96`（59824d5）。oracle 的 column 已经是 1 基，构造 src 时又使用 `column + 2`，实际偏移两列；标题、注释及报告描述为一列。
- 该用例仍能证明读源码自检会拒绝错误位置，不使 R3 重新失效。建议改成 `+1`，或把描述改为两列，并在报告中准确区分这一自检与插件真实列号变异。

**N3 · 完整性相等检查依赖当前模板全部源码节点都会渲染**

- 位置：`tests/e2e/checks.ts:116`、`:135`；`tests/e2e/m0b-pick.spec.ts:398` 的 missing 断言（59824d5）。
- 当前静态模板成立，复核也已得到 36/36。后续加入未激活的条件分支、尚未挂载的组件，或被保留属性删除的 JSX 后，全部 AST 原生节点并不都应出现在当前 DOM；直接要求集合完全相等会产生误报。
- 建议为后续模板分别运行应覆盖的渲染状态/fixture，并明确当前状态的应渲染集合；继续保留渲染树无漏标和独立锚点断言，不要用写死数量或删除 missing 检查来掩盖问题。

### 本次执行与剩余收口

本次执行的均为秒级、无仓库文件写入的专项探针：从合并提交读取插件/bridge/shared 及 Pi checks，内存转译；独立 Chromium 中使用真实父子窗口、鼠标、Enter/Space、空闲帧与清理跟踪；用 React 服务端渲染生成快照模板供 R3 探针点击，未连接项目 dev server。R3 复用了快照的判定函数，但这是专项浏览器探针，不是 pnpm test:e2e 的完整重跑；对 li 的漏标变异是在 span 变异后叠加，报告只据此声明检测到 li 新增缺失和 3 个未标记 li，独立变异 A/B 的正式用例另由 Pi 跑。

没有安装依赖、修改模板或 tests、覆盖 Pi JSON、启动真实资产后端、调用 Lux3D，也没有执行完整 build/typecheck/test/e2e。浏览器已关闭。本次没有把 Pi 正在执行的合并后回归算作通过，也没有把合并快照中等待 Pi 移除的 test.fail/it.fails 误判为实现仍未修复。

**收口条件**：修复 N1 并通过组件名兼容性回归；Pi 完成合并后正式回归，确认 R1/R2 的预期失败标记已移除、原验收及 R3 新判定真实通过；再复核 N1。届时才可将本报告最新结论改为“通过”。

## 复核（N1）

日期：2026-11-09。复核合并快照 **9d50cc4**：组件修复 `f8e0b45`、taskId 校验 `f4d15cd`。以下新增位置均对应 9d50cc4；未读取或改动 `.worktrees/m1a`，未改 Pi 正在回归的实现、测试或证据。

**最新代码审查结论：可转为“通过”，N1 已修复。** 新增阻断 0、应修 0、建议 2。三条指定退化已消除，Heading 反例和公开绑定优先没有反弹；所测扩展写法未发现本次新引入的误归属。Pi 的合并后正式回归仍由调度核对，不能将本次专项探针等同于全量测试通过。

### N1 修复及边界证据

`packages/vite-plugin-source-tag/src/index.ts:6` 剥离不改变运行值的 TS/括号包装；`:21` 只跨越透明包装和已识别的 memo/forwardRef 第一参数去找直接变量绑定；`:40` 在找不到公开绑定时保留具名函数/类表达式名称。它没有沿任意对象属性或未知调用直接抢用上层变量名。

对 9d50cc4 和旧快照 59824d5 分别内存调用插件，执行 **16 个 fixture** 并断言 cid 及所有输出标记在原文处确实指向 `<`。主要结果：

| 写法 | 9d50cc4 结果 | 判断 |
| --- | --- | --- |
| `export default memo(function Card(){return <div/>});` | Card | **N1 已修复**，旧快照为 Anonymous |
| `const Page = (() => <main/>) as React.FC;` | Page | **N1 已修复**，旧快照为 Anonymous |
| `const Page = (() => <main/>) satisfies React.FC;` | Page | **N1 已修复**，旧快照为 Anonymous |
| `const Page=()=>{const Heading=<h1/>;return Heading;}` | Page | 未重新误归属给保存 JSX 的变量 |
| `const Page = function PageView(){return <main/>};` | Page | 公开绑定名优先 |
| `const Panel=memo(React.forwardRef(function Internal(){return <section/>}));` | Panel | 嵌套包装的公开绑定优先于内部函数名 |
| `class Panel … { render(){const Heading=<h1/>;return <main>{Heading}</main>}}` | Panel、Panel | render 内两处原生 JSX 归属类组件 |
| `const Panel=class Internal … {render(){return <div/>}};` | Panel | 类表达式也优先取公开绑定 |
| `const make=()=>function Card(){return <div/>};` | Card | 取返回的具名组件，未误取工厂名 |
| `const make=()=>()=> <div/>;`；`export default () => <div/>;` | Anonymous | 无可确定名称时保留明确兜底 |
| `export default withX(function Foo(){return <div/>});` | Foo | 未猜测自定义 HOC，具名表达式兜底有效 |
| `const Page=withX(function Foo(){return <div/>});` | Foo | 未跨未知 withX 抢用 Page；这是最近具名函数的标签，不代表已解析 withX 的运行时结果 |
| `const Page=withX(()=> <div/>);` | Anonymous | 自定义 HOC 的匿名参数未被错误当作直接公开绑定 |
| `const ui={Card:()=> <div/>};` | Anonymous | 对象属性名推断仍未支持，与旧快照一致 |
| `function Outer(){const ui={Card:()=> <div/>};return <ui.Card/>;}` | Outer | 仍回溯外层具名函数；并未识别 ui.Card，属于既有推断边界，见建议 N4 |

`packages/vite-plugin-source-tag/src/component-name.test.ts:54`、`:59`、`:64` 三条已从 it.fails 改回普通 it，预期仍为 Card/Page/Page；现有 Heading、公开绑定、嵌套与类组件的断言保留，没有通过放宽预期来关闭 N1。文件开头和分组处仍有“待修/it.fails”的旧注释，属于文案未同步，不影响测试实际执行方式。

### taskId 字段级校验复核

`apps/server/src/app.ts:63` 仅将 taskId 的属性 schema 设为空，使该字段的原始 JSON 类型留到 handler；body 仍要求对象、taskId 必填，并保留 additionalProperties 配置。`:66`–`:71` 在调用 service 前校验：字符串须为无前导零的 1–19 位正十进制文本，数字须为安全正整数；完整匹配比较还拒绝末尾换行。没有调整 Fastify 全局的 coerceTypes，也没有修改生成路由的字段 schema。

复用两个快照的实际 createApp/Fastify inject，以假 AssetService 截获调用，执行字段类型对照（没有网络或真实资产写入）：

- 新快照对字符串 `"1e5"`、`"01"`、末尾换行、20 位文本、不安全数字、null、布尔、对象及 `["123"]` 均返回 400，未进入 importTask；缺 taskId 仍为 400。
- 19 位十进制字符串 `"9999999999999999999"`、字符串 `"123"` 和数字 456 返回 202，交给 service 的值保持精确十进制文本。
- 对照创建路由输入 `{prompt:42, version:"G1", idempotencyKey:123}`，旧快照 5275f7c 和新快照均按既有 Fastify 规则转换为 prompt `"42"`、key `"123"`。这证明其他字段转换行为未被这次字段级改法改变，不是在认可所有输入都应自动转换。
- 全部 inject 探针的 fetch 调用数为 **0**。`task-id.test.ts` 中的 24 条边界测试仍有拒绝状态与上游计数/精确值断言，未发现 schema 放宽绕过 handler 的路径。

### 新增建议（均不阻断本轮）

**N4 · 对象属性和任意 HOC 的名称推断需明确范围。** 位置：`packages/vite-plugin-source-tag/src/index.ts:21`、`:36`。顶层对象的匿名 Card 为 Anonymous，嵌在 Outer 内时可能回溯为 Outer；未知 HOC 则只保留内部具名函数，匿名参数仍为 Anonymous。本次已与旧快照对照，不是 f8e0b45 新引入的回归。建议将这些边界记录在插件约定里；未来如需要精准支持 ui.Card，增加 ObjectProperty/对象方法上下文和专门 fixture，不能把当前结果宣传为所有组件表达式都能一一识别。

**N5 · taskId 前后端输入约束应同步。** 位置：`apps/studio/src/AssetPanel.tsx:95` 与 `apps/server/src/app.ts:67`。UI 仍允许 `[0-9]{1,20}`，会放过前导零和 20 位文本，再由后端拒绝；后端此次已明确采用 1–19 位、无前导零。建议同步表单 pattern/提示及接口约定。拒绝发生在调用上游之前，不涉及路径越界或多扣费，故不重新阻断已关闭的 N1。

### 验证边界与收口

本次仅从 Git 快照加载插件和 app，内存转译后执行 16 个插件 fixture、Fastify 字段级 inject 对照；后者替换 AssetService，专门核验 schema/handler 行为，没有测试实际下载处理。未重跑完整 build/typecheck/test/e2e，未覆盖 Pi 证据、未安装依赖、未读取 `.env`、未连接真实 Lux3D。

原 R1/R2/R3/S1 的实现不在本次两个修复提交中改动，上一轮复核结论继续有效；原建议 N2 的变异在 9d50cc4 已为 `column + 1`，原 N3 留 M1 的范围不变。**N1 可关闭，M0-B 代码审查可转“通过”；由调度结合 Pi 的正式回归结果最终收口。**
