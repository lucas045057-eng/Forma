import { createHash } from 'node:crypto';
import { expect } from '@playwright/test';
import { assertMissingCandidateFile, readCandidateFile } from './candidate-files';

export const LEDGER_ROLES = new Set(['source', 'model', 'provenance', 'parts', 'config', 'component', 'runtime', 'tsconfig']);
export const LEDGER_OPERATIONS = new Set(['create', 'modify', 'delete']);

export interface LedgerEntryLike {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  role: string;
  beforeHash: string | null;
  afterHash: string | null;
  bytes: number;
  assetId?: string;
  instanceId?: string;
}

export interface LedgerLike {
  intent?: string;
  instanceId?: string;
  reference?: { action?: string; file?: string; instanceId?: string; anchor?: string } | null;
  entries: LedgerEntryLike[];
}

/**
 * 测试域统一 ledger 矩阵（不导入产品 validateLedger）：
 * - role/operation 精确白名单；source 必须在 src/ 且对应 reference.file；
 * - create ⇒ beforeHash null；modify/delete ⇒ beforeHash 64hex；
 * - delete ⇒ afterHash null + bytes 0，且候选内必须真正没有目录项（含悬空链接）；
 * - 非 delete ⇒ afterHash 64hex + 安全整数 bytes>0，并从候选根安全回读字节做 sha256/长度对账。
 */
export function assertLedgerMatrix(ledger: LedgerLike, candidateRoot: string, referenceFile?: string): void {
  for (const entry of ledger.entries) {
    expect(LEDGER_ROLES.has(entry.role), `未知 ledger role：${entry.role}`).toBe(true);
    expect(LEDGER_OPERATIONS.has(entry.operation), `未知 ledger operation：${entry.operation}`).toBe(true);

    if (entry.operation === 'create') {
      expect(entry.beforeHash, `create 条目 beforeHash 必须为 null：${entry.path}`).toBeNull();
    } else {
      expect(entry.beforeHash, `${entry.operation} 条目 beforeHash 必须是 64hex：${entry.path}`).toMatch(/^[a-f0-9]{64}$/);
    }

    if (entry.operation === 'delete') {
      expect(entry.afterHash, `delete 条目 afterHash 必须为 null：${entry.path}`).toBeNull();
      expect(entry.bytes, `delete 条目 bytes 必须为 0：${entry.path}`).toBe(0);
      assertMissingCandidateFile(candidateRoot, entry.path);
    } else {
      expect(entry.afterHash, `非 delete 条目 afterHash 必须是 64hex：${entry.path}`).toMatch(/^[a-f0-9]{64}$/);
      expect(Number.isSafeInteger(entry.bytes), `条目 bytes 必须是安全整数：${entry.path}`).toBe(true);
      expect(entry.bytes, `非 delete 条目 bytes 必须 >0：${entry.path}`).toBeGreaterThan(0);
      const bytes = readCandidateFile(candidateRoot, entry.path);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.afterHash);
      expect(bytes.length).toBe(entry.bytes);
    }

    if (entry.role === 'source') {
      expect(entry.path.startsWith('src/'), `source 条目必须在 src/ 下：${entry.path}`).toBe(true);
      if (referenceFile !== undefined) expect(entry.path, 'source 条目应对应 reference.file').toBe(referenceFile);
    }
  }
}
