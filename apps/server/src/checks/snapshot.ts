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

const MAX_FILES = 500;
const MAX_BYTES = 32 * 1024 * 1024; // Includes existing 11–14 MB product GLBs; still bounded.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB total

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
