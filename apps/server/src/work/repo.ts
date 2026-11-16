import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FileDiff } from '@spatial/shared';
import { assertManagedTree, verifyCandidateLedger, type AssetLedger, type LedgerChange } from './asset-ledger.ts';

export class WorkError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
const idPattern = /^[a-z0-9]{6,32}$/;
const modelWritable = /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tsx|ts|css|json|svg)$/;
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

/** Read raw bytes (binary assets) without git text decoding or line-ending filters. */
function gitBytes(args: string[], cwd: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    execFile('git', [...identity, ...args], {
      cwd, env: { ...clean, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 128 * 1024 * 1024, windowsHide: true, encoding: 'buffer',
    }, (error, stdout, stderr) => {
      if (error && typeof (error as { code?: unknown }).code !== 'number') return reject(error);
      resolve({ code: error ? (error as unknown as { code: number }).code : 0, stdout: stdout as unknown as Buffer, stderr: String(stderr) });
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
  private closing = false;
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return operation();
    if (this.closing) return Promise.reject(new WorkError('SERVICE_CLOSING', '后端正在关闭，未接受作品操作', 503));
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
    for (const name of ['init', 'head', 'snapshot', 'isCommit', 'fileAt', 'fileChangedSince', 'createCandidate', 'commitCandidate', 'pendingDiff', 'candidateCommit', 'diff', 'adopt', 'revert', 'removeCandidate', 'candidateExists']) {
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
  /** Review N4: stop accepting work-tree operations and wait until every queued one has finished. */
  async drain() { this.closing = true; await this.operations; }

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
      // A merge or revert interrupted by a crash must not leave the work half-applied. Aborting
      // rewrites work files, so refuse first if the work tree holds links (review N1): the conflict
      // state is kept for a human to resolve instead of being written through a junction.
      await this.assertNoLinks();
      await this.main(['merge', '--abort'], true);
      await this.main(['revert', '--abort'], true);
      await this.main(['worktree', 'prune'], true);
    }
    await this.auditTree();
  }
  private permitted(file: string) {
    if (file.split('/').some(part => /^(?:\.|.*(?:secret|credential|private.?key|backup))/i.test(part) || /\.(?:pem|key|crt|p12|pfx|bak|tmp|old|orig)$/i.test(part))) return false;
    return /^(?:src|public)\/[a-z0-9_./-]+$/i.test(file) || ['index.html', 'package.json', 'vite.config.ts', 'tsconfig.json'].includes(file);
  }
  /**
   * Audit a commit's whole tree (review F3): a pre-existing repository may already track files the
   * allow-list forbids (keys, backups, links, submodules). Run unconditionally — not only when there
   * is something new to stage — at startup, before a snapshot version is handed out and before a
   * candidate is checked out from it.
   */
  async auditTree(revision = 'HEAD') {
    const listing = (await this.main(['ls-tree', '-r', '-z', '--full-tree', revision])).stdout.split('\0').filter(Boolean);
    const bad: string[] = [];
    for (const record of listing) {
      // "<mode> <type> <object>\t<path>": the path is everything after the FIRST tab (review N2).
      const tab = record.indexOf('\t');
      const meta = tab < 0 ? '' : record.slice(0, tab), file = tab < 0 ? record : record.slice(tab + 1);
      const mode = /^(\d{6}) (blob|tree|commit) [0-9a-f]{40,64}$/.exec(meta)?.[1];
      if (!mode || mode === '120000' || mode === '160000' || /[\u0000-\u001f\u007f]/.test(file) || !this.permitted(file)) bad.push(JSON.stringify(file));
    }
    if (bad.length) throw new WorkError('UNSAFE_TRACKED_FILE', `作品版本库跟踪了不允许的文件或链接（${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' 等' : ''}），请人工迁移到干净的版本库`, 409);
    await assertManagedTree(this, revision);
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
  /**
   * Links (symlinks, junctions) inside the work's writable areas are refused outright: git writes
   * through an existing directory link, so merging a candidate that adds `src/link/x.ts` over a
   * work tree where `src/link` is a junction would place the file outside the work. Compared by
   * real path as well, because the link type reported by lstat differs across link kinds.
   */
  async assertNoLinks(root = this.workRoot) {
    const base = await realpath(root);
    const refuse = (file: string) => new WorkError('UNSAFE_WORK_TREE', `作品目录里的 ${file} 是链接（符号链接或目录联接），出于安全拒绝操作；请删除该链接后重试`, 409);
    /** A path is safe when it is not a link and its real path is exactly where it lexically sits. */
    const isLink = async (absolute: string, file: string) => {
      const info = await lstat(absolute);
      const real = await realpath(absolute).catch(() => '');
      return { link: info.isSymbolicLink() || !real || path.relative(path.join(base, file), real) !== '', info };
    };
    const walk = async (folder: string, relative: string): Promise<void> => {
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const absolute = path.join(folder, entry.name), file = `${relative}/${entry.name}`;
        const { link, info } = await isLink(absolute, file);
        if (link) throw refuse(file);
        if (info.isDirectory()) await walk(absolute, file);
      }
    };
    for (const area of ['src', 'public']) {
      // The area roots themselves too: a junctioned src/ redirects every write below it (review F1).
      const absolute = path.join(base, area);
      let checked;
      try { checked = await isLink(absolute, area); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (checked.link || !checked.info.isDirectory()) throw refuse(area);
      await walk(absolute, area);
    }
  }
  async head() { return (await this.main(['rev-parse', 'HEAD'])).stdout.trim(); }
  /** Commit whatever is on disk (3D write-back, manual edits) so HEAD always equals the files. */
  async snapshot(message = '自动快照：作品目录的未提交改动') {
    await this.assertNoLinks();
    if ((await this.main(['status', '--porcelain'])).stdout.trim()) {
      await this.stage(this.workRoot, args => this.main(args));
      if ((await this.main(['diff', '--cached', '--name-only'])).stdout.trim()) await this.main(['commit', '-q', '-m', message]);
    }
    await this.auditTree();
    return this.head();
  }
  async isCommit(version: string) {
    return /^[0-9a-f]{7,64}$/.test(version) && (await this.main(['cat-file', '-e', `${version}^{commit}`], true)).code === 0;
  }
  async fileAt(version: string, file: string): Promise<string | undefined> {
    const result = await this.main(['show', `${version}:${file}`], true);
    return result.code === 0 ? result.stdout : undefined;
  }
  async fileBufferAt(version:string,file:string):Promise<Buffer|undefined>{
    const result=await gitBytes(['--git-dir',this.gitDir,'--work-tree',this.workRoot,'show',`${version}:${file}`],this.workRoot);
    return result.code===0?result.stdout:undefined;
  }
  async candidateBufferAt(id:string,file:string):Promise<Buffer|undefined>{
    try{return await readFile(path.join(this.candidatePath(id),file));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
  }
  async listTree(revision:string):Promise<string[]>{
    return (await this.main(['ls-tree','-r','-z','--name-only',revision])).stdout.split('\0').filter(Boolean);
  }
  async diffNameStatus(id:string,base:string):Promise<LedgerChange[]>{
    const output=(await this.inCandidate(id,['diff','--name-status','-z',base,'--'])).stdout;
    const parts=output.split('\0');const changes:LedgerChange[]=[];
    for(let index=0;index<parts.length;){
      const status=parts[index++];if(!status)continue;
      if(status.startsWith('R')||status.startsWith('C')){const from=parts[index++],to=parts[index++];if(from&&to)changes.push({status,from,path:to});}
      else{const file=parts[index++];if(file)changes.push({status,path:file});}
    }
    return changes;
  }
  private baseFile(id:string){return path.join(this.candidatesDir,`.base-${id}`);}
  async candidateBase(id:string):Promise<string>{
    if(!idPattern.test(id))throw new WorkError('NOT_FOUND','候选编号无效',404);
    try{return (await readFile(this.baseFile(id),'utf8')).trim();}
    catch{throw new WorkError('NOT_FOUND','候选缺少基线版本',404);}
  }
  async transitionMatches(before: string, kind: 'adopt' | 'revert', id: string, target?: string) {
    const text = (await this.main(['log', '-1', '--format=%P%n%B'])).stdout;
    const [parents, ...body] = text.split('\n');
    if (parents.split(' ')[0] !== before) return false;
    if (kind === 'adopt') {
      const candidate = (await this.main(['rev-parse', this.branch(id)], true)).stdout.trim();
      return parents.split(' ')[1] === candidate && body.join('\n').trim() === `采用候选版本 ${id}`;
    }
    return !!target && body.join('\n').includes(target);
  }
  async fileChangedSince(version: string, file: string) {
    return (await this.main(['diff', '--quiet', version, 'HEAD', '--', file], true)).code !== 0;
  }

  async createCandidate(id: string, base: string) {
    const directory = this.candidatePath(id);
    await this.assertNoLinks();
    await this.auditTree(base);
    if ((await this.main(['show-ref', '--verify', '--quiet', `refs/heads/${this.branch(id)}`], true)).code === 0) throw new WorkError('CANDIDATE_EXISTS', '候选分支已经存在', 409);
    try {
      await this.main(['worktree', 'add', '-q', '-b', this.branch(id), directory, base]);
      await mkdir(this.candidatesDir,{recursive:true});
      await writeFile(this.baseFile(id),base,'utf8');
      await this.linkDependencies(directory); return directory;
    } catch (error) { await this.removeCandidate(id); throw error; }
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
  /**
   * Read the complete unpublished diff without committing it. Intent-to-add makes new files
   * visible to git diff; the digest covers every changed file's exact bytes, including deletion.
   */
  async pendingDiff(id: string, base: string, ledger?: AssetLedger) {
    const directory = this.candidatePath(id);
    await this.assertNoLinks(directory);
    await this.auditTree(base);
    const untracked = (await this.inCandidate(id, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
    if (untracked.length) await this.inCandidate(id, ['add', '-N', '--', ...untracked]);
    const changedFiles = (await this.inCandidate(id, ['diff', '--name-only', '-z', base, '--'])).stdout.split('\0').filter(Boolean);
    await verifyCandidateLedger(this, id, base, ledger);
    const diff: FileDiff[] = [];
    const hash = createHash('sha256').update(base);
    for (const file of changedFiles) {
      const patch = (await this.inCandidate(id, ['diff', '--no-color', '--unified=3', base, '--', file])).stdout;
      diff.push({ path: file, patch: patch.length > 60_000 ? `${patch.slice(0, 60_000)}\n…（差异过长，已截断）` : patch });
      let content: Buffer | undefined;
      try { content = await readFile(path.join(directory, file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      hash.update(file).update(Buffer.from(String(content?.byteLength ?? -1)));
      if (content) hash.update(content);
    }
    // Full, untruncated patches participate in the identity even though the public diff is capped.
    for (const file of changedFiles) hash.update(await this.inCandidate(id, ['diff', '--no-color', '--unified=3', base, '--', file]).then(result => result.stdout));
    return { changedFiles, diff, contentDigest: hash.digest('hex') };
  }
  async candidateCommit(id: string, options: { clean?: boolean; expectedCommit?: string } = {}) {
    const result = await this.main(['rev-parse', '--verify', this.branch(id)], true);
    if (result.code !== 0) throw new WorkError('NOT_FOUND', '私有草稿分支不存在', 404);
    const commit = result.stdout.trim();
    if (options.expectedCommit !== undefined && commit !== options.expectedCommit) {
      throw new WorkError('STALE_CANDIDATE', '候选分支不再对应待检查的提交', 409);
    }
    if (options.clean) {
      const directory = this.candidatePath(id);
      await this.assertNoLinks(directory);
      const common = (await this.inCandidate(id, ['rev-parse', '--git-common-dir'])).stdout.trim();
      if (path.relative(await realpath(this.gitDir), await realpath(path.resolve(directory, common))) !== '') {
        throw new WorkError('STALE_CANDIDATE', '候选工作树不属于本作品版本库', 409);
      }
      const head = (await this.inCandidate(id, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
      if (head !== commit) throw new WorkError('STALE_CANDIDATE', '候选工作树HEAD与分支提交不一致', 409);
      await this.auditTree(commit);
      const status = await this.inCandidate(id, ['-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=all']);
      const ignored = await this.inCandidate(id, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'src', 'public']);
      if (status.stdout.length || ignored.stdout.length) {
        throw new WorkError('STALE_CANDIDATE', '候选包含未提交或被忽略的输入，不能使用旧提交检查', 409);
      }
    }
    return commit;
  }
  /** Stage and commit the agent's edits. Returns the changed paths (empty when nothing changed). */
  async commitCandidate(id: string, message: string, ledger?: AssetLedger) {
    await this.assertNoLinks(this.candidatePath(id));
    await this.stage(this.candidatePath(id), args => this.inCandidate(id, args));
    const changed = (await this.inCandidate(id, ['diff', '--cached', '--name-only'])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
    if (changed.length) {
      const base = ledger?.baseVersion ?? await this.candidateBase(id);
      await verifyCandidateLedger(this, id, base, ledger);
      await this.inCandidate(id, ['commit', '-q', '-m', message]);
    }
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
    await this.assertNoLinks();
    await this.snapshot();
    const merge = await this.main(['merge', '--no-ff', '-q', '-m', `采用候选版本 ${id}`, this.branch(id)], true);
    if (merge.code !== 0) {
      await this.main(['merge', '--abort'], true);
      throw new WorkError('MERGE_CONFLICT', '候选版本与当前版本的改动冲突，无法自动合并；请撤回该候选后重新生成', 409);
    }
    return this.head();
  }
  async revert(mergeCommit: string) {
    await this.assertNoLinks();
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
    await rm(this.baseFile(id), { force: true }).catch(() => {});
  }
  async candidateExists(id: string) {
    try { return (await lstat(path.join(this.candidatePath(id), '.git'))).isFile(); } catch { return false; }
  }
}
