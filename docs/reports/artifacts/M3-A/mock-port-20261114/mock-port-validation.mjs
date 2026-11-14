import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const changed = ['apps/server/src/agent/client.test.ts', 'apps/server/src/app.test.ts', 'apps/server/src/assets/lux3d.test.ts', 'apps/server/src/assets/recovery.test.ts', 'apps/server/src/assets/service.test.ts', 'apps/server/src/m2-api.test.ts', 'apps/server/src/task-id.test.ts', 'apps/server/src/work/service.test.ts', 'apps/server/src/test-support/fetch-listener.ts', 'apps/server/src/test-support/fetch-listener.test.ts'];
const snapshot = () => ({
  head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain', '--untracked-files=all'),
  lock: hash(readFileSync(path.join(root, 'pnpm-lock.yaml'))),
  diff: hash(git('diff', '--binary', 'HEAD')),
  files: Object.fromEntries(changed.map(file => [file, { sha256: hash(readFileSync(path.join(root, file))), gitBlob: git('hash-object', '--', file) }])),
});
const before = snapshot();
if (before.head !== 'c2f79f8227466e908d064c81e49d530cc264756e') throw new Error('Unexpected baseline');
// git output is trimmed above, so the leading column of the first line may be absent.
const normalizedPaths = git('status', '--porcelain', '--untracked-files=all', '-z').split('\0').filter(Boolean).map(line => line.replace(/^\s*[M?]+\s+/, ''));
if (normalizedPaths.length !== changed.length || normalizedPaths.some(file => !changed.includes(file))) throw new Error('Unexpected dirty paths');
const directory = path.join(root, '.data', `mock-port-validation-${Date.now()}`);
await mkdir(directory, { recursive: true });
const evidence = { root, before, startedAt: new Date().toISOString(), steps: [], status: 'running',
  contract: { testOnlyListenerPorts: [20000, 65535], maxAllocationCandidates: 32, httpRetries: 0, previousTimeoutsUnchanged: true } };
const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
const same = value => JSON.stringify(value) === JSON.stringify(before);
const env = { ...process.env, CI: 'true', NO_COLOR: '1', CODING_AGENT_BASE_URL: 'http://127.0.0.1:4011', CODING_AGENT_API_KEY: 'mock-only', CODING_AGENT_MODEL: 'mock-coder', LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'mock-only' };
console.log(JSON.stringify({ stage: 'standard-validation', root, before, directory }));
await save();
try {
  for (const script of ['typecheck', 'build', 'test']) {
    if (!same(snapshot())) throw new Error('Identity changed before step');
    const args = ['/d', '/s', '/c', `pnpm ${script}`];
    const step = { name: script, command: [process.env.ComSpec || 'cmd.exe', ...args], startedAt: new Date().toISOString(), before: snapshot(), log: `${script}.log` };
    evidence.steps.push(step);
    await save();
    console.log(`START pnpm ${script}`);
    const log = createWriteStream(path.join(directory, step.log));
    const start = Date.now();
    const child = spawn(step.command[0], args, { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    step.pid = child.pid;
    child.stdout.on('data', chunk => { log.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { log.write(chunk); process.stderr.write(chunk); });
    child.on('error', error => { step.spawnError = { code: error.code, message: error.message }; });
    const result = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
    await new Promise(resolve => log.end(resolve));
    Object.assign(step, result, { finishedAt: new Date().toISOString(), elapsedMs: Date.now() - start, after: snapshot() });
    step.identityPreserved = same(step.after);
    await save();
    console.log(`END pnpm ${script} exit=${step.exitCode} signal=${step.signal} identity=${step.identityPreserved}`);
    if (step.exitCode !== 0 || step.signal || step.spawnError || !step.identityPreserved) throw new Error(`Failed at ${script}`);
  }
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.after = snapshot();
  evidence.identityPreserved = same(evidence.after);
  if (!evidence.identityPreserved) { evidence.status = 'failed'; process.exitCode = 1; }
  await save();
  console.log(JSON.stringify({ status: evidence.status, evidence: path.join(directory, 'evidence.json') }));
}
