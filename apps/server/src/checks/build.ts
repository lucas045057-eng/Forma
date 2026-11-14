import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import react from '@vitejs/plugin-react';
import { build, createLogger, type InlineConfig, type Plugin } from 'vite';
import type { CheckResult } from '@spatial/shared';
import type { CheckContext } from './runner.ts';
import { writeAtomic } from '../assets/atomic-file.ts';
import { browserAliases, projectRoot, workspaceRoots, toolVersions } from './tools.ts';

const topPackages = new Set(['react', 'react-dom', '@spatial/shared', '@spatial/bridge', '@spatial/scene-renderer']);
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const denied = () => new Error('UNSAFE_IMPORT: 只允许快照内文件与已声明的浏览器依赖');
const cleanId = (value: string) => value.split(/[?#]/, 1)[0];
function decode(value: string) {
  try { return decodeURIComponent(value); } catch { throw denied(); }
}

/** Candidate requests are checked before a compiler/plugin can open a resource. */
function candidateSpecifier(specifier: string, importer: string, root: string, css = false) {
  const value = decode(specifier.trim());
  if (css && (value.startsWith('#') || /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i.test(value))) return;
  if (!value || value.includes('\0') || value.startsWith('//') || value.startsWith('/@fs/') || value.includes('\\')) throw denied();
  const file = cleanId(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !path.isAbsolute(file)) throw denied();
  const isFile = css || file.startsWith('.') || file.startsWith('/') || path.isAbsolute(file);
  if (isFile) {
    let target: string;
    if (inside(root, file) && path.isAbsolute(file)) target = file;
    else if (/^\/(?:src|assets|public)\//.test(file)) target = path.join(root, file.startsWith('/assets/') ? 'public' + file : file.substring(1));
    else if (path.isAbsolute(file)) throw denied();
    else target = path.resolve(path.dirname(cleanId(importer)), file);
    if (!inside(path.join(root, 'src'), target) && !inside(path.join(root, 'public'), target)) throw denied();
  } else {
    const parts = file.split('/');
    if (parts.some(part => part === '..' || part === '.' || !part)) throw denied();
    const pkg = file.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!topPackages.has(pkg)) throw denied();
  }
}

async function auditSources(ctx: CheckContext) {
  for (const entry of ctx.snapshot.entries) {
    ctx.signal.throwIfAborted();
    if (!entry.path.startsWith('src/')) continue;
    const file = path.resolve(ctx.buildRoot, entry.path);
    if (!inside(path.join(ctx.buildRoot, 'src'), file)) throw denied();
    if (/\.tsx?$/.test(file)) {
      const source = await readFile(file, 'utf8');
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) candidateSpecifier(node.moduleSpecifier.text, file, ctx.buildRoot);
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
          const arg = node.arguments[0];
          if (arg && ts.isStringLiteral(arg)) candidateSpecifier(arg.text, file, ctx.buildRoot);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    } else if (file.endsWith('.css')) {
      const source = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6}\s?|.)/gi, (_, value: string) => /^[0-9a-f]/i.test(value) ? String.fromCodePoint(parseInt(value.trim(), 16)) : value);
      const resources = source.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)|@import\s+["']([^"']+)["']/gi);
      for (const match of resources) candidateSpecifier(match[1] ?? match[2] ?? match[3] ?? match[4], file, ctx.buildRoot, true);
    }
  }
}

async function boundary(root: string): Promise<Plugin> {
  const aliases = await browserAliases();
  const modules = await realpath(path.join(projectRoot, 'node_modules'));
  const allowed = [root, modules, ...workspaceRoots];
  const alias = (request: string) => {
    if (aliases[request]) return aliases[request];
    for (const pkg of ['react-dom', 'react', 'three']) if (request.startsWith(pkg + '/')) return path.join(aliases[pkg], request.substring(pkg.length + 1));
    return request;
  };
  return {
    name: 'checks-input-boundary', enforce: 'pre',
    async resolveId(request, importer, options) {
      const local = importer && inside(root, cleanId(importer));
      // Vite injects exactly this trusted virtual import into our generated HTML.
      const generatedPreload = request === 'vite/modulepreload-polyfill' && importer &&
        path.resolve(cleanId(importer)) === path.join(root, 'index.html');
      if (local && !generatedPreload) candidateSpecifier(request, importer, root);
      const result = await this.resolve(alias(request), importer, { ...options, skipSelf: true });
      if (!result) return null;
      if (result.id.startsWith('\0') || result.id.startsWith('__vite-browser-external')) return result;
      if (result.external) { if (local) throw denied(); return result; }
      const resolved = cleanId(result.id);
      if (!path.isAbsolute(resolved)) throw denied();
      const canonical = await realpath(resolved);
      if (!allowed.some(area => inside(area, canonical))) throw denied();
      return result;
    },
  };
}

