# M4 前端 watcher 关闭门禁 · 有限差异只读复审

- 审查者：Claude Code
- 日期：2026-11-16
- 审查对象（以固定 Git 对象为准，用 `git show` / `git diff` 读取，`core.longpaths=true`）：
  - 实现树 `.worktrees/m4`：`70e82ca → ea32d48a6f3827b6dac853f53288647db07784cf`
    - `c8f35b0`：唯一的生产改动，即自有 Vite `watcher.add` 的关闭门禁；
    - `ea32d48`：只改测试，处理保留响应流的终态分类。
  - Pi 验收树：`e375b73` 中 `tests/e2e/m4/helpers.ts` 的新点选屏障（`pickElement`）。
- 范围：只看上面两段差异，不重审全仓。
- 方式：纯只读。**没有运行** types、build、test、浏览器、服务或探针；两棵树的源码、HEAD 和文件都没动；没读 `.env`、ASKS、代理或提供商凭据；没有提交。
- 本报告写在主工作树，**未提交**。

## 0. 结论

| 级别 | 数量 |
|---|---|
| Blocker | **0** |
| Should-fix | **0** |
| Suggestion | **4**（都不阻断 Pi 的新一轮 M4 19 例） |

- `c8f35b0` 的门禁与根因证据一致，是最小改动：
  - 不改关闭顺序，也不改 45 秒预算；
  - 不碰私有字段，不用 `unref`，不用 `process.exit`，不全局 patch fs。
- `ea32d48` 的响应分类没有按 `terminated` 文本笼统放过：要求关联到本次响应、关闭时的时序、原始 socket cause，以及生产自然退出的证明，缺一项就失败。
- `e375b73` 的点选屏障只接收真实 iframe（source 加 origin 双重核对）发来的消息，不伪造消息，并要求命中元素、消息和面板三者一致。
- **补充运行事实（写报告后收到，见 §4.1）：** Pi 的 `job_f17f54bb` 在受测合并提交 `6161e86` 上跑完 M4 独立 19 例，**19/19 通过**。这次合并的产品和脚本与 `ea32d48` 完全一致，独立 helper 即 `e375b73`。所以 `e375b73` 的 helper 和门禁后的生产关闭链现在都有了一次实测证据。
- **这不是 M4 收口：** 完整的类型检查、构建、单测、脚本测试和旧 174 例，都还没在新的生产代码上重跑。

**审查时两棵树的 HEAD 已经前移，审查身份不变：**
- 实现树到了 `e802a8b`（docs-only 归档）。相对 `ea32d48`，`apps packages templates scripts package.json pnpm-lock.yaml` 均无变化。
- 验收树到了 `6161e86`（合入 `ea32d48`）。相对 `e375b73`，`helpers.ts` 无变化。

## 1. 生产改动：`c8f35b0`

改动文件：`scripts/demo/frontend-watch-gate.mjs`（新增）和 `scripts/demo/frontends.mjs`（改 2 行）。

### 1.1 门禁语义

**运行期调用不变**
- `attach` 先保存原来的 `watcher.add`，再在实例上放一个同名的自有属性覆盖它。
- 没有封口时，用 `Reflect.apply(add, this, paths)` 调用原方法，所以 `this`、全部参数、返回值和抛出的异常都原样保留。

**封口后的行为**
- 封口后调用 `add` 不再委托原方法，直接返回 `this`，链式调用照常可用。
- 这里只是不再登记新路径，不关闭也不改动任何已有的 watcher。

**封口时机是同步的**
- 门禁在 `ownedLifetime` 的 close 回调第一行调用 `watchGate.seal()`，后面才是 `await server.close()`。
- 在调用 `server.close()` 之前，两个自有 watcher 都已经封口。

**为什么能拦住根因**
- 来源追踪显示：关闭完成后，Vite 7.3.7 自带的 chokidar 又通过 `add → _addToNodeFs → … → createFsWatchInstance` 新建了一个持久的 `fs.watch`。报告引用的静态源码说明，`add` 会把 chokidar 的 closed 状态重新置回 false。
- 门禁拦的就是"关闭开始后又有人调用 `add`"这一入口。
- 关闭前就已发起的 add，其异步后续仍由 chokidar 自己在 stat 之后检查 closed 状态。

