import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../assets/atomic-file.ts';
import { assertPlainPath, readPlainFile } from './paths.ts';

/**
 * Security boundary for check snapshots: audit candidate src + safe public assets,
 * compute an ordered byte-level tree digest that covers unmodified dependency source
 * and deletions, and copy only audited files into a trusted build root.
 *
 * The digest is NOT a diff summary — it hashes every file's relative path, length,
 * and raw bytes in a deterministic order, so any content change (including deletion
 * or substitution of an unchanged dependency file) invalidates the identity.
 */

/** Files allowed in the candidate's src tree. */
const srcPattern = /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tsx|ts|css|json|svg)$/;
/** Safe public assets (images, fonts, models). */
const publicPattern = /^public\/(?:assets\/)?[A-Za-z0-9_./-]+\.(?:glb|gltf|png|jpg|jpeg|webp|svg|json|woff2?|ttf|otf|css)$/;
/** Files explicitly forbidden anywhere in the tree. */
const forbiddenPattern = /(?:^|\/)(?:\.env|\.env\.[^/]+|secret|credential|private.?key|backup|.*\.(?:pem|key|crt|p12|pfx|bak|tmp|old|orig))$/i;

export const SNAPSHOT_MAX_FILES = 500;
export const SNAPSHOT_MAX_FILE_BYTES = 32 * 1024 * 1024; // Includes existing 11–14 MB product GLBs; still bounded.
export const SNAPSHOT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total
const MAX_FILES = SNAPSHOT_MAX_FILES;
const MAX_BYTES = SNAPSHOT_MAX_FILE_BYTES;
const MAX_TOTAL_BYTES = SNAPSHOT_MAX_TOTAL_BYTES;

export interface SnapshotEntry {
  path: string;
  bytes: number;
  hash: string;
}

export interface SnapshotResult {
  entries: SnapshotEntry[];
  digest: string;
  totalBytes: number;
}
export interface SnapshotOptions { toolIdentity?: string; signal?: AbortSignal }

export class SnapshotError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export interface SnapshotBudgetDetail {
  reason: 'file' | 'total' | 'count' | 'path';
  path?: string;
  bytes?: number;
  limit: number;
  used?: number;
  remaining?: number;
}

/** A budget failure is separate from unsafe content; callers map it to a placement error. */
export class SnapshotBudgetError extends SnapshotError {
  readonly detail: SnapshotBudgetDetail;
  constructor(detail: SnapshotBudgetDetail, message: string) { super('PLACEMENT_CHECK_BUDGET_EXCEEDED', message); this.detail = detail; }
}

export interface BudgetEntry { path: string; bytes: number }

/** Pure budget evaluation shared by checks and placement preflight. */
export function evaluateSnapshotBudget(entries: readonly BudgetEntry[]): SnapshotBudgetDetail | undefined {
  if (entries.length > SNAPSHOT_MAX_FILES) return { reason: 'count', limit: SNAPSHOT_MAX_FILES, used: entries.length, remaining: 0 };
  let total = 0;
  for (const entry of entries) {
    if (entry.bytes > SNAPSHOT_MAX_FILE_BYTES) return { reason: 'file', path: entry.path, bytes: entry.bytes, limit: SNAPSHOT_MAX_FILE_BYTES, used: total, remaining: Math.max(0, SNAPSHOT_MAX_TOTAL_BYTES - total) };
    total += entry.bytes;
    if (total > SNAPSHOT_MAX_TOTAL_BYTES) return { reason: 'total', path: entry.path, bytes: entry.bytes, limit: SNAPSHOT_MAX_TOTAL_BYTES, used: total, remaining: 0 };
  }
  return undefined;
}

function budgetAllowed(file: string): boolean { return srcPattern.test(file) || publicPattern.test(file); }

