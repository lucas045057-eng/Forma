import path from 'node:path';
import { transformSync, type NodePath, type types as t } from '@babel/core';
import MagicString from 'magic-string';
import type { Plugin } from 'vite';

function componentName(element: NodePath<t.JSXOpeningElement>): string {
  for (let parent: NodePath | null = element.parentPath; parent; parent = parent.parentPath) {
    let name: string | undefined;
    if (parent.isFunctionDeclaration() || parent.isFunctionExpression() || parent.isClassDeclaration()) {
      name = parent.node.id?.name;
    } else if (parent.isVariableDeclarator() && parent.node.id.type === 'Identifier') {
      name = parent.node.id.name;
    }
    if (name && /^[A-Z]/.test(name)) return name;
  }
  return 'Anonymous';
}

export function tagSource(code: string, filename: string, root: string) {
  const relative = path.relative(root, filename).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) return null;
  const output = new MagicString(code);
  transformSync(code, {
    filename,
    configFile: false,
    babelrc: false,
    code: false,
    ast: false,
    parserOpts: { sourceType: 'module', plugins: ['jsx', 'typescript'] },
    plugins: [() => ({
      visitor: {
        JSXOpeningElement(element: NodePath<t.JSXOpeningElement>) {
          const { name, loc, end, attributes } = element.node;
          if (name.type !== 'JSXIdentifier' || !/^[a-z]/.test(name.name) || !loc || end == null) return;
          // Reserved attributes are replaced; append after spreads so they cannot override the mapping.
          for (const attribute of attributes) {
            if (attribute.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' &&
                ['data-src', 'data-cid'].includes(attribute.name.name) && attribute.start != null && attribute.end != null) {
              output.remove(attribute.start, attribute.end);
            }
          }
          const src = `${relative}:${loc.start.line}:${loc.start.column + 1}`;
          const at = end - (element.node.selfClosing ? 2 : 1);
          output.appendLeft(at, ` data-src={${JSON.stringify(src)}} data-cid={${JSON.stringify(componentName(element))}}`);
        },
      },
    })],
  });
  return { code: output.toString(), map: output.generateMap({ hires: true, source: filename, includeContent: true }) };
}

export default function sourceTag(): Plugin {
  let root: string;
  return {
    name: 'spatial-source-tag',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) { root = config.root; },
    transform(code, id) {
      const filename = id.split('?')[0];
      if (!/\.[jt]sx$/.test(filename) || filename.replaceAll('\\', '/').includes('/node_modules/')) return null;
      return tagSource(code, filename, root);
    },
  };
}
