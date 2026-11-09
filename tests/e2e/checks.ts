import type { Frame, Page } from '@playwright/test';
import {
  clearE2eMarks,
  clickMarkedByText,
  domSrcSet,
  domTagInventory,
  markByOwnText,
  readSelection,
  readSourceAt,
  selectionText,
  waitForSelectionChange,
} from './lib';
import { astSrcSet, nativeJsxNodes, nodeByText, type JsxNodeModel } from './source-model';

/**
 * 用例 8（确定性目标）与用例 9（应标记节点完整性）的判定逻辑。
 * 单独放一份，供验收用例和「变异验证」用例共用同一套判定 —— 变异验证要证明的
 * 正是这套判定不会空转。
 */

/** 确定性锚点：同一文件里位置不同的同名标签 + 不同标签 + 链接，期望值全部来自 AST。 */
export const DETERMINISTIC_ANCHORS: Array<{ tag: string; text: string }> = [
  { tag: 'span', text: 'MUJIAN / SCENT & LIVING' },
  { tag: 'span', text: '/ 100 mL · 雪松与佛手柑' },
  { tag: 'span', text: '静静陪伴 · 慢慢散香' },
  { tag: 'small', text: '100 mL' },
  { tag: 'h2', text: '不必远行，也能亲近自然。' },
  { tag: 'a', text: '关于这缕香气' },
];

export interface AnchorExpectation extends JsxNodeModel {
  tag: string;
  text: string;
  node: JsxNodeModel;
}

export function anchorExpectations(): AnchorExpectation[] {
  const nodes = nativeJsxNodes();
  return DETERMINISTIC_ANCHORS.map((anchor) => ({ ...anchor, node: nodeByText(nodes, anchor.tag, anchor.text) })) as AnchorExpectation[];
}

export interface AnchorCheckResult {
  records: Array<Record<string, unknown>>;
  failures: string[];
  oracleFailures: string[];
}

/**
 * 逐个点击确定性锚点，把 Studio 上报的 src 与 AST 算出的期望值比对。
 * 完全不读 DOM 上的 data-src 作为期望值。
 */
export async function checkDeterministicAnchors(page: Page, frame: Frame, expected = anchorExpectations()): Promise<AnchorCheckResult> {
  const oracleFailures: string[] = [];
  for (const item of expected) {
    const hit = readSourceAt(item.node.src);
    if (hit.char !== '<') oracleFailures.push(`AST 位置 ${item.node.src} 处是 ${JSON.stringify(hit.char)}，不是 '<'`);
    if (hit.tag !== item.tag) oracleFailures.push(`AST 位置 ${item.node.src} 处标签是 ${String(hit.tag)}，期望 ${item.tag}`);
  }

  const records: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const item of expected) {
    const found = await markByOwnText(frame, item.tag, item.text);
    const record: Record<string, unknown> = { tag: item.tag, text: item.text, expectedFromAst: item.node.src, domMatches: found };
    if (found !== 1) {
      await clearE2eMarks(frame);
      failures.push(`<${item.tag}>「${item.text}」在 DOM 里命中 ${found} 个元素，无法点击`);
      record.pass = false;
      records.push(record);
      continue;
    }
    try {
      const before = await selectionText(page);
      record.clickMode = await clickMarkedByText(page, frame);
      await waitForSelectionChange(page, before);
      const selection = await readSelection(page);
      record.selectionSrc = selection.src;
      // 只作对照记录，不用来判定：历史用例 1 的判定依据就是它，会漏掉同标签错标
      record.domDataSrc = await frame.evaluate(
        ({ tag, text }) => {
          const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
          const ownTextOf = (element: Element) => normalize(Array.from(element.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? '').join(''));
          const match = Array.from(document.querySelectorAll(tag)).find((element) => ownTextOf(element) === text);
          return match?.getAttribute('data-src') ?? null;
        },
        { tag: item.tag, text: item.text },
      );
      if (selection.src !== item.node.src) failures.push(`<${item.tag}>「${item.text}」期望 ${item.node.src}，实际 ${String(selection.src)}`);
      record.pass = selection.src === item.node.src;
    } catch (error) {
      record.pass = false;
      record.error = error instanceof Error ? error.message : String(error);
      failures.push(`<${item.tag}>「${item.text}」点选失败：${record.error as string}`);
      await clearE2eMarks(frame);
    }
    records.push(record);
  }
  return { records, failures, oracleFailures };
}

export interface CompletenessResult {
  astNodeCount: number;
  astUniquePositions: number;
  domUniqueSrcs: number;
  domElementCount: number;
  astPositions: string[];
  domPositions: string[];
  phantom: string[];
  missing: string[];
  unmarked: Array<{ tag: string; text: string }>;
  oracleFailures: string[];
}

/** AST 位置集合 ↔ 运行时 DOM 标记集合双向对照，并要求渲染树里没有漏标元素。 */
export async function checkCompleteness(frame: Frame): Promise<CompletenessResult> {
  const nodes = nativeJsxNodes();
  const astSet = astSrcSet(nodes);
  const oracleFailures: string[] = [];
  for (const node of nodes) {
    const hit = readSourceAt(node.src);
    if (hit.char !== '<') oracleFailures.push(`AST 位置 ${node.src} 处不是 '<'`);
    if (hit.tag !== node.tag) oracleFailures.push(`AST 位置 ${node.src} 处标签是 ${String(hit.tag)}，期望 ${node.tag}`);
  }
  const domSet = await domSrcSet(frame);
  const inventory = await domTagInventory(frame);
  return {
    astNodeCount: nodes.length,
    astUniquePositions: astSet.size,
    domUniqueSrcs: domSet.length,
    domElementCount: inventory.total,
    astPositions: [...astSet].sort(),
    domPositions: domSet,
    phantom: domSet.filter((src) => !astSet.has(src)),
    missing: [...astSet].filter((src) => !domSet.includes(src)),
    unmarked: inventory.unmarked,
    oracleFailures,
  };
}
