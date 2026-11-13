# M2-A 后端闭环实现报告

日期：2026-11-13  
分支：`feat/m2-point-speak`  
范围：事件日志、作品版本库、任务队列、编码 Agent、候选版本与候选预览。M2-B Studio 界面不在本轮。

## 实现摘要

- 资产、场景、任务、候选和版本事件统一经过 `EventLog`：全局 `seq` 跨重启接续，追加写入 `events.jsonl`，WebSocket 连接返回当前 `seq`/`oldest`，REST 支持按序号补拉。
- 作品使用独立 git-dir；读取版本、提交任务、采用和回退前自动快照作品目录。候选是独立 git worktree，依赖按包 junction 到真实路径。
- 任务单 worker 串行执行，状态、步骤、候选和采用历史持久化到 `tasks.json`（唯一临时文件 + 原子替换）。运行中/排队任务在重启后标为 `failed / SERVICE_RESTARTED`，可重新提交。
- 编码 Agent 使用 OpenAI 兼容 chat-completions 和工具调用；最多 16 轮、默认总时限 180 秒、可取消。只有 list/read/replace/write/finish，无 shell；写操作限制在候选 `src/`，拒绝路径逃逸、符号链接和配置/依赖修改。
- 候选提交后生成 diff、记录 `outOfScope`、启动独立 Vite 预览；四项 checks 全为 `not_run`。最多 3 个待定候选，超出自动撤回最早候选。采用使用 `merge --no-ff`，冲突返回 409 并中止 merge；回退使用 `git revert -m 1`。
- 候选经后端同源代理访问，只允许 GET/HEAD；关闭服务时停止任务与全部候选预览，删除候选前停止预览并摘除 junction。
- Studio Vite 增加 `/preview/c/` → `127.0.0.1:3001` 代理。

## 配置

| 环境变量 | 用途 | 默认/约束 |
|---|---|---|
| `WORK_ROOT` | 作品目录 | `templates/product-page` |
| `WORK_DATA_DIR` | 事件、作品版本库、任务、候选目录 | `.data/work`；测试传入 `dataDirectory` 时默认为其下 `m2/` |
| `CODING_AGENT_BASE_URL` | OpenAI 兼容上游，例如 `https://opencode.ai/zen/go/v1` | 非 loopback 必须 HTTPS；URL 不得带凭据 |
| `CODING_AGENT_API_KEY` | 上游 key | 仅后端读取，不写日志、响应或事件 |
| `CODING_AGENT_MODEL` | 模型 id | 实测服务使用 `deepseek-v4.1-flash` |
| `CODING_AGENT_MOCK_PORT` | mock-cli 监听端口 | `4011` |
| `CODING_AGENT_MOCK_KEY` | mock-cli 期望的假 key | `mock-only` |
| `CODING_AGENT_MOCK_SCENARIO` | mock 初始场景 | `success` |

每个上游请求带 `x-opencode-session: <taskId>`，同一任务的所有轮次保持不变。未配置真实上游时不要启动真实任务；所有测试均使用 mock。

## REST 与事件

| 方法 | 路径 | 结果 |
|---|---|---|
| GET | `/version` | 自动快照后返回 `{version}` |
| POST | `/version/revert` | 回退最近一次采用；无记录 409 `NO_ADOPTION` |
| POST | `/tasks` | `{instruction, selection?}` → 202；单任务串行 |
| GET | `/tasks`、`/tasks/:id` | 任务状态与逐步事件 |
| POST | `/tasks/:id/cancel` | 取消排队或运行中任务 |
| GET | `/candidates`、`/candidates/:id` | diff、outOfScope、checks、decision |
| POST | `/candidates/:id/adopt` | 合并候选；冲突 409 `MERGE_CONFLICT` |
| POST | `/candidates/:id/discard` | 停预览、摘 junction、删 worktree/分支 |
| GET/HEAD | `/preview/c/:id/*` | 同源转发到该候选的 loopback Vite |
| GET | `/events/history?since=<seq>` | `{events,current,oldest,truncated}` |
| WS | `/events` | 首发 `{type:"ready",seq,oldest}`，随后推送统一事件 |

