import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { TEMPLATE_CONFIG } from './env';
import { writeArtifactFrom } from './artifact';
import { openProductPage, waitFor, withTempConfig } from './viewport';

/**
 * 资源释放（尽力而为）：反复整页重载、以及反复 HMR 改配置之后，页面里不应该堆积
 * WebGL 上下文，也不应出现浏览器的 “Too many active WebGL contexts” 警告。
 *
 * 说明：Playwright 拿不到“当前活跃 WebGL 上下文数量”的精确计数，这里用三件事代替：
 * 1) 捕获浏览器控制台里的 WebGL 警告；
 * 2) 每次加载统计 canvas 数量与 getContext('webgl2') 调用次数（初始化脚本注入）；
 * 3) 确认 HMR 改配置不会重建 Canvas（画布数量保持不变）。
 */

const valid = JSON.parse(readFileSync(TEMPLATE_CONFIG, 'utf8'));
const originalConfig = readFileSync(TEMPLATE_CONFIG, 'utf8');

test('资源释放：多次重载与多次 HMR 后没有 WebGL 上下文堆积警告', async ({ page }) => {
const warningPattern = /Too many active WebGL contexts|CONTEXT_LOST_WEBGL|WebGL context (was )?lost|lose_context/i;

  const warnings: string[] = [];
  const webglMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (!/webgl|Too many active/i.test(text)) return;
    webglMessages.push(`${message.type()}: ${text}`);
    // 只把「上下文丢失 / 上下文过多」当作问题；驱动层的 ReadPixels 性能提示不算
    if (warningPattern.test(text)) warnings.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const counter = { contexts: 0 };
    (window as unknown as { __webgl: typeof counter }).__webgl = counter;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patched(contextId: string, ...rest: unknown[]) {
      if (contextId === 'webgl' || contextId === 'webgl2') counter.contexts += 1;
      return (original as unknown as (id: string, ...args: unknown[]) => unknown).call(this, contextId, ...rest);
    } as typeof HTMLCanvasElement.prototype.getContext;
  });

  const measure = async () => {
    const frame = page.mainFrame();
    return frame.evaluate(() => {
      const scene = document.querySelector('[data-testid="product-scene"]');
      return {
        canvases: document.querySelectorAll('canvas').length,
        sceneCanvases: scene ? scene.querySelectorAll('canvas').length : 0,
        contexts: (window as unknown as { __webgl?: { contexts: number } }).__webgl?.contexts ?? -1,
        state: scene?.getAttribute('data-state') ?? null,
      };
    });
  };

  const loads: Array<Record<string, unknown>> = [];
  for (let round = 0; round < 4; round += 1) {
    if (round === 0) await openProductPage(page);
    else {
      await page.reload();
      const frame = page.mainFrame();
      await frame.waitForFunction(
        () => document.querySelector('[data-testid="product-scene"]')?.getAttribute('data-state') === 'ready',
        undefined,
        { timeout: 90_000 },
      );
    }
    await page.waitForTimeout(900);
    loads.push({ round, ...(await measure()) });
  }

  // 反复 HMR 改配置：不应重建 Canvas（画布数量保持 1），也不应多创建上下文
  const hmr: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 4; index += 1) {
    const rotation = [0, Number((0.4 + index * 0.2).toFixed(2)), 0];
    const variant = JSON.stringify({ ...valid, hero: { ...valid.hero, model: { ...valid.hero.model, rotation } } }, null, 2);
    const applied = await withTempConfig(variant, async () => {
      await waitFor(page, async () => {
        const current = await measure();
        return current.sceneCanvases === 1;
      }, 20_000);
      await page.waitForTimeout(900);
      return measure();
    });
    hmr.push({ index, ...applied.result });
  }

  const restored = readFileSync(TEMPLATE_CONFIG, 'utf8');
  const artifact = writeArtifactFrom('resource-release.json', {
    loads,
    hmr,
    warnings,
    webglMessages,
    pageErrors,
    restoredConfig: restored === originalConfig,
  });
  expect(artifact).toBeTruthy();
  expect(readFileSync(TEMPLATE_CONFIG, 'utf8'), 'scene.config.json 没有还原').toEqual(originalConfig);

  // 每次加载都只有一个画布、只创建一个 WebGL 上下文
  for (const load of loads) {
    expect(load.sceneCanvases, `第 ${String(load.round)} 次加载画布数量异常：${JSON.stringify(load)}`).toBe(1);
    expect(load.canvases).toBe(1);
    expect(load.contexts, `第 ${String(load.round)} 次加载创建了多个 WebGL 上下文`).toBe(1);
  }
  // HMR 不重建画布
  for (const entry of hmr) {
    expect(entry.sceneCanvases, `HMR 后画布被重建：${JSON.stringify(entry)}`).toBe(1);
    expect(entry.contexts, 'HMR 后又创建了新上下文').toBe(1);
  }
  expect(warnings, '出现了 WebGL 上下文相关警告').toEqual([]);
  expect(pageErrors).toEqual([]);
});
