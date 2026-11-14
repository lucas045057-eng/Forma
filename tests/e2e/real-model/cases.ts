import { expect } from '@playwright/test';
import type { Snapshot } from './helpers';

export interface CaseDef {
  id: number;
  title: string;
  selector: string;
  instruction: string;
  /** mock 接线时注入的工具调用；不参与真实模型运行。 */
  mockSteps: Array<Array<{ name: string; args?: Record<string, unknown> }>>;
  /** 允许发生变化的扁平快照键；其他键必须与基线一致。 */
  allowed: string[];
  /** 候选/采用后的目标断言；公共的“非目标不变”由 callCase 统一检查。 */
  check: (snapshot: Snapshot, baseline: Snapshot) => void;
}

const replace = (file: string, oldText: string, newText: string, finish: string) => [
  [{ name: 'replace_in_file', args: { path: file, old: oldText, new: newText } }],
  [{ name: 'finish', args: { summary: finish } }],
];

export const CASES: CaseDef[] = [
  {
    id: 1, title: '首屏立即购买 → 加入购物袋',
    selector: '[data-testid="buy-button"]',
    instruction: '把这个按钮的文字改成‘加入购物袋’，保留原来的购买行为，其他按钮文案不要改。',
    mockSteps: replace('src/App.tsx', '立即购买', '加入购物袋', '按钮文案已改，购买行为保留'),
    allowed: ['buttonTexts.buy-button', 'buttons.buy-button.width'],
    check: (snapshot, baseline) => {
      expect(snapshot.buttonTexts['buy-button']).toBe('加入购物袋');
      expect(snapshot.buttonTexts['save-button']).toBe(baseline.buttonTexts['save-button']);
      expect(snapshot.buttonTexts['gift-button']).toBe(baseline.buttonTexts['gift-button']);
    },
  },
  {
    id: 2, title: '主标题 → 把森林，带回家。',
    selector: 'h1',
    instruction: '把主标题改成‘把森林，带回家。’，保留现有标题样式。',
    mockSteps: replace('src/App.tsx', '<h1>给生活，<br/>留一点香气。</h1>', '<h1>把森林，带回家。</h1>', '主标题已改，样式保留'),
    allowed: ['h1'],
    check: (snapshot, baseline) => {
      expect(snapshot.h1).toBe('把森林，带回家。');
      expect(snapshot.h1Tag).toBe('H1');
      expect(snapshot.h1Style).toEqual(baseline.h1Style);
    },
  },
  {
    id: 3, title: '价格 168 → 198',
    selector: '.price',
    instruction: '把价格从 168 元改成 198 元，容量和香型说明保持原样。',
    mockSteps: replace('src/App.tsx', '¥ 168', '¥ 198', '价格已改为 198'),
    allowed: ['price'],
    check: (snapshot, baseline) => {
      expect(snapshot.price).toContain('¥ 198');
      expect(snapshot.price).toContain('100 mL · 雪松与佛手柑');
      expect(snapshot.price).not.toContain('168');
      expect((snapshot.price.match(/198/g) ?? []).length).toBe(1);
      expect(snapshot.priceSpan).toBe(baseline.priceSpan);
    },
  },
  {
    id: 4, title: '导航 → 探索香气',
    selector: 'header a[href="#details"]',
    instruction: '把这个导航链接的文字改成‘探索香气’，仍然跳到下面的详情区。',
    mockSteps: replace('src/App.tsx', '>关于这缕香气</a>', '>探索香气</a>', '导航文案已改，链接保留'),
    allowed: ['navText'],
    check: (snapshot, baseline) => {
      expect(snapshot.navText).toBe('探索香气');
      expect(snapshot.navHref).toBe('#details');
      expect(baseline.navHref).toBe('#details');
    },
  },
  {
    id: 5, title: '购买按钮下的小字',
    selector: '.fine-print',
    instruction: '把这句小字改成‘给自己一份安静的礼物。’，其他文案保持原样。',
    mockSteps: replace('src/App.tsx', '一份给自己，也给生活的温柔礼物。', '给自己一份安静的礼物。', '小字已改'),
    allowed: ['fine'],
    check: (snapshot, baseline) => {
      expect(snapshot.fine).toBe('给自己一份安静的礼物。');
      expect(snapshot.h1).toBe(baseline.h1);
      expect(snapshot.intro).toBe(baseline.intro);
      expect(snapshot.buttonTexts).toEqual(baseline.buttonTexts);
      expect(snapshot.footer).toBe(baseline.footer);
    },
  },
  {
    id: 6, title: 'intro 字号 16px，比例保持 2',
    selector: '.intro',
    instruction: '把这段介绍文字的字号改为 16px，保持颜色和行高比例不变。',
    mockSteps: replace('src/style.css', '.intro { font-size: 14px; line-height: 2;', '.intro { font-size: 16px; line-height: 2;', '介绍字号改为 16px'),
    allowed: ['introStyle.font-size', 'introStyle.line-height'],
    check: (snapshot, baseline) => {
      const style = snapshot.introStyle as Record<string, string>;
      const base = baseline.introStyle as Record<string, string>;
      expect(style['font-size']).toBe('16px');
      expect(Number.parseFloat(style['line-height']) / Number.parseFloat(style['font-size'])).toBeCloseTo(2, 2);
      expect(style['color']).toBe(base['color']);
      expect(snapshot.intro).toBe(baseline.intro);
    },
  },
  {
    id: 7, title: '购买/收藏按钮间距 24px',
    selector: '[data-testid="buy-button"]',
    instruction: '把这一排购买和收藏按钮的间距改成 24px，不改变按钮本身的大小。',
    mockSteps: replace('src/style.css', '.actions { display: flex; flex-wrap: wrap; gap: 12px; }', '.actions { display: flex; flex-wrap: wrap; gap: 24px; }', '按钮间距改为 24px'),
    allowed: ['actionsGap'],
    check: (snapshot, baseline) => {
      expect(snapshot.actionsGap).toBe('24px');
      expect(snapshot.buttons).toEqual(baseline.buttons);
      expect(snapshot.buttonTexts).toEqual(baseline.buttonTexts);
    },
  },
  {
    id: 8, title: '共享 Button 三处 12px 圆角',
    selector: '[data-testid="save-button"]',
    instruction: '把这个共享按钮组件在页面上的三处实例都改成 12px 圆角，不改文字、颜色和点击行为。',
    mockSteps: replace('src/style.css', 'border-radius: 3px; padding: 14px 25px;', 'border-radius: 12px; padding: 14px 25px;', '共享按钮圆角改为 12px'),
    allowed: ['buttons.buy-button.radius', 'buttons.save-button.radius', 'buttons.gift-button.radius'],
    check: (snapshot, baseline) => {
      expect((snapshot.buttons['buy-button'] as any).radius).toBe('12px');
      expect((snapshot.buttons['save-button'] as any).radius).toBe('12px');
      expect((snapshot.buttons['gift-button'] as any).radius).toBe('12px');
      expect(snapshot.buttonTexts).toEqual(baseline.buttonTexts);
    },
  },
  {
    id: 9, title: '三条卖点标题 20px',
    selector: '[data-testid="benefit-item"] h3',
    instruction: '把这组三条卖点的标题字号都改成 20px，卖点正文保持原样。',
    mockSteps: replace('src/style.css', 'h3 { font-size: 16px; font-weight: 500; }', 'h3 { font-size: 20px; font-weight: 500; }', '卖点标题改为 20px'),
    allowed: ['benefits.0.h3Size', 'benefits.1.h3Size', 'benefits.2.h3Size'],
    check: (snapshot, baseline) => {
      const benefits = snapshot.benefits as Array<{ title: string; h3Size: string; text: string; pSize: string }>;
      const base = baseline.benefits as Array<{ title: string; h3Size: string; text: string; pSize: string }>;
      expect(benefits.map((item) => item.h3Size)).toEqual(['20px', '20px', '20px']);
      expect(benefits.map((item) => item.title)).toEqual(base.map((item) => item.title));
      expect(benefits.map((item) => item.text)).toEqual(base.map((item) => item.text));
      expect(benefits.map((item) => item.pSize)).toEqual(base.map((item) => item.pSize));
    },
  },
  {
    id: 10, title: '3D 展示环境光 ambient 0.8',
    selector: '[data-testid="product-scene"]',
    instruction: '把这个 3D 场景的环境光强度改成 0.8，模型、相机、主光和滚动开盖配置都不要改。',
    mockSteps: [], // mock 模式下由 spec 用基线 scene.config.json 生成 write_file 步骤
    allowed: [],
    check: (snapshot) => {
      expect(snapshot.sceneState).toBe('ready');
      expect(snapshot.sceneCanvas).toBe(true);
    },
  },
];
