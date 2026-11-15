/**
 * 证据索引（测试侧 helper）：**类型感知**地枚举 `docs/reports/artifacts` 下的条目，供
 * `.data` 专项入口与 `full-regression.mjs` 共用。
 *
 * 为什么需要它：归档证据里可能出现 Git **gitlink（mode 160000）**——某个目录在 index 里被记成
 * "嵌入提交"而不是普通文件。旧的 `git ls-files` + `readFileSync` 枚举会 **EISDIR** 崩掉入口
 * （2026-11-15 的 M4 专项就是这样 exit1/2s、0 用例执行）。这里必须：
 *
 * - 用 `git ls-files --stage -z` 拿到 **mode + OID + path**，按类型分开：
 *   `100644/100755` 普通文件、`120000` 符号链接、`160000` gitlink、其它未知 mode；
 * - 普通文件：`lstat` 确认是**普通文件**再读字节算 SHA256；读失败/不存在记 `missing`，**绝不**静默当成目录过滤掉；
 * - 符号链接/junction：只记录 `linkTarget`（`readlink`），**不跟随**、不读目标内容；
 * - gitlink：记录 index OID + 磁盘上该路径的类型（缺失/目录/文件/链接），**不把 OID 当成载荷内容**；
 *   目录存在时对目录内文件单独产出容器摘要（并跳过 `.git` 指针与外部链接），供"归档容器"使用；
 * - 还原时**拒绝**对 gitlink 走普通 `git checkout`（卡片明确要求：不能拿普通文件恢复套在 gitlink 上）。
 *
 * 本模块只做只读扫描与纯计算，不启动服务、不跑测试、不写仓库文件。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

const git = (root, args) => {
  const result = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 退出码 ${result.status}: ${(result.stderr ?? '').slice(0, 300)}`);
  return `${result.stdout ?? ''}`;
};

/** 读取 index 里的条目：`{ path, mode, oid }`。 */
export function indexEntries(root, pathspec) {
  const raw = git(root, ['ls-files', '--stage', '-z', '--', ...pathspec]);
  const entries = [];
  for (const record of raw.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/.exec(record);
    if (!match) continue;
    entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]), path: match[4] });
  }
  return entries;
}

/** 目录容器摘要：逐文件 SHA256（跳过 `.git` 指针、链接不跟随），返回摘要与文件清单。 */
function directoryDigest(root, absoluteDir) {
  const files = [];
  const skipped = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (entry.isSymbolicLink()) { skipped.push({ path: rel, reason: 'symlink' }); continue; }
      if (entry.isDirectory()) {
        if (entry.name === '.git') { skipped.push({ path: rel, reason: 'nested-git-dir' }); continue; }
        walk(full);
        continue;
      }
      try {
        const bytes = readFileSync(full);
        files.push({ path: rel, bytes: bytes.length, sha256: sha256Hex(bytes) });
      } catch (error) {
        skipped.push({ path: rel, reason: `unreadable: ${String(error).slice(0, 80)}` });
      }
    }
  };
  walk(absoluteDir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { digest: sha256Hex(Buffer.from(files.map((file) => `${file.path}\0${file.sha256}`).join('\n'))), files, skipped };
}

/**
 * 枚举证据路径并分类。返回：
 * - `files`：普通文件（含磁盘字节哈希；读不到的标 `missing: true`）
 * - `links`：符号链接（记录 linkTarget，不跟随）
 * - `gitlinks`：mode 160000（index OID + 磁盘现状 + 可选目录容器摘要）
 * - `unknown`：其它未知 mode
 */
export function scanEvidence(root, evidenceDir) {
  const entries = indexEntries(root, [evidenceDir]);
  const files = [];
  const links = [];
  const gitlinks = [];
  const unknown = [];
  for (const entry of entries) {
    const absolute = join(root, entry.path);
    const rel = entry.path.split(sep).join('/');
    if (entry.mode === '160000') {
      const record = { path: rel, mode: entry.mode, oid: entry.oid, disk: 'missing' };
      try {
        const stats = lstatSync(absolute);
        if (stats.isSymbolicLink()) {
          record.disk = 'link';
          record.linkTarget = readlinkSync(absolute);
        } else if (stats.isDirectory()) {
          record.disk = 'directory';
          const container = directoryDigest(root, absolute);
          record.container = { digest: container.digest, files: container.files.length, skipped: container.skipped };
        } else {
          record.disk = 'file';
          record.fileBytes = stats.size;
        }
      } catch { record.disk = 'missing'; }
      gitlinks.push(record);
      continue;
    }
    if (entry.mode === '120000') {
      const record = { path: rel, mode: entry.mode, oid: entry.oid, linkTarget: null };
      try { record.linkTarget = readlinkSync(absolute); } catch { record.unreadable = true; }
      links.push(record);
      continue;
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      unknown.push({ path: rel, mode: entry.mode, oid: entry.oid });
      continue;
    }
    try {
      const stats = lstatSync(absolute);
      if (!stats.isFile()) { files.push({ path: rel, mode: entry.mode, oid: entry.oid, missing: true, reason: `lstat=${stats.isDirectory() ? 'directory' : 'other'}` }); continue; }
      const bytes = readFileSync(absolute);
      files.push({ path: rel, mode: entry.mode, oid: entry.oid, bytes: bytes.length, sha256: sha256Hex(bytes) });
    } catch (error) {
      files.push({ path: rel, mode: entry.mode, oid: entry.oid, missing: true, reason: String(error).slice(0, 120) });
    }
  }
  const present = files.filter((file) => !file.missing);
  return {
    files, links, gitlinks, unknown,
    summary: {
      indexed: entries.length,
      files: files.length,
      presentFiles: present.length,
      missingFiles: files.length - present.length,
      links: links.length,
      gitlinks: gitlinks.length,
      unknownModes: unknown.length,
      payloadBytes: present.reduce((total, file) => total + (file.bytes ?? 0), 0),
      payloadDigest: sha256Hex(Buffer.from(present.map((file) => `${file.path}\0${file.sha256}`).sort().join('\n'))),
    },
  };
}

/**
 * 还原计划：普通文件才能按 blob 还原；gitlink/符号链接/未知 mode **一律拒绝**并显式列出，
 * 不允许"顺手 checkout"把 gitlink 换成普通文件或被静默丢弃。
 */
export function planRestore(kind, file) {
  if (kind !== 'file') return { restorable: false, reason: `${kind} 不能走普通文件还原` };
  return { restorable: true, path: file.path };
}
