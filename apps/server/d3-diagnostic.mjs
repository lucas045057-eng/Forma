// Implementation diagnostic, not Pi's formal E2E. Run from this worktree root on Windows.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, copyFile, symlink, realpath, writeFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '../..');
const mode = process.argv[2];
if (mode === 'launcher') {
  const child = spawn(process.execPath, [script, 'backend', ...process.argv.slice(3)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  child.on('message', message => process.send?.(message));
  child.on('exit', code => process.exit(code ?? 0));
} else if (mode === 'backend') {
  const [directory, upstream] = process.argv.slice(3);
  const { createApp } = await import('./src/app.ts');
  const { app, work } = await createApp({
    workRoot: path.join(directory, 'work'), workDataDirectory: path.join(directory, 'data'),
    dataDirectory: path.join(directory, 'assets'), historyDirectory: path.join(directory, 'history'),
    base: upstream, key: 'fake-d3-only', codingAgentBaseUrl: upstream,
    codingAgentApiKey: 'fake-d3-only', codingAgentModel: 'mock',
  });
  const boundaries = [];
  const redact = value => String(value ?? '').replaceAll(directory, '<fixture>').replaceAll(root, '<worktree>');
  for (const name of ['snapshot', 'createCandidate', 'linkDependencies', 'main', 'inCandidate']) {
    const operation = work.repo[name].bind(work.repo);
    work.repo[name] = async (...args) => {
      try { return await operation(...args); }
      catch (error) {
        boundaries.push({ boundary: name, code: error.code, message: redact(error.message), stack: redact(error.stack) });
        await writeFile(path.join(directory, 'repo-errors.json'), JSON.stringify(boundaries, null, 2));
        throw error;
      }
    };
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  process.send?.({ backendPid: process.pid, port: app.server.address().port });
} else {
  if (process.platform !== 'win32') throw new Error('This diagnostic records Windows process identity');
  const directory = path.join(root, '.data', `d3-diagnostic-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  const evidence = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), directory, cases: [] };
  const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 30_000 });
  const snapshot = () => {
    const result = JSON.parse(ps("$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine); $n = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess); @{processes=$p;listeners=$n} | ConvertTo-Json -Depth 4 -Compress"));
    // Raw command lines stay in memory; evidence must not capture other applications' arguments.
    const processes = result.processes.map(({ CommandLine, ...identity }) => ({
      ...identity,
      commandDigest: createHash('sha256').update(CommandLine ?? '').digest('hex'),
      previewWorker: /preview-worker\.(ts|js)/.test(CommandLine ?? ''),
      piMatch: /vite.js/i.test(CommandLine ?? '') && /preview-cache/i.test(CommandLine ?? ''),
      diagnosticDirectory: (CommandLine ?? '').toLowerCase().includes(directory.toLowerCase()),
    }));
    return { at: new Date().toISOString(), processes, listeners: result.listeners };
  };
  const same = (a, b) => a && b && a.ProcessId === b.ProcessId && a.CreationDate === b.CreationDate && a.commandDigest === b.commandDigest;
  const descendants = (state, pid) => {
    const ids = new Set([pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const p of state.processes) if (ids.has(p.ParentProcessId) && !ids.has(p.ProcessId)) { ids.add(p.ProcessId); changed = true; }
    }
    return state.processes.filter(p => ids.has(p.ProcessId));
  };
  const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const killVerified = (identity, state, tree = false) => {
    if (!same(identity, state.processes.find(p => p.ProcessId === identity.ProcessId))) return false;
    execFileSync('taskkill.exe', [...(tree ? ['/T'] : []), '/F', '/PID', String(identity.ProcessId)], { encoding: 'utf8', timeout: 30_000 });
    return true;
  };
  const counts = new Map();
  const mock = createServer(async (request, response) => {
    for await (const chunk of request) { /* consume only local mock request */ }
    const session = request.headers['x-opencode-session'];
    const turn = counts.get(session) ?? 0;
    counts.set(session, turn + 1);
    const call = turn === 0
      ? { name: 'replace_in_file', arguments: JSON.stringify({ path: 'src/App.tsx', old: '立即购买', new: 'D3诊断购买' }) }
      : { name: 'finish', arguments: JSON.stringify({ summary: 'D3 diagnostic' }) };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: call }] } }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const template = path.join(root, 'templates/product-page');
  const files = execFileSync('git', ['ls-files', '-z', '--', 'templates/product-page'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  try {
    for (const kind of (mode === '--smoke' ? ['ready-smoke'] : ['backend-pid', 'launcher-tree'])) {
      const fixture = path.join(directory, kind);
      const work = path.join(fixture, 'work');
      await mkdir(work, { recursive: true });
      for (const file of files) {
        const relative = path.relative(template, path.join(root, file));
        if (relative.split(/[\\/]/).some(part => part.startsWith('.env'))) continue;
        const target = path.join(work, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(path.join(root, file), target);
      }
      const linkPackages = async (source, target) => {
        await mkdir(target, { recursive: true });
        for (const name of await readdir(source)) {
          if (name.startsWith('.')) continue;
          if (name.startsWith('@')) await linkPackages(path.join(source, name), path.join(target, name));
          else await symlink(await realpath(path.join(source, name)), path.join(target, name), 'junction');
        }
      };
      await linkPackages(path.join(template, 'node_modules'), path.join(work, 'node_modules'));
      const entry = { kind, fixture, before: snapshot(), owned: [] };
      evidence.cases.push(entry);
      const env = {};
      for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec']) if (process.env[key]) env[key] = process.env[key];
      env.PREVIEW_ORIGIN_PORT = '0';
      const launcher = spawn(process.execPath, [script, 'launcher', fixture, upstream], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let log = '';
      launcher.stdout.on('data', c => { log += c; });
      launcher.stderr.on('data', c => { log += c; });
      try {
        const backend = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Backend startup deadline')), 60_000);
          launcher.once('message', value => { clearTimeout(timer); resolve(value); });
          launcher.once('error', error => { clearTimeout(timer); reject(error); });
          launcher.once('exit', code => { clearTimeout(timer); reject(new Error(`Launcher exited ${code}: ${log}`)); });
        });
        entry.backend = backend;
        const base = `http://127.0.0.1:${backend.port}`;
        const submitted = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: '把购买按钮文字改为D3诊断购买' }) });
        const task = await submitted.json();
        entry.submission = { status: submitted.status, task };
        if (submitted.status !== 202) throw new Error(`Task submission failed: ${JSON.stringify(task)}`);
        const deadline = Date.now() + 120_000;
        for (;;) {
          const current = await (await fetch(`${base}/tasks/${task.id}`)).json();
          if (current.status === 'done') { entry.task = current; break; }
          if (['failed', 'cancelled'].includes(current.status)) throw new Error(`Task failed: ${JSON.stringify(current)}`);
          if (Date.now() > deadline) throw new Error('Candidate startup deadline');
          await delay(250);
        }
        entry.running = snapshot();
        entry.owned = descendants(entry.running, launcher.pid);
        entry.listeners = entry.running.listeners.filter(n => entry.owned.some(p => p.ProcessId === n.OwningProcess));
        const workerIds = entry.owned.filter(p => p.previewWorker).map(p => p.ProcessId);
        entry.previewResponses = [];
        for (const listener of entry.listeners.filter(n => workerIds.includes(n.OwningProcess))) {
          const response = await fetch(`http://127.0.0.1:${listener.LocalPort}/preview/c/${entry.task.candidateId}/`, { signal: AbortSignal.timeout(5000) });
          entry.previewResponses.push({ pid: listener.OwningProcess, port: listener.LocalPort, status: response.status });
          await response.body?.cancel();
        }
        if (!entry.previewResponses.some(r => r.status === 200)) throw new Error('No actual worker-owned Vite HTTP 200');
        entry.piMatches = entry.running.processes.filter(p => p.piMatch);
        entry.readyVerified = true;
        entry.mockCalls = [...counts.values()].reduce((sum, count) => sum + count, 0);
        if (mode === '--smoke') continue;
        const targetPid = kind === 'backend-pid' ? backend.backendPid : launcher.pid;
        const identity = entry.owned.find(p => p.ProcessId === targetPid);
        if (!identity) throw new Error('No verified target identity');
        entry.kill = { identity, tree: kind === 'launcher-tree', at: new Date().toISOString() };
        killVerified(identity, snapshot(), kind === 'launcher-tree');
        await delay(1000);
        entry.after1s = snapshot();
        await delay(29_000);
        entry.after30s = snapshot();
        entry.survivors = entry.owned.filter(p => same(p, entry.after30s.processes.find(q => q.ProcessId === p.ProcessId)));
      } catch (error) {
        entry.error = String(error.stack ?? error);
        process.exitCode = 1;
      } finally {
        entry.log = log;
        const state = snapshot();
        // Include descendants created before a startup failure, but never claim unrelated global matches.
        entry.owned = [...new Map([...entry.owned, ...descendants(state, launcher.pid)].map(p => [p.ProcessId, p])).values()];
        await save();
        for (const identity of [...entry.owned].reverse()) killVerified(identity, snapshot());
        entry.cleaned = snapshot();
        entry.cleanupSurvivors = entry.owned.filter(p => same(p, entry.cleaned.processes.find(q => q.ProcessId === p.ProcessId)));
        if (entry.cleanupSurvivors.length) process.exitCode = 1;
        if (launcher.connected) launcher.disconnect();
        await save();
      }
    }
  } finally {
    await new Promise(resolve => mock.close(resolve));
    await save();
    console.log(`D3 diagnostic evidence: ${path.join(directory, 'evidence.json')}`);
    console.log(JSON.stringify(evidence.cases.map(c => ({ kind: c.kind, error: c.error, backend: c.backend, owned: c.owned, survivors: c.survivors, cleanupSurvivors: c.cleanupSurvivors })), null, 2));
  }
}
