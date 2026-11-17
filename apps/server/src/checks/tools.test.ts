import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { browserAliases, projectRoot } from './tools.ts';

/**
 * The check build runs from a snapshot without node_modules, so every workspace import made by
 * the canonical runtime must be supplied as an exact alias. Derive the requirement from the real
 * runtime source instead of restating it: a new subpath import fails here until the build map has
 * an exact entry, and the entry may only point at that module (never a broad directory alias).
 */
it('aliases every @spatial/shared subpath imported by the canonical runtime', async () => {
  const runtime = await readFile(path.join(projectRoot, 'templates/product-page/src/spatial-module.tsx'), 'utf8');
  const specifiers = [...new Set([...runtime.matchAll(/from\s+['"](@spatial\/shared\/[^'"]+)['"]/g)].map(match => match[1]))].sort();
  expect(specifiers).toEqual(expect.arrayContaining(['@spatial/shared/scene-module']));

  const aliases = await browserAliases();
  for (const specifier of specifiers) {
    const target = aliases[specifier];
    expect(target, `${specifier} 缺少构建别名`).toBeTruthy();
    expect(existsSync(target), `${specifier} 的别名目标不存在`).toBe(true);
    expect(path.dirname(target), `${specifier} 只能指向 shared 源码目录`).toBe(path.join(projectRoot, 'packages/shared/src'));
    expect(path.basename(target), `${specifier} 必须指向同名模块而不是包入口`).toBe(`${specifier.split('/').pop()}.ts`);
  }
  expect(aliases['@spatial/shared'], '包入口仍须是 index.ts，不能改成目录级放行').toBe(path.join(projectRoot, 'packages/shared/src/index.ts'));
});