**为什么覆盖 Vite 的内部调用**
- Vite 内部通过同一个 `server.watcher` 对象调用 `add`（例如 `ensureWatchedFile`），调用时按属性查找，会命中实例上的覆盖。

**没有用到的手段**
- 门禁和 `frontends.mjs` 的改动里没有 `unref`，没有 `process.exit`，也没有访问 `closed`、`_fsWatchers` 之类的私有字段。
- `process.exitCode` 只出现在原有的启动失败分支里，不是这次新增的。

### 1.2 关闭流程与迟到实例的归属

- `stop` 回调里仍然是先 `seal()`，再按 `servers.reverse()` 依次 `await server.close()`，顺序还是原来的 Studio → main。异常仍汇总成 `AggregateError`。
- `launch.mjs` 和 `runtime.mjs` 都没改，45 秒预算不变。
- `ownServer` 新顺序：先 `attach` 并登记到 `servers`，再检查是否已开始关闭。
  - 如果已开始关闭，就关掉这个实例、不再 `listen`，并抛出原来的"已开始关闭"错误；
  - `listen` 期间如果开始关闭，原来的那次检查也保留。
  - 关闭开始之后才由 `createServer` 返回的实例，同样在调用 `add` 之前就被封口（门禁回归第 3 项覆盖了这一点）。

### 1.3 门禁回归（`frontend-watch-gate.test.mjs`）

覆盖五个方面：
- 运行期 `add` 的 `this`、参数和链式返回；
- 封口是同步的，`await` 之后两个 watcher 的迟到 add 都不再委托；
- 封口之后才 attach 的 watcher 也被拦住；
- 原有异常原样透传；
- 不同的门禁实例互不影响。

这些回归同时由 `safety.test.mjs` 导入，原有脚本断言一条没删。

## 2. 测试改动：`ea32d48`（响应流分类）

改动在 `test-support/retained-response.mjs`、`retained-response.test.mjs` 和 `frontend-close-confirm.mjs`，生产文件零差异。

**保留流的处理方式**
- 只拿 reader、从不读取数据（`readCalls=0`），提前挂上 `reader.closed` 观察终态。
- 记录的内容：请求 URL、响应 URL、状态码、拿到响应头时和关闭时 `bodyUsed` 的值、是否上锁、关闭标记的时间（单调时钟）、终态，以及完整的 cause/socket 链。

**分类规则：只有满足全部条件才算预期**
- 必须是 status-only 场景下的保留流；
- 响应 URL 等于请求 URL，状态码为 200，目标是 `127.0.0.1` 上本轮自有的端口；
- 关闭时这个流还没被消费，也没有读过；
- 出错时间不早于关闭请求的时间；
- 没有提前取消；
- 原始 cause 是 `UND_ERR_SOCKET`，且 socket 两端与请求一致；
- 生产已经自然关闭，具体是：
  - 退出码 0、无信号，manifest 为 `stopped`，`problems` 为空，两个角色都没有被强制结束；
  - backend 和 frontends 各有一条原生 exit 和一条原生 close；
  - 按 PID＋创建时间核对，全部进程为 gone 或 reused，自有端口全部释放。

**逐项负例都会失败**
- 回归第 4 项覆盖：只有 `terminated` 文本、cause 是其他 I/O 错误、远端端口不同、URL 对不上、有角色被强制结束、缺少原生 close、身份查询结果为 unknown、存在主错误、缺少关闭标记。
- 关闭前就出现的 socket 错误仍判失败。
- 取消时出现新的 I/O 错误，即使消息里写着 terminated，也判失败。

**资源归属与收尾**
- 不论分类结果如何，都会释放 reader 锁；释放失败会进入错误汇总。
- 仍可读的流，只有在确认生产已自然关闭之后才 `cancel`；已经结束的流不再重复取消。

**一处看似放宽、实际不需要证明的地方**
- 终态为 closed（正常结束，或在确认自然关闭之后被取消）时，不再要求生产证明。
- 这是合理的：closed 不是错误，没有东西需要豁免；仍可读的流在取消前已经单独校验过生产自然关闭。

## 3. Pi 点选屏障：`e375b73` 的 `tests/e2e/m4/helpers.ts`

**消息来源可信**
- 监听器只接收 `event.source === preview.contentWindow`，且 `event.origin` 等于 iframe 的 origin 的消息；
- 消息必须是 `pick:result`，且 `src` 和 `cid` 都是字符串。
- 只记录，不 `postMessage`，不伪造消息。