async function collectBudget(root: string): Promise<Map<string, number>> {
  await assertPlainPath(root, () => new SnapshotError('UNSAFE_PATH', '预算检查根目录或其父目录包含链接'));
  const realRoot = await realpath(root);
  const result = new Map<string, number>();
  const visit = async (folder: string, relative: string): Promise<void> => {
    let items;
    try { items = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const item of items) {
      const abs = path.join(folder, item.name), rel = relative ? `${relative}/${item.name}` : item.name;
      if (!relative && item.name !== 'src' && item.name !== 'public') continue;
      if (forbiddenPattern.test(rel) || forbiddenPattern.test(item.name)) throw new SnapshotError('UNSAFE_PATH', `预算检查拒绝敏感文件：${rel}`);
      if (item.name.startsWith('.')) continue;
      const info = await lstat(abs);
      if (info.isSymbolicLink()) throw new SnapshotError('UNSAFE_PATH', `预算检查拒绝符号链接：${rel}`);
      if (path.relative(abs, await realpath(abs).catch(() => '')) !== '') throw new SnapshotError('UNSAFE_PATH', `预算检查拒绝路径逃逸：${rel}`);
      if (info.isDirectory()) { await visit(abs, rel); continue; }
      if (info.isFile() && budgetAllowed(rel)) result.set(rel, info.size);
    }
  };
  await visit(realRoot, '');
  return result;
}

/**
 * Preflight the same src/public file set and byte/file limits used by computeSnapshot.
 * `overrides` are the post-change bytes (undefined deletes). A same-path replacement is
 * counted once by its final size, never added to the old size.
 */
export async function assertSnapshotBudget(root: string, overrides: ReadonlyMap<string, Buffer | undefined> = new Map()): Promise<void> {
  const files = await collectBudget(root);
  for (const [raw, bytes] of overrides) {
    const file = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!file || file.includes('..') || path.isAbsolute(file) || !budgetAllowed(file)) throw new SnapshotError('UNSAFE_PATH', `预算检查拒绝路径：${file}`);
    if (bytes === undefined) files.delete(file);
    else files.set(file, bytes.length);
  }
  const detail = evaluateSnapshotBudget([...files.entries()].map(([file, bytes]) => ({ path: file, bytes })));
  if (!detail) return;
  const label = detail.reason === 'file' ? `单文件 ${detail.path} 为 ${detail.bytes} 字节，超过 ${SNAPSHOT_MAX_FILE_BYTES} 字节；总量剩余 ${detail.remaining ?? 0} 字节` :
    detail.reason === 'count' ? `文件数 ${detail.used} 超过 ${SNAPSHOT_MAX_FILES} 个` :
    `作品 src/public 总量已用 ${detail.used} 字节，超过 ${SNAPSHOT_MAX_TOTAL_BYTES} 字节；剩余 0 字节`;
  throw new SnapshotBudgetError(detail, `${label}；放置前检查预算失败，force 不能绕过检查/安全预算。`);
}

/**
 * Walk a directory tree, collecting audited file entries in lexicographic order.
 * Refuses symlinks, junctions, hidden/dot files, forbidden patterns, and paths
 * that escape the root via realpath comparison.
 */
async function walk(root: string, dir: string, relative: string, entries: SnapshotEntry[], options: SnapshotOptions): Promise<void> {
  options.signal?.throwIfAborted();
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const item of items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    options.signal?.throwIfAborted();
    const abs = path.join(dir, item.name);
    const rel = relative ? `${relative}/${item.name}` : item.name;
    // At the root level, only descend into src and public — skip everything else
    // (node_modules junctions, .env, package.json, vite.config, dist, etc.)
    // without checking their contents or rejecting them.
    if (!relative && item.name !== 'src' && item.name !== 'public') continue;
    // Check forbidden patterns inside src/public: a file named .env or .env.tsx
    // inside src must be caught even though it starts with a dot.
    if (forbiddenPattern.test(rel) || forbiddenPattern.test(item.name)) throw new SnapshotError('UNSAFE_PATH', `快照拒绝敏感文件：${rel}`);
    // Skip dot-files and dot-directories (hidden config, .git, etc.) — but only after
    // the forbidden check above has had a chance to reject them.
    if (item.name.startsWith('.')) continue;
    // Get file info for type checking.
    const info = await lstat(abs);
    // Reject symlinks and junctions: realpath must equal the lexical path.
    if (info.isSymbolicLink()) throw new SnapshotError('UNSAFE_PATH', `快照拒绝符号链接：${rel}`);
    const real = await realpath(abs).catch(() => '');
    if (!real || path.relative(abs, real) !== '') throw new SnapshotError('UNSAFE_PATH', `快照拒绝路径逃逸或目录联接：${rel}`);
    if (info.isDirectory()) {
      // Only descend into src and public — refuse anything else.
      if (rel === 'src' || rel === 'public' || rel.startsWith('src/') || rel.startsWith('public/')) {
        await walk(root, abs, rel, entries, options);
      }
      continue;
    }
    if (!info.isFile()) continue; // skip sockets, pipes, etc.
    if (!srcPattern.test(rel) && !publicPattern.test(rel)) continue; // only allowed extensions
    if (entries.length >= MAX_FILES) throw new SnapshotError('SNAPSHOT_LIMIT', `快照文件数超过上限 ${MAX_FILES}`);
    const content = await readPlainFile(abs, MAX_BYTES,
      () => new SnapshotError('UNSAFE_PATH', `快照拒绝链接或特殊文件：${rel}`),
      () => new SnapshotError('SNAPSHOT_LIMIT', `文件 ${rel} 超过单文件上限 ${MAX_BYTES} 字节`), options.signal);
    const hash = createHash('sha256').update(content).digest('hex');
    entries.push({ path: rel, bytes: content.byteLength, hash });
  }
}

