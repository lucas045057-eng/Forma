import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Sandbox, ToolError } from './tools.ts';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'spatial-sandbox-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.tsx'), '<button>立即购买</button>\n');
  await writeFile(path.join(root, 'package.json'), '{}\n');
  return root;
}

it('reads and replaces source but refuses escapes, configuration writes and oversized content', async () => {
  const root = await fixture();
  try {
    const sandbox = new Sandbox(root);
    expect(await sandbox.list()).toBe('src/App.tsx');
    expect(await sandbox.replace('src/App.tsx', '立即购买', '马上购买')).toContain('已修改');
    expect(await readFile(path.join(root, 'src', 'App.tsx'), 'utf8')).toContain('马上购买');
    await expect(sandbox.write('../outside.ts', 'bad')).rejects.toThrow(ToolError);
    await expect(sandbox.write('package.json', '{}')).rejects.toThrow(ToolError);
    await expect(sandbox.write('src/App.tsx', 'x'.repeat(200_001))).rejects.toThrow('内容过大');
    await expect(sandbox.read('/etc/passwd')).rejects.toThrow(ToolError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects writes through a junction even when the normalized path stays under src', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(tmpdir(), 'spatial-outside-'));
  try {
    await symlink(outside, path.join(root, 'src', 'linked'), 'junction');
    const sandbox = new Sandbox(root);
    await expect(sandbox.write('src/linked/escape.ts', 'bad')).rejects.toThrow('路径不得经过符号链接');
    expect(await readFile(path.join(root, 'src', 'App.tsx'), 'utf8')).toContain('立即购买');
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

it('validates JSON and scene configuration before writing', async () => {
  const root = await fixture();
  try {
    const sandbox = new Sandbox(root);
    await expect(sandbox.write('src/data.json', '{bad')).rejects.toThrow('合法 JSON');
    await expect(sandbox.write('src/scene.config.json', '{}')).rejects.toThrow('场景配置');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('strips empty CSS @import placeholders and rejects external network imports or uninstalled npm packages', async () => {
  const root = await fixture();
  try {
    const sandbox = new Sandbox(root);
    await sandbox.write('src/style.css', "@import url('');\nbody { margin: 0; background: #f8f8f5; }\n");
    const savedCss = await readFile(path.join(root, 'src/style.css'), 'utf8');
    expect(savedCss).not.toContain('@import');
    expect(savedCss).toContain('background: #f8f8f5');

    await expect(sandbox.write('src/style.css', '@import url("https://fonts.googleapis.com/css");\n')).rejects.toThrow('外网');
    await expect(sandbox.write('src/App.tsx', 'import { Sparkles } from "lucide-react";\nexport default () => <main />;\n')).rejects.toThrow('lucide-react');
    await expect(sandbox.write('src/App.tsx', 'export default () => <main><img src="https://example.com/a.jpg" /></main>;\n')).rejects.toThrow('外网媒体');
    await expect(sandbox.write('src/App.tsx', 'export default () => <main><h1>unclosed</main>;\n')).rejects.toThrow('语法错误');
    await expect(sandbox.write('src/spatial-module.tsx', 'export const x = 1;\n')).rejects.toThrow('pointerEvents');
    await expect(sandbox.write('src/scene-modules/abc.json', '{}\n')).rejects.toThrow('pointerEvents');
  } finally { await rm(root, { recursive: true, force: true }); }
});
