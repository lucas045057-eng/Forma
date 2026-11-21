# Forma Windows 桌面客户端

Forma Windows 桌面客户端采用 **原生 Win32/WinForms 进程托管器 (`Forma.exe`) + Chromium 独立应用窗口 (`--app`)** 架构：
- **零外部重依赖 & 锁文件不动**：直接调用 Windows 10/11 内置的 `.NET Framework 4.x` 编译器 (`csc.exe`) 编译出 ~62 KB 的原生 GUI 可执行程序 `desktop/bin/Forma.exe`，不修改 `pnpm-lock.yaml`，不引入 200 MB+ 的 Electron 运行时。
- **Win32 Job Object 零孤儿进程托管**：后台启动 `scripts/forma/start.mjs`（Fastify Server + Preview Origin + Main Vite + Studio Vite），通过 `stdin` `shutdown` 协议优雅停机，并绑定 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 内核作业对象，即使客户端被强制结束也不会遗留任何占用 `5173`/`5174`/`3001` 端口的 Node/Vite 孤儿进程。
- **独立无边框应用窗口 (`--app`)**：服务就绪后自动调用本机 Microsoft Edge / Google Chrome 以独立无地址栏应用窗口 (`--app=http://127.0.0.1:<port>`) 打开 Studio 空间画布，完整支持同源 iframe 1:1 坐标点选、Three.js WebGL2、拖拽放置与语音录制。
- **图形化模型与密钥配置**：内置深色主题配置弹窗，支持可视化编辑 `apps/server/.env`（强制 UTF-8 无 BOM 写入，保留原有注释与自定义项，掩码保护 API Key），无需手工改配置文件。
- **工作区一键切换与系统托盘**：支持在「日常创作工作区 (`.data/forma`)」、「空间画布试用工作区 (`.data/studio-pilot`)」、「临时隔离沙箱 (`--ephemeral`)」及自定义目录间一键切换，支持系统托盘常驻与一键生成桌面快捷方式。

## 快速使用

### 1. 直接双击启动
- 双击仓库根目录的 [`Forma.cmd`](../Forma.cmd) 或 [`desktop/bin/Forma.exe`](./bin/Forma.exe) 即可启动。
- 或在终端运行：
  ```powershell
  pnpm desktop
  ```

### 2. 编译与自检命令
```powershell
# 重新生成多分辨率图标并编译 desktop/bin/Forma.exe
pnpm desktop:build

# 运行端到端自检（启动临时工作区 -> 探测 /health, /works, /favicon.ico -> 验证优雅停机零孤儿进程）
pnpm desktop:verify

# 运行桌面客户端单元与集成测试套件
pnpm desktop:test

# 在 Windows 桌面创建「Forma 空间化AI工作台.lnk」快捷方式
pnpm desktop:shortcut
```

### 3. 命令行参数 (`Forma.exe`)
- `--port <port>`：指定首选 Studio 端口（默认 `5173`，试用工作区默认 `5183`）
- `--data-dir <path>`：指定持久化作品目录（`FORMA_DATA_DIR`）
- `--ephemeral`：使用临时沙箱目录启动
- `--no-open`：服务就绪后不自动弹出独立工作台窗口
- `--self-test`：运行自动化无头端到端自检并退出