**命中检查**
- 在 iframe 文档里对目标元素中心做 `elementFromPoint`，取 `closest('[data-src]')`。
- 没命中就直接报错。旧版的 `.catch` 会把错误吞成 null，这次已经去掉。

**完成屏障**
- 新消息的序号必须增加；
- 最新消息的 `src` 必须等于命中元素的 `src`，不一致就立即报错，不会空等；
- 面板 JSON 的 `src`、`cid` 与最新消息一致，且 `baseVersion` 等于点选期间拿到的 `GET /version` 返回的 200 结果。
- 读取面板后还会再核对一次消息与面板一致。

**结论**
- 修掉了"面板早已可见、读到上一次结果"的竞态。
- 也允许重复点选同一个对象。
- 没有删除 notEqual 或冲突断言，也没有改点选目标。

## 4. 运行证据与边界（两轮各自计数，不合并）

**`c8f35b0` 那一轮（`.data/frontend-close-focused-2026-11-15T18-35-43.132Z`）：8 项，7 过、1 败**
- 三个真实生产场景（no-request、consumed、status-only）都是 `closed {code:0, signal:null}`、manifest `stopped`、两个角色都没被强制结束（`forced=false`）、`fallbackKills=0`、`remaining=0`。
- consumed 场景收到了 1 个真实 HMR update 帧，没有触发文档导航（navigations 1→1）。
- 唯一失败：status-only 的测试夹具在清理时收到 `terminated`（`cleanupErrors=1`），属于测试夹具问题。

**`ea32d48` 那一轮（`.data/frontend-status-only-focused-2026-11-15T18-53-30.008Z`）：7/7**
- 6 项是分类回归，1 项是真实 status-only 场景。生产同样自然关闭，没有强制结束，也没有残留。
- 4 个保留流里：
  - 3 个在关闭后约 2.37 秒仍可读，确认自然关闭后被取消，归类为 `closed-by-post-shutdown-release`；
  - 1 个（main Vite 的 `/@fs/…/scene-renderer/src/index.tsx`）在关闭请求后约 685 毫秒出错，cause 为 `UND_ERR_SOCKET`，归类为 `server-shutdown-socket-terminal`。
- 4 个流的锁都已释放。

### 4.1 补充：M4 独立 19 例（`job_f17f54bb`）

**受测身份**
- 合并提交 `6161e86f79bbf82ca887d3fffefaef1492495bfe`，产品和脚本与 `ea32d48` 完全一致，helper 为 `e375b73`。
- 原件：`.worktrees/m4-acceptance/docs/reports/artifacts/M4/regression/2026-11-15T18-57-35-050Z-m4-special/`，我只读了原件，没有改动。

**计数与身份**
- `counts.json`：expected 19、unexpected 0、skipped 0、flaky 0，每条用例只有一次结果且 retry=0。
- `manifest` 和 `cleanup`：前后都是 HEAD `6161e86`，身份稳定（identityStable 为 true）。运行结束时没有监听中的端口，也没有自有的 node 或 chrome 进程残留。
- Codex 已复核 30 个载荷的 SHA，0 mismatch，清单不包含自身。

**和门禁直接相关的证据**
- 三个正常关闭的真实 demo run，manifest 都是 `stopped`，backend 和 frontends 都是 exit 0、无信号、forced=false，没有 problems。修复前，frontends 关闭超过 45 秒被强制结束；这次没有再出现。
- 第四个 demo run 是硬杀用例，manifest 停在 `running`，这符合预期，因为启动器被直接杀掉了。按 Pi 和 Codex 的口径，它只证明原有进程身份已经消失，并且 remaining、reused、unknown 和端口都为空，**不证明 watchdog 执行过**。

**和点选屏障直接相关的证据**
- `speech-iframe-repick.json` 和 `speech-selection-conflict.json` 中：
  - 命中元素的 `src`（`src/App.tsx:41:15`，h3）等于消息的 `src`；
  - 消息的 origin 是预览源 `http://127.0.0.1:5175`；
  - 点选前面板是上一次的选择（`Button.tsx:5:5`），点选后换成了新对象。
- 这说明上一轮"读到上一次结果"的竞态已经修复。
- W3 提到的"同一对象重复点选、可能早一步通过"这个窗口，本轮的用例没有走到。

