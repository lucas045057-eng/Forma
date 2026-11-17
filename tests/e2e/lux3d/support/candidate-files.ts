import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';

/**
 * 测试域的候选文件边界校验（不导入产品验证函数）：
 * - 只接受规范的相对 posix 路径，拒绝绝对路径、反斜线、`.`/`..`、控制字符；
 * - resolve + path.relative 必须严格落在 candidateRoot 内；
 * - candidateRoot 与每一级祖先（以及叶，若非 delete 末级缺失）都 lstat 拒符号链接；
 * - delete 只允许末级缺失，祖先仍必须存在且非链接。
 * 返回用于 readFileSync 的绝对路径；delete 末级缺失时由调用方断言不存在。
 */
export function candidateFilePath(candidateRoot: string, entryPath: string, allowMissingLeaf = false): string {
  expect(typeof entryPath, 'ledger 条目 path 必须是字符串').toBe('string');
  expect(entryPath, 'ledger path 不能为空').not.toBe('');
  expect(entryPath, `ledger path 不能是绝对路径：${entryPath}`).not.toMatch(/^(?:[A-Za-z]:|[\\/])/);
  expect(entryPath, `ledger path 不能含反斜线/控制字符：${entryPath}`).not.toMatch(/[\\\u0000-\u001f]/);
  const segments = entryPath.split('/');
  expect(segments, `ledger path 不能含 . 或 ..：${entryPath}`).not.toContain('.');
  expect(segments, `ledger path 不能含 . 或 ..：${entryPath}`).not.toContain('..');

  const root = path.resolve(candidateRoot);
  const absolute = path.resolve(root, entryPath);
  const relative = path.relative(root, absolute);
  expect(relative, `ledger path 越出候选根：${entryPath}`).not.toBe('');
  expect(relative.startsWith('..') || path.isAbsolute(relative), `ledger path 越出候选根：${entryPath}`).toBe(false);
  expect(realpathSync(root).toLowerCase(), '候选根 realpath 必须是本身').toBe(root.toLowerCase());
  const rootInfo = lstatSync(root);
  expect(rootInfo.isSymbolicLink(), '候选根不能是链接').toBe(false);
  expect(rootInfo.isDirectory(), '候选根必须是目录').toBe(true);

  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const isLeaf = index === segments.length - 1;
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && isLeaf && (error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
      throw error;
    }
    expect(info.isSymbolicLink(), `候选路径含符号链接：${entryPath}`).toBe(false);
    if (!isLeaf) expect(info.isDirectory(), `候选路径祖先不是目录：${entryPath}`).toBe(true);
    else expect(info.isFile(), `候选条目不是普通文件：${entryPath}`).toBe(true);
  }
  return absolute;
}

/** delete 条目必须真正没有目录项；悬空链接/文件/目录都视为未删除。 */
export function assertMissingCandidateFile(candidateRoot: string, entryPath: string): void {
  const absolute = candidateFilePath(candidateRoot, entryPath, true);
  try {
    lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`删除条目仍有目录项（含悬空链接）：${entryPath}`);
}

export function readCandidateFile(candidateRoot: string, entryPath: string): Buffer {
  return readFileSync(candidateFilePath(candidateRoot, entryPath, false));
}
