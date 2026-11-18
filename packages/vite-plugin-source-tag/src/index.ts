import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { transformSync, type NodePath, type types as t } from '@babel/core';
import MagicString from 'magic-string';
import type { Plugin } from 'vite';

function runtimeValue(node: t.Node | null | undefined): t.Node | null | undefined {
  while (node?.type === 'TSAsExpression' || node?.type === 'TSSatisfiesExpression' || node?.type === 'TSNonNullExpression' || node?.type === 'ParenthesizedExpression' || node?.type === 'TypeCastExpression') node = node.expression;
  return node;
}
function componentValue(value: t.Node | null | undefined): boolean {
  const node = runtimeValue(value);
  if (!node) return false;
  if (['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(node.type)) return true;
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  const wrapper = callee.type === 'Identifier' ? callee.name :
    callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' &&
    callee.object.name === 'React' && callee.property.type === 'Identifier' ? callee.property.name : '';
  return ['memo', 'forwardRef'].includes(wrapper) && componentValue(node.arguments[0]);
}
function expressionBinding(expression: NodePath): string | undefined {
  let value = expression;
  while (value.parentPath) {
    const parent = value.parentPath;
    if (runtimeValue(parent.node) !== parent.node ||
        (parent.isCallExpression() && parent.node.arguments[0] === value.node && componentValue(parent.node))) {
      value = parent;
      continue;
    }
    if (parent.isVariableDeclarator() && parent.node.init === value.node && parent.node.id.type === 'Identifier' && /^[A-Z]/.test(parent.node.id.name)) {
      return parent.node.id.name;
    }
    break;
  }
}
function componentName(element: NodePath<t.JSXOpeningElement>): string {
  for (let parent: NodePath | null = element.parentPath; parent; parent = parent.parentPath) {
    let name: string | undefined;
    if (parent.isFunctionDeclaration() || parent.isClassDeclaration()) name = parent.node.id?.name;
    else if (parent.isFunctionExpression() || parent.isClassExpression()) name = expressionBinding(parent) ?? parent.node.id?.name;
    else if (parent.isArrowFunctionExpression()) name = expressionBinding(parent);
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return 'Anonymous';
}

export function tagSource(code: string, filename: string, root: string) {
  const relative = path.relative(root, filename).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
  const output = new MagicString(code);
  const removed = new WeakSet<t.JSXAttribute>();
  transformSync(code, {
    filename, configFile: false, babelrc: false, code: false, ast: false,
    parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
    plugins: [() => ({ visitor: {
      JSXAttribute(attribute: NodePath<t.JSXAttribute>) {
        if (removed.has(attribute.node)) attribute.skip();
      },
      JSXOpeningElement(element: NodePath<t.JSXOpeningElement>) {
        const { name, loc, end, attributes } = element.node;
        if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name) || !loc || end == null) return;
        // Remove before inserting at adjacent boundaries; skip descendants when visited later.
        for (const attribute of attributes) {
          if (attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' &&
              ['data-src', 'data-cid'].includes(attribute.name.name) && attribute.start != null && attribute.end != null) {
            output.remove(attribute.start, attribute.end);
            removed.add(attribute);
          }
        }
        const src = `${relative}:${loc.start.line}:${loc.start.column + 1}`;
        output.appendLeft(end - (element.node.selfClosing ? 2 : 1), ` data-src={${JSON.stringify(src)}} data-cid={${JSON.stringify(componentName(element))}}`);
      },
    } })],
  });
  return { code: output.toString(), map: output.generateMap({ hires: true, source: filename, includeContent: true }) };
}
export async function recoverNonEmptySource(code: string, filename: string, delaysMs = [15, 25, 40, 60, 80, 100]): Promise<string> {
  if (code.trim().length > 0) return code;
  for (const delayMs of delaysMs) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const disk = await readFile(filename, 'utf8');
      if (disk.trim().length > 0) return disk;
    } catch {
      // Transient ENOENT/EBUSY while git checkout/merge/revert updates the work tree on Windows.
    }
  }
  throw new Error(`Refusing to cache empty JSX/TSX module during concurrent file update: ${filename}`);
}

export default function sourceTag(): Plugin {
  let root: string;
  return {
    name: 'spatial-source-tag', apply: 'serve', enforce: 'pre',
    configResolved(config) { root = config.root; },
    async transform(code, id) {
      const filename = id.split('?')[0];
      if (!/\.[jt]sx$/.test(filename) || filename.replaceAll('\\', '/').includes('/node_modules/')) return null;
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
      const resolved = await recoverNonEmptySource(code, filename);
      return tagSource(resolved, filename, root);
    },
  };
}
