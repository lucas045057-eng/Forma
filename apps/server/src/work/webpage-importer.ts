import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { permittedWorkPath } from './path-policy.ts';
import { WorkError } from './repo.ts';
import { compileHtmlToReactWork, sanitizeImportedCss } from './html-import.ts';
import { linkWorkDependencies, scaffoldRuntimeBase } from './starter-templates.ts';

export type ImportWorkRequest =
  | { mode: 'html'; name?: string; html: string; css?: string }
  | { mode: 'files'; name?: string; files: Array<{ path: string; contentBase64: string }> }
  | { mode: 'directory'; name?: string; directoryPath: string }
  | { mode: 'url'; name?: string; url: string };

export interface PreparedImportResult {
  name: string;
  sourceLabel: string;
  kind: 'html' | 'react';
  importedFiles: number;
}

export interface ImporterInternalOptions {
  fetchImpl?: typeof fetch;
  allowLoopbackForTest?: boolean;
  protectedRoots?: string[];
}

const MAX_IMPORT_FILES = 250;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif']);
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.vite', '.cache', 'coverage']);

function asciiSlug(rawName: string, fallbackPrefix: string, index: number): string {
  const parsed = path.posix.parse(rawName.replaceAll('\\', '/'));
  const ext = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = parsed.name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  const stem = base && !/^(?:secret|credential|backup)/i.test(base) ? base : `${fallbackPrefix}-${index}`;
  return ext ? `${stem}${ext}` : stem;
}

function normalizeRelativeInputPath(rawPath: string): string | null {
  const unified = rawPath.replaceAll('\\', '/').trim().replace(/^\/+|\/+$/g, '');
  if (!unified || unified.includes('\0')) return null;
  const parts = unified.split('/').filter(Boolean);
  if (parts.length === 0 || parts.length > 12) return null;
  if (parts.some(part => part === '.' || part === '..' || part.startsWith('.') || IGNORED_DIRS.has(part.toLowerCase()))) {
    return null;
  }
  if (parts.some(part => /(?:secret|credential|private.?key|backup)/i.test(part) || /\.(?:pem|key|crt|p12|pfx|bak|tmp|old|orig|env)$/i.test(part))) {
    return null;
  }
  return parts.join('/');
}

function stripSharedTopFolder(entries: Array<{ relPath: string; bytes: Buffer }>): Array<{ relPath: string; bytes: Buffer }> {
  if (entries.length === 0) return entries;
  const firstSegments = new Set(entries.map(item => item.relPath.split('/')[0]));
  if (firstSegments.size !== 1) return entries;
  const onlyRoot = [...firstSegments][0];
  if (onlyRoot === 'src' || onlyRoot === 'public') return entries;
  if (!entries.every(item => item.relPath.includes('/'))) return entries;
  return entries.map(item => ({
    relPath: item.relPath.slice(onlyRoot.length + 1),
    bytes: item.bytes,
  }));
}

function isPrivateOrReservedIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true;
    }
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateOrReservedIp(mapped);
    }
    return false;
  }
  return true;
}

async function assertSafeRemoteUrl(rawUrl: string, allowLoopbackForTest = false): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new WorkError('INVALID_URL', '请输入合法的 http:// 或 https:// 网页地址', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WorkError('INVALID_URL', '仅支持 http:// 或 https:// 网页地址', 400);
  }
  if (parsed.username || parsed.password) {
    throw new WorkError('INVALID_URL', '网页地址不得包含账号或密码凭据', 400);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new WorkError('INVALID_URL', '网页地址缺少有效域名', 400);

  if (allowLoopbackForTest && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')) {
    return parsed;
  }

  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new WorkError('URL_HOST_DENIED', '安全策略禁止拉取内网或本机私有服务地址；本机网页请使用“上传文件/文件夹”或“本机目录”导入', 400);
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new WorkError('URL_HOST_DENIED', '安全策略禁止拉取内网、回环或云元数据地址', 400);
    }
    return parsed;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new WorkError('URL_UNREACHABLE', `无法解析域名 ${hostname}`, 400);
  }
  if (!resolved.length || resolved.some(entry => isPrivateOrReservedIp(entry.address))) {
    throw new WorkError('URL_HOST_DENIED', '目标域名解析到内网或保留地址，已拒绝连接', 400);
  }
  return parsed;
}