新增全局事件：`task.updated`、`candidate.ready`、`candidate.closed`、`version.changed`。原有 `asset.progress`、`asset.ready`、`scene.changed` 保留原负载和各自 `sequence`，同时增加全局 `seq`。

选中对象校验：`src` 必须是 `src/…:行:列`；文件可读、行号在范围内；`baseVersion` 必须存在于作品版本库；选中文件自该提交起发生变化则 409 `STALE_SELECTION`。候选改动文件不在选中文件及祖先文件内时写入 `candidate.outOfScope`，M2 只记录，不拦截。

## mock 上游

启动：

```sh
pnpm --filter @spatial/server mock:agent
```

后端 mock 配置：

```text
CODING_AGENT_BASE_URL=http://127.0.0.1:4011
CODING_AGENT_API_KEY=mock-only
CODING_AGENT_MODEL=mock-coder
```

`success` 场景按每个 taskId 独立执行三轮：读取 `src/App.tsx` → 把“立即购买”替换为“马上购买” → finish。其他场景：

- `timeout`：延迟响应，验证总时限/取消。
- `error`：HTTP 500。
- `escape`：尝试写 `../outside.ts`，沙箱拒绝。
- `no-tools`：返回普通文本，协议校验失败。

运行中可 `POST /__scenario {"scenario":"error"}` 切换并重置轮次；`GET /__stats` 查看调用次数、场景和 session 记录。mock 会校验假 Authorization 与 `x-opencode-session`。

## 验证

### 自动化

- `pnpm typecheck`：通过。
- `pnpm build`：通过；保留既有 Three 分包 >500 kB 警告。
- `pnpm test`：通过，共 **202 项**（shared 68、源码标记插件 20、scene-renderer 5、server 108、bridge 1）。
- 新增覆盖：事件 seq 重启接续/补拉/截断、版本快照/采用/回退/冲突、选中对象与 STALE_SELECTION、沙箱逃逸/junction/配置校验、Agent 成功/超时/取消/上游错误/无工具、任务取消与重启恢复、候选上限与清理、outOfScope、代理 GET/HEAD 限制、完整 REST 流程与 key 不外泄。

### 真实本地预览闭环（mock 模型，无真实额度）

使用实际作品模板、独立作品版本库、真实候选 git worktree、逐包 junction 和真实 Vite 子进程跑通：

1. `GET /version` 得到初始提交。
2. `POST /tasks` → Agent 三轮工具调用 → 任务 `done`。
3. `GET /preview/c/<id>/` 与 `/src/App.tsx` 均为 200；候选源码含“马上购买”和 `data-src`。
4. `POST /candidates/<id>/adopt` → 版本号变化，主作品源码变为“马上购买”。
5. `POST /version/revert` → 新版本提交，主作品源码恢复“立即购买”。
6. `/events/history?since=0` 返回连续全局 seq 1–16，含 candidate/version 事件。
7. 闭环后 monorepo 工作树没有模板源码改动；验证服务和 mock 已停止。

未编写或运行 Playwright；浏览器验收由 Pi 负责。

## 已知限制

- 单后端进程；JSON 状态与 git 操作不是多进程协调方案。
- 任务失败/重启后的“重试”是重新 `POST /tasks`，本轮没有单独 retry 接口。
- 后端重启保留任务/候选/采用记录，但不会自动重启待定候选的 Vite 进程；其预览代理会返回 404，可重新生成候选，旧候选仍可采用或撤回。
- 事件补拉内存窗口保留最近 2000 条，JSONL 文件持续追加；`truncated=true` 时 Studio 应重拉完整状态。
- 任务和候选记录暂未设置总条数上限；git 命令本身不可中途取消，取消在命令/模型请求/预览启动边界生效。
- 空闲端口分配与 Vite 绑定之间存在很小的端口竞争窗口；启动失败会让任务失败并清理候选。
- M2 不运行构建、冒烟、遮挡或 Schema 检查，四项始终 `not_run`；越界只记录，M3 才接入请示与检查。
- 本轮未调用真实编码模型，未验证真实模型修改质量或“10 次至少 8 次改对”；该实测需按任务卡另行确认模型额度。
- M2-B Studio 指令输入、候选对比和断线补拉 UI 尚未实现。
