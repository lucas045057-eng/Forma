import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = path.join(root, 'apps/server');
const require = createRequire(path.join(server, 'package.json'));
const tsc = require.resolve('typescript/bin/tsc');
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const probe = process.argv.includes('--probe');
const pnpmVersion = process.platform === 'win32'
  ? ['cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd --version'], root]
  : ['pnpm', ['--version'], root];
const install = process.platform === 'win32'
  ? ['cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd install --offline --frozen-lockfile'], root]
  : ['pnpm', ['install', '--offline', '--frozen-lockfile'], root];
const steps = probe ? [
  pnpmVersion,
  [process.execPath, [tsc, '--version'], server],
  [process.execPath, [vitest, '--version'], server],
] : [
  install,
  [process.execPath, [tsc], server],
  [process.execPath, [path.join(server, 'scripts/m3a-native-import.mjs')], root],
  [process.execPath, [vitest, 'run', 'src/work/approvals.test.ts', 'src/events-lock.test.ts'], server],
];

console.log(`[m3a-verify] worktree ${root}`);
for (const [command, args, cwd] of steps) {
  const printable = [command, ...args].join(' ');
  console.log(`[m3a-verify] start ${printable}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false, windowsHide: true });
  console.log(`[m3a-verify] end ${printable} exit=${String(result.status)} signal=${String(result.signal)}`);
  if (result.error) {
    console.error(`[m3a-verify] spawn error: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0 || result.signal) process.exit(result.status ?? 1);
}
