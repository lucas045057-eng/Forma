import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, SERVER_DIR, WORK_ROOT } from './env';
import { freePort, startChild } from '../m0a/harness';
import { http } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * N4 停机排空接点（真实 HTTP / 真实 app.close）— **当前 HEAD f70f046 预期失败**。
 *
 * 设计：用仓库内的 `core.fsmonitor` 钩子挂住一次真实 GET /version 触发的自动快照，
 * 让一个“已被接受”的作品操作停在 repo.exclusive 队列里；然后走真实优雅关闭
 * （stdin `close` → app.close）。验收要求：
 *   1. 关闭期间同一 WORK_DATA_DIR 的第二实例必须仍拿不到实例锁；
 *   2. app.close 必须等该作品操作完成才返回（不能提前关日志/放锁）；
 *   3. 锁文件消失的那一刻，作品最后写入（git HEAD 含被挂住快照的改动）与事件日志
 *      最后写入（version.changed）都必须已经落盘；
 *   4. 重启后事件 seq 接续、日志不再被改。
 *
 * 修法目前只在 `.worktrees/m2fix` 的未提交草稿里；master 尚未合并，所以本用例用
 * `test.fail` 标明“预期失败”，草稿合并且审查通过后再去掉标记重跑。
 * 不使用 taskkill 强杀，也不重复消耗 D3 的 30 秒等待。
 */

const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface UnlockSnapshot {
  at: number; reason: string; lockExists: boolean; head: string; headHasMarker: boolean;
  eventBytes: number; hasVersionChanged: boolean; operationCompleted: boolean;
}

