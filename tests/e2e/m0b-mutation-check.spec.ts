import { expect, test } from '@playwright/test';
import { anchorExpectations, checkCompleteness, checkDeterministicAnchors } from './checks';
import { openStudio, setPicking, writeArtifact } from './lib';

/**
 * 变异验证：证明「用例 8（AST 确定性锚点）」和「用例 9（应标记节点完整性）」
 * 不是空转的判定。
 *
 * 变异施加在**插件产物**上（渲染树里的 data-src 属性），效果与「插件把同名标签
 * 标错 / 漏标某类元素」完全相同：bridge 上报的 src 直接来自这些属性，所以从
 * Studio 一侧看是不可区分的。
 *
 * 为什么不用改插件源码再重启开发服务器：本轮 CodeBuddy 正在同一工作树里跑 M0-A，
 * 5173/5174 是它的 `pnpm dev`；插件改动需要 Vite 重启配置依赖，我没有端口可用，
 * 也不该打断它的服务。
 *
 * M1-A 起作品页有条件渲染，所以变异都在 3D 成功态（ready）下做。
 */

test.describe('变异验证（R3：证明判定条件有效）', () => {
  test('变异 A 同名标签错标：所有 span 统一指向同一个错误位置，必须被抓到', async ({ page }) => {
    const frame = await openStudio(page);
    await setPicking(page, true);

    // 基线：干净状态下判定必须全部通过
    const clean = await checkDeterministicAnchors(page, frame, anchorExpectations('ready'));
    expect(clean.oracleFailures).toEqual([]);
    expect(clean.failures).toEqual([]);

    // 施加变异：渲染树里所有 span 的 data-src 都改成另一个 span 的源码位置
    // （33:82 是 AST 里真实存在的 span，但不是任何一个锚点的期望值）
    const mutatedCount = await frame.evaluate(() => {
      let count = 0;
      for (const element of Array.from(document.querySelectorAll('span[data-src]'))) {
        element.setAttribute('data-src', 'src/App.tsx:33:82');
        count += 1;
      }
      return count;
    });
    expect(mutatedCount, '页面里应当有至少 3 个 span').toBeGreaterThanOrEqual(3);

    const mutated = await checkDeterministicAnchors(page, frame, anchorExpectations('ready'));

    // 3D 成功态的两个 span 锚点（16:45、24:40）都应该对不上（全被改成 33:82）
    const spanFailures = mutated.failures.filter((line) => line.includes('<span>'));
    const spanAnchors = mutated.records.filter((record) => record.tag === 'span');
    expect(spanAnchors.length, '3D 成功态应有 span 锚点').toBeGreaterThanOrEqual(2);
    expect(spanFailures.length, `判定没有抓到同名标签错标：${JSON.stringify(mutated.failures)}`).toBe(spanAnchors.length);
    expect(spanFailures.join('\n')).toContain('src/App.tsx:33:82');

    // 旧判定的盲点：以 data-src 为期望值时，这些错标全部“通过”
    const legacyPasses = mutated.records.filter((record) => typeof record.domDataSrc === 'string' && record.selectionSrc === record.domDataSrc);
    expect(legacyPasses.length, '预期以 data-src 为准的旧判定会放过全部错标').toBe(mutated.records.length);

    writeArtifact('case-mutation-same-tag.json', {
      mutation: '所有 span 的 data-src 统一改成 src/App.tsx:33:82（等价于插件同名标签错标）',
      renderState: 'ready',
      mutatedCount,
      failures: mutated.failures,
      legacyDataSrcBasedPasses: legacyPasses.length,
      records: mutated.records,
    });
  });

  test('变异 B 漏标一类元素：li 不再注入 data-src，完整性校验必须报出来', async ({ page }) => {
    const frame = await openStudio(page);

    const clean = await checkCompleteness(frame, 'ready');
    expect(clean.oracleFailures).toEqual([]);
    expect([...clean.phantom, ...clean.missing, ...clean.leaked, ...clean.unmarked], '基线状态必须干净').toEqual([]);

    const removed = await frame.evaluate(() => {
      const items = Array.from(document.querySelectorAll('li[data-src]'));
      for (const element of items) element.removeAttribute('data-src');
      return items.length;
    });
    expect(removed, '卖点列表应有多个 li').toBeGreaterThan(0);

    const dirty = await checkCompleteness(frame, 'ready');
    expect(dirty.missing.length, `漏标 li 后完整性校验没有报缺失：${JSON.stringify(dirty)}`).toBeGreaterThan(0);
    expect(dirty.missing.some((src) => src.startsWith('src/App.tsx:')), '缺失项应当包含 li 的源码位置').toBe(true);
    expect(dirty.unmarked.length, '渲染树里应当出现未标记的 li').toBeGreaterThanOrEqual(removed);

    // 用例 8 的锚点不涉及 li，应当仍然通过 —— 说明两套判定各管一摊、互不代替
    await setPicking(page, true);
    const anchors = await checkDeterministicAnchors(page, frame, anchorExpectations('ready'));
    expect(anchors.failures).toEqual([]);

    writeArtifact('case-mutation-missing-tag.json', {
      mutation: '移除所有 li 的 data-src（等价于插件漏标这一类元素）',
      removed,
      missing: dirty.missing,
      unmarked: dirty.unmarked,
      deterministicAnchorsStillPass: anchors.failures.length === 0,
    });
  });

  test('变异 C 列号整体偏一位：AST 期望本身自检能发现 oracle 与源码不一致', async () => {
    // 这一条不依赖浏览器：把 AST 期望位置整体右移一列（列号已是 1 基，所以 +1 就是偏一列），
    // 校验 readSourceAt 的自检会报错，说明「读源码确认该处是 < 且标签一致」这一步本身也有效。
    const expected = anchorExpectations('ready');
    const shifted = expected.map((item) => ({ ...item, node: { ...item.node, src: `${item.node.file}:${item.node.line}:${item.node.column + 1}` } }));
    const { readSourceAt } = await import('./lib');
    const failures = shifted
      .map((item) => ({ item, hit: readSourceAt(item.node.src) }))
      .filter(({ item, hit }) => hit.char !== '<' || hit.tag !== item.tag)
      .map(({ item }) => item.text);
    expect(failures.length).toBe(shifted.length);
    writeArtifact('case-mutation-column-offset.json', { shiftedCount: shifted.length, detected: failures.length });
  });
});
