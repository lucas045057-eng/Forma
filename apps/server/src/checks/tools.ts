import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const templateRoot = path.join(projectRoot, 'templates/product-page');
export const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
export const workspaceRoots = ['shared', 'bridge', 'scene-renderer'].map(name => path.join(projectRoot, 'packages', name));

export async function browserAliases(): Promise<Record<string, string>> {
  return {
    react: await realpath(path.join(templateRoot, 'node_modules/react')),
    'react-dom': await realpath(path.join(templateRoot, 'node_modules/react-dom')),
    three: await realpath(path.join(projectRoot, 'packages/scene-renderer/node_modules/three')),
    '@spatial/shared': path.join(workspaceRoots[0], 'src/index.ts'),
    '@spatial/shared/scene-config': path.join(workspaceRoots[0], 'src/scene-config.ts'),
    '@spatial/shared/scene-edit': path.join(workspaceRoots[0], 'src/scene-edit.ts'),
    '@spatial/bridge': path.join(workspaceRoots[1], 'src/index.ts'),
    '@spatial/scene-renderer': path.join(workspaceRoots[2], 'src/index.tsx'),
  };
}

export async function toolVersions() {
  const entries = await Promise.all(['vite', '@vitejs/plugin-react', '@playwright/test'].map(async name => {
    const value = JSON.parse(await readFile(path.join(serverRoot, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown };
    if (typeof value.version !== 'string') throw new Error('CHECK_TOOLS_MISSING: 工具版本不可读取');
    return [name, value.version] as const;
  }));
  return Object.fromEntries(entries);
}

/** Only code/tool inputs are fingerprinted; provider configuration is never read. */
export async function getCheckToolsIdentity(): Promise<string> {
  const hash = createHash('sha256').update(JSON.stringify(await toolVersions()));
  const walk = async (dir: string) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (/\.(?:ts|tsx|js|json)$/.test(entry.name) && !/\.test\./.test(entry.name)) hash.update(file.substring(projectRoot.length)).update(await readFile(file));
    }
  };
  await walk(fileURLToPath(new URL('./', import.meta.url)));
  for (const root of workspaceRoots) await walk(path.join(root, 'src'));
  hash.update(await readFile(path.join(projectRoot, 'pnpm-lock.yaml')));
  return hash.digest('hex');
}

export function workerPermissions(buildRoot: string): string[] {
  const reads = [
    buildRoot, fileURLToPath(new URL('./', import.meta.url)),
    fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../assets/atomic-file.ts' : '../assets/atomic-file.js', import.meta.url)),
    path.join(projectRoot, 'node_modules'), path.join(serverRoot, 'node_modules'), path.join(templateRoot, 'node_modules'),
    path.join(projectRoot, 'package.json'), path.join(projectRoot, 'pnpm-lock.yaml'),
    path.join(serverRoot, 'package.json'), path.join(templateRoot, 'package.json'), ...workspaceRoots,
  ];
  return ['--permission', '--allow-child-process', '--allow-addons', '--max-old-space-size=1024',
    ...reads.map(file => '--allow-fs-read=' + file), '--allow-fs-write=' + buildRoot];
}