async function fetchBoundedBytes(
  rawUrl: string,
  maxBytes: number,
  options: ImporterInternalOptions,
  timeoutMs = 15_000,
): Promise<{ finalUrl: URL; bytes: Buffer; contentType: string }> {
  const fetchFn = options.fetchImpl ?? fetch;
  let currentUrl = await assertSafeRemoteUrl(rawUrl, options.allowLoopbackForTest);

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response: Response;
    try {
      response = await fetchFn(currentUrl.href, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': 'FormaSpatialWorkbench/1.0 (+local-import)',
          accept: 'text/html,text/css,image/*,*/*;q=0.8',
        },
      });
    } catch {
      throw new WorkError('URL_FETCH_FAILED', `无法连接目标网页：${currentUrl.origin}`, 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location || redirects === 3) {
        throw new WorkError('URL_FETCH_FAILED', '目标网页重定向次数过多或缺少跳转目标', 502);
      }
      currentUrl = await assertSafeRemoteUrl(new URL(location, currentUrl).href, options.allowLoopbackForTest);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new WorkError('URL_FETCH_FAILED', `目标网页返回 HTTP ${response.status}`, 502);
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!response.body) {
      return { finalUrl: currentUrl, bytes: Buffer.alloc(0), contentType };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new WorkError('IMPORT_TOO_LARGE', `远程资源超过大小上限（${Math.round(maxBytes / 1024)} KiB）`, 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return { finalUrl: currentUrl, bytes: Buffer.concat(chunks), contentType };
  }
  throw new WorkError('URL_FETCH_FAILED', '无法读取目标网页', 502);
}

