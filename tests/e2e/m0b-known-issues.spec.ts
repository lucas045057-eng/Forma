import { expect, test } from '@playwright/test';
import {
  clickTarget,
  hoverBoxCount,
  hoverTarget,
  installEventProbe,
  installSingleInputForm,
  markedIndexOf,
  openStudio,
  previewHash,
  readProbe,
  selectionText,
  setPicking,
  waitForSelectionChange,
  writeArtifact,
} from './lib';

/**
 * Codex 审查 R1 的回归用例（docs/reports/M0-B-review.md#R1）。
 *
 * 整改回合 1 里这些用例带 `test.fail`，用来把「已知待修」和新回归分开；
 * CodeBuddy 在 fix/m0b-review 修好并合并后（合并提交 59824d5），本轮已删除标记，
 * 改为正常断言。
 *
 * 业务监听器全部由测试在预览页内注入（表单、各激活事件计数器），不改模板实现。
 * M0 模板本身只有 onClick，这里构造的是 M1 之后会真实出现的场景。
 */

test.describe('R1 选取模式不得触发先于/绕过 click 的业务行为', () => {
  test('R1a 真实鼠标的 pointerdown / mousedown / mouseup 不应触达业务监听器', async ({ page }) => {
    const frame = await openStudio(page);
    await installEventProbe(frame, '[data-testid="buy-button"]');
    await setPicking(page, true);

    const index = await markedIndexOf(frame, '[data-testid="buy-button"]');
    const before = await selectionText(page);
    await clickTarget(page, frame, { index });
    await waitForSelectionChange(page, before);

    const probe = await readProbe(frame);
    writeArtifact('case-r1a-pointer-events.json', { probe });
    expect(probe.pointerdown, 'pointerdown 触达了业务监听器').toBe(0);
    expect(probe.mousedown, 'mousedown 触达了业务监听器').toBe(0);
    expect(probe.mouseup, 'mouseup 触达了业务监听器').toBe(0);
    expect(probe.click, 'click 触达了业务监听器').toBe(0);
  });

  test('R1b 单输入框表单的回车隐式提交不应触发', async ({ page }) => {
    const frame = await openStudio(page);
    await installEventProbe(frame, '[data-testid="buy-button"]');
    await installSingleInputForm(frame);
    await setPicking(page, true);

    await frame.locator('#probe-input').focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    const probe = await readProbe(frame);
    writeArtifact('case-r1b-form-submit.json', { probe });
    expect(probe.submit, '单输入框回车触发了隐式表单提交').toBe(0);
  });

  test('R1c 选取模式下链接不跳转，退出选取后链接恢复可跳转', async ({ page }) => {
    const frame = await openStudio(page);
    await setPicking(page, true);
    const linkIndex = await markedIndexOf(frame, 'a[href="#details"]');

    const before = await selectionText(page);
    await clickTarget(page, frame, { index: linkIndex });
    await waitForSelectionChange(page, before);
    expect(await previewHash(frame), '选取模式下链接不应改变 hash').toBe('');

    await setPicking(page, false);
    await clickTarget(page, frame, { index: linkIndex });
    await expect.poll(() => previewHash(frame), { timeout: 5_000 }).toBe('#details');
    writeArtifact('case-r1c-link.json', { reachedHash: '#details' });
  });

  test('R1d 退出选取后 pointer / mouse / click 监听器完全恢复', async ({ page }) => {
    const frame = await openStudio(page);
    await installEventProbe(frame, '[data-testid="buy-button"]');
    const index = await markedIndexOf(frame, '[data-testid="buy-button"]');

    await setPicking(page, true);
    const before = await selectionText(page);
    await clickTarget(page, frame, { index });
    await waitForSelectionChange(page, before);
    const duringPick = await readProbe(frame);

    await setPicking(page, false);
    await clickTarget(page, frame, { index });
    await page.waitForTimeout(250);
    const afterStop = await readProbe(frame);

    writeArtifact('case-r1d-restore.json', { duringPick, afterStop });
    expect(afterStop.pointerdown, '退出选取后 pointerdown 仍未恢复').toBeGreaterThan(duringPick.pointerdown);
    expect(afterStop.mousedown, '退出选取后 mousedown 仍未恢复').toBeGreaterThan(duringPick.mousedown);
    expect(afterStop.click, '退出选取后 click 仍未恢复').toBe(duringPick.click + 1);
  });

  test('R1e 选取模式下右键菜单与双击被拦截，退出选取后恢复', async ({ page }) => {
    const frame = await openStudio(page);
    await installEventProbe(frame, '[data-testid="buy-button"]');
    const index = await markedIndexOf(frame, '[data-testid="buy-button"]');

    await setPicking(page, true);
    await clickTarget(page, frame, { index }, { button: 'right' });
    await page.waitForTimeout(300);
    await clickTarget(page, frame, { index }, { clicks: 2 });
    await page.waitForTimeout(300);
    const duringPick = await readProbe(frame);
    expect(duringPick.contextmenu, '选取模式下右键菜单事件触达了业务监听器').toBe(0);
    expect(duringPick.dblclick, '选取模式下双击事件触达了业务监听器').toBe(0);

    await setPicking(page, false);
    await clickTarget(page, frame, { index }, { button: 'right' });
    await page.waitForTimeout(300);
    await clickTarget(page, frame, { index }, { clicks: 2 });
    await page.waitForTimeout(300);
    const afterStop = await readProbe(frame);

    writeArtifact('case-r1e-contextmenu-dblclick.json', { duringPick, afterStop });
    expect(afterStop.contextmenu, '退出选取后 contextmenu 仍未恢复').toBeGreaterThan(duringPick.contextmenu);
    expect(afterStop.dblclick, '退出选取后 dblclick 仍未恢复').toBeGreaterThan(duringPick.dblclick);
  });

  test('R1f 选取模式下 Space 激活被拦截，退出选取后按钮可被 Space 激活', async ({ page }) => {
    const frame = await openStudio(page);
    await installEventProbe(frame, '[data-testid="buy-button"]');
    const button = frame.locator('[data-testid="buy-button"]');
    const status = frame.locator('[data-testid="action-status"]');

    await setPicking(page, true);
    await button.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const duringPick = await readProbe(frame);
    expect(duringPick.keydown, 'Space 的 keydown 触达了业务监听器').toBe(0);
    expect(duringPick.keyup, 'Space 的 keyup 触达了业务监听器').toBe(0);
    expect(duringPick.click, 'Space 在选取模式下不应产生 click').toBe(0);
    expect(await status.getAttribute('data-purchases'), 'Space 触发了业务 onClick').toBe('0');

    await setPicking(page, false);
    await button.focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const afterStop = await readProbe(frame);

    writeArtifact('case-r1f-space.json', { duringPick, afterStop });
    expect(afterStop.keydown, '退出选取后 keydown 仍未恢复').toBeGreaterThan(duringPick.keydown);
    expect(afterStop.click, '退出选取后按钮应能被 Space 激活').toBeGreaterThan(duringPick.click);
    expect(await status.getAttribute('data-purchases')).toBe('1');
  });

  test('R1g 选取期间悬停高亮与滚动仍然正常（拦截不误伤移动/滚动）', async ({ page }) => {
    const frame = await openStudio(page);
    await setPicking(page, true);

    // 悬停：bridge 的悬停框是橙色边框
    const itemIndex = await markedIndexOf(frame, '[data-testid="benefit-item"]');
    await hoverTarget(page, frame, { index: itemIndex });
    await expect.poll(() => hoverBoxCount(frame), { timeout: 5_000 }).toBeGreaterThan(0);
    const hoverBoxes = await hoverBoxCount(frame);

    // 滚动：先回到顶部拿到基线，再往下滚，确认 Studio 收到 scroll:progress（视口模式标签里的百分比）
    const percent = async () => {
      const text = await page.locator('.viewport-mode-pill').innerText();
      const match = /(\d+)%/.exec(text);
      return match ? Number(match[1]) : -1;
    };
    await frame.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(percent, { timeout: 5_000 }).toBe(0);
    const beforePercent = await percent();
    const scrolled = await frame.evaluate(() => { window.scrollTo(0, 700); return window.scrollY; });
    await expect.poll(percent, { timeout: 5_000 }).toBeGreaterThan(beforePercent);
    const afterPercent = await percent();

    writeArtifact('case-r1g-hover-scroll.json', {
      hoverBoxes,
      scrollY: scrolled,
      percent: { before: beforePercent, after: afterPercent },
    });
    expect(scrolled, '预览页滚动被拦截了').toBeGreaterThan(0);
    expect(afterPercent).toBeGreaterThan(0);
  });
});
