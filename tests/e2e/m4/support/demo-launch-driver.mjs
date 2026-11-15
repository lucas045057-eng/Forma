/**
 * 测试专用 demo 启动 driver —— **只用于在进程内模拟 SIGINT 处理**，不是产品入口、也不是产品后门。
 *
 * 为什么需要它：产品 `scripts/demo/launch.mjs` 只在"自己的进程收到 SIGINT/SIGTERM"时走 graceful shutdown，
 * 而 `ChildProcess.kill('SIGINT')` 在 Windows 上实测是直接终止（见 docs/reports/artifacts/M4/regression/
 * …-sigint-diagnostic/：exit/close code=null signal=SIGINT，manifest 停在 running），根本到不了那个 handler。
 *
 * 本 driver 的做法：
 * - 是**普通文件入口**（`node driver.mjs`），`import` 产品的 `launch`（file URL），**不替换任何 options**；
 * - `execArgv` 必须为空、`NODE_OPTIONS` 必须未设（launch 自己也有该校验）——即**不用注入**方式接近子进程；
 * - 真正的 backend/frontends/prepare 全走产品代码，没有任何替身；
 * - 收到测试 IPC 消息 `{type:'sigint'}` 时才 `process.emit('SIGINT')`，让 launch 自己注册的处理器执行。
 *
 * 边界（报告里必须这么写）：这是**进程内 SIGINT 处理模拟**，
 * **不是**真实 Windows 控制台 Ctrl+C（CTRL_C_EVENT 投递路径未测）。
 */
import { launch } from '../../../../scripts/demo/launch.mjs';

if (process.env.NODE_OPTIONS) {
  console.error('driver must run without NODE_OPTIONS');
  process.exit(9);
}
if (process.execArgv.length) {
  console.error('driver must run without execArgv injections');
  process.exit(9);
}
if (!process.send) {
  console.error('driver requires parent IPC');
  process.exit(9);
}

const onMessage = (message) => {
  if (message && typeof message === 'object' && message.type === 'sigint') {
    // 只触发进程内 SIGINT 事件，让 launch 自己的 once('SIGINT') 处理器跑起来。
    process.emit('SIGINT');
  }
};
process.on('message', onMessage);

try {
  await launch('mock', []);
} catch (error) {
  console.error(`driver launch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  // IPC 通道与监听会保持事件循环：必须在这里释放，否则 launch 返回后进程不退出。
  // 注意是**子进程侧**主动 disconnect（父侧 child.disconnect() 在旧版 Node 有已知问题，不使用）。
  process.removeListener('message', onMessage);
  if (process.connected) { try { process.disconnect(); } catch { /* 已断开 */ } }
}
