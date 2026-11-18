# 经验

## 本机代理与网络排查

- 判断 claude 是否走代理，先看 `~/.claude/settings.json` 的 `env`：它只对该 claude 进程生效，不出现在系统环境变量里；配置存在不等于生效，必须实测。
- 代理地址不可达时 claude 会走直连；直连 `api.anthropic.com` 返回 403 是「可达但未鉴权」的正常信号，可用来区分「网络不通」和「代理挂了」。
- 排查先用 TCP 探端口（`/dev/tcp/<host>/<port>`），比 curl 超时更快定位是端口不通还是 CONNECT 被拒。
- claude 用不了先跑一次 `claude -p "ok"` 读报错：「1 秒内报 OAuth session expired / could not be refreshed」是凭据问题（`.credentials.json` 的 accessToken/refreshToken 被清空），不是网络问题，重新 `/login` 即可；只有超时才继续查网络。
- `api.anthropic.com` 未带鉴权返回 403 是「网络可达」的正常信号，可用来快速区分链路通不通。
- 单次 curl 超时或一次 `/dev/tcp` 失败不能判定代理已死，重复测 2–3 次再下结论（曾据此误判一个可用代理为不可达）。
- 代理「TCP 端口能连」不等于可用：端口开但 HTTP CONNECT 全程超时，说明代理服务端或上游出口坏了，判据要用 `curl -x` 拿实际状态码，而不是 `/dev/tcp`。
- Clash 处于 rule 模式时，未命中规则的站点走直连，所以 `curl -x 127.0.0.1:7897` 和直连得到的出口 IP 相同是正常现象，不能据此判断梯子没生效；要验证梯子得选一个会命中代理规则的域名。
- Node 系 CLI（claude 等）一旦在 settings 里配了 `HTTPS_PROXY` 就只会用它，代理挂了不会回退直连，表现是长时间卡住而非报错。
  supersedes: - 代理地址不可达时 claude 会走直连；直连 `api.anthropic.com` 返回 403 是「可达但未鉴权」的正常信号，可用来区分「网络不通」和「代理挂了」。

## 浏览器截图与验收脚本

- 在仓库内用临时 node 脚本直接 `import 'playwright'` 或 `@playwright/test` 会报 ERR_MODULE_NOT_FOUND（pnpm 链接解析失败）；改用绝对 file URL 导入 `node_modules/.pnpm/playwright-core@1.65.0/node_modules/playwright-core/index.mjs`，并以 `{channel:'chrome'}` 启动即可。