/**
 * Compute the identity digest of a candidate tree. Covers every audited file's
 * path, byte length, and content hash in sorted order — NOT just changed files.
 */
export async function computeSnapshot(candidateRoot: string, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  options.signal?.throwIfAborted();
  await assertPlainPath(candidateRoot, () => new SnapshotError('UNSAFE_PATH', '候选根目录或其父目录包含链接'));
  const realRoot = await realpath(candidateRoot);
  const entries: SnapshotEntry[] = [];
  await walk(realRoot, realRoot, '', entries, options);
  const hasher = createHash('sha256');
  hasher.update(JSON.stringify(['m3b-snapshot-v2', options.toolIdentity ?? ''])).update('\n');
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SnapshotError('SNAPSHOT_LIMIT', `快照总字节数超过上限 ${MAX_TOTAL_BYTES}`);
    hasher.update(JSON.stringify([entry.path, entry.bytes, entry.hash])).update('\n');
  }
  return { entries, digest: hasher.digest('hex'), totalBytes };
}

/**
 * Copy audited files from the candidate tree to a trusted build root.
 * Re-computes the snapshot after copy to detect any mid-copy tampering.
 * Refuses to copy node_modules — the build root links trusted dependencies separately.
 */
export async function copyAudited(candidateRoot: string, dest: string, expectedDigest?: string, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const before = await computeSnapshot(candidateRoot, options);
  if (expectedDigest !== undefined && before.digest !== expectedDigest) throw new SnapshotError('SNAPSHOT_MISMATCH', '候选内容与待检查摘要不一致');
  const denied = () => new SnapshotError('UNSAFE_PATH', '复制路径包含链接或特殊文件');
  await assertPlainPath(dest, denied, true);
  await mkdir(dest, { recursive: true });
  await assertPlainPath(dest, denied);
  if ((await readdir(dest)).length) throw new SnapshotError('UNSAFE_PATH', '检查快照目标必须为空目录');
  const realDest = await realpath(dest);
  for (const entry of before.entries) {
    options.signal?.throwIfAborted();
    const srcFile = path.join(candidateRoot, entry.path);
    const destFile = path.join(realDest, entry.path);
    await mkdir(path.dirname(destFile), { recursive: true });
    const content = await readPlainFile(srcFile, MAX_BYTES, denied,
      () => new SnapshotError('SNAPSHOT_LIMIT', '复制源文件超过上限'), options.signal);
    if (content.length !== entry.bytes || createHash('sha256').update(content).digest('hex') !== entry.hash) {
      throw new SnapshotError('SNAPSHOT_MISMATCH', '复制期间候选文件发生变化');
    }
    await assertPlainPath(destFile, denied, true);
    await writeAtomic(destFile, content, options.signal);
  }
  // Re-read the copied tree and verify the digest matches.
  const after = await computeSnapshot(realDest, options);
  const sourceAfter = await computeSnapshot(candidateRoot, options);
  if (after.digest !== before.digest || sourceAfter.digest !== before.digest) throw new SnapshotError('SNAPSHOT_MISMATCH', '复制前后内容摘要不一致，可能中途被篡改');
  return after;
}

/**
 * Compare two snapshot digests. Returns true if the content identity is identical.
 */
export function digestEqual(a: string, b: string): boolean {
  return a === b;
}

/** Clean up a snapshot directory. */
export async function cleanupSnapshot(dir: string): Promise<void> {
  await assertPlainPath(dir, () => new SnapshotError('UNSAFE_PATH', '不能清理含链接的快照根目录'), true);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
