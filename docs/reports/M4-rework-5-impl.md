# M4 统一返工五：Windows 预加载模块 URL（未运行验证）

日期：2026-11-15。仅在 `.worktrees/m4` / `feat/m4-demo`，基 `c79fbfca89e8a04161be42b4b0f9ee4943ab2da5`；起点tracked干净，只有fallback未跟踪。全文读取根a4b545a的 `orbital/coordination/m4/unified-rework-5.md`。没有为读文档合并主线。

## 本轮已知证据与原因

按固定交接卡记录，`job_2d4484eb` 已结束，受测d6d46e6、产品c79，run `2026-11-15T13-51-08-829Z-full`。typecheck/build通过，server376通过/2失败（378）；Studio单测、demo脚本和全部193 E2E未执行。preparedDirs的D2_RUN_DIR准备成功，两个asset诊断文件已落盘。

这轮两例stderr均明确为 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，收到协议 `e:`：Node的ESM预加载器把Windows盘符路径当成模块URL协议。源码对应的两处`--import`参数确实把已构造的模块URL经`fileURLToPath`转换成了Windows磁盘路径。生命周期worker在屏障求值前exit1；持久化夹具在preload/entry前exit1。此处为测试启动接线错误，不是运行证伪worker自主断开或生产持久化合同。

这是**这轮新保存stderr所支持的原因**，不倒写旧轮也已掌握相同信息。旧失败/诊断原件由Pi在验收树归档，历史报告保持原样。审批恢复5秒超时这轮未复现，不据此宣称上一批性能归因已经证明。

## 仅两处代码修正

| 文件/参数 | 修改 | 保留 |
| --- | --- | --- |
| `apps/server/src/test-support/asset-parent.ts`：fork的execArgv | `--import`值改为`new URL('./asset-loader-register.mjs',import.meta.url).href` | fork入口仍是process-worker的本地路径；GLB输入、staging输出仍为文件系统路径 |
| `apps/server/src/assets/recovery.test.ts`：spawn的Node参数 | `--import`值改为`new URL('../test-support/asset-persistence-register.mjs',import.meta.url).href` | 后续asset-persistence-parent入口仍用本地路径；directory/base参数、IPC与环境白名单不变 |

没有全局替换fileURLToPath，也没有改加载器或生产逻辑。

## 相关调用点的静态核对

- `asset-loader-register.mjs`用静态相对ESM import加载resolve钩子，`registerHooks`接函数，不需要磁盘路径转URL。
- `asset-model-loader.mjs`的精确target本来就是`new URL(...).href`；先nextResolve后比较完整URL，返回普通data模块。IPC屏障仍由模块实际求值后发送，不以resolver命中代替ready。
- `asset-persistence-register.mjs`的精确target、带查询的原始模块import均已使用href，保持原值；其他specifier仍交Node处理。
- `process-worker.ts`仍有静态模块声明，先注册disconnect及检查失联，再相对动态import模型模块；未改执行顺序。
- 相关server模块中其它动态导入为相对ESM specifier，预览worker/检查worker从磁盘定位模块时已使用`pathToFileURL(...).href`；没有把这些正确调用或进程入口、文件IO路径混为一类替换。

上述仅源码阅读，未原生导入/解析或执行任何模块。新参数是否实际消除错误仍须集中运行确认。

## 不变的合同与交付边界

保留实际求值IPC屏障、早退stderr/阶段证据、屏障前worker归属与清理、主失败/清理/写证据失败聚合、真实死亡后的锁接管、活锁拒绝、creates恰好1与显式导入恢复、ready来源真实hash核验。没有改断言、时间预算、skip或retry。

本批改动仅两行测试接线及本报告；生产实现、注册器/加载器、依赖锁、模板GLB/默认来源、demo脚本、Pi独立套件/runner、旧像素阈值和历史证据均未修改。fallback未跟踪、不入库；验收树与主线未触碰，未merge/push。

**本批没有运行typecheck、build、测试、collect、浏览器、服务、探针或审查，没有创建job。** 只做静态源码/Git diff核对；没有读取真实.env/ASKS/代理配置或凭据，没有真实阿里/厂商识别/编码/Lux3D调用。真实语音主链仍阿里云百炼。

固定HEAD见交付消息。双方交回后由Codex统一冻结集中阶段；不预填新通过计数，不把193收集数当执行结果。Claude独立审查仍欠报告，不能拿未来运行全绿替代独立审查，M4及项目未验收。