function resolveRelativePosix(fromFile: string, rawRef: string): string | null {
  const clean = rawRef.split(/[?#]/, 1)[0].trim().replaceAll('\\', '/');
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return null;
  if (clean.startsWith('/')) {
    return path.posix.normalize(clean.slice(1));
  }
  const dir = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(dir === '.' ? clean : `${dir}/${clean}`);
  if (joined.startsWith('..')) return null;
  return joined;
}

async function importFromFileMap(input: {
  entries: Array<{ relPath: string; bytes: Buffer }>;
  targetWorkRoot: string;
  explicitName?: string;
  fallbackName: string;
  sourceLabel: string;
  dependencySourceRoots: string[];
}): Promise<PreparedImportResult> {
  const normalizedEntries = stripSharedTopFolder(input.entries);
  const byPath = new Map<string, Buffer>();
  const byLowerPath = new Map<string, { relPath: string; bytes: Buffer }>();
  for (const entry of normalizedEntries) {
    byPath.set(entry.relPath, entry.bytes);
    byLowerPath.set(entry.relPath.toLowerCase(), entry);
  }

  const lookupEntry = (candidate: string | null) => {
    if (!candidate) return undefined;
    const direct = byPath.get(candidate);
    if (direct) return { relPath: candidate, bytes: direct };
    return byLowerPath.get(candidate.toLowerCase());
  };

  // Case A: React / Vite source project (has src/App.tsx or src/App.jsx)
  const reactAppEntry = lookupEntry('src/App.tsx') ?? lookupEntry('src/App.jsx');
  if (reactAppEntry) {
    let inferredTitle = input.explicitName?.trim() || '';
    const indexHtml = lookupEntry('index.html');
    if (!inferredTitle && indexHtml) {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(indexHtml.bytes.toString('utf8'));
      if (m?.[1]?.trim()) inferredTitle = m[1].replace(/\s+/g, ' ').trim().slice(0, 60);
    }
    const workName = (inferredTitle || input.fallbackName).slice(0, 60);
    await scaffoldRuntimeBase({
      targetWorkRoot: input.targetWorkRoot,
      name: workName,
      dependencySourceRoots: input.dependencySourceRoots,
      linkDeps: false,
    });

    const reservedSrc = new Set([
      'src/main.tsx',
      'src/main.jsx',
      'src/main.ts',
      'src/main.js',
      'src/spatial-module.tsx',
      'src/scene-config-store.ts',
      'src/scene.config.json',
    ]);

    let copiedCount = 0;
    let hasStyleCss = false;
    let appSourceText = '';

    for (const { relPath, bytes } of normalizedEntries) {
      const lower = relPath.toLowerCase();
      if (reservedSrc.has(lower) || lower.startsWith('src/spatial-module') || lower.startsWith('src/scene-modules/')) {
        continue;
      }
      if (lower.startsWith('public/assets/') && lower.endsWith('.glb')) {
        continue;
      }
      if (!lower.startsWith('src/') && !lower.startsWith('public/')) {
        continue;
      }

      // Convert .jsx -> .tsx so TypeScript + Vite source-tag plugin process uniformly
      let targetRel = relPath.endsWith('.jsx') ? `${relPath.slice(0, -4)}.tsx` : relPath;
      // Sanitize each path segment under src/ or public/ to permittedWorkPath ASCII
      const parts = targetRel.split('/');
      const sanitizedParts = [
        parts[0],
        ...parts.slice(1).map((seg, idx) => asciiSlug(seg, 'file', copiedCount * 10 + idx)),
      ];
      targetRel = sanitizedParts.join('/');
      if (!permittedWorkPath(targetRel)) continue;

      const destAbs = path.join(input.targetWorkRoot, targetRel);
      await mkdir(path.dirname(destAbs), { recursive: true });

      if (targetRel.endsWith('.css')) {
        const cleanedCss = sanitizeImportedCss(bytes.toString('utf8'));
        await writeFile(destAbs, cleanedCss + '\n');
        if (targetRel === 'src/style.css') hasStyleCss = true;
      } else if (targetRel === 'src/App.tsx') {
        appSourceText = bytes.toString('utf8');
        await writeFile(destAbs, appSourceText);
      } else {
        await writeFile(destAbs, bytes);
      }
      copiedCount += 1;
    }

    if (!hasStyleCss) {
      await writeFile(path.join(input.targetWorkRoot, 'src', 'style.css'), 'body { margin: 0; }\n');
    }

    // Ensure #root main[data-spatial-page] exists for Forma smoke/occlusion gates & spatial placement
    if (!/\bdata-spatial-page\b/.test(appSourceText)) {
      if (/<main\b/.test(appSourceText)) {
        const patched = appSourceText.replace(/<main\b/, '<main data-spatial-page');
        await writeFile(path.join(input.targetWorkRoot, 'src', 'App.tsx'), patched);
      } else {
        await writeFile(path.join(input.targetWorkRoot, 'src', 'ImportedRoot.tsx'), appSourceText);
        const wrapper = `import ImportedRoot from './ImportedRoot';\n\nexport default function App() {\n  return (\n    <main data-spatial-page className="forma-imported-page">\n      <ImportedRoot />\n    </main>\n  );\n}\n`;
        await writeFile(path.join(input.targetWorkRoot, 'src', 'App.tsx'), wrapper);
      }
    }

    await linkWorkDependencies(input.targetWorkRoot, input.dependencySourceRoots);
    return { name: workName, sourceLabel: input.sourceLabel, kind: 'react', importedFiles: copiedCount };
  }

  // Case B: Static HTML / CSS / Assets Webpage
  const htmlCandidates = normalizedEntries.filter(item => /\.html?$/i.test(item.relPath));
  if (htmlCandidates.length === 0) {
    throw new WorkError('NO_HTML_ENTRY', '未找到可导入的网页入口文件（需要 index.html / *.html 或 React 项目的 src/App.tsx）', 400);
  }
  const primaryHtml =
    htmlCandidates.find(item => item.relPath.toLowerCase() === 'index.html') ??
    htmlCandidates.find(item => path.posix.basename(item.relPath).toLowerCase() === 'index.html') ??
    htmlCandidates[0];

  const htmlText = primaryHtml.bytes.toString('utf8');

  // Collect linked stylesheets first, then any remaining .css files in the folder
  const linkedCssPaths: string[] = [];
  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(htmlText)) !== null) {
    const tag = linkMatch[0];
    if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) continue;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    if (!href) continue;
    const resolved = resolveRelativePosix(primaryHtml.relPath, href);
    const found = lookupEntry(resolved);
    if (found && !linkedCssPaths.includes(found.relPath)) {
      linkedCssPaths.push(found.relPath);
    }
  }
  for (const item of normalizedEntries) {
    if (item.relPath.toLowerCase().endsWith('.css') && !linkedCssPaths.includes(item.relPath)) {
      linkedCssPaths.push(item.relPath);
    }
  }

  // Prepare asset localization maps for images referenced in HTML or CSS
  const publicImages = new Map<string, { slug: string; bytes: Buffer }>();
  const cssImages = new Map<string, { slug: string; bytes: Buffer }>();
  let assetCounter = 0;

  const ensureLocalizedImage = (sourceRelContext: string, rawRef: string, kind: 'img' | 'css'): string | null => {
    const resolved = resolveRelativePosix(sourceRelContext, rawRef) ?? resolveRelativePosix(primaryHtml.relPath, rawRef);
    const found = lookupEntry(resolved);
    if (!found) return null;
    const ext = path.posix.extname(found.relPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) return null;

    if (kind === 'img') {
      let record = publicImages.get(found.relPath);
      if (!record) {
        assetCounter += 1;
        const hashSuffix = createHash('sha256').update(found.bytes).digest('hex').slice(0, 6);
        const baseSlug = asciiSlug(path.posix.basename(found.relPath, ext), 'img', assetCounter);
        record = { slug: `${baseSlug}-${hashSuffix}${ext}`, bytes: found.bytes };
        publicImages.set(found.relPath, record);
      }
      return `imported/${record.slug}`;
    }

    let cssRecord = cssImages.get(found.relPath);
    if (!cssRecord) {
      assetCounter += 1;
      const hashSuffix = createHash('sha256').update(found.bytes).digest('hex').slice(0, 6);
      const baseSlug = asciiSlug(path.posix.basename(found.relPath, ext), 'bg', assetCounter);
      cssRecord = { slug: `${baseSlug}-${hashSuffix}${ext}`, bytes: found.bytes };
      cssImages.set(found.relPath, cssRecord);
    }
    return `./imported/${cssRecord.slug}`;
  };

  const combinedCssBlocks: string[] = [];
  for (const cssRel of linkedCssPaths) {
    const cssEntry = lookupEntry(cssRel);
    if (!cssEntry) continue;
    combinedCssBlocks.push(
      sanitizeImportedCss(cssEntry.bytes.toString('utf8'), (rawUrl, kind) => ensureLocalizedImage(cssEntry.relPath, rawUrl, kind)),
    );
  }

  const compiled = compileHtmlToReactWork(htmlText, {
    fallbackTitle: input.explicitName?.trim() || input.fallbackName,
    extraCss: combinedCssBlocks.join('\n\n'),
    resolveAssetUrl: (rawUrl, kind) => ensureLocalizedImage(primaryHtml.relPath, rawUrl, kind),
  });

  const finalName = (input.explicitName?.trim() || compiled.title || input.fallbackName).slice(0, 60);
  await scaffoldRuntimeBase({
    targetWorkRoot: input.targetWorkRoot,
    name: finalName,
    dependencySourceRoots: input.dependencySourceRoots,
    linkDeps: false,
  });

  if (publicImages.size > 0) {
    const pubDir = path.join(input.targetWorkRoot, 'public', 'imported');
    await mkdir(pubDir, { recursive: true });
    for (const item of publicImages.values()) {
      await writeFile(path.join(pubDir, item.slug), item.bytes);
    }
  }
  if (cssImages.size > 0) {
    const srcImgDir = path.join(input.targetWorkRoot, 'src', 'imported');
    await mkdir(srcImgDir, { recursive: true });
    for (const item of cssImages.values()) {
      await writeFile(path.join(srcImgDir, item.slug), item.bytes);
    }
  }

  await writeFile(path.join(input.targetWorkRoot, 'src', 'App.tsx'), compiled.appTsx);
  await writeFile(path.join(input.targetWorkRoot, 'src', 'style.css'), compiled.styleCss);
  await linkWorkDependencies(input.targetWorkRoot, input.dependencySourceRoots);

  return {
    name: finalName,
    sourceLabel: input.sourceLabel,
    kind: 'html',
    importedFiles: 2 + publicImages.size + cssImages.size,
  };
}

