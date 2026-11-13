import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSceneConfig } from '@spatial/shared/scene-config';

/** Raised for anything the model asked for that the sandbox refuses; the text goes back to the model. */
export class ToolError extends Error {}

const WRITABLE = /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tsx|ts|css|json|svg)$/;
const READABLE = /^(?:src|public)\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$|^(?:index\.html|package\.json)$/;
const MAX_READ = 200_000, MAX_WRITE = 200_000;

export const toolDefinitions = [
  { type: 'function', function: { name: 'list_files', description: '列出作品 src/ 下的全部源码文件（相对路径）。', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
  { type: 'function', function: { name: 'read_file', description: '读取一个文件的完整内容。路径相对作品根目录，例如 src/App.tsx。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
  { type: 'function', function: { name: 'replace_in_file', description: '把文件中恰好出现一次的 old 文本替换为 new。old 必须与文件内容逐字符一致（含缩进），且只出现一次；改动小时优先用它。', parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'], additionalProperties: false } } },
  { type: 'function', function: { name: 'write_file', description: '用给定内容整体写入 src/ 下的一个文件（新建或覆盖）。只在需要新建文件或大幅改写时使用。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } } },
  { type: 'function', function: { name: 'finish', description: '修改全部完成后调用，用一两句中文说明改了什么。', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } },
] as const;

/** File access confined to one candidate worktree. There is deliberately no command execution. */
export class Sandbox {
  private root: string;
  readonly written = new Set<string>();
  constructor(root: string) { this.root = root; }

  private async resolve(relative: unknown, pattern: RegExp, action: string) {
    if (typeof relative !== 'string') throw new ToolError('path 必须是字符串');
    const normalized = relative.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!pattern.test(normalized) || normalized.split('/').includes('..')) {
      throw new ToolError(`不允许${action}这个路径：${relative}。${action === '写入' ? '只能写 src/ 下的 .tsx/.ts/.css/.json/.svg 文件；依赖与构建配置不可修改。' : '只能读取 src/、public/ 下的文件以及 index.html、package.json。'}`);
    }
    const root = await realpath(this.root);
    let current = root;
    for (const part of normalized.split('/')) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new ToolError('路径不得经过符号链接'); }
      catch (error) { if (error instanceof ToolError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return { absolute: current, relative: normalized };
  }
  async list() {
    const root = await realpath(this.root), result: string[] = [];
    const walk = async (folder: string) => {
      for (const entry of await readdir(path.join(root, folder), { withFileTypes: true })) {
        const relative = `${folder}/${entry.name}`;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(relative);
        else if (entry.isFile()) result.push(relative);
        if (result.length > 500) throw new ToolError('文件过多');
      }
    };
    await walk('src');
    return result.sort().join('\n');
  }
  async read(file: unknown) {
    const target = await this.resolve(file, READABLE, '读取');
    let content: Buffer;
    try { content = await readFile(target.absolute); }
    catch { throw new ToolError(`文件不存在：${target.relative}`); }
    if (content.byteLength > MAX_READ) throw new ToolError('文件过大，无法读取');
    if (content.includes(0)) throw new ToolError('这是二进制文件，无法作为文本读取');
    return content.toString('utf8');
  }
  private async store(target: { absolute: string; relative: string }, content: string) {
    if (Buffer.byteLength(content) > MAX_WRITE) throw new ToolError('内容过大');
    if (target.relative === 'src/scene.config.json') {
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { throw new ToolError('scene.config.json 必须是合法 JSON'); }
      if (!isSceneConfig(parsed)) throw new ToolError('scene.config.json 不符合场景配置的约定（字段、取值范围或关键帧顺序）');
    } else if (target.relative.endsWith('.json')) {
      try { JSON.parse(content); } catch { throw new ToolError('JSON 文件内容不是合法 JSON'); }
    }
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, content);
    this.written.add(target.relative);
  }
  async write(file: unknown, content: unknown) {
    if (typeof content !== 'string') throw new ToolError('content 必须是字符串');
    const target = await this.resolve(file, WRITABLE, '写入');
    await this.store(target, content);
    return `已写入 ${target.relative}（${content.split('\n').length} 行）`;
  }
  async replace(file: unknown, before: unknown, after: unknown) {
    if (typeof before !== 'string' || typeof after !== 'string' || !before) throw new ToolError('old 与 new 必须是字符串，old 不能为空');
    const target = await this.resolve(file, WRITABLE, '写入');
    const current = await this.read(target.relative);
    // Files are stored with whatever line endings they had; match the model's \n against both.
    const variants = [before, before.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')];
    const needle = variants.find(candidate => current.includes(candidate));
    if (!needle) throw new ToolError('old 文本在文件中找不到。请先 read_file 确认逐字符一致（含空格与缩进）。');
    if (current.split(needle).length !== 2) throw new ToolError('old 文本在文件中出现多次。请加入更多上下文使其唯一。');
    const replacement = needle.includes('\r\n') ? after.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : after;
    await this.store(target, current.replace(needle, () => replacement));
    return `已修改 ${target.relative}`;
  }
}
