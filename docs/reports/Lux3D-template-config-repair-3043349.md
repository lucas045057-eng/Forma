# 3043349 模板 TS5097 补修与 legacy runtime 配置兼容

## 事实

- 受测 `30433496e50840fce6210604d91d0e3fca9f769b`，`job_3667b695` exit 1，identityStable=true。
- 6 个 workspace 通过，唯一失败是 `templates/product-page` 消费 `packages/shared/src/scene-module.ts` 首行 `./scene-config.ts` 的 TS5097：模板独立的 `tsconfig.json` 未启用 `allowImportingTsExtensions`。
- 不是 server 旧错误；原 14 条 server 诊断已消失。

## 新作品模板

`templates/product-page/tsconfig.json` 只增加：

```json
"allowImportingTsExtensions": true
```

保留原有 `moduleResolution: Bundler`、`strict`、`noEmit`、`include` 和 `types`。这使受管生成的显式 `.tsx` 导入（renderer 与实例组件）可在模板类型检查中通过；没有删除类型检查、没有关闭 strict、没有撤销显式 renderer/受管命名空间保护。

## 旧作品兼容（server 受控迁移）

`asset-module.ts` 新增 `ensureModuleTsConfig(root)`，在模块插入候选打包时调用：

- 只处理作品根 `tsconfig.json`，不是模型可写路径。
- 若 `allowImportingTsExtensions` 已为 true，不产生差异。
- 若缺少该选项且 `noEmit:true`，保留所有现有 compilerOptions，仅增加 `allowImportingTsExtensions:true`，以 server ledger 的 `tsconfig` 角色记录 before/after 哈希、字节和路径。
- 若 `tsconfig.json` 缺失、不是可解析 JSON、没有 compilerOptions 或 `noEmit` 不为 true，返回 `MODULE_TS_CONFIG_INCOMPATIBLE`，不修改作品、不改编译语义。
- ledger `SAFE_PATH` 仅新增精确的 `tsconfig.json`；模型候选写 `tsconfig.json` 仍不在普通 `modelWritable` 范围，必须有 server ledger 证明。没有给模型任意配置权限。
- 迁移只发生在候选 worktree；采用前主作品和 39743/20884 不变，回退时由作品版本回退处理。旧作品未自动触碰，只有用户确认插入模块时才进入候选迁移。
- 旧作品如果存在自定义/非 JSON tsconfig，必须由维护者处理；服务端不覆盖。

`asset-ledger.ts` 同步增加 `tsconfig` 角色（只允许 server ledger 证明），未改变 F1–F8 的 managed/runtime 拒绝优先规则。

## 边界

本批尚未重新运行 typecheck；template build/checks 不会复制 tsconfig 的旧快照行为也未改变。补修后需要一次 `pnpm.cmd -r --no-bail typecheck` 确认全部 workspace，build/unit/safety/E2E 仍未执行。

未读 env/ASKS/秘密，未安装依赖，未启动服务/云调用，未派人，未触碰 Pi 树、主线或 live 实例。原 `job_3667b695`、`3043349`、旧报告均保留。