test.describe('N4 停机排空（真实 HTTP）', () => {
  test('app.close 等已接受的作品操作完成才关日志/放锁；第二实例在关闭期间仍被锁拒；重启 seq 接续', async () => {
    // N4 修法只在 .worktrees/m2fix 未提交草稿；master f70f046 的 preClose 仍在 HTTP 排空前关日志/放锁。
    // 草稿合并且审查通过后去掉 test.fail 再重跑。
    test.fail(true, 'N4 修法只在 .worktrees/m2fix 未提交草稿；master f70f046 的 preClose 仍在 HTTP 排空前关日志/放锁');

    const root = path.join(os.tmpdir(), 'pi-m2a-n4-shutdown');
    const work = path.join(root, 'work');
    const dataDir = path.join(root, 'data');
    const assetsDir = path.join(root, 'assets');
    const sceneDir = path.join(root, 'scene');
    const marker = path.join(root, 'hold.marker');
    const markerLog = path.join(root, 'fsmonitor.log');
    const blocker = path.join(root, 'block.sh');
    const gitDir = path.join(dataDir, 'work.git');
    const eventsFile = path.join(dataDir, 'events.jsonl');
    const lockFile = path.join(dataDir, '.instance.lock');

    const facts: Record<string, unknown> = {};
    const children: Array<{ pid: number; stop(): Promise<void> }> = [];
    const instances: Array<{ label: string; pid: number; port: number; stopped: boolean }> = [];
    let markerRemovedAt = 0;

    const slash = (value: string) => value.replace(/\\/g, '/');
    const gitMain = (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', work, ...args], { encoding: 'utf8' });
    const headHasMarker = (): boolean => {
      try { return gitMain('show', 'HEAD:src/App.tsx').includes('n4: blocked snapshot write'); } catch { return false; }
    };

    const start = async (label: string, timeoutMs = 20_000) => {
      const port = await freePort();
      const child = await startChild({
        command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
        env: {
          PORT: String(port), WORK_ROOT: work, WORK_DATA_DIR: dataDir,
          ASSETS_DIR: assetsDir, SCENE_HISTORY_DIR: sceneDir,
          LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'unused', PREVIEW_ORIGIN_PORT: '0',
          // 与其它测试一致：出站守卫只放行回环；不读真实 .env / 不调用真实模型或 Lux3D。
          PI_NET_GUARD_LOG: path.join(root, `guard-${label}-${port}.log`),
          NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
        },
        readyUrl: `http://127.0.0.1:${port}/health`, label, timeoutMs,
      });
      children.push(child);
      instances.push({ label, pid: child.pid, port, stopped: false });
      return { ...child, port, base: `http://127.0.0.1:${port}` };
    };

    /** 第二实例：健康起来 = 锁没拦住；退出码信息含 INSTANCE_LOCKED = 锁生效。 */
    const attemptSecondInstance = async () => {
      try {
        const child = await start('n4-second-instance', 12_000);
        await child.stop();
        return { locked: false, started: true, detail: '第二个实例在关闭期间成功启动' };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { locked: detail.includes('INSTANCE_LOCKED'), started: false, detail: detail.slice(-800) };
      }
    };

    try {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      for (const entry of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
        writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
      }
      for (const entry of ['src/App.tsx', 'src/main.tsx', 'src/style.css', 'src/components/ProductHero.tsx', 'src/components/Button.tsx']) {
        mkdirSync(path.join(work, path.dirname(entry)), { recursive: true });
        writeFileSync(path.join(work, entry), readFileSync(path.join(WORK_ROOT, entry)));
      }
      mkdirSync(path.join(work, 'public'), { recursive: true });

      // 1) 先正常起一次，让作品版本库建立，再配 core.fsmonitor 挂起快照。
      const bootstrap = await start('n4-bootstrap');
      const bootstrapVersion = (await http(`${bootstrap.base}/version`)).body.version as string;
      const bootstrapClose = await bootstrap.gracefulClose(20_000);
      expect(bootstrapClose.code, `bootstrap 关闭失败：${bootstrapClose.output.slice(-400)}`).toBe(0);
      facts.bootstrapVersion = bootstrapVersion;

      writeFileSync(blocker, [
        '#!/bin/sh',
        `if [ -f "${slash(marker)}" ]; then`,
        `  echo "blocked" >> "${slash(markerLog)}"`,
        `  while [ -f "${slash(marker)}" ]; do sleep 0.05; done`,
        'fi',
        'echo "fsmonitor released" >&2',
        'exit 1',
        '',
      ].join('\n'), 'utf8');
      execFileSync('git', ['--git-dir', gitDir, 'config', 'core.fsmonitor', `sh '${slash(blocker)}'`], { encoding: 'utf8' });
      expect(execFileSync('git', ['--git-dir', gitDir, 'config', '--get', 'core.fsmonitor'], { encoding: 'utf8' })).toContain('block.sh');

      // 2) 让作品脏着，这样被挂住的 GET /version 必须写一次快照（作品最后写入）。
      //    先在没有 marker 的情况下启动（fsmonitor 钩子会立即 exit 1，不影响 init），
      //    再由测试放上 marker，确保只有这一次请求被挂住。
      appendFileSync(path.join(work, 'src', 'App.tsx'), '\n// n4: blocked snapshot write\n', 'utf8');

      const first = await start('n4-first');
      const before = (await http(`${first.base}/events/history?since=0`)).body as { current: number; oldest: number };
      facts.seqBefore = before;
      writeFileSync(marker, 'hold');

      // 3) 发一个真实的 GET /version：它进入 repo.exclusive 后会被 fsmonitor 卡住。
      let versionResult: { status: number; body: { version?: string } } | null = null;
      const versionPromise = fetch(`${first.base}/version`).then(async (response) => {
        versionResult = { status: response.status, body: await response.json().catch(() => ({})) };
        return versionResult;
      });
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 20_000;
        const check = () => {
          if (existsSync(markerLog) && statSync(markerLog).size > 0) return resolve();
          if (Date.now() > deadline) return reject(new Error('fsmonitor 没有被调用，无法证明请求已进入作品操作队列'));
          setTimeout(check, 100);
        };
        check();
      });
      await sleep(500);
      facts.operationAcceptedAndBlocked = versionResult === null;
      expect(facts.operationAcceptedAndBlocked, '被挂住的作品操作不应提前完成').toBe(true);

      // 4) 观察锁释放的那一刻，并在关闭期间尝试第二实例。
      let closeDoneAt = 0;
      const unlockRef: { value: UnlockSnapshot | null } = { value: null };
      const captureUnlock = (reason: string) => {
        if (unlockRef.value) return;
        const at = Date.now();
        let head = '';
        try { head = gitMain('rev-parse', 'HEAD').trim(); } catch { /* ignore */ }
        unlockRef.value = {
          at, reason, lockExists: existsSync(lockFile), head, headHasMarker: headHasMarker(),
          eventBytes: read(eventsFile).length, hasVersionChanged: read(eventsFile).includes('version.changed'),
          operationCompleted: versionResult !== null,
        };
      };
      const lockWatcher = (async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if (!existsSync(lockFile)) { captureUnlock('lock-file-gone'); return; }
          if (closeDoneAt !== 0) { captureUnlock('close-settled'); return; }
          await sleep(20);
        }
      })();

      const closePromise = first.gracefulClose(90_000).then((result) => {
        const at = Date.now(); closeDoneAt = at; return { at, ...result };
      });
      await sleep(800);
      const closeSettledWhileBlocked = closeDoneAt !== 0;
      const lockHeldWhileBlocked = existsSync(lockFile);
      const secondWhileBlocked = await attemptSecondInstance();
      facts.whileBlocked = { closeSettledWhileBlocked, lockHeldWhileBlocked, secondWhileBlocked, operationStillBlocked: versionResult === null };

      // 5) 释放被挂住的操作，等关闭完成。
      markerRemovedAt = Date.now();
      rmSync(marker, { force: true });
      const released = await versionPromise;
      facts.blockedOperationResult = released;
      const closeResult = await closePromise;
      await lockWatcher;
      const logAfterClose = read(eventsFile);

      // 6) 重启：seq 接续、日志不再被改，并确认被挂住操作的写入已持久化。
      const restarted = await start('n4-restarted');
      const restartedVersion = (await http(`${restarted.base}/version`)).body.version as string;
      const after = (await http(`${restarted.base}/events/history?since=0`)).body as { current: number; oldest: number; events: Array<{ type: string }> };
      const logAfterRestart = read(eventsFile);
      const headVersion = gitMain('rev-parse', 'HEAD').trim();
      const logMtime = statSync(eventsFile).mtimeMs;
      const headTime = Number(gitMain('log', '-1', '--format=%ct').trim()) * 1000;
      const unlock = unlockRef.value;

      facts.after = {
        closeResult, processExitedWhileBlocked: closeSettledWhileBlocked, closeExitedAfterRelease: closeResult.at >= markerRemovedAt,
        unlock, lockReleasedAt: unlock?.at ?? null,
        restartedVersion, headVersion, headHasMarker: headHasMarker(),
        seqAfterRestart: after, logAfterRestartEqualsClose: logAfterRestart === logAfterClose,
        logMtime, headTimeOfLastWrite: headTime,
        writesBeforeUnlock: Boolean(unlock && unlock.headHasMarker && unlock.hasVersionChanged && logMtime <= (unlock.at + 1000) && headTime <= (unlock.at + 1000)),
        secondInstanceTests: { secondWhileBlocked },
        eventsAfterUnlock: { hasVersionChanged: logAfterRestart.includes('version.changed') },
      };

      // 7) N4 的验收断言（当前 HEAD 预期失败；用 soft 让所有事实都先记录）。
      expect.soft(facts.operationAcceptedAndBlocked, '被挂住的作品操作提前完成了').toBe(true);
      expect.soft(lockHeldWhileBlocked, '关闭期间实例锁已被提前释放').toBe(true);
      expect.soft(unlock?.operationCompleted, '锁释放那一刻，被挂住的作品操作还没有完成').toBe(true);
      expect.soft(secondWhileBlocked.locked, `关闭期间第二实例没有被 INSTANCE_LOCKED 拦下：${secondWhileBlocked.detail}`).toBe(true);
      expect.soft(closeResult.at >= markerRemovedAt, 'app.close 早于被阻塞操作的释放完成').toBe(true);
      expect.soft(unlock?.headHasMarker, '锁释放那一刻，被阻塞操作的作品写入还没落盘').toBe(true);
      expect.soft(unlock?.hasVersionChanged, '锁释放那一刻，被阻塞操作的事件还没落盘').toBe(true);
      expect.soft(released?.status, '被阻塞的 GET /version 没有正常完成').toBe(200);
      expect.soft(restartedVersion, '重启后作品版本与被阻塞操作返回的版本不一致').toBe(released?.body?.version);
      expect.soft(after.current >= before.current + 1, '重启后事件序号没有接续').toBe(true);
      expect.soft(after.oldest, '重启后事件历史被归零').toBe(before.oldest);
      expect.soft(logAfterRestart, '重启改写了事件日志').toBe(logAfterClose);
      expect.soft(headHasMarker(), '被阻塞操作的作品写入没有持久化').toBe(true);
    } finally {
      rmSync(marker, { force: true });
      for (const child of [...children].reverse()) await child.stop().catch(() => {});
      for (const instance of instances) instance.stopped = true;
      facts.instances = instances;
      writeArtifactFrom('takeover-n4-shutdown.json', facts);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
