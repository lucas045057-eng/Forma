import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));

const RAW_FETCH_TRANSPORT_ALLOWLIST = new Set([
  'api.ts',
  'lux3d-api.ts',
  'speech-api.ts',
  'EventCenter.tsx',
]);

// Ratchet baselines (ai-native-garden Step 2): RAW_FETCH_RATCHET 已清零为 {}；其余基线只准降、不准涨，
// 新文件必须满足 0 裸 fetch / 0 类型逃生 / <=450 TSX 行数 / <=4 useEffect / <=800 CSS 行数。
const RAW_FETCH_RATCHET: Record<string, number> = {};

const LEGACY_TYPE_ESCAPE_RATCHET: Record<string, number> = {
  'm2-state.ts': 2,
  'NewWorkModal.tsx': 1,
  'SceneEditor.tsx': 4,
  'speech-input.ts': 1,
};

const FILE_LINE_RATCHET: Record<string, number> = {
  'App.tsx': 596,
  'AssetPlacement.tsx': 545,
  'NewWorkModal.tsx': 530,
};

const USE_EFFECT_RATCHET: Record<string, number> = {
  'App.tsx': 9,
  'AssetPlacement.tsx': 8,
  'SceneEditor.tsx': 5,
};

const DEFAULT_MAX_TS_LINES = 450;
const DEFAULT_MAX_CSS_LINES = 800;
const DEFAULT_MAX_USE_EFFECTS = 4;

interface SourceEntry {
  rel: string;
  abs: string;
  content: string;
  lines: number;
  ext: 'ts' | 'tsx' | 'css';
}

function collectProductionSources(dir: string = SRC_ROOT): SourceEntry[] {
  const entries: SourceEntry[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'test-support' || item.name === 'node_modules') continue;
      entries.push(...collectProductionSources(abs));
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(item.name) || /\.test\./.test(item.name)) continue;
    const rel = path.relative(SRC_ROOT, abs).replaceAll('\\', '/');
    const content = fs.readFileSync(abs, 'utf8');
    const ext = item.name.endsWith('.tsx') ? 'tsx' : item.name.endsWith('.css') ? 'css' : 'ts';
    entries.push({ rel, abs, content, lines: content.split(/\r?\n/).length, ext });
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '));
}

function parseRuleBlocks(css: string): Array<{ selector: string; body: string; line: number }> {
  const clean = stripCssComments(css);
  const blocks: Array<{ selector: string; body: string; line: number }> = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let currentSelector = '';

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        currentSelector = clean.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const line = clean.slice(0, selectorStart).split('\n').length;
        const body = clean.slice(bodyStart, i);
        // Recurse into @media / @supports rule bodies to inspect inner selector blocks too
        if (currentSelector.startsWith('@')) {
          const innerBlocks = parseRuleBlocks(body);
          for (const inner of innerBlocks) {
            blocks.push({ ...inner, line: line + inner.line - 1 });
          }
        } else {
          blocks.push({ selector: currentSelector, body, line });
        }
        selectorStart = i + 1;
      }
    }
  }
  return blocks;
}