**范围限制**
- 这次只跑了 19 例，关闭仍然是进程内的 SIGINT 模拟。
- 不能用它代替 614 单测、全部脚本测试、旧 174 例和类型检查/构建，也不能代替真实的 Windows 控制台 Ctrl+C。

**这两轮不能合成"同一轮 8/8"**
- `ea32d48` 那一轮没有重跑门禁回归、no-request、consumed 和 HMR。
- 两轮之间生产代码没有差异，但这只说明两轮分别得到的结论都适用于同一份生产代码，不构成同轮通过。

**证据的局限**
- 门禁修复后，focused 确认里每个真实场景只跑过 1 次。M4 19 例又补充了 3 个正常关闭的真实 demo run，全部自然退出（§4.1）。修复前，consumed 场景两次都被强制结束（三场景诊断和来源追踪各一次）。迟到 add 的发生依赖时序，样本有所增加，但仍然有限。
- 门禁封口后丢掉的 add 调用没有计数，无法从证据里直接看到"真的拦下过迟到注册"（见 W1）。
- 关闭只在 IPC 里用 `process.emit('SIGINT')` 模拟。真实的 Windows 控制台 Ctrl+C、真实提供商调用、真人 A/B 和彩排都不在本次范围内。

## 5. 建议（都不阻断）

- **W1（门禁可观测性）**：封口后被丢掉的 `add` 调用，建议计数，或至少把第一次的路径和栈写进 stderr 或诊断记录。现在无论有没有拦下迟到注册，证据看起来都一样，只能靠"进程自然退出"间接推断。
- **W2（`ownServer` 的重复关闭窗口）**：现在实例在"已开始关闭"检查之前就加进了 `servers`，而 `stop` 的 `for…of servers.reverse()` 遍历的是会变化的数组。如果 `createServer` 在关闭开始后才返回，而 stop 循环还在等待别的实例关闭，这个新实例可能被 `ownServer` 和循环各关一次。
  - 原来的代码在 `listen` 期间也有同类窗口，这次只是把窗口扩大到了 listen 之前。
  - 这个实例没 listen 过，Vite 对它重复调用 close 大概率没有影响，但没有被证明过。
  - 修法：只在启动中断的分支里不登记，或者给 close 加一层只执行一次的保护。
- **W3（点选里的 version 绑定）**：`waitForResponse` 只能证明点击前后出现过一次 `GET /version` 200，证明不了这次响应就是这次点选触发的。版本在点选期间不变，所以不影响判断不同对象。但同一对象重复点选时，如果旧面板已经和新消息一致，屏障可能在 App 处理完新消息之前就通过了。
  - 建议在新消息到达之后再匹配那次 `/version` 请求，或者在面板上加一个点选序号。
  - 另外，注释里写的"实际点击坐标"其实是 iframe 内元素中心的坐标，建议改成准确说法。真正的因果是靠"消息 `src` 等于命中元素 `src`"保证的，这条结论不受影响。
- **W4（分类器对 socket 字段较宽松）**：cause 上没有 `socket` 对象或端点字段时，`socketEndpointConsistent` 直接视为一致。实际运行里有 `cause.code=UND_ERR_SOCKET`，并且与 URL 关联，足够判断。如果以后 undici 改了 cause 的结构，这一项就起不到约束作用。可以考虑要求 socket 字段必须存在，或者把缺失单独记录下来。

## 6. 身份与只读声明

- 审查用的固定对象：`70e82ca`、`c8f35b0`、`ea32d48`（实现树），`e375b73`（验收树）。
- 两棵树的当前 HEAD 都已前移（`e802a8b`、`6161e86`），差异已核对：相关源码和 helper 都没变。
- §4.1 的运行事实来自 Pi 和 Codex 已完成的 `job_f17f54bb`。我只读了它的原件（`counts`、`manifest`、`cleanup`、demo-run 的 manifest、两份点选审计 JSON），自己没有运行任何东西。
- 补充这些事实后，结论不变：0 个 blocker、0 个 should-fix、4 条建议。
- M4 仍未收口：类型检查、构建、全量单测、全部脚本测试和旧 174 例，都需要在新的生产代码上重跑。
- 我没有在两棵树里写入任何文件，没有提交、合并或派实现者。
