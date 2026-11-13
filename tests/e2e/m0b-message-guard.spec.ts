import { expect, test } from '@playwright/test';
import {
  PREVIEW_ORIGIN,
  STUDIO_ORIGIN,
  clickTarget,
  consoleErrorsOf,
  highlightBoxCount,
  markedIndexOf,
  openStudio,
  pickMarked,
  readSelection,
  selectionText,
  setPicking,
  waitForSelectionChange,
  writeArtifact,
} from './lib';

/**
 * Codex 审查 S4 的消息安全回归（docs/reports/M0-B-review.md#S4）：
 * 两端都要拒绝「来源不对」和「形状不对」的消息。这里用合成 MessageEvent 精确构造
 * origin / source，可以覆盖浏览器真实发送时难以构造的分支。
 */

const buttonSrc = 'src/components/Button.tsx:5:5';

const validPayload = {
  src: 'src/App.tsx:1:1',
  cid: 'GuardProbe',
  text: '合法对照',
  bbox: [1, 2, 3, 4],
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

/** 各种形状不合法但仍然「看起来像」pick:result 的 payload。 */
const malformedPayloads: Array<{ name: string; message: unknown }> = [
  { name: '缺少 payload', message: { type: 'pick:result' } },
  { name: 'payload 不是对象', message: { type: 'pick:result', payload: 'nope' } },
  { name: 'bbox 只有 3 项', message: { type: 'pick:result', payload: { ...validPayload, bbox: [1, 2, 3] } } },
  { name: 'bbox 含 NaN', message: { type: 'pick:result', payload: { ...validPayload, bbox: [1, 2, 3, Number.NaN] } } },
  { name: 'instances 为 0', message: { type: 'pick:result', payload: { ...validPayload, instances: 0 } } },
  { name: 'instances 非整数', message: { type: 'pick:result', payload: { ...validPayload, instances: 1.5 } } },
  { name: 'ancestors 超过 3 层', message: { type: 'pick:result', payload: { ...validPayload, ancestors: ['a:1:1', 'b:1:1', 'c:1:1', 'd:1:1'] } } },
  { name: 'styles 缺字段', message: { type: 'pick:result', payload: { ...validPayload, styles: { ...validPayload.styles, color: undefined } } } },
  { name: 'note 取值非法', message: { type: 'pick:result', payload: { ...validPayload, note: 'outer' } } },
  { name: 'src 非字符串', message: { type: 'pick:result', payload: { ...validPayload, src: 123 } } },
  { name: '未知消息类型', message: { type: 'pick:result!', payload: validPayload } },
  { name: 'scroll:progress 越界', message: { type: 'scroll:progress', payload: { at: 1.5 } } },
];

test.describe('S4 消息来源与形状校验', () => {
  test('S4a bridge 忽略 source 不是 parent 的 pick:start', async ({ page }) => {
    const frame = await openStudio(page);
    const status = frame.locator('[data-testid="action-status"]');
    const index = await markedIndexOf(frame, '[data-testid="buy-button"]');

    // 伪造：origin 正确（bridge 期望的 studioOrigin），但 source 是预览页自己而不是父窗口
    await frame.evaluate((studioOrigin) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:start' },
        origin: studioOrigin,
        source: window,
      }));
    }, STUDIO_ORIGIN);
    await page.waitForTimeout(200);

    await clickTarget(page, frame, { index });
    await expect(status, '错误 source 的 pick:start 不应让 bridge 进入选取模式').toHaveAttribute('data-purchases', '1');
    writeArtifact('case-s4a-bridge-source.json', { purchases: await status.getAttribute('data-purchases') });
  });

  test('S4b 对照：source 正确时 bridge 会进入选取模式并拦截点击', async ({ page }) => {
    const frame = await openStudio(page);
    const status = frame.locator('[data-testid="action-status"]');
    const index = await markedIndexOf(frame, '[data-testid="buy-button"]');

    await frame.evaluate((studioOrigin) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:start' },
        origin: studioOrigin,
        source: window.parent,
      }));
    }, STUDIO_ORIGIN);
    await page.waitForTimeout(200);

    await clickTarget(page, frame, { index });
    await page.waitForTimeout(200);
    expect(await status.getAttribute('data-purchases'), 'source 正确时 bridge 应拦截点击').toBe('0');
    expect(await highlightBoxCount(frame, buttonSrc), 'bridge 应画出同源实例高亮').toBeGreaterThan(0);
  });

  test('S4c Studio 忽略形状非法的 pick:result（合法对照必须被接受）', async ({ page }) => {
    const frame = await openStudio(page);
    await setPicking(page, true);
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');
    await pickMarked(page, frame, buyIndex);
    const baseline = await selectionText(page);
    expect(baseline).toContain(buttonSrc);

    const dispatch = async (message: unknown) => {
      await page.evaluate(({ data, previewOrigin }) => {
        const iframe = document.querySelector('[data-testid="preview-frame"]') as HTMLIFrameElement | null;
        window.dispatchEvent(new MessageEvent('message', {
          data,
          origin: previewOrigin,
          source: iframe?.contentWindow ?? null,
        }));
      }, { data: message, previewOrigin: PREVIEW_ORIGIN });
      await page.waitForTimeout(120);
      return selectionText(page);
    };

    const results: Array<{ name: string; changed: boolean }> = [];
    for (const item of malformedPayloads) {
      results.push({ name: item.name, changed: (await dispatch(item.message)) !== baseline });
    }

    // 对照：同一条合法 payload 必须被接受，证明上面的“不变”是形状校验生效，而不是通道没通
    const acceptedText = await dispatch({ type: 'pick:result', payload: validPayload });
    const accepted = acceptedText !== baseline;
    const acceptedSelection = accepted ? await readSelection(page) : null;

    const errors = consoleErrorsOf(page).filter((line) => !line.includes('favicon'));
    writeArtifact('case-s4c-studio-payload-guard.json', { baselineSrc: buttonSrc, results, accepted, errors });

    expect(results.filter((item) => item.changed), '这些畸形 payload 被 Studio 接受了').toEqual([]);
    expect(accepted, '合法对照 payload 未被接受，说明通道本身没通').toBe(true);
    expect(acceptedSelection?.cid).toBe(validPayload.cid);
    expect(errors).toEqual([]);
  });

  test('S4d bridge 忽略畸形 highlight 与未知 Studio 消息', async ({ page }) => {
    const frame = await openStudio(page);
    const status = frame.locator('[data-testid="action-status"]');
    await setPicking(page, true);
    const buyIndex = await markedIndexOf(frame, '[data-testid="buy-button"]');
    await pickMarked(page, frame, buyIndex);
    await expect.poll(() => highlightBoxCount(frame, buttonSrc), { timeout: 10_000 }).toBe(3);

    // 畸形 highlight：src 不是字符串，应当被整条忽略，覆盖框数量不变
    await frame.evaluate((studioOrigin) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'highlight', payload: { src: 123 } },
        origin: studioOrigin,
        source: window.parent,
      }));
    }, STUDIO_ORIGIN);
    await page.waitForTimeout(200);
    expect(await highlightBoxCount(frame, buttonSrc), '畸形 highlight 改变了高亮').toBe(3);

    // 未知类型不应改变选取状态
    await frame.evaluate((studioOrigin) => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'pick:start!' },
        origin: studioOrigin,
        source: window.parent,
      }));
    }, STUDIO_ORIGIN);
    await page.waitForTimeout(200);

    const before = await selectionText(page);
    // 换点另一个按钮：三个按钮共享同一处源码但 bbox 不同，能确认真实点选仍然可用
    const saveIndex = await markedIndexOf(frame, '[data-testid="save-button"]');
    await clickTarget(page, frame, { index: saveIndex });
    await waitForSelectionChange(page, before);
    expect(await status.getAttribute('data-purchases'), '未知 Studio 消息后 bridge 应仍在选取模式').toBe('0');

    const errors = consoleErrorsOf(page).filter((line) => !line.includes('favicon'));
    writeArtifact('case-s4d-bridge-guard.json', { highlightBoxes: 3, errors });
    expect(errors).toEqual([]);
  });
});