describe('Studio architecture & slop guardrails (ai-native-garden)', () => {
  const sources = collectProductionSources();
  const cssFiles = sources.filter(s => s.ext === 'css');
  const tsFiles = sources.filter(s => s.ext !== 'css');

  it('CSS redline: preview iframes never use non-none transform (preserves 1:1 coordinate fidelity)', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      for (const block of parseRuleBlocks(file.content)) {
        if (!/\biframe\b|preview-frame|candidate-frame/.test(block.selector)) continue;
        const match = /\btransform\s*:\s*([^;]+)/i.exec(block.body);
        if (match && match[1].trim().toLowerCase() !== 'none') {
          violations.push(`${file.rel}:${block.line} (${block.selector}) sets transform: ${match[1].trim()}`);
        }
      }
    }
    expect(
      violations,
      '禁止对预览 iframe 施加 transform 缩放/位移（会破坏 1:1 点选坐标与视觉保真）。请删除 transform 或改为 transform: none；若需居中请使用容器布局宽度控制。',
    ).toEqual([]);
  });

  it('CSS redline: backdrop-filter is banned outside .modal-backdrop to prevent compositor ghosting beside iframes', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      for (const block of parseRuleBlocks(file.content)) {
        if (!/\b(?:backdrop-filter|-webkit-backdrop-filter)\s*:/i.test(block.body)) continue;
        if (block.selector !== '.modal-backdrop') {
          violations.push(`${file.rel}:${block.line} (${block.selector})`);
        }
      }
    }
    expect(
      violations,
      '禁止在除 .modal-backdrop 外的选择器上使用 backdrop-filter（Windows WebView2/Chromium 在跨进程 iframe 旁滚动时会产生合成器重影）。请改用 var(--bg-surface-1) 或 var(--bg-surface-solid) 高不透明度实底。',
    ).toEqual([]);
  });

  it('CSS tokenization: z-index must reference --z-* semantic tokens instead of magic numbers', () => {
    const violations: string[] = [];
    for (const file of cssFiles) {
      const clean = stripCssComments(file.content);
      const regex = /\bz-index\s*:\s*([^;]+);/gi;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(clean)) !== null) {
        const value = match[1].trim();
        if (!/^var\(--z-[a-z0-9-]+\)$/.test(value) && !/^(?:auto|inherit|initial|unset)$/.test(value)) {
          const line = clean.slice(0, match.index).split('\n').length;
          violations.push(`${file.rel}:${line} uses z-index: ${value}`);
        }
      }
    }
    expect(
      violations,
      '禁止在 CSS 中硬编码数字 z-index（易导致浮层互相遮挡）。请在 src/styles/tokens.css 的 :root 使用并复用语义令牌：var(--z-link) / var(--z-dock) / var(--z-placement) / var(--z-drawer) / var(--z-hud) / var(--z-toast) / var(--z-modal)。',
    ).toEqual([]);
  });

  it('L1 state machine boundary: App.tsx must derive panel visibility from StudioSurface instead of independent booleans', () => {
    const appFile = tsFiles.find(file => file.rel === 'App.tsx');
    expect(appFile).toBeDefined();
    const sf = ts.createSourceFile(appFile!.abs, appFile!.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const forbiddenHooks: string[] = [];
    let importsSurfaceReducer = false;

    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (node.moduleSpecifier.text.includes('surface-state')) importsSurfaceReducer = true;
      }
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const callee = node.initializer.expression;
        if (ts.isIdentifier(callee) && callee.text === 'useState') {
          for (const elem of node.name.elements) {
            if (ts.isBindingElement(elem) && ts.isIdentifier(elem.name)) {
              if (['showAssets', 'showScene', 'inspectorOpen'].includes(elem.name.text)) {
                forbiddenHooks.push(elem.name.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    expect(
      importsSurfaceReducer,
      'App.tsx 必须导入 src/surface-state.ts 的 reduceStudioSurface 与 surfaceFlags，保持互斥抽屉单一状态真源。',
    ).toBe(true);
    expect(
      forbiddenHooks,
      '禁止在 App.tsx 中为 showAssets / showScene / inspectorOpen 声明独立 useState（会导致同时点击 3D 资产与场景编辑冲突）。请在 src/surface-state.ts 中扩展 StudioSurface / SurfaceAction 并通过 dispatchSurface 转移状态。',
    ).toEqual([]);
  });

  it('Type safety & XSS redline: zero as any / as never / @ts-ignore / dangerouslySetInnerHTML, and legacy escapes strictly ratcheted', () => {
    const zeroToleranceViolations: string[] = [];
    const escapeViolations: string[] = [];

    for (const file of tsFiles) {
      const sf = ts.createSourceFile(file.abs, file.content, ts.ScriptTarget.Latest, true, file.ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let doubleUnknownCount = 0;

      function visit(node: ts.Node) {
        if (ts.isAsExpression(node)) {
          if (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.NeverKeyword) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            zeroToleranceViolations.push(`${file.rel}:${line + 1} uses unsafe cast`);
          }
          if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
            doubleUnknownCount += 1;
          }
        }
        if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          zeroToleranceViolations.push(`${file.rel}:${line + 1} uses dangerouslySetInnerHTML`);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) &&
          node.left.name.text === 'innerHTML'
        ) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          zeroToleranceViolations.push(`${file.rel}:${line + 1} assigns .innerHTML`);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);

      if (/@ts-ignore\b/.test(file.content)) {
        zeroToleranceViolations.push(`${file.rel} uses @ts-ignore`);
      }

      const tsExpectCount = (file.content.match(/@ts-expect-error\b/g) ?? []).length;
      const totalLegacyEscapes = doubleUnknownCount + tsExpectCount;
      const cap = LEGACY_TYPE_ESCAPE_RATCHET[file.rel] ?? 0;
      if (totalLegacyEscapes > cap) {
        escapeViolations.push(`${file.rel}: found ${totalLegacyEscapes} (ratchet cap ${cap})`);
      }
    }

    expect(
      zeroToleranceViolations,
      '严禁使用 as any / as never / @ts-ignore / dangerouslySetInnerHTML / .innerHTML = 。请使用类型守卫（如 m2-state.ts 模式）或 JSX 自动转义。',
    ).toEqual([]);
    expect(
      escapeViolations,
      '禁止新增 `as unknown as` 或 `@ts-expect-error` 类型逃生舱。请补充精确接口定义或运行期类型守卫，只允许减少 LEGACY_TYPE_ESCAPE_RATCHET 基线。',
    ).toEqual([]);
  });

  it('Network boundary ratchet: raw fetch() is restricted to src/api.ts and transport adapters', () => {
    const violations: string[] = [];
    for (const file of tsFiles) {
      if (RAW_FETCH_TRANSPORT_ALLOWLIST.has(file.rel)) continue;
      const sf = ts.createSourceFile(file.abs, file.content, ts.ScriptTarget.Latest, true, file.ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let fetchCalls = 0;
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
          fetchCalls += 1;
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
      const cap = RAW_FETCH_RATCHET[file.rel] ?? 0;
      if (fetchCalls > cap) {
        violations.push(`${file.rel}: raw fetch() count=${fetchCalls} (ratchet cap ${cap})`);
      }
    }
    expect(
      violations,
      '禁止在业务/UI 组件中直接新增裸 fetch()（会丢失 cache: no-store、超时信号与 ApiError 统一错误映射）。请改用 src/api.ts 导出的 api() / mutation()，或将新传输能力封装进 src/api.ts。',
    ).toEqual([]);
  });

  it('Context health ratchet: file line counts and useEffect counts must not exceed baseline limits', () => {
    const lineViolations: string[] = [];
    const effectViolations: string[] = [];

    for (const file of sources) {
      const defaultMax = file.ext === 'css' ? DEFAULT_MAX_CSS_LINES : DEFAULT_MAX_TS_LINES;
      const cap = FILE_LINE_RATCHET[file.rel] ?? defaultMax;
      if (file.lines > cap) {
        lineViolations.push(`${file.rel}: ${file.lines} lines (ratchet cap ${cap})`);
      }
    }

    for (const file of tsFiles) {
      const sf = ts.createSourceFile(file.abs, file.content, ts.ScriptTarget.Latest, true, file.ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let useEffectCalls = 0;
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') {
          useEffectCalls += 1;
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
      const cap = USE_EFFECT_RATCHET[file.rel] ?? DEFAULT_MAX_USE_EFFECTS;
      if (useEffectCalls > cap) {
        effectViolations.push(`${file.rel}: ${useEffectCalls} useEffect calls (ratchet cap ${cap})`);
      }
    }

    expect(
      lineViolations,
      '前端文件行数超出上限（防止上下文膨胀污染 Agent 注意力）。请将 UI 拆分为独立子组件、纯状态转移模块（*.ts）或按功能拆出样式文件。',
    ).toEqual([]);
    expect(
      effectViolations,
      '单组件 useEffect 数量超出上限（副作用链过多易引发循环更新与竞争态）。请将事件订阅或派生状态收敛为纯函数 reducer / 独立 Hook。',
    ).toEqual([]);
  });

  it('L2 bundle boundary: static entry import graph from main.tsx never eagerly pulls 3D engines', () => {
    const sourceByRel = new Map(tsFiles.map(file => [file.rel, file]));
    const HEAVY_3D_IMPORT = /^(?:three(?:\/|$)|@react-three\/|@spatial\/scene-renderer(?:\/|$))/;

    function collectRuntimeStaticSpecifiers(file: SourceEntry): string[] {
      const sf = ts.createSourceFile(
        file.abs,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        file.ext === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const specs: string[] = [];
      for (const stmt of sf.statements) {
        if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const clause = stmt.importClause;
          const allNamedTypeOnly = Boolean(
            clause &&
            !clause.name &&
            clause.namedBindings &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every(el => el.isTypeOnly),
          );
          if (clause?.isTypeOnly || allNamedTypeOnly) continue;
          specs.push(stmt.moduleSpecifier.text);
        } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const allNamedTypeOnly = Boolean(
            stmt.exportClause &&
            ts.isNamedExports(stmt.exportClause) &&
            stmt.exportClause.elements.length > 0 &&
            stmt.exportClause.elements.every(el => el.isTypeOnly),
          );
          if (stmt.isTypeOnly || allNamedTypeOnly) continue;
          specs.push(stmt.moduleSpecifier.text);
        }
      }
      return specs;
    }

    function resolveLocalTs(fromRel: string, spec: string): string | undefined {
      if (!spec.startsWith('./') && !spec.startsWith('../')) return undefined;
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
      const candidates = [joined];
      if (joined.endsWith('.js')) {
        candidates.push(joined.slice(0, -3) + '.ts', joined.slice(0, -3) + '.tsx');
      } else if (joined.endsWith('.jsx')) {
        candidates.push(joined.slice(0, -4) + '.tsx', joined.slice(0, -4) + '.ts');
      }
      candidates.push(
        `${joined}.ts`,
        `${joined}.tsx`,
        path.posix.join(joined, 'index.ts'),
        path.posix.join(joined, 'index.tsx'),
      );
      return candidates.find(candidate => sourceByRel.has(candidate));
    }

    expect(sourceByRel.has('main.tsx')).toBe(true);
    const visited = new Set<string>(['main.tsx']);
    const queue: Array<{ rel: string; chain: string[] }> = [{ rel: 'main.tsx', chain: ['main.tsx'] }];
    const violations: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const entry = sourceByRel.get(current.rel);
      if (!entry) continue;
      for (const spec of collectRuntimeStaticSpecifiers(entry)) {
        if (HEAVY_3D_IMPORT.test(spec)) {
          violations.push(`${current.chain.join(' -> ')} -> ${spec}`);
          continue;
        }
        const nextRel = resolveLocalTs(current.rel, spec);
        if (nextRel && !visited.has(nextRel)) {
          visited.add(nextRel);
          queue.push({ rel: nextRel, chain: [...current.chain, nextRel] });
        }
      }
    }

    expect(visited.has('App.tsx'), '入口依赖图遍历未能解析到 App.tsx，请检查 resolveLocalTs 逻辑。').toBe(true);
    expect(
      violations,
      '禁止首屏入口静态引入 3D 渲染依赖（three / @react-three/* / @spatial/scene-renderer）：这会把 ~1.1MB 3D 引擎打入首屏主包。请改为 React.lazy(() => import(...)) 按需懒加载含 3D 视口的组件，并在仅需类型时使用 import type。',
    ).toEqual([]);
  });
});
