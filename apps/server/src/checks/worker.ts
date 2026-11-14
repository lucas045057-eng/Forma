import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckName, CheckResult } from '@spatial/shared';
import type { CheckContext, CheckExecutor } from './runner.ts';
import { workerPermissions } from './tools.ts';
import { record } from './protocol.ts';
import { validateArtifactName } from './artifacts.ts';
import { assertPlainPath } from './paths.ts';

const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
const cancelled = () => fault('CANCELLED', '检查被取消');
interface Session {
  child: ChildProcess; root: string; digest: string; ready: Promise<void>; exited: Promise<void>;
  dead: boolean; stopping: boolean; stop?: Promise<void>; output: string;
  pending?: { token: number; ctx: CheckContext; name: CheckName; resolve: (result: CheckResult) => void; reject: (error: unknown) => void; refs: Set<string> };
}
export function workerScriptPath() {
  return fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './worker-entry.ts' : './worker-entry.js', import.meta.url));
}

/** Only fixed trusted code is executable. The parent alone owns evidence persistence. */
export function createRealExecutor(): CheckExecutor {
  const sessions = new Map<string, Session>();
  let token = 0;
  async function stop(runId: string) {
    const s = sessions.get(runId);
    if (!s) return;
    if (s.stop) return s.stop;
    s.stopping = true;
    s.stop = (async () => {
      if (s.dead) return;
      s.child.send({ kind: 'stop' }, () => {});
      const timer = setTimeout(() => {
        if (s.dead || !s.child.pid) return;
        if (process.platform === 'win32') {
          execFile('taskkill.exe', ['/T', '/F', '/PID', String(s.child.pid)], { windowsHide: true }, () => {});
        } else {
          try { process.kill(-s.child.pid, 'SIGKILL'); } catch { s.child.kill('SIGKILL'); }
        }
      }, 2000);
      try { await s.exited; } finally { clearTimeout(timer); }
    })();
    return s.stop;
  }
  async function session(ctx: CheckContext): Promise<Session> {
    if (!/^[a-f0-9]{32}$/.test(ctx.runId)) throw fault('WORKER_PROTOCOL', '非法运行编号');
    const existing = sessions.get(ctx.runId);
    if (existing) {
      if (existing.root !== ctx.buildRoot || existing.digest !== ctx.snapshot.digest || existing.stopping || existing.dead) throw fault('WORKER_STATE', '检查进程身份不匹配或已结束');
      return existing;
    }
    await assertPlainPath(ctx.buildRoot, () => fault('PATH_DENIED', '检查快照路径包含链接'));
    ctx.signal.throwIfAborted();
    const temporary = path.join(ctx.buildRoot, '.tmp');
    await mkdir(temporary, { recursive: true });
    await writeFile(path.join(ctx.buildRoot, 'package.json'), '{"private":true,"type":"module","workspaces":[]}');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', TEMP: temporary, TMP: temporary };
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [...workerPermissions(ctx.buildRoot), workerScriptPath(), ctx.runId], {
      cwd: ctx.buildRoot, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let acceptReady!: () => void, rejectReady!: (e: unknown) => void, acceptExit!: () => void;
    const ready = new Promise<void>((resolve, reject) => { acceptReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const exited = new Promise<void>(resolve => { acceptExit = resolve; });
    const s: Session = { child, root: ctx.buildRoot, digest: ctx.snapshot.digest, ready, exited, dead: false, stopping: false, output: '' };
    sessions.set(ctx.runId, s);
    const collect = (data: Buffer) => { s.output = (s.output + data.toString('utf8')).slice(-6000); };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    const failed = (error: unknown) => { rejectReady(error); s.pending?.reject(error); };
    child.on('error', error => { failed(error); if (!child.pid) { s.dead = true; acceptExit(); } });
    child.once('close', () => {
      s.dead = true; acceptExit();
      failed(fault('WORKER_EXITED', '检查子进程退出：' + s.output.slice(-1500)));
    });
    child.on('message', message => {
      if (!record(message) || s.stopping) return;
      if (message.kind === 'ready') { acceptReady(); return; }
      const p = s.pending;
      if (!p || message.requestToken !== p.token || p.ctx.signal.aborted) return;
      if (message.kind === 'artifact') {
        void (async () => {
          try {
            if (typeof message.name !== 'string' || typeof message.content !== 'string' || message.content.length > 3_000_000 ||
              !['utf8', 'base64'].includes(String(message.encoding)) || !Number.isSafeInteger(message.token)) throw fault('WORKER_PROTOCOL', '非法证据消息');
            validateArtifactName(message.name);
            if (!message.name.startsWith(p.name + '.')) throw fault('WORKER_PROTOCOL', '证据不属于当前阶段');
            const ref = await p.ctx.writeArtifact(message.name, message.encoding === 'base64' ? Buffer.from(message.content, 'base64') : message.content);
            if (s.pending !== p || p.ctx.signal.aborted || s.stopping) return;
            p.refs.add(ref.hash);
            child.send({ kind: 'artifact-result', token: message.token, ref }, () => {});
          } catch { p.reject(fault('ARTIFACT_FAILED', '检查证据保存失败')); await stop(ctx.runId); }
        })();
      } else if (message.kind === 'result') {
        const result = message.result;
        if (!record(result) || result.name !== p.name || !['passed', 'failed', 'not_run', 'cancelled'].includes(String(result.status)) ||
          (result.status === 'passed' && (typeof result.evidence !== 'string' || !p.refs.has(result.evidence)))) {
          p.reject(fault('WORKER_PROTOCOL', '检查结果或证据身份无效')); void stop(ctx.runId);
        } else p.resolve(result as unknown as CheckResult);
      } else if (message.kind === 'error') {
        p.reject(fault('WORKER_FAILED', typeof message.message === 'string' ? message.message.slice(0, 600) : '检查进程失败'));
      }
    });
    return s;
  }
  async function run(name: CheckName, ctx: CheckContext): Promise<CheckResult> {
    if (ctx.signal.aborted) throw cancelled();
    const s = await session(ctx);
    if (ctx.signal.aborted) { await stop(ctx.runId); throw cancelled(); }
    if (s.pending) throw fault('WORKER_BUSY', '检查进程正在执行其它阶段');
    return new Promise<CheckResult>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, result?: CheckResult) => {
        if (settled) return;
        settled = true; clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); s.pending = undefined;
        if (error) reject(error); else resolve(result!);
      };
      const abort = () => { void stop(ctx.runId).then(() => finish(cancelled()), finish); };
      const timer = setTimeout(() => {
        void stop(ctx.runId).then(() => finish(fault('TIMEOUT', '检查阶段超时')), finish);
      }, name === 'build' ? ctx.buildTimeoutMs : ctx.browserTimeoutMs);
      const requestToken = ++token;
      s.pending = { token: requestToken, ctx, name, refs: new Set(), resolve: result => {
        if (ctx.signal.aborted || s.stopping) return;
        finish(undefined, result);
      }, reject: error => { if (!s.stopping) finish(error); } };
      ctx.signal.addEventListener('abort', abort, { once: true });
      if (ctx.signal.aborted) { abort(); return; }
      void s.ready.then(() => {
        if (settled || s.stopping) return;
        s.child.send({ kind: 'run', token: requestToken, runId: ctx.runId, name, buildRoot: ctx.buildRoot,
          snapshot: ctx.snapshot, buildTimeoutMs: ctx.buildTimeoutMs, browserTimeoutMs: ctx.browserTimeoutMs }, error => {
          if (error) finish(error);
        });
      }, error => { finish(error); void stop(ctx.runId); });
    });
  }
  return { schema: ctx => run('schema', ctx), build: ctx => run('build', ctx),
    smoke: ctx => run('smoke', ctx), occlusion: ctx => run('occlusion', ctx), stop };
}