async function assertSafeLocalImportDirectory(rawDir: string, protectedRoots: string[] = []): Promise<string> {
  const trimmed = rawDir.trim();
  if (!trimmed || !path.isAbsolute(trimmed) || trimmed.includes('\0')) {
    throw new WorkError('INVALID_DIRECTORY', '请输入本机完整绝对目录路径（例如 D:\\my-webpage）', 400);
  }
  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new WorkError('DIRECTORY_DENIED', '不允许直接导入磁盘根目录，请选择具体的网页项目文件夹', 400);
  }

  // Verify no ancestor or target is a symlink/junction
  let cursor = parsed.root;
  const relSegments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  for (const segment of relSegments) {
    cursor = path.join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      throw new WorkError('DIRECTORY_NOT_FOUND', '指定的本机目录不存在或不可访问', 400);
    }
    if (info.isSymbolicLink()) {
      throw new WorkError('DIRECTORY_DENIED', '安全策略不允许导入包含符号链接或目录联接的路径', 400);
    }
  }

  const real = await realpath(resolved);
  if (path.relative(resolved, real) !== '') {
    throw new WorkError('DIRECTORY_DENIED', '安全策略不允许导入目录联接路径', 400);
  }
  const targetStat = await lstat(real);
  if (!targetStat.isDirectory()) {
    throw new WorkError('INVALID_DIRECTORY', '所选路径不是文件夹', 400);
  }

  const lowerReal = real.toLowerCase();
  const blockedSystemPrefixes = [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    '/etc',
    '/proc',
    '/sys',
    '/var',
    '/usr',
  ];
  if (blockedSystemPrefixes.some(prefix => lowerReal === prefix || lowerReal.startsWith(prefix + path.sep))) {
    throw new WorkError('DIRECTORY_DENIED', '不允许导入操作系统目录', 400);
  }

  for (const protectedRoot of protectedRoots) {
    const cleanProtected = path.resolve(protectedRoot);
    const rel = path.relative(cleanProtected, real);
    if (rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))) {
      throw new WorkError('DIRECTORY_DENIED', '不能导入工作台自身的内部运行时数据目录', 400);
    }
  }

  return real;
}

