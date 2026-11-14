import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = realpathSync(path.resolve(import.meta.dirname, '..'));
const server = path.join(root, 'apps/server');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const snapshot = () => ({ head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'),
  lock: createHash('sha256').update(readFileSync(path.join(root, 'pnpm-lock.yaml'))).digest('hex') });
if (path.relative(root, realpathSync(git('rev-parse', '--show-toplevel'))) !== '') throw new Error('Git root differs from the intended isolated worktree');
const before = snapshot();
if (before.head !== '012d9a65b4242cad2407a40c34614b2d162c8032' || before.status) throw new Error('Controlled run requires the unchanged clean implementation baseline');
const completionProbe = process.argv.includes('--completion-probe');
const names = ['combines rules into one card and enforces the three-pending-card limit',
  'persists stale main approvals, releases capacity and rejects repeated answers consistently',
  'keeps at most three pending candidates and cleans up the oldest'];
const output = path.join(root, '.data', `${completionProbe ? 'codex-heavy-completion' : 'codex-worker-control'}-${Date.now()}`);
await mkdir(output, { recursive: true });
const require = createRequire(path.join(server, 'package.json'));
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const reportPath = path.join(output, 'vitest.json');
const argv = [vitest, 'run', '--minWorkers=1', '--maxWorkers=2', '--reporter=verbose', '--reporter=json', '--outputFile', reportPath];
if (completionProbe) argv.push('--testNamePattern', names.join('|'), '--testTimeout=15000');
const evidence = { root, cwd: server, before, command: [process.execPath, ...argv],
  machine: { availableParallelism: os.availableParallelism(), cpus: os.cpus().length, platform: process.platform, node: process.version },
  workers: { min: 1, max: 2 }, startedAt: new Date().toISOString(), report: 'vitest.json',
  purpose: completionProbe ? 'Observe natural completion only; not acceptance and no committed timeout change' : 'Controlled unchanged server suite',
  diagnosticOnly: completionProbe };
const save = () => writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
await save();
console.log(JSON.stringify({ stage: 'controlled-server-suite', root, head: before.head, output, workers: evidence.workers }));
const log = createWriteStream(path.join(output, 'server-test.log'));
const started = performance.now();
const child = spawn(process.execPath, argv, { cwd: server, shell: false, windowsHide: true,
  env: { ...process.env, CI: 'true', NO_COLOR: '1', CODING_AGENT_BASE_URL: 'http://127.0.0.1:4011',
    CODING_AGENT_API_KEY: 'mock-only', CODING_AGENT_MODEL: 'mock-coder', LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'mock-only' },
  stdio: ['ignore', 'pipe', 'pipe'] });
evidence.pid = child.pid;
child.stdout.on('data', data => log.write(data));
child.stderr.on('data', data => log.write(data));
child.once('error', error => { evidence.spawnError = error.message; });
const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
await new Promise(resolve => log.end(resolve));
evidence.elapsedMs = Math.round(performance.now() - started);
evidence.exitCode = result.code;
evidence.signal = result.signal;
evidence.finishedAt = new Date().toISOString();
evidence.after = snapshot();
evidence.identityPreserved = JSON.stringify(before) === JSON.stringify(evidence.after);
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const assertions = report.testResults.flatMap(file => file.assertionResults ?? []);
  evidence.counts = { total: report.numTotalTests, passed: report.numPassedTests, failed: report.numFailedTests,
    pending: report.numPendingTests, todo: report.numTodoTests ?? 0, assertions: assertions.length };
  evidence.heavy = assertions.filter(test => names.some(name => test.fullName.includes(name)))
    .map(test => ({ name: test.fullName, status: test.status, duration: test.duration }));
  evidence.assertionsPassed = assertions.length === 179 && evidence.heavy.length === 3 && (completionProbe
    ? evidence.heavy.every(test => test.status === 'passed') && assertions.filter(test => test.status === 'passed').length === 3
    : assertions.every(test => test.status === 'passed'));
} catch (error) { evidence.reportError = error.message; }
evidence.passed = result.code === 0 && !result.signal && !evidence.spawnError && !evidence.reportError &&
  evidence.identityPreserved && evidence.assertionsPassed && evidence.counts.total === 179 && evidence.counts.passed === (completionProbe ? 3 : 179);
await save();
console.log(JSON.stringify({ passed: evidence.passed, exit: evidence.exitCode, elapsedMs: evidence.elapsedMs,
  identityPreserved: evidence.identityPreserved, counts: evidence.counts, heavy: evidence.heavy, evidence: path.join(output, 'evidence.json') }));
process.exitCode = evidence.passed ? 0 : 1;
