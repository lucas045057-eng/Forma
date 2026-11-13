#!/usr/bin/env node
/**
 * 快速探针：证明 preflight 扫描的辨别力（只在临时 Git 仓库里做，不碰生产源码/测试）。
 *
 * 1) 只有 runner/fixture（.mjs）包含扫描词 → clean=true（不误报自己）；
 * 2) 真实 *.spec.ts 里追加未清理标记 → clean=false、reason=marker-found，命中该 spec；
 * 3) git grep 执行错误（status=128）→ clean=false、reason=git-grep-failed；
 * 4) git ls-files 执行错误 → clean=false、reason=git-ls-files-failed；
 * 5) 用例文件扩展名过滤：*.spec.tsx / *.test.ts 会被扫描，.mjs/.json 不会。
 *
 * 用法：node tests/e2e/final-verification/spec-scan.probe.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultGitRunner, scanTrackedSpecsForMarker } from './spec-scan.mjs';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'm2-spec-scan-'));
const results = {};
let failed = false;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}
const expect = (name, condition, detail) => {
  if (!condition) failed = true;
  results[name] = { ok: Boolean(condition), detail };
};

try {
  const repo = path.join(tempRoot, 'repo');
  mkdirSync(path.join(repo, 'tests', 'e2e', 'nested'), { recursive: true });
  writeFileSync(path.join(repo, 'tests', 'e2e', 'nested', 'runner.mjs'), "const marker = 'test.fail(';\n", 'utf8');
  writeFileSync(path.join(repo, 'tests', 'e2e', 'nested', 'sample.spec.ts'), "import { test } from '@playwright/test';\ntest('ok', () => {});\n", 'utf8');
  writeFileSync(path.join(repo, 'tests', 'e2e', 'nested', 'sample.spec.tsx'), "import { test } from '@playwright/test';\ntest('ok tsx', () => {});\n", 'utf8');
  writeFileSync(path.join(repo, 'tests', 'e2e', 'nested', 'sample.test.ts'), "import { test } from 'node:test';\ntest('ok test', () => {});\n", 'utf8');
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=probe', '-c', 'user.email=probe@local', 'add', '-A']);
  git(repo, ['-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-q', '-m', 'fixture']);

  const clean = scanTrackedSpecsForMarker({ cwd: repo });
  expect('runner-text-does-not-self-match', clean.clean === true && clean.scannedFiles === 3, clean);

  writeFileSync(path.join(repo, 'tests', 'e2e', 'nested', 'sample.spec.ts'), "import { test } from '@playwright/test';\ntest.fail(true, 'probe marker');\ntest('ok', () => {});\n", 'utf8');
  const found = scanTrackedSpecsForMarker({ cwd: repo });
  expect('spec-marker-blocks', found.clean === false && found.reason === 'marker-found' && found.matches.some((line) => line.includes('sample.spec.ts')), found);

  // 只让 grep 失败：ls-files 仍走真实 git。
  const grepFailureRunner = (args, options) => {
    if (args[0] === 'grep') return { status: 128, stdout: '', stderr: 'simulated git grep failure' };
    return defaultGitRunner(args, options);
  };
  const grepFailure = scanTrackedSpecsForMarker({ cwd: repo, gitRunner: grepFailureRunner });
  expect('git-grep-error-blocks', grepFailure.clean === false && grepFailure.reason === 'git-grep-failed' && grepFailure.status === 128, grepFailure);

  const listFailure = scanTrackedSpecsForMarker({ cwd: repo, gitRunner: () => ({ status: 128, stdout: '', stderr: 'simulated ls-files failure' }) });
  expect('git-ls-files-error-blocks', listFailure.clean === false && listFailure.reason === 'git-ls-files-failed', listFailure);

  const spawnFailure = scanTrackedSpecsForMarker({ cwd: repo, gitRunner: () => ({ error: new Error('simulated spawn error') }) });
  expect('git-spawn-error-blocks', spawnFailure.clean === false && spawnFailure.reason === 'git-ls-files-error', spawnFailure);

  console.log(JSON.stringify({ tempRoot, results }, null, 2));
  if (failed) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