export async function prepareImportedWorkDirectory(input: {
  request: ImportWorkRequest;
  targetWorkRoot: string;
  dependencySourceRoots: string[];
  internal?: ImporterInternalOptions;
}): Promise<PreparedImportResult> {
  const { request, targetWorkRoot, dependencySourceRoots, internal = {} } = input;

  if (request.mode === 'html') {
    const html = typeof request.html === 'string' ? request.html : '';
    if (!html.trim()) throw new WorkError('INVALID_INPUT', '请粘贴非空的 HTML 网页源码', 400);
    if (Buffer.byteLength(html, 'utf8') > MAX_SINGLE_FILE_BYTES) {
      throw new WorkError('IMPORT_TOO_LARGE', '粘贴的 HTML 源码超过 8 MiB 上限', 413);
    }
    const extraCss = typeof request.css === 'string' ? request.css : '';
    if (Buffer.byteLength(extraCss, 'utf8') > MAX_SINGLE_FILE_BYTES) {
      throw new WorkError('IMPORT_TOO_LARGE', '粘贴的 CSS 样式超过 8 MiB 上限', 413);
    }
    const compiled = compileHtmlToReactWork(html, {
      fallbackTitle: request.name?.trim() || '粘贴导入网页',
      extraCss,
    });
    const finalName = (request.name?.trim() || compiled.title || '粘贴导入网页').slice(0, 60);
    await scaffoldRuntimeBase({
      targetWorkRoot,
      name: finalName,
      dependencySourceRoots,
      linkDeps: false,
    });
    await writeFile(path.join(targetWorkRoot, 'src', 'App.tsx'), compiled.appTsx);
    await writeFile(path.join(targetWorkRoot, 'src', 'style.css'), compiled.styleCss);
    await linkWorkDependencies(targetWorkRoot, dependencySourceRoots);
    return { name: finalName, sourceLabel: 'HTML 源码导入', kind: 'html', importedFiles: 2 };
  }

  if (request.mode === 'files') {
    if (!Array.isArray(request.files) || request.files.length === 0) {
      throw new WorkError('INVALID_INPUT', '请至少选择一个网页文件（如 index.html）或网页文件夹', 400);
    }
    if (request.files.length > MAX_IMPORT_FILES) {
      throw new WorkError('IMPORT_TOO_LARGE', `单次最多上传 ${MAX_IMPORT_FILES} 个网页文件`, 413);
    }
    const entries: Array<{ relPath: string; bytes: Buffer }> = [];
    let totalBytes = 0;
    for (const item of request.files) {
      if (!item || typeof item.path !== 'string' || typeof item.contentBase64 !== 'string') continue;
      const relPath = normalizeRelativeInputPath(item.path);
      if (!relPath) continue;
      const bytes = Buffer.from(item.contentBase64, 'base64');
      if (bytes.byteLength > MAX_SINGLE_FILE_BYTES) {
        throw new WorkError('IMPORT_TOO_LARGE', `文件 ${relPath} 超过 8 MiB 限制`, 413);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new WorkError('IMPORT_TOO_LARGE', '上传网页总大小超过 20 MiB 限制', 413);
      }
      entries.push({ relPath, bytes });
    }
    if (entries.length === 0) {
      throw new WorkError('INVALID_INPUT', '未检测到受支持的网页源码或图片文件', 400);
    }
    return importFromFileMap({
      entries,
      targetWorkRoot,
      explicitName: request.name,
      fallbackName: '上传网页作品',
      sourceLabel: `上传文件（${entries.length} 项）`,
      dependencySourceRoots,
    });
  }

  if (request.mode === 'directory') {
    const safeDir = await assertSafeLocalImportDirectory(request.directoryPath, internal.protectedRoots);
    const entries: Array<{ relPath: string; bytes: Buffer }> = [];
    let totalBytes = 0;

    const walk = async (absDir: string, relPrefix: string) => {
      const dirItems = await readdir(absDir, { withFileTypes: true });
      for (const item of dirItems) {
        if (item.name.startsWith('.') || IGNORED_DIRS.has(item.name.toLowerCase())) continue;
        const absChild = path.join(absDir, item.name);
        const relChild = relPrefix ? `${relPrefix}/${item.name}` : item.name;
        const info = await lstat(absChild);
        if (info.isSymbolicLink()) continue;
        if (info.isDirectory()) {
          if (relChild.split('/').length <= 10) {
            await walk(absChild, relChild);
          }
          continue;
        }
        if (!info.isFile()) continue;
        const normalizedRel = normalizeRelativeInputPath(relChild);
        if (!normalizedRel) continue;
        if (info.size > MAX_SINGLE_FILE_BYTES) continue;
        if (entries.length >= MAX_IMPORT_FILES) {
          throw new WorkError('IMPORT_TOO_LARGE', `目录内网页文件超过 ${MAX_IMPORT_FILES} 个上限，请指定更具体的子目录`, 413);
        }
        const bytes = await readFile(absChild);
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new WorkError('IMPORT_TOO_LARGE', '目录内网页文件总大小超过 20 MiB 上限', 413);
        }
        entries.push({ relPath: normalizedRel, bytes });
      }
    };

    await walk(safeDir, '');
    const folderTitle = path.basename(safeDir).slice(0, 60) || '本地导入网页';
    return importFromFileMap({
      entries,
      targetWorkRoot,
      explicitName: request.name,
      fallbackName: folderTitle,
      sourceLabel: `本机目录 · ${path.basename(safeDir)}`,
      dependencySourceRoots,
    });
  }

  if (request.mode === 'url') {
    const pageFetch = await fetchBoundedBytes(request.url, 2 * 1024 * 1024, internal);
    const htmlText = pageFetch.bytes.toString('utf8');
    if (!htmlText.trim()) {
      throw new WorkError('URL_EMPTY', '目标网址返回内容为空', 502);
    }

    // Fetch up to 6 external stylesheets linked in the HTML
    const extraCssBlocks: string[] = [];
    const linkRegex = /<link\b[^>]*>/gi;
    const stylesheetUrls: string[] = [];
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(htmlText)) !== null && stylesheetUrls.length < 6) {
      const tag = linkMatch[0];
      if (!/\brel\s*=\s*["']?stylesheet["']?/i.test(tag)) continue;
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
      if (!href) continue;
      try {
        const resolvedCssUrl = new URL(href, pageFetch.finalUrl).href;
        if (!stylesheetUrls.includes(resolvedCssUrl)) stylesheetUrls.push(resolvedCssUrl);
      } catch {
        // ignore invalid href
      }
    }

    for (const cssUrl of stylesheetUrls) {
      try {
        const cssRes = await fetchBoundedBytes(cssUrl, 512 * 1024, internal, 8_000);
        extraCssBlocks.push(cssRes.bytes.toString('utf8'));
      } catch {
        // Non-fatal: continue even if one external stylesheet fails
      }
    }

    // Discover up to 12 <img src="..."> URLs and localize them into public/imported/
    const localizedByRawSrc = new Map<string, { slug: string; bytes: Buffer }>();
    const imgSrcRegex = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    const candidateImgSrcs: string[] = [];
    let imgMatch: RegExpExecArray | null;
    while ((imgMatch = imgSrcRegex.exec(htmlText)) !== null && candidateImgSrcs.length < 12) {
      const rawSrc = (imgMatch[1] ?? imgMatch[2] ?? imgMatch[3] ?? '').trim();
      if (!rawSrc || rawSrc.startsWith('data:') || candidateImgSrcs.includes(rawSrc)) continue;
      candidateImgSrcs.push(rawSrc);
    }

    let imgTotalBytes = 0;
    let imgIndex = 0;
    for (const rawSrc of candidateImgSrcs) {
      try {
        const fullImgUrl = new URL(rawSrc, pageFetch.finalUrl);
        const imgRes = await fetchBoundedBytes(fullImgUrl.href, 3 * 1024 * 1024, internal, 8_000);
        if (imgRes.bytes.byteLength === 0) continue;
        imgTotalBytes += imgRes.bytes.byteLength;
        if (imgTotalBytes > 12 * 1024 * 1024) break;

        let ext = path.posix.extname(fullImgUrl.pathname).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) {
          if (imgRes.contentType.includes('svg')) ext = '.svg';
          else if (imgRes.contentType.includes('webp')) ext = '.webp';
          else if (imgRes.contentType.includes('png')) ext = '.png';
          else if (imgRes.contentType.includes('gif')) ext = '.gif';
          else ext = '.jpg';
        }
        imgIndex += 1;
        const hash = createHash('sha256').update(imgRes.bytes).digest('hex').slice(0, 6);
        const slug = `${asciiSlug(path.posix.basename(fullImgUrl.pathname, ext), 'remote-img', imgIndex)}-${hash}${ext}`;
        localizedByRawSrc.set(rawSrc, { slug, bytes: imgRes.bytes });
      } catch {
        // Non-fatal: unlocalized images fall back to clean offline SVG placeholder
      }
    }

    const hostFallback = pageFetch.finalUrl.hostname.replace(/^www\./i, '');
    const compiled = compileHtmlToReactWork(htmlText, {
      fallbackTitle: request.name?.trim() || hostFallback,
      extraCss: extraCssBlocks.join('\n\n'),
      resolveAssetUrl: (rawUrl, kind) => {
        if (kind === 'img') {
          const hit = localizedByRawSrc.get(rawUrl.trim());
          return hit ? `imported/${hit.slug}` : null;
        }
        return null;
      },
    });

    const finalName = (request.name?.trim() || compiled.title || hostFallback).slice(0, 60);
    await scaffoldRuntimeBase({
      targetWorkRoot,
      name: finalName,
      dependencySourceRoots,
      linkDeps: false,
    });

    if (localizedByRawSrc.size > 0) {
      const pubDir = path.join(targetWorkRoot, 'public', 'imported');
      await mkdir(pubDir, { recursive: true });
      for (const item of localizedByRawSrc.values()) {
        await writeFile(path.join(pubDir, item.slug), item.bytes);
      }
    }

    await writeFile(path.join(targetWorkRoot, 'src', 'App.tsx'), compiled.appTsx);
    await writeFile(path.join(targetWorkRoot, 'src', 'style.css'), compiled.styleCss);
    await linkWorkDependencies(targetWorkRoot, dependencySourceRoots);

    return {
      name: finalName,
      sourceLabel: `网址导入 · ${pageFetch.finalUrl.hostname}`,
      kind: 'html',
      importedFiles: 2 + localizedByRawSrc.size,
    };
  }

  throw new WorkError('INVALID_INPUT', '不支持的导入方式', 400);
}