/** Only invoked inside the fixed permission-constrained worker. */
export async function checkBuild(ctx: CheckContext): Promise<CheckResult> {
  const startedAt = Date.now();
  let log = '';
  const append = (message: string) => { log = (log + message + '\n').slice(-90_000); };
  try {
    ctx.signal.throwIfAborted();
    await auditSources(ctx);
    const versions = await toolVersions();
    append('Vite ' + versions.vite + ', React plugin ' + versions['@vitejs/plugin-react']);
    const html = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
    await writeAtomic(path.join(ctx.buildRoot, 'index.html'), html, ctx.signal);
    const logger = createLogger('silent', { allowClearScreen: false });
    logger.warn = message => append(message);
    logger.warnOnce = message => append(message);
    logger.error = message => append(message);
    const config: InlineConfig = {
      root: ctx.buildRoot, base: './', configFile: false, envFile: false, envDir: ctx.buildRoot,
      cacheDir: path.join(ctx.buildRoot, '.vite-cache'), publicDir: path.join(ctx.buildRoot, 'public'),
      // Even build() resolves server defaults; suppress its upward workspace search.
      server: { fs: { allow: [ctx.buildRoot] } },
      mode: 'production', customLogger: logger, clearScreen: false,
      plugins: [await boundary(ctx.buildRoot), react({ babel: { babelrc: false, configFile: false } })],
      css: { postcss: { plugins: [] } },
      // Vite merges object tsconfigRaw with disk configs; a string suppresses that search.
      esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: 'react-jsx', target: 'ES2022', useDefineForClassFields: true } }) },
      build: { outDir: path.join(ctx.buildRoot, 'dist'), emptyOutDir: true, sourcemap: false, watch: null,
        rollupOptions: { input: path.join(ctx.buildRoot, 'index.html') } },
    };
    await build(config);
    ctx.signal.throwIfAborted();
    if (!(await stat(path.join(ctx.buildRoot, 'dist/index.html'))).size) throw new Error('BUILD_EMPTY: HTML产物为空');
    append('BUILD PASSED');
    const ref = await ctx.writeArtifact('build.log', log);
    return { name: 'build', status: 'passed', evidence: ref.hash, durationMs: Date.now() - startedAt };
  } catch (error) {
    const details: string[] = [];
    const seen = new Set<unknown>();
    const explain = (value: unknown) => {
      if (!value || typeof value !== 'object' || seen.has(value) || seen.size >= 5) return;
      seen.add(value);
      const item = value as { code?: unknown; resource?: unknown; stack?: unknown; cause?: unknown };
      if (typeof item.resource === 'string') details.push('resource=' + item.resource);
      if (typeof item.stack === 'string') details.push(item.stack.split('\n').slice(0, 5).join('\n'));
      explain(item.cause);
    };
    explain(error);
    const code = (error as NodeJS.ErrnoException).code;
    const resource = (error as { resource?: unknown }).resource;
    const message = code === 'ERR_ACCESS_DENIED' ? 'UNSAFE_IMPORT: 构建读取超出允许范围：' +
      (typeof resource === 'string' ? resource.substring(0, 350) : 'unknown') :
      (error instanceof Error ? error.message : 'BUILD_ERROR').replace(/file:\/\/[^\s]+/g, '<path>').substring(0, 600);
    append('BUILD FAILED: ' + message + '\n' + details.join('\n'));
    const ref = await ctx.writeArtifact('build.log', log);
    return { name: 'build', status: 'failed', message: message + '\n' + details.join('\n').substring(0, 2000), evidence: ref.hash, durationMs: Date.now() - startedAt };
  }
}

/** Kept as a narrow shared assertion for callers inspecting resolved paths. */
export function assertSafeResolution(resolved: string, allowedRoots: string[]) {
  if (!allowedRoots.some(root => inside(root, resolved))) throw denied();
}
