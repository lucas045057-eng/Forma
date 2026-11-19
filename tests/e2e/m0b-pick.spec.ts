import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import {
  ARTIFACT_DIR,
  PREVIEW_ORIGIN,
  SAMPLE_SIZE,
  SEED,
  STUDIO_ORIGIN,
  clickTarget,
  consoleErrorsOf,
  countInstances,
  enumerateMarked,
  highlightBoxCount,
  markedIndexOf,
  openStudio,
  pickMarked,
  readSelection,
  readSourceAt,
  sampleDeterministic,
  screenshot,
  selectionText,
  setPicking,
  waitForSelectionChange,
  writeArtifact,
} from './lib';
import { anchorExpectations, checkCompleteness, checkDeterministicAnchors } from './checks';

/** 构造一条结构合法的 pick:result payload（用于 origin / source 校验用例）。 */
const forgedPayload = {
  src: 'src/App.tsx:1:1',
  cid: 'Forged',
  text: '伪造消息',
  bbox: [1, 2, 3, 4] as [number, number, number, number],
  styles: {
    display: 'block',
    position: 'static',
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    fontSize: '16px',
    fontFamily: 'sans-serif',
    fontWeight: '400',
    lineHeight: 'normal',
    padding: '0px',
    margin: '0px',
    borderRadius: '0px',
    width: '10px',
    height: '10px',
  },
  instances: 1,
  ancestors: [] as string[],
};

/** 在 Studio 窗口上派发一条可伪造 origin / source 的 message 事件。 */
async function dispatchToStudio(page: Page, origin: string): Promise<void> {
  await page.evaluate(
    ({ payload, messageOrigin }) => {
      const iframe = document.querySelector('[data-testid="preview-frame"]') as HTMLIFrameElement | null;
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:result', payload },
        origin: messageOrigin,
        source: iframe?.contentWindow ?? null,
      }));
    },
    { payload: forgedPayload, messageOrigin: origin },
  );
}

test.describe('M0-B 校验器自检（非验收用例）', () => {
  test('readSourceAt 能识别列号偏移（防止断言空转）', () => {
    const exact = readSourceAt('src/components/Button.tsx:5:5');
    expect(exact.char).toBe('<');
    expect(exact.tag).toBe('button');

    const offByOne = readSourceAt('src/components/Button.tsx:5:6');
    expect(offByOne.char).not.toBe('<');
    expect(offByOne.tag).toBeNull();
  });
});

