# 项目状态

## 当前焦点

- 无进行中的功能开发；本轮只做本机 claude 连不上问题的排查，全程只读，未改动任何文件。
- 前端重设计处于选方向阶段：`deliverables/design-samples/` 有三套可交互 HTML 样板（A 暗房深色工具型 / B 修改单浅色纸面 / C 空间画布），入口 `index.html` 并排对比；等用户选定或混搭后再落到 `apps/studio`，业务代码尚未改动。
- 工作台本身已推进到 M4 里程碑（语音与真实模型用例已落地），服务端口为 Studio 5173、模板 5174、Server 3001。

## 本机 claude 环境

- `claude` 是官方 npm 全局安装（claude-code 2.1.318，native exe），OAuth 登录 Claude Pro，未设置 `ANTHROPIC_BASE_URL`，不经过任何 API 中转。
- claude 当前无法使用：`~/.claude/.credentials.json` 里 `accessToken` 与 `refreshToken` 均为空串，运行即报 "OAuth session expired and could not be refreshed"（1.3 秒失败）；需执行 `/login` 重新登录。
- `~/.claude/settings.json` 的 `env` 里配了带鉴权的外部 HTTP(S) 正向代理（只对 claude 进程生效），claude 的流量全部交给它，无直连回退；正常时 claude 的出口 IP 就是该代理机 207.55.155.169。
- 该专属代理当前是「端口通、转发坏」：TCP 9146 可连，HTTP 请求连续 8 秒超时返回 000，属于间歇性故障，claude 会卡在这里。
- 本机梯子：Clash Verge（verge-mihomo 核心）混合端口 7897，系统代理已开、TUN 关闭、rule 模式。
- 本机直连公网出口 IP 为 103.151.172.28；因 rule 模式下该站点走直连，经 7897 看到的也是同一个 IP。
- 网络本身正常：直连 `api.anthropic.com` / `claude.ai` / `console.anthropic.com` 均可达；只有 `statsig.anthropic.com` 域名不存在（不影响使用）。
- 11-03 的 settings 备份里曾有一套本地中转（127.0.0.1:3425 + auth token + deepseek 模型映射），已被弃用，现不存在。

## 待办

- 用户在 claude 里重新 `/login` 后确认可用。
- 专属代理间歇性故障未解决；若要绕开，可把 settings 里的 proxy `env` 改成 `http://127.0.0.1:7897` 或删除改由系统代理接管。
