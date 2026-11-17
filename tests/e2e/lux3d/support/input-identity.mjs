/**
 * 输入身份（readonly，类型感知）：只对 Git tracked 的产品/测试输入做字节身份，
 * 用于发现"运行期间被改的未提交字节"与 HEAD 漂移。
 *
 * 来源约定与根 `.worktrees/m4/.data/lux3d-http-contract-check.mjs` 的 trackedManifest/identity 一致：
 * - 只纳入 apps/packages/templates/scripts/tests + package.json + pnpm-lock.yaml + tsconfig.json + playwright 配置；
 * - env/secret/credential/private-key/证书等路径一律排除，**只记录路径名不读取内容**；
 * - 普通文件 lstat 后 sha256；symlink 只 readlink 不跟随；gitlink 只记 mode/OID 不遍历；
 * - 排序稳定，整体指纹 = 逐条 JSON 规范化后拼接的 sha256。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const PRIVATE_PATH = /(^|\/)(?:\.env(?:\.|$)|[^/]*\.(?:pem|key|p12|pfx|crt)|secret|credentials?|private.?key|\.git)(?:\/|$)/i;
const INCLUDED_ROOTS = [
  'apps', 'packages', 'templates', 'scripts', 'tests',
  'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'playwright.lux3d.config.ts',
];

export function trackedManifest(root) {
  const output = execFileSync('git', ['ls-files', '-s', '-z', '--', ...INCLUDED_ROOTS], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  const entries = [];
  const excluded = [];
  for (const record of output.split('\u0000')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const file = record.slice(tab + 1).replaceAll('\\', '/');
    const [mode, oid] = meta;
    if (!file) continue;
    if (PRIVATE_PATH.test(file)) { excluded.push(file); continue; }
    entries.push({ file, mode, oid });
  }
  return { entries, excluded };
}

export function captureInputIdentity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const manifest = trackedManifest(root);
  const entries = [];
  for (const item of manifest.entries) {
    if (item.mode === '160000') { entries.push({ path: item.file, type: 'gitlink', oid: item.oid }); continue; }
    const full = join(root, item.file);
    const info = lstatSync(full);
    if (info.isSymbolicLink() || item.mode === '120000') { entries.push({ path: item.file, type: 'link', target: readlinkSync(full) }); continue; }
    if (!info.isFile()) { entries.push({ path: item.file, type: 'other', mode: item.mode }); continue; }
    const bytes = readFileSync(full);
    entries.push({ path: item.file, type: 'file', mode: item.mode, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = createHash('sha256');
  for (const entry of entries) digest.update(JSON.stringify(entry)).update('\n');
  return { at: new Date().toISOString(), head, entries, excluded: manifest.excluded, digest: digest.digest('hex') };
}

/** 只比较路径级变化；输出可直接写证据。读失败由调用方捕获并转为 identity error。 */
export function diffInputIdentity(before, after) {
  const toMap = (snapshot) => new Map(snapshot.entries.map((entry) => [entry.path, JSON.stringify(entry)]));
  const beforeMap = toMap(before);
  const afterMap = toMap(after);
  const changed = [];
  const added = [];
  const removed = [];
  for (const [path, value] of afterMap) {
    const previous = beforeMap.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== value) changed.push(path);
  }
  for (const path of beforeMap.keys()) if (!afterMap.has(path)) removed.push(path);
  const headDrift = before.head !== after.head;
  changed.sort(); added.sort(); removed.sort();
  return {
    headBefore: before.head, headAfter: after.head, headDrift,
    digestBefore: before.digest, digestAfter: after.digest,
    changed, added, removed,
    excluded: after.excluded,
    stable: !headDrift && !changed.length && !added.length && !removed.length,
  };
}
