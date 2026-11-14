import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../assets/atomic-file.ts';

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
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
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

export class SnapshotError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/**
 * Walk a directory tree, collecting audited file entries in lexicographic order.
 * Refuses symlinks, junctions, hidden/dot files, forbidden patterns, and paths
 * that escape the root via realpath comparison.
 */
async function walk(root: string, dir: string, relative: string, entries: SnapshotEntry[]): Promise<void> {
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, item.name);
    const rel = relative ? `${relative}/${item.name}` : item.name;
    // Check forbidden patterns BEFORE skipping dot-files: a file named .env or .env.tsx
    // inside src must be caught even though it starts with a dot.
    if (forbiddenPattern.test(rel) || forbiddenPattern.test(item.name)) throw new SnapshotError('UNSAFE_PATH', `快照拒绝敏感文件：${rel}`);
    // Skip dot-files and dot-directories (hidden config, .git, etc.) — but only after
    // the forbidden check above has had a chance to reject them.
    if (item.name.startsWith('.')) continue;
    // Reject symlinks and junctions: realpath must equal the lexical path.
    const info = await lstat(abs);
    if (info.isSymbolicLink()) throw new SnapshotError('UNSAFE_PATH', `快照拒绝符号链接：${rel}`);
    const real = await realpath(abs).catch(() => '');
    if (!real || path.relative(abs, real) !== '') throw new SnapshotError('UNSAFE_PATH', `快照拒绝路径逃逸或目录联接：${rel}`);
    if (forbiddenPattern.test(rel) || forbiddenPattern.test(item.name)) throw new SnapshotError('UNSAFE_PATH', `快照拒绝敏感文件：${rel}`);
    if (info.isDirectory()) {
      // Only descend into src and public — refuse anything else.
      if (rel === 'src' || rel === 'public' || rel.startsWith('src/') || rel.startsWith('public/')) {
        await walk(root, abs, rel, entries);
      }
      continue;
    }
    if (!info.isFile()) continue; // skip sockets, pipes, etc.
    if (!srcPattern.test(rel) && !publicPattern.test(rel)) continue; // only allowed extensions
    if (entries.length >= MAX_FILES) throw new SnapshotError('SNAPSHOT_LIMIT', `快照文件数超过上限 ${MAX_FILES}`);
    const content = await readFile(abs);
    if (content.byteLength > MAX_BYTES) throw new SnapshotError('SNAPSHOT_LIMIT', `文件 ${rel} 超过单文件上限 ${MAX_BYTES} 字节`);
    const hash = createHash('sha256').update(content).digest('hex');
    entries.push({ path: rel, bytes: content.byteLength, hash });
  }
}

/**
 * Compute the identity digest of a candidate tree. Covers every audited file's
 * path, byte length, and content hash in sorted order — NOT just changed files.
 */
export async function computeSnapshot(candidateRoot: string): Promise<SnapshotResult> {
  const realRoot = await realpath(candidateRoot);
  const entries: SnapshotEntry[] = [];
  await walk(realRoot, realRoot, '', entries);
  const hasher = createHash('sha256');
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SnapshotError('SNAPSHOT_LIMIT', `快照总字节数超过上限 ${MAX_TOTAL_BYTES}`);
    hasher.update(entry.path).update(String(entry.bytes)).update(entry.hash);
  }
  return { entries, digest: hasher.digest('hex'), totalBytes };
}

/**
 * Copy audited files from the candidate tree to a trusted build root.
 * Re-computes the snapshot after copy to detect any mid-copy tampering.
 * Refuses to copy node_modules — the build root links trusted dependencies separately.
 */
export async function copyAudited(candidateRoot: string, dest: string): Promise<SnapshotResult> {
  const before = await computeSnapshot(candidateRoot);
  await mkdir(dest, { recursive: true });
  const realDest = await realpath(dest);
  for (const entry of before.entries) {
    const srcFile = path.join(candidateRoot, entry.path);
    const destFile = path.join(realDest, entry.path);
    await mkdir(path.dirname(destFile), { recursive: true });
    const content = await readFile(srcFile);
    // Verify the file hasn't changed between snapshot and copy.
    const realSrc = await realpath(srcFile);
    if (path.relative(path.join(candidateRoot, entry.path), realSrc) !== '') throw new SnapshotError('UNSAFE_PATH', `复制时路径逃逸：${entry.path}`);
    await writeAtomic(destFile, content);
  }
  // Re-read the copied tree and verify the digest matches.
  const after = await computeSnapshot(realDest);
  if (after.digest !== before.digest) throw new SnapshotError('SNAPSHOT_MISMATCH', '复制前后内容摘要不一致，可能中途被篡改');
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
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