test.describe('M0-B 点选 → 源码定位', () => {
  test('用例 1：随机 20 个 data-src 元素，点选后 src 指向该元素 JSX 开标签', async ({ page }, testInfo) => {
    const frame = await openStudio(page);
    const marked = await enumerateMarked(frame);
    expect(marked.length, '预览页应存在带 data-src 的元素').toBeGreaterThan(SAMPLE_SIZE);
    // 抽样前先检查一遍枚举结果里 data-src 是否都是 文件:行:列 格式
    for (const element of marked) {
      expect(element.src, `data-src 格式异常：${JSON.stringify(element)}`).toMatch(/^.+:\d+:\d+$/);
    }

    const sample = sampleDeterministic(marked, SAMPLE_SIZE, SEED);
    await setPicking(page, true);

    const records: Array<Record<string, unknown>> = [];
    const failures: string[] = [];

    for (const element of sample) {
      const record: Record<string, unknown> = {
        index: element.index,
        expectedSrc: element.src,
        expectedTag: element.tag,
        expectedCid: element.cid,
        text: element.text,
      };
      try {
        const { mode, selection } = await pickMarked(page, frame, element.index);
        record.clickMode = mode;
        record.selectionSrc = selection.src;
        record.selectionCid = selection.cid;
        record.selectionInstances = selection.instances;
        record.note = selection.note ?? null;

        const reported = String(selection.src ?? '');
        const hit = readSourceAt(reported);
        record.sourceFile = hit.file;
        record.sourceLine = hit.line;
        record.sourceColumn = hit.column;
        record.sourceLineText = hit.lineText.trim().slice(0, 160);
        record.charAtColumn = hit.char;
        record.tagAtColumn = hit.tag;

        if (reported !== element.src) {
          failures.push(`#${element.index} src 不一致：期望 ${element.src}，实际 ${reported}`);
        }
        if (hit.char !== '<') {
          failures.push(`#${element.index} ${reported} 处字符是 ${JSON.stringify(hit.char)}，不是 '<'`);
        }
        if (hit.tag !== element.tag) {
          failures.push(`#${element.index} ${reported} 处标签是 ${String(hit.tag)}，元素实际标签是 ${element.tag}`);
        }
        if (selection.cid !== element.cid) {
          failures.push(`#${element.index} cid 不一致：期望 ${element.cid}，实际 ${String(selection.cid)}`);
        }
        if (selection.note !== undefined) {
          failures.push(`#${element.index} 直接点中带标记元素却带 note=${String(selection.note)}`);
        }
        record.pass = !failures.some((failure) => failure.startsWith(`#${element.index} `));
      } catch (error) {
        record.pass = false;
        record.error = error instanceof Error ? error.message : String(error);
        failures.push(`#${element.index} 点选失败：${record.error as string}`);
        await screenshot(page, `case1-fail-${element.index}.png`).catch(() => '');
      }
      records.push(record);
    }

    const artifact = writeArtifact('case1-random-sample.json', {
      seed: SEED,
      algorithm: 'mulberry32(seed) + Fisher-Yates 洗牌 DOM 顺序的 data-src 元素列表，取前 20 个',
      sampleSize: SAMPLE_SIZE,
      totalMarked: marked.length,
      clickModeCounts: records.reduce<Record<string, number>>((acc, record) => {
        const key = String(record.clickMode ?? 'failed');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      failures,
      records,
    });
    await testInfo.attach('case1-random-sample.json', { path: artifact, contentType: 'application/json' });

    expect(failures, `随机 ${SAMPLE_SIZE} 个元素中存在定位错误`).toEqual([]);
  });

  test('用例 2：选取模式下点击不触发原行为，退出选取后恢复', async ({ page }) => {
    const frame = await openStudio(page);
    const status = frame.locator('[data-testid="action-status"]');
    expect(await status.getAttribute('data-purchases')).toBe('0');

    await setPicking(page, true);
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');
    const { selection } = await pickMarked(page, frame, buyIndex);
    expect(selection.src).toBe('src/components/Button.tsx:5:5');

    expect(await status.getAttribute('data-purchases'), '选取模式下的点击不应触发 onClick').toBe('0');
    expect((await status.innerText()).trim(), '选取模式下的点击不应改变页面反馈').toBe('');

    await setPicking(page, false);
    await clickTarget(page, frame, { selector: '[data-testid="buy-button"]' });
    await expect(status).toHaveAttribute('data-purchases', '1');
    expect((await status.innerText()).trim()).toContain('已加入购物袋');
  });

  test('用例 3：共享 Button 的 instances 与高亮框数量一致（≥3）', async ({ page }) => {
    const frame = await openStudio(page);
    const marked = await enumerateMarked(frame);
    const buttonSrc = 'src/components/Button.tsx:5:5';
    const domCount = await countInstances(frame, buttonSrc);
    expect(domCount, '共享 Button 至少被 3 处使用').toBeGreaterThanOrEqual(3);
    expect(marked.filter((element) => element.src === buttonSrc).map((element) => element.tag)).toEqual(
      Array.from({ length: domCount }, () => 'button'),
    );

    await setPicking(page, true);
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');
    const { selection } = await pickMarked(page, frame, buyIndex);

    expect(selection.src).toBe(buttonSrc);
    expect(selection.instances).toBe(domCount);

    await expect
      .poll(() => highlightBoxCount(frame, buttonSrc), { timeout: 10_000 })
      .toBe(domCount);

    const instancesText = await page.locator('[data-testid="instances"]').innerText();
    expect(instancesText).toContain(`同源码实例：${domCount} 处`);
    writeArtifact('case3-shared-button.json', { buttonSrc, domCount, selection });
  });

  test('用例 4：map 生成的卖点列表项被标注为多实例且 instances 正确', async ({ page }) => {
    const frame = await openStudio(page);
    const marked = await enumerateMarked(frame);
    const items = marked.filter((element) => element.tag === 'li');
    expect(items.length, '卖点列表应有 3 项').toBe(3);

    const sources = new Set(items.map((item) => item.src));
    expect(sources.size, '3 个列表项应共享同一处源码').toBe(1);
    const listSrc = [...sources][0];
    expect(listSrc).toMatch(/^src\/App\.tsx:\d+:\d+$/);
    const hit = readSourceAt(listSrc);
    expect(hit.char).toBe('<');
    expect(hit.tag).toBe('li');

    await setPicking(page, true);
    const firstIndex = items[0].index;
    const { selection } = await pickMarked(page, frame, firstIndex);
    expect(selection.src).toBe(listSrc);
    expect(selection.instances).toBe(items.length);
    expect(selection.instances as number).toBeGreaterThan(1);

    // 再点第二项，确认同一处源码、实例数不变
    const second = await pickMarked(page, frame, items[1].index);
    expect(second.selection.src).toBe(listSrc);
    expect(second.selection.instances).toBe(items.length);

    writeArtifact('case4-map-list.json', { listSrc, itemCount: items.length, selection });
  });

  test('用例 5：点击无 data-src 的子元素归到最近标记外层并带 outer-container', async ({ page }) => {
    const frame = await openStudio(page);
    const hostSelector = '[data-testid="benefit-item"]';
    const hostIndex = await markedIndexOf(frame, hostSelector);
    const hostSrc = (await enumerateMarked(frame))[hostIndex].src;

    // 页面里所有原生元素都被插件标记了，这里注入一个无标记子元素来构造该场景
    await frame.evaluate((selector) => {
      const host = document.querySelector(selector);
      if (!host) throw new Error('未找到注入宿主');
      const probe = document.createElement('span');
      probe.id = 'unmarked-probe';
      probe.textContent = '无标记探针';
      probe.setAttribute('style', 'display:inline-block;padding:6px 10px;background:#ffe9c9;color:#4a2f1b;');
      host.prepend(probe);
    }, hostSelector);
    await page.waitForTimeout(200);

    await setPicking(page, true);
    const before = await selectionText(page);
    const mode = await clickTarget(page, frame, { selector: '#unmarked-probe' });
    await waitForSelectionChange(page, before);
    const selection = await readSelection(page);

    expect(mode, '探针应能被真实鼠标点中').toBe('mouse');
    expect(selection.src).toBe(hostSrc);
    expect(selection.note).toBe('outer-container');
    expect(await page.locator('.inspector .selection-badges').innerText()).toContain('外层容器');
    writeArtifact('case5-outer-container.json', { hostSrc, clickMode: mode, selection });
  });

  test('用例 6：ancestors 最多 3 层且每项都是合法 data-src', async ({ page }) => {
    const frame = await openStudio(page);
    const marked = await enumerateMarked(frame);
    const markedSources = new Set(marked.map((element) => element.src));
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');

    // DOM 侧期望值：直接向上的 3 个 DOM 层级里，带标记的那些 src
    const expected = await frame.evaluate((index) => {
      const element = document.querySelectorAll('[data-src]')[index];
      const result: string[] = [];
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < 3; depth += 1, ancestor = ancestor.parentElement) {
        const src = ancestor.getAttribute('data-src');
        if (src) result.push(src);
      }
      return result;
    }, buyIndex);

    await setPicking(page, true);
    const { selection } = await pickMarked(page, frame, buyIndex);
    const ancestors = selection.ancestors as string[];

    expect(Array.isArray(ancestors)).toBe(true);
    expect(ancestors.length).toBeGreaterThan(0);
    expect(ancestors.length).toBeLessThanOrEqual(3);
    for (const ancestor of ancestors) {
      expect(markedSources.has(ancestor), `ancestor 不是页面里的 data-src：${ancestor}`).toBe(true);
      const hit = readSourceAt(ancestor);
      expect(hit.char, `${ancestor} 处不是 '<'`).toBe('<');
      expect(hit.tag, `${ancestor} 处没有解析出标签名`).not.toBeNull();
    }
    expect(ancestors).toEqual(expected);
    writeArtifact('case6-ancestors.json', { buyIndex, ancestors, expected, selection });
  });

  test('用例 7：错误 origin 的 pick:result 被 Studio 忽略（bridge 侧同样校验）', async ({ page }) => {
    const frame = await openStudio(page);
    await setPicking(page, true);

    // 基线：真实点选一次，拿到可对比的 Selection
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');
    const { selection: realSelection } = await pickMarked(page, frame, buyIndex);
    const baseline = await selectionText(page);
    expect(realSelection.src).toBe('src/components/Button.tsx:5:5');

    // 1) 伪造 origin，但 source 指向真正的预览 iframe
    await dispatchToStudio(page, 'http://evil.example');
    await page.waitForTimeout(600);
    expect(await selectionText(page), '错误 origin 的 pick:result 必须被忽略').toBe(baseline);
    expect(await page.locator('[data-testid="selection-json"]').innerText()).not.toContain('Forged');

    // 2) 对照：同一条 payload 用正确 origin 发出时必须被接受，证明上面被忽略是 origin 校验所致
    await dispatchToStudio(page, PREVIEW_ORIGIN);
    await waitForSelectionChange(page, baseline);
    const accepted = await readSelection(page);
    expect(accepted.src).toBe(forgedPayload.src);
    expect(accepted.cid).toBe(forgedPayload.cid);
    expect(accepted.baseVersion, 'Studio 应补上 baseVersion').toBeTruthy();

    // 3) bridge 侧：错误 origin 的 pick:stop 必须被忽略，选取模式仍然生效
    await frame.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:stop' },
        origin: 'http://evil.example',
        source: window.parent,
      }));
    });
    await page.waitForTimeout(300);
    const status = frame.locator('[data-testid="action-status"]');
    const beforeStopProbe = await selectionText(page);
    await clickTarget(page, frame, { index: buyIndex });
    await waitForSelectionChange(page, beforeStopProbe);
    expect(await status.getAttribute('data-purchases'), '伪造 pick:stop 后仍应拦截点击').toBe('0');

    // 4) 错误 source（正确 origin、非预览窗口）同样被忽略
    const beforeWrongSource = await selectionText(page);
    await page.evaluate(({ previewOrigin, payload }) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:result', payload: { ...payload, src: 'src/App.tsx:9:9', cid: 'WrongSource' } },
        origin: previewOrigin,
        source: window,
      }));
    }, { previewOrigin: PREVIEW_ORIGIN, payload: forgedPayload });
    await page.waitForTimeout(600);
    expect(await selectionText(page), '错误 source 的 pick:result 必须被忽略').toBe(beforeWrongSource);

    const errors = consoleErrorsOf(page).filter((line) => !line.includes('favicon'));
    writeArtifact('case7-origin-check.json', {
      artifactDir: ARTIFACT_DIR,
      baselineSrc: realSelection.src,
      acceptedSrc: accepted.src,
      wrongSourceIgnored: true,
      consoleErrors: errors,
    });
  });

  // 用例 8/9 是 R3 的整改：期望值一律由 templates/product-page 源码经 Babel AST 算出，
  // 不读 DOM 上的 data-src，也不把候选总数写死。判定逻辑在 tests/e2e/checks.ts。
  // M1-A 起作品页有条件渲染（3D 成功 / 回退占位），所以期望集合按渲染状态分组；
  // 这里跑 3D 成功态，回退态在 M1-A 的 03-fallback 用例里跑。
  test('用例 8：确定性目标——期望位置由模板源码 AST 独立算出（不读 data-src）', async ({ page }, testInfo) => {
    const expected = anchorExpectations('ready');
    const spanPositions = expected.filter((item) => item.tag === 'span').map((item) => item.node.src);
    expect(spanPositions.length, '3D 成功态至少应有两个 span 锚点').toBeGreaterThanOrEqual(2);
    expect(new Set(spanPositions).size, `span 锚点位置重复：${spanPositions.join(' / ')}`).toBe(spanPositions.length);

    const frame = await openStudio(page);
    await setPicking(page, true);
    const { records, failures, oracleFailures } = await checkDeterministicAnchors(page, frame, expected);

    const artifact = writeArtifact('case8-deterministic-ast.json', {
      oracle: '解析 templates/product-page/src 下全部 .tsx 的 Babel AST，取原生小写 JSX 开标签的 1 基行列',
      independentFromDataSrc: true,
      renderState: 'ready',
      anchors: expected.map((item) => ({ tag: item.tag, text: item.text, expectedFromAst: item.node.src, component: item.node.component })),
      oracleFailures,
      failures,
      records,
    });
    await testInfo.attach('case8-deterministic-ast.json', { path: artifact, contentType: 'application/json' });
    expect(oracleFailures, 'AST oracle 自检失败').toEqual([]);
    expect(failures, '确定性锚点定位不一致').toEqual([]);
  });

  test('用例 9：应标记节点完整性——AST 位置集合与运行时 DOM 标记集合互相对照', async ({ page }) => {
    const frame = await openStudio(page);
    // 3D 成功态：Placeholder 的节点不应出现，R3F 生成的 Canvas 子树不算模板 DOM
    const result = await checkCompleteness(frame, 'ready');

    writeArtifact('case9-completeness.json', result);

    expect(result.oracleFailures, 'AST oracle 自检失败').toEqual([]);
    expect(result.phantom, 'DOM 里出现了 AST 中不存在的源码位置').toEqual([]);
    expect(result.missing, 'AST 里该渲染的原生 JSX 位置没有在 DOM 中出现（漏标或未渲染）').toEqual([]);
    expect(result.leaked, '3D 成功态里不该出现 Placeholder 的节点').toEqual([]);
    expect(result.unmarked, '渲染树里存在没有 data-src 的元素').toEqual([]);
    // 只记录规模，不把总数写死成具体数值
    expect(result.expectedUniquePositions).toBeGreaterThan(0);
    expect(result.domUniqueSrcs).toBe(result.expectedUniquePositions);
    // 3D 成功态必预有 R3F 生成的外部分支（被排除在漏标检查之外）
    expect(result.externalElements, '3D 成功态没有出现 Canvas 子树').toBeGreaterThan(0);
  });
});
