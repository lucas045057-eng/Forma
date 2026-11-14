#!/usr/bin/env node
/**
 * 正式验收的收尾核对（只读，不改任何被测物）：
 *
 *   node tests/e2e/m3b/finalize-evidence.mjs [--dir docs/reports/artifacts/M3-B/formal-YYYYMMDD]
 *
 * 做四件事，结果写进 `<dir>/sha256-manifest.json`：
 * 1. 对证据目录里每个文件算 sha256 / 字节数（清单本身除外）；
 * 2. 用 `happy-path.json` 里记录的六份证据 hash 逐份复算落盘字节，证明证据没被事后改写；
 * 3. 逐份复查每个 Playwright JSON 报告（复用 runner-support 的三层状态判据），不信任 manifest 的结论；
 * 4. 复查四个 `disposals-*.json`：优雅关闭、端口不再监听、目录已删、failures 为空。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyPlaywrightReport } from './runner-support.mjs';

const argv = process.argv.slice(2);
const dirArg = argv.indexOf('--dir');
const root = path.resolve(process.cwd(), dirArg >= 0 ? argv[dirArg + 1] : 'docs/reports/artifacts/M3-B/formal-20261115');
const OUT_FILE = path.join(root, 'sha256-manifest.json');

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else if (entry.isFile()) acc.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return acc;
}

const files = walk(root)
  .filter((file) => path.join(root, file) !== OUT_FILE)
  .sort();

const inventory = files.map((file) => {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
});

const problems = [];

/* ---------------------------------------------- 1) 六份检查证据逐份复算 */
const happyPath = path.join(root, 'checks', 'happy-path.json');
const evidence = [];
if (!existsSync(happyPath)) problems.push(`缺少 checks/happy-path.json：${happyPath}`);
else {
  const recorded = JSON.parse(readFileSync(happyPath, 'utf8'));
  for (const ref of recorded.artifacts ?? []) {
    const file = path.join(root, 'checks', 'evidence-01-happy', ref.name);
    if (!existsSync(file)) { problems.push(`缺少落盘证据 ${ref.name}`); continue; }
    const bytes = readFileSync(file);
    const actual = sha256(bytes);
    evidence.push({ name: ref.name, recordedHash: ref.hash, actualHash: actual, recordedBytes: ref.bytes, actualBytes: bytes.length, match: actual === ref.hash && bytes.length === ref.bytes });
    if (actual !== ref.hash) problems.push(`证据 ${ref.name} 复算 sha256 不符：${actual} != ${ref.hash}`);
    if (bytes.length !== ref.bytes) problems.push(`证据 ${ref.name} 字节数不符：${bytes.length} != ${ref.bytes}`);
  }
  if (evidence.length !== 6) problems.push(`六份证据数量不对：${evidence.length}`);
  if (!recorded.run || recorded.run.outcome !== 'passed') problems.push('happy-path.json 里的 run 不是 passed');
  if ((recorded.run?.checks ?? []).some((check) => check.status !== 'passed')) problems.push('happy-path.json 里存在非 passed 检查项');
}

/* ---------------------------------------------- 2) 逐份独立复查 Playwright 报告 */
const reports = [];
const regression = path.join(root, 'regression');
const runDirs = existsSync(regression) ? readdirSync(regression).sort() : [];
for (const runDir of runDirs) {
  const full = path.join(regression, runDir);
  for (const file of readdirSync(full).filter((name) => name.endsWith('-results.json')).sort()) {
    const report = JSON.parse(readFileSync(path.join(full, file), 'utf8'));
    const verdict = verifyPlaywrightReport(report);
    reports.push({ run: runDir, file: `${runDir}/${file}`, ok: verdict.ok, counts: verdict.counts, stats: verdict.stats, problems: verdict.problems.slice(0, 6) });
  }
}

/* ---------------------------------------------- 3) 收尾证据 */
const disposals = [];
const checksDir = path.join(root, 'checks');
if (existsSync(checksDir)) {
  for (const file of readdirSync(checksDir).filter((name) => /^disposals-.*\.json$/.test(name)).sort()) {
    const parsed = JSON.parse(readFileSync(path.join(checksDir, file), 'utf8'));
    const records = parsed.records ?? [];
    const clean = (parsed.failures ?? []).length === 0 && records.every((record) =>
      record.graceful?.code === 0 && record.graceful?.forced === false
      && (record.stillListening ?? []).length === 0 && record.dirRemoved === true && (record.problems ?? []).length === 0);
    disposals.push({ file, records: records.length, failures: parsed.failures ?? [], clean, pids: records.map((record) => record.pid), ports: records.map((record) => record.ports) });
    if (!clean) problems.push(`收尾证据不干净：${file}`);
  }
}

const manifest = {
  generatedAt: new Date().toISOString(),
  dir: path.relative(process.cwd(), root).split(path.sep).join('/'),
  fileCount: inventory.length,
  totalBytes: inventory.reduce((sum, item) => sum + item.bytes, 0),
  evidence,
  reports,
  disposals,
  problems,
  files: inventory,
};
writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ dir: manifest.dir, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes, evidence: evidence.length, reports: reports.length, disposals: disposals.length, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
