// Run through bg-m2d3.cmd from the worktree root. No package-manager installation hooks.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const lockHash = () => createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex');
const evidence = { head: git('rev-parse', 'HEAD'), lockHash: lockHash(), startedAt: new Date().toISOString(), steps: [] };
if (git('status', '--porcelain')) throw new Error('Validation requires a clean worktree');
const directory = path.join(root, '.data', `m2-validation-${Date.now()}`);
await mkdir(directory, { recursive: true });
const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`Frozen HEAD: ${evidence.head}\nEvidence: ${directory}`);
const packages = ['packages/shared', 'packages/vite-plugin-source-tag', 'packages/bridge',
  'packages/scene-renderer', 'apps/server', 'apps/studio', 'templates/product-page'];

async function run(folder, kind, round) {
  if (git('rev-parse', 'HEAD') !== evidence.head || lockHash() !== evidence.lockHash || git('status', '--porcelain')) {
    throw new Error('Code identity, lockfile or worktree changed during validation');
  }
  const cwd = path.join(root, folder);
  const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const script = pkg.scripts?.[kind];
  if (!script) throw new Error(`Missing ${kind} script in ${folder}`);
  const require = createRequire(path.join(cwd, 'package.json'));
  const [tool, ...args] = script.split(/\s+/);
  let command;
  if (tool === 'tsc') command = [require.resolve('typescript/bin/tsc'), ...args];
  else if (tool === 'vite') command = [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), ...args];
  else if (tool === 'vitest') command = [path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), ...args];
  else if (tool === 'node') command = args;
  else throw new Error(`Unsupported local script: ${script}`);
  const label = `${kind}${round ? `-${round}` : ''}-${folder.replaceAll('/', '-')}`;
  const step = { label, folder, script, head: evidence.head, startedAt: new Date().toISOString(), log: `${label}.log` };
  evidence.steps.push(step);
  await save();
  console.log(`START ${label}`);
  const log = createWriteStream(path.join(directory, step.log));
  const child = spawn(process.execPath, command, { cwd, env: { ...process.env, CI: 'true', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  step.pid = child.pid;
  child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
  child.on('error', error => { step.spawnError = error.message; });
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await new Promise(resolve => log.end(resolve));
  Object.assign(step, { exitCode: result.code, signal: result.signal, endedAt: new Date().toISOString() });
  step.headAfter = git('rev-parse', 'HEAD');
  step.lockHashAfter = lockHash();
  step.statusAfter = git('status', '--porcelain');
  await save();
  console.log(`END ${label}: exit=${result.code} signal=${result.signal}`);
  if (result.code !== 0 || result.signal || step.spawnError) throw new Error(`Validation stopped at ${label}; see ${step.log}`);
  if (step.headAfter !== evidence.head || step.lockHashAfter !== evidence.lockHash || step.statusAfter) {
    throw new Error(`Validation changed tracked files or code identity at ${label}`);
  }
}
try {
  for (const kind of ['typecheck', 'build']) for (const folder of packages) await run(folder, kind);
  for (let round = 1; round <= 5; round++) {
    for (const folder of packages.slice(0, -1)) await run(folder, 'test', round);
    evidence.completedTestRounds = round;
    await save();
  }
  evidence.passed = true;
} catch (error) {
  evidence.passed = false;
  evidence.error = String(error.stack ?? error);
  process.exitCode = 1;
  console.error(evidence.error);
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.finalHead = git('rev-parse', 'HEAD');
  evidence.finalLockHash = lockHash();
  evidence.finalStatus = git('status', '--porcelain');
  await save();
  console.log(`Validation evidence: ${path.join(directory, 'evidence.json')}`);
}
