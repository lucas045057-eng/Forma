import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, mkdir, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff } from '@spatial/shared';

export class WorkError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
const idPattern = /^[a-z0-9]{6,32}$/;
const identity = ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Studio', '-c', 'user.email=studio@localhost', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false'];

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    execFile('git', [...identity, ...args], { cwd, env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== 'number') return reject(error);
        resolve({ code: error ? (error as unknown as { code: number }).code : 0, stdout, stderr });
      });
  });
}

/**
 * The work's own version history, kept apart from the monorepo's git: the repository lives in
 * the data directory and uses the work directory as its work tree. Candidates are worktrees.
 */
export class WorkRepo {
  readonly workRoot: string;
  readonly gitDir: string;
  readonly candidatesDir: string;
  private operations: Promise<unknown> = Promise.resolve();
  private scope = new AsyncLocalStorage<boolean>();
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return operation();
    const result = this.operations.then(() => this.scope.run(true, operation));
    this.operations = result.catch(() => {});
    return result;
  }
  constructor(options: { workRoot: string; dataDirectory: string }) {
    this.workRoot = path.resolve(options.workRoot);
    this.gitDir = path.join(path.resolve(options.dataDirectory), 'work.git');
    this.candidatesDir = path.join(path.resolve(options.dataDirectory), 'candidates');
    // Bind every repository operation to the same reentrant queue, including nested snapshot calls.
    const methods = this as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['init', 'head', 'snapshot', 'isCommit', 'fileAt', 'fileChangedSince', 'createCandidate', 'commitCandidate', 'diff', 'adopt', 'revert', 'removeCandidate', 'candidateExists']) {
      const operation = methods[name].bind(this);
      methods[name] = (...args) => this.exclusive(() => operation(...args));
    }
  }
  private async main(args: string[], allowFailure = false) {
    const result = await git(['--git-dir', this.gitDir, '--work-tree', this.workRoot, ...args], this.workRoot);
    if (result.code !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
  private async inCandidate(id: string, args: string[], allowFailure = false) {
    const result = await git(args, this.candidatePath(id));
    if (result.code !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
  candidatePath(id: string) {
    if (!idPattern.test(id)) throw new WorkError('INVALID_ID', '候选编号无效');
    return path.join(this.candidatesDir, id);
  }
  branch(id: string) { this.candidatePath(id); return `candidate/${id}`; }

  async init() {
    this.workRoot.length; // The work root must already exist; realpath throws otherwise.
    await realpath(this.workRoot);
    await mkdir(this.candidatesDir, { recursive: true });
    const exists = (await git(['--git-dir', this.gitDir, 'rev-parse', '--git-dir'], this.workRoot)).code === 0;
    if (!exists) {
      await mkdir(this.gitDir, { recursive: true });
      await this.main(['init', '-q', '-b', 'main']);
      await this.main(['config', 'core.worktree', this.workRoot]);
      await mkdir(path.join(this.gitDir, 'info'), { recursive: true });
      await writeFile(path.join(this.gitDir, 'info', 'exclude'), 'node_modules/\ndist/\n.vite/\n*.tmp\n');
      await this.stage(this.workRoot, args => this.main(args));
      await this.main(['commit', '-q', '--allow-empty', '-m', '初始版本']);
    } else {
      const configured = (await this.main(['config', 'core.worktree'], true)).stdout.trim();
      if (configured && path.resolve(configured) !== this.workRoot) {
        throw new Error(`作品版本库 ${this.gitDir} 属于另一个作品目录（${configured}），请为当前 WORK_ROOT 使用独立的数据目录`);
      }
      // A merge or revert interrupted by a crash must not leave the work half-applied.
      await this.main(['merge', '--abort'], true);
      await this.main(['revert', '--abort'], true);
      await this.main(['worktree', 'prune'], true);
    }
  }
  private permitted(file: string) {
    if (file.split('/').some(part => /^(?:\.|.*(?:secret|credential|private.?key|backup))/i.test(part) || /\.(?:pem|key|crt|p12|pfx|bak|tmp|old|orig)$/i.test(part))) return false;
    return /^(?:src|public)\/[a-z0-9_./-]+$/i.test(file) || ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json'].includes(file);
  }
  private async stage(root: string, command: (args: string[]) => Promise<{ stdout: string }>) {
    const tracked = (await command(['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    if (tracked.some(file => !this.permitted(file))) throw new WorkError('UNSAFE_TRACKED_FILE', '作品版本库含不允许的文件，请人工迁移到干净版本库');
    await command(['add', '-u']);
    const walk = async (folder: string, prefix = '') => {
      for (const item of await readdir(folder, { withFileTypes: true })) {
        const file = prefix + item.name;
        if (item.isSymbolicLink()) { if (tracked.includes(file)) throw new WorkError('UNSAFE_TRACKED_FILE', '版本库不能跟踪符号链接'); continue; }
        if (item.isDirectory() && (file === 'src' || file === 'public' || /^(src|public)\//.test(file)) && !item.name.startsWith('.')) await walk(path.join(folder, item.name), `${file}/`);
        else if (item.isFile() && this.permitted(file)) await command(['add', '--', file]);
      }
    };
    await walk(root);
    const staged = (await command(['ls-files', '--stage', '-z'])).stdout.split('\0').filter(Boolean);
    if (staged.some(entry => entry.startsWith('120000 ') || !this.permitted(entry.slice(entry.indexOf('\t') + 1)))) throw new WorkError('UNSAFE_INDEX', '暂存区含不允许的路径或链接');
  }
  async head() { return (await this.main(['rev-parse', 'HEAD'])).stdout.trim(); }
  /** Commit whatever is on disk (3D write-back, manual edits) so HEAD always equals the files. */
  async snapshot(message = '自动快照：作品目录的未提交改动') {
    if ((await this.main(['status', '--porcelain'])).stdout.trim()) {
      await this.stage(this.workRoot, args => this.main(args));
      if ((await this.main(['diff', '--cached', '--name-only'])).stdout.trim()) await this.main(['commit', '-q', '-m', message]);
    }
    return this.head();
  }
  async isCommit(version: string) {
    return /^[0-9a-f]{7,64}$/.test(version) && (await this.main(['cat-file', '-e', `${version}^{commit}`], true)).code === 0;
  }
  async fileAt(version: string, file: string): Promise<string | undefined> {
    const result = await this.main(['show', `${version}:${file}`], true);
    return result.code === 0 ? result.stdout : undefined;
  }
  async fileChangedSince(version: string, file: string) {
    return (await this.main(['diff', '--quiet', version, 'HEAD', '--', file], true)).code !== 0;
  }

  async createCandidate(id: string, base: string) {
    const directory = this.candidatePath(id);
    await this.main(['worktree', 'add', '-q', '-b', this.branch(id), directory, base]);
    try { await this.linkDependencies(directory); return directory; }
    catch (error) { await this.removeCandidate(id); throw error; }
  }
  /** pnpm's package links are relative, so link every package to its real location instead of the folder. */
  private async linkDependencies(directory: string) {
    const link = async (from: string, to: string) => {
      await mkdir(to, { recursive: true });
      for (const entry of await readdir(from)) {
        if (entry.startsWith('.')) continue;
        if (entry.startsWith('@')) await link(path.join(from, entry), path.join(to, entry));
        else await symlink(await realpath(path.join(from, entry)), path.join(to, entry), 'junction');
      }
    };
    const modules = path.join(this.workRoot, 'node_modules');
    try { await lstat(modules); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await link(modules, path.join(directory, 'node_modules'));
  }
  private async unlinkDependencies(directory: string) {
    const unlink = async (folder: string) => {
      let entries: string[];
      try { entries = await readdir(folder); } catch { return; }
      for (const entry of entries) {
        const target = path.join(folder, entry);
        const info = await lstat(target);
        // Remove the link itself; never recurse through it into the real package.
        if (info.isSymbolicLink()) await rmdir(target).catch(() => rm(target, { force: true }));
        else if (info.isDirectory()) await unlink(target);
      }
    };
    await unlink(path.join(directory, 'node_modules'));
    await rm(path.join(directory, 'node_modules'), { recursive: true, force: true });
  }
  /** Stage and commit the agent's edits. Returns the changed paths (empty when nothing changed). */
  async commitCandidate(id: string, message: string) {
    await this.stage(this.candidatePath(id), args => this.inCandidate(id, args));
    const changed = (await this.inCandidate(id, ['diff', '--cached', '--name-only'])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
    if (changed.length) await this.inCandidate(id, ['commit', '-q', '-m', message]);
    return changed;
  }
  async diff(id: string, base: string): Promise<FileDiff[]> {
    const range = [base, this.branch(id)];
    const names = (await this.main(['diff', '--name-only', ...range])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const result: FileDiff[] = [];
    for (const file of names) {
      const patch = (await this.main(['diff', '--no-color', '--unified=3', ...range, '--', file])).stdout;
      result.push({ path: file, patch: patch.length > 60_000 ? `${patch.slice(0, 60_000)}\n…（差异过长，已截断）` : patch });
    }
    return result;
  }
  /** Merge the candidate into main. Returns the merge commit; a conflict leaves main untouched. */
  async adopt(id: string) {
    await this.snapshot();
    const merge = await this.main(['merge', '--no-ff', '-q', '-m', `采用候选版本 ${id}`, this.branch(id)], true);
    if (merge.code !== 0) {
      await this.main(['merge', '--abort'], true);
      throw new WorkError('MERGE_CONFLICT', '候选版本与当前版本的改动冲突，无法自动合并；请撤回该候选后重新生成', 409);
    }
    return this.head();
  }
  async revert(mergeCommit: string) {
    await this.snapshot();
    const result = await this.main(['revert', '-m', '1', '--no-edit', mergeCommit], true);
    if (result.code !== 0) {
      await this.main(['revert', '--abort'], true);
      throw new WorkError('REVERT_CONFLICT', '之后的改动与这次采用有冲突，无法自动回退', 409);
    }
    return this.head();
  }
  async removeCandidate(id: string) {
    const directory = this.candidatePath(id);
    await this.unlinkDependencies(directory);
    await this.main(['worktree', 'remove', '--force', directory], true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    await this.main(['worktree', 'prune'], true);
    await this.main(['branch', '-D', this.branch(id)], true);
  }
  async candidateExists(id: string) {
    try { return (await lstat(path.join(this.candidatePath(id), '.git'))).isFile(); } catch { return false; }
  }
}
