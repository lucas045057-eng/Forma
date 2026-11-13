import { spawnSync } from 'node:child_process';

/**
 * 最终验证入口的 preflight 扫描：只在**被 git 跟踪的测试用例文件**里查找固定字符串。
 *
 * 背景：上一版入口对整个 `tests/e2e` 做 git grep，扫描词同时出现在入口脚本自身，
 * 导致 runner 把自己当成“未清理的 test.fail 标记”而 preflight 阻断。
 * 这里把范围限定为 `*.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx`，runner/fixture/证据
 * （.mjs、.json 等）不参与；匹配用 `git grep -F -e <固定字符串>`，不做字符串拆分。
 *
 * `git grep` 退出码约定：0=找到、1=未找到、其他=错误。ls-files / grep 的执行错误
 * 一律返回 clean=false，调用方必须阻断，不能当成“没有标记”。
 */

export const MARKER = 'test.fail(';

export function defaultGitRunner(args, options) {
  return spawnSync('git', args, { encoding: 'utf8', windowsHide: true, ...options });
}

export function listTrackedSpecFiles({ cwd, gitRunner = defaultGitRunner }) {
  const result = gitRunner(['ls-files', '-z', '--', 'tests/e2e'], { cwd });
  if (result.error) return { ok: false, reason: 'git-ls-files-error', detail: String(result.error) };
  if (result.status !== 0) return { ok: false, reason: 'git-ls-files-failed', status: result.status, stderr: String(result.stderr ?? '').trim().slice(0, 500) };
  const files = String(result.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .filter((file) => /\.(?:spec|test)\.(?:ts|tsx)$/.test(file));
  return { ok: true, files };
}

export function scanTrackedSpecsForMarker({ cwd, marker = MARKER, gitRunner = defaultGitRunner }) {
  const listed = listTrackedSpecFiles({ cwd, gitRunner });
  if (!listed.ok) return { clean: false, reason: listed.reason, detail: listed, scannedFiles: 0 };
  if (listed.files.length === 0) return { clean: false, reason: 'no-tracked-spec-files', scannedFiles: 0 };

  const grep = gitRunner(['grep', '-n', '-F', '-e', marker, '--', ...listed.files], { cwd });
  if (grep.error) return { clean: false, reason: 'git-grep-error', detail: String(grep.error), scannedFiles: listed.files.length };
  if (grep.status === 1) return { clean: true, reason: 'no-marker', scannedFiles: listed.files.length, matches: [] };
  if (grep.status !== 0) {
    return {
      clean: false, reason: 'git-grep-failed', status: grep.status,
      stderr: String(grep.stderr ?? '').trim().slice(0, 500), scannedFiles: listed.files.length,
    };
  }
  const matches = String(grep.stdout ?? '').split('\n').filter(Boolean);
  return { clean: false, reason: 'marker-found', scannedFiles: listed.files.length, matches };
}
