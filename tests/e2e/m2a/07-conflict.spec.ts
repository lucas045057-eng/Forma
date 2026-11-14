import { expect, test } from '@playwright/test';
import {
  adoptCandidate, appText, discardCandidate, ensureChecksPassed, getCandidate, getVersion, git, pickSelection, resetMock, restoreTemplate,
  revertVersion, setScript, submitTask, waitForTask,
} from './api';
import { BACKEND_BASE } from './env';
import { startChecks } from '../m3b/checks';
import { writeArtifactFrom } from './artifact';

/**
 * 采用冲突：两个候选都基于同一版本，先采用的会让另一个 409，且主线不留半合并状态。
 * M3-B 后 B 的拒绝分两条路径：startChecks → STALE_CANDIDATE；adopt → CHECKS_NOT_PASSED。
 * （MERGE_CONFLICT 已不再是公共 API 可达行为；原「无半合并/主线不变/pending/可撤回」断言保留。）
 */

test.describe('采用冲突', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('后采用的候选 409 MERGE_CONFLICT，主线不变、无半合并', async ({ page }) => {
    await resetMock();
    const selection = await pickSelection(page);

    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'A' } }],
    ]);
    const first = await waitForTask((await submitTask('把按钮改成马上购买', selection)).body.id);
    expect(first.status, JSON.stringify(first.error)).toBe('done');

    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '立刻下单' } }],
      [{ name: 'finish', args: { summary: 'B' } }],
    ]);
    const versionBefore = (await getVersion()).body.version;
    const second = await waitForTask((await submitTask('把按钮改成立刻下单', selection)).body.id);
    expect(second.status, JSON.stringify(second.error)).toBe('done');

    const a = (await getCandidate(first.candidateId!)).body;
    const b = (await getCandidate(second.candidateId!)).body;
    expect(a.baseVersion, '两个候选不是基于同一版本').toBe(b.baseVersion);
    expect(a.baseVersion).toBe(versionBefore);

    // M3-B：两个候选都要先拿到各自的真实检查绿灯（同一基线版本各跑一次）
    expect((await ensureChecksPassed(a.id)).checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect((await ensureChecksPassed(b.id)).checks.map((check) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);

    expect((await adoptCandidate(a.id)).status, '第一个候选采用失败').toBe(200);
    const afterFirst = appText();
    expect(afterFirst).toContain('马上购买');

    // M3-B：A 采用后 B 的绿灯已属旧基线，两条路径的错误码不同，分开验证：
    // 1) 重新发起检查（startChecks）直接在候选解析阶段比对主版本 → STALE_CANDIDATE；
    // 2) 直接采用（adopt）则把「证明失效」统一归一为 CHECKS_NOT_PASSED（work/service.ts:650-657）。
    const restartChecks = await startChecks(BACKEND_BASE, b.id);
    expect(restartChecks.status, JSON.stringify(restartChecks.body)).toBe(409);
    expect((restartChecks.body as any)?.error?.code).toBe('STALE_CANDIDATE');

    const conflict = await adoptCandidate(b.id);
    expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
    expect((conflict.body as any).error.code).toBe('CHECKS_NOT_PASSED');

    // 主线没有变化，也没有半合并状态
    expect(appText(), '冲突后主线被改动了').toBe(afterFirst);
    expect(git(['status', '--porcelain']).out.trim(), '有未提交的半合并状态').toBe('');
    expect(git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code, '仓库仍处于 merge 状态').not.toBe(0);
    // 冲突的候选仍然可以被撤回
    expect((await getCandidate(b.id)).body.decision).toBe('pending');

    expect((await discardCandidate(b.id)).status).toBe(200);
    expect((await revertVersion()).status).toBe(200);
    expect(appText()).toContain('立即购买');

    writeArtifactFrom('adopt-conflict.json', {
      baseVersion: a.baseVersion,
      first: { id: a.id, decision: (await getCandidate(a.id)).body.decision },
      second: {
        id: b.id,
        restartStatus: restartChecks.status, restartCode: (restartChecks.body as any)?.error?.code,
        adoptStatus: conflict.status, adoptCode: (conflict.body as any).error.code,
        decision: (await getCandidate(b.id)).body.decision,
      },
      mergeConflictReachable: false,
    });
  });
});
