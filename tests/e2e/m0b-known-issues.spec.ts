import { expect, test } from '@playwright/test';
import {
  clickTarget,
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
 * R1 尚未修复时，下面标了 `test.fail` 的两条会失败——这是**预期**的，用来把
 * 「已知待修」和「新出现的回归」区分开：`pnpm test:e2e` 会因为「预期失败却通过了」
 * 而报警（说明 CodeBuddy 已经修好，需要删掉这里的 test.fail 标记）。
 *
 * 所有业务监听器都由测试在预览页内注入（表单、pointer/mouse 计数器），不改模板实现。
 * M0 模板本身只有 onClick，所以这里构造的是 M1 之后会真实出现的场景。
 */

test.describe('R1 选取模式不得触发先于 click 的业务行为', () => {
  test('R1a 真实鼠标的 pointerdown / mousedown / mouseup 不应触达业务监听器', async ({ page }) => {
    test.fail(true, 'R1 未修复：选取模式需要在 capture 阶段拦截 pointer 按下/抬起（Codex M0-B-review R1）。修复后删除本条 test.fail。');
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
    test.fail(true, 'R1 未修复：选取模式需要拦截 submit 与键盘激活（Codex M0-B-review R1）。修复后删除本条 test.fail。');
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
    await page.waitForTimeout(200);
    const afterStop = await readProbe(frame);

    writeArtifact('case-r1d-restore.json', { duringPick, afterStop });
    expect(afterStop.pointerdown, '退出选取后 pointerdown 仍未恢复').toBeGreaterThan(duringPick.pointerdown);
    expect(afterStop.mousedown, '退出选取后 mousedown 仍未恢复').toBeGreaterThan(duringPick.mousedown);
    expect(afterStop.click, '退出选取后 click 仍未恢复').toBe(duringPick.click + 1);
  });
});
