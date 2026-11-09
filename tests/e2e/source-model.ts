import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { REPO_ROOT, TEMPLATE_ROOT } from './lib';

/**
 * 独立于 `data-src` 的期望模型：直接解析模板源码，得到「每个原生 JSX 开标签」的
 * 原始位置。行、列都是 1 基，列表 UTF-16 code unit —— 与插件规范一致，但**不经过插件**，
 * 也不读 DOM 上的 data-src。
 */

const PLUGIN_DIR = path.join(REPO_ROOT, 'packages', 'vite-plugin-source-tag');
const TEMPLATE_SRC = path.join(TEMPLATE_ROOT, 'src');

type BabelNode = {
  type: string;
  loc?: { start: { line: number; column: number } };
  name?: { type: string; name: string };
  value?: string;
  children?: BabelNode[];
  [key: string]: unknown;
};

interface BabelApi {
  parseSync(code: string, options: Record<string, unknown>): { program: BabelNode };
}

function loadBabel(): BabelApi {
  // @babel/core 是插件包自己的依赖，这里按插件包解析，避免给根包新增依赖。
  const requireFromPlugin = createRequire(path.join(PLUGIN_DIR, 'package.json'));
  return requireFromPlugin('@babel/core') as BabelApi;
}

export interface JsxNodeModel {
  /** 相对 templates/product-page 的路径，统一 / 分隔 */
  file: string;
  line: number;
  column: number;
  tag: string;
  /** 该元素自身的静态文本（只算直接子级 JSXText），空白折叠后 trim */
  ownText: string;
  /** `文件:行:列`，与插件注入的 data-src 同一格式 */
  src: string;
}

function collectTsxFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTsxFiles(full));
    else if (/\.tsx$/.test(entry.name)) files.push(full);
  }
  return files.sort();
}

function walk(node: BabelNode | undefined, parent: BabelNode | null, visit: (node: BabelNode, parent: BabelNode | null) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child as unknown as BabelNode, parent, visit);
    return;
  }
  if (typeof node.type === 'string') visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'leadingComments' || key === 'trailingComments') continue;
    walk(node[key] as BabelNode, node, visit);
  }
}

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** 模板源码里所有「原生小写 JSX 开标签」的位置（AST 口径，独立于插件产物）。 */
export function nativeJsxNodes(): JsxNodeModel[] {
  const babel = loadBabel();
  const nodes: JsxNodeModel[] = [];
  for (const file of collectTsxFiles(TEMPLATE_SRC)) {
    const code = readFileSync(file, 'utf8');
    const ast = babel.parseSync(code, {
      babelrc: false,
      configFile: false,
      code: false,
      ast: true,
      parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
    });
    walk(ast.program, null, (node, parent) => {
      if (node.type !== 'JSXOpeningElement') return;
      if (!node.name || node.name.type !== 'JSXIdentifier' || !/^[a-z]/.test(node.name.name)) return;
      const ownText = (parent?.children ?? [])
        .filter((child) => child.type === 'JSXText')
        .map((child) => child.value ?? '')
        .join('');
      const relative = path.relative(TEMPLATE_ROOT, file).split(path.sep).join('/');
      const line = node.loc!.start.line;
      const column = node.loc!.start.column + 1;
      nodes.push({ file: relative, line, column, tag: node.name.name, ownText: normalize(ownText), src: `${relative}:${line}:${column}` });
    });
  }
  return nodes.sort((a, b) => a.src.localeCompare(b.src, 'en', { numeric: true }));
}

/** AST 位置字符串集合（去重后），用于和运行时 DOM 的 data-src 对照。 */
export function astSrcSet(nodes = nativeJsxNodes()): Set<string> {
  return new Set(nodes.map((node) => node.src));
}

/** 用 `标签|自身文本` 唯一定位一个 AST 节点；不唯一就报错而不是随便挑一个。 */
export function nodeByText(nodes: JsxNodeModel[], tag: string, ownText: string): JsxNodeModel {
  const matches = nodes.filter((node) => node.tag === tag && node.ownText === ownText);
  if (matches.length !== 1) {
    throw new Error(`AST 里用 <${tag}> + 文本「${ownText}」命中 ${matches.length} 个节点，无法作为确定性锚点`);
  }
  return matches[0];
}
