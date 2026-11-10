# M1 整改实现说明（Claude Code，2026-11-10）

依据：`docs/reports/M1-A-review.md`（Codex，R1–R3、S1–S4）与 `docs/reports/M1-B-review.md`（B1、B2）。
验证：`pnpm typecheck`、`pnpm build`、`pnpm test` 全过（shared 68、插件 20、scene-renderer 5、后端 89，共 182）；已有 e2e 重跑无回归（M0-B 24、M0-A 27、M1-A 7）。**以下各项的浏览器端到端验收未做，由 Pi 负责。**

| 项 | 处理 | 改动 |
|---|---|---|
| M1-A R1 Studio 未读作品配置 | 已由 M1-B 解决，未再改 | 场景编辑器用 `GET /scene`；对照模式用已保存配置 + 同一模型 + iframe 滚动位置。资产面板保持默认配置（仅看模型）。 |
| M1-A R2 未识别部件时同名 `lid` 仍被移动 | **已修** | 资产管线识别成功时给 `lid`/`body`/`cap`/`reed_n` 节点写 glTF `extras.spatialPart`；识别失败时清除源模型自带的同名标记。渲染器 `applyPartOffsets` 只移动带该标记的节点，不再按名字查找。作品自带的 `diffuser-4969889.glb` 已用同一管线重新生成（987,884 → 988,116 字节，顶点数 86,529 不变，`parts.json` 内容不变）。 |
| M1-A R3 启动清理无所有权检查 | **已修** | 新增 `apps/server/src/assets/instance-lock.ts`：`AssetService.init()` 在清理、读索引、恢复任务之前先拿资产目录的排他锁（`.instance.lock`，含 pid 与随机 token）。锁的主人还活着 → 启动失败 `INSTANCE_LOCKED`，什么都不碰；主人已死或锁文件不可读 → 接管。离线 CLI 走同一个 `init()`，同样受约束。`close()` 释放锁；端口被占导致 `listen` 失败时也会释放。 |
| M1-A S1 Euler 插值跨 ±π 绕远 | **已处理（写入侧）** | 渲染器保持逐轴数值插值（配置文件里仍可写多圈旋转）。编辑器写关键帧时把角度相对前一个带旋转的关键帧（没有则相对首屏角度）展开到最近的等价角，于是 +179° → −179° 存成 181°，走 2° 短弧。at=0 的帧不展开。 |
| M1-A S2 GLTFLoader 改了全局 LoadingManager | **已修** | 每次加载新建私有 `LoadingManager`。 |
| M1-A S3 Schema 不含帧序 | 已满足，未改 | `PUT /scene` 统一走 `validateScene`（Ajv + `isSceneConfig`）。 |
| M1-A S4 Three 分包体积警告 | 未处理 | 不影响正确性；留到 M4 打磨时按实测加载时间决定是否拆包。 |
| M1-B B1 DNS 重绑定 | **已修** | 后端增加 Host 白名单（loopback + `ALLOWED_HOSTS`），否则 403 `HOST_DENIED`。 |
| M1-B B2 历史无上限 | **已修** | 历史记录与撤回栈各保留最近 50 条。 |
| N5 任务号输入框规则 | 已一致，未改 | `AssetPanel` pattern 已是 `[1-9][0-9]{0,18}`。 |

## 行为变化（测试需要知道）

- **同一资产目录只能有一个后端实例**。测试里“重启”必须先关掉前一个实例；进程被强杀后留下的锁会在下次启动时自动接管。原单测 `service.test.ts` 的重启用例已按此调整（先 `close()` 再重启）。
- **开盖只对带标记的模型生效**。老的、没有 `extras.spatialPart` 的已处理模型（例如 `.data/assets/` 里 M1 之前处理的）需要重新处理/导入后才会开盖。
- **非本机主机名访问后端会被拒**（403 `HOST_DENIED`）。
- 撤回最多回退 50 步。

## 新增/修改的单测

- `instance-lock.test.ts`：第二实例被拒且第一实例的临时文件未被碰；死进程/损坏/本进程残留锁被接管。
- `parts.test.ts`：只有识别成功的部件带标记；识别失败时伪造标记被清除、其余 extras 保留。
- `pose.test.ts`：只同名、无标记的 `lid` 不被移动。
- `scene-edit.test.ts`：跨 ±π 展开、以最近的前一旋转帧为参照、at=0 不展开。
- `scene/service.test.ts`：历史上限；非 loopback Host 被拒、`allowedHosts` 放行。
