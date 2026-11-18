import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import ts from 'typescript';
import path from 'node:path';
import {
  MODULE_INSTANCE_PATTERN,
  isManagedModulePath,
  moduleComponentPath,
  moduleConfigPath,
  parseSceneModuleConfig,
  normalizeRepoPath,
  isCanonicalModuleRenderer,
  isTrustedRuntimeSource,
} from '@spatial/shared/scene-module';
import { writeAtomic } from '../assets/atomic-file.ts';
import { readPlainFile } from '../checks/paths.ts';
import { permittedWorkPath } from './path-policy.ts';
import { WorkError } from './repo.ts';

export type LedgerRole = 'model' | 'provenance' | 'parts' | 'config' | 'component' | 'source' | 'runtime' | 'tsconfig';
export type LedgerOperation = 'create' | 'modify' | 'delete';

export interface LedgerEntry {
  path: string;
  operation: LedgerOperation;
  role: LedgerRole;
  beforeHash: string | null;
  afterHash: string | null;
  bytes: number;
  assetId?: string;
  instanceId?: string;
}

export interface LedgerReference {
  action: 'add' | 'remove';
  file: string;
  instanceId: string;
  /** `${line}:${column}` of the static reference in the bound source file. */
  anchor?: string;
}

export interface AssetLedger {
  schemaVersion: 1;
  candidateId: string;
  baseVersion: string;
  instanceId?: string;
  intent: 'insert' | 'remove';
  entries: LedgerEntry[];
  reference: LedgerReference | null;
  createdAt: string;
}

export interface LedgerChange { status: string; path: string; from?: string }
export interface LedgerRepo {
  candidatePath(id: string): string;
  candidateBufferAt(id: string, file: string): Promise<Buffer | undefined>;
  diffNameStatus(id: string, base: string): Promise<LedgerChange[]>;
  fileBufferAt(version: string, file: string): Promise<Buffer | undefined>;
  listTree(version: string): Promise<string[]>;
}

const HASH = /^[a-f0-9]{64}$/;
const SAFE_PATH = /^(?:tsconfig\.json|(?:src|public)\/[A-Za-z0-9_-][A-Za-z0-9._/-]*)$/;

export function sha256Bytes(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

export function ledgerFile(directory: string, candidateId: string): string {
  if (!/^[a-z0-9]{6,32}$/.test(candidateId)) throw new WorkError('INVALID_LEDGER', '候选编号无效');
  return path.join(directory, 'lux3d-ledgers', `${candidateId}.json`);
}

export function validateLedger(value: unknown): AssetLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkError('INVALID_LEDGER', '受信资产清单格式无效');
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1 || typeof input.candidateId !== 'string' || !/^[a-z0-9]{6,32}$/.test(input.candidateId) ||
    typeof input.baseVersion !== 'string' || !input.baseVersion ||
    (input.intent !== 'insert' && input.intent !== 'remove') || !Array.isArray(input.entries)) {
    throw new WorkError('INVALID_LEDGER', '受信资产清单字段不完整');
  }
  if (input.instanceId !== undefined && (typeof input.instanceId !== 'string' || !MODULE_INSTANCE_PATTERN.test(input.instanceId))) {
    throw new WorkError('INVALID_LEDGER', '受信资产实例编号无效');
  }
  const paths = new Set<string>();
  const entries = input.entries.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new WorkError('INVALID_LEDGER', '受信资产条目无效');
    const entry = item as Record<string, unknown>;
    const file = String(entry.path ?? '');
    if (!SAFE_PATH.test(file) || file.includes('..') || file.includes('\\') || paths.has(file)) throw new WorkError('INVALID_LEDGER', '受信资产路径无效或重复');
    paths.add(file);
    if (!['create', 'modify', 'delete'].includes(String(entry.operation)) ||
      !['model', 'provenance', 'parts', 'config', 'component', 'source', 'runtime', 'tsconfig'].includes(String(entry.role)) ||
      typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 ||
      (entry.beforeHash !== null && !HASH.test(String(entry.beforeHash))) ||
      (entry.afterHash !== null && !HASH.test(String(entry.afterHash)))) {
      throw new WorkError('INVALID_LEDGER', '受信资产条目字段无效');
    }
    if (entry.operation === 'create' && entry.beforeHash !== null) throw new WorkError('INVALID_LEDGER', '新建条目不能声明旧哈希');
    if (entry.operation === 'delete' && (entry.afterHash !== null || entry.bytes !== 0)) throw new WorkError('INVALID_LEDGER', '删除条目不能声明新字节');
    if (entry.role === 'model' && entry.operation === 'delete') throw new WorkError('INVALID_LEDGER', '共享模型不允许随候选删除');
    if (entry.assetId !== undefined && (typeof entry.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.assetId))) throw new WorkError('INVALID_LEDGER', '受信资产编号无效');
    if (entry.instanceId !== undefined && (typeof entry.instanceId !== 'string' || !MODULE_INSTANCE_PATTERN.test(entry.instanceId))) throw new WorkError('INVALID_LEDGER', '受信资产实例编号无效');
    return {
      path: file, operation: entry.operation as LedgerOperation, role: entry.role as LedgerRole,
      beforeHash: entry.beforeHash as string | null, afterHash: entry.afterHash as string | null,
      bytes: Number(entry.bytes), ...(entry.assetId ? { assetId: String(entry.assetId) } : {}),
      ...(entry.instanceId ? { instanceId: String(entry.instanceId) } : {}),
    } satisfies LedgerEntry;
  });
  let reference: LedgerReference | null = null;
  if (input.reference !== null) {
    if (!input.reference || typeof input.reference !== 'object' || Array.isArray(input.reference)) throw new WorkError('INVALID_LEDGER', '受信引用声明无效');
    const ref = input.reference as Record<string, unknown>;
    if (!['add', 'remove'].includes(String(ref.action)) || typeof ref.file !== 'string' || !SAFE_PATH.test(ref.file) ||
      typeof ref.instanceId !== 'string' || !MODULE_INSTANCE_PATTERN.test(ref.instanceId) ||
      (ref.anchor !== undefined && (typeof ref.anchor !== 'string' || !/^[1-9]\d*:[1-9]\d*$/.test(ref.anchor)))) throw new WorkError('INVALID_LEDGER', '受信引用声明无效');
    reference = { action: ref.action as 'add' | 'remove', file: ref.file, instanceId: ref.instanceId, ...(ref.anchor ? { anchor: String(ref.anchor) } : {}) };
  }
  const intent = input.intent as 'insert' | 'remove';
  if (intent === 'insert' && (!reference || reference.action !== 'add' || !input.instanceId || reference.instanceId !== input.instanceId)) throw new WorkError('INVALID_LEDGER', '新增模块必须声明唯一实例引用');
  if (intent === 'remove' && (!reference || reference.action !== 'remove' || !input.instanceId || reference.instanceId !== input.instanceId)) throw new WorkError('INVALID_LEDGER', '移除模块必须声明被移除的实例引用');
  return {
    schemaVersion: 1, candidateId: input.candidateId, baseVersion: input.baseVersion, intent,
    ...(input.instanceId ? { instanceId: String(input.instanceId) } : {}), entries, reference,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : '',
  };
}

export async function writeLedger(directory: string, ledger: AssetLedger): Promise<string> {
  const validated = validateLedger(ledger);
  const file = ledgerFile(directory, validated.candidateId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, JSON.stringify(validated, null, 2) + '\n');
  return file;
}

export async function readLedger(directory: string, candidateId: string): Promise<AssetLedger> {
  const file = ledgerFile(directory, candidateId);
  let bytes: Buffer;
  try { bytes = await readPlainFile(file, 128 * 1024, () => new WorkError('INVALID_LEDGER', '受信资产清单路径含链接', 409), () => new WorkError('INVALID_LEDGER', '受信资产清单过大', 409)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkError('LEDGER_NOT_FOUND', '候选缺少受信资产清单', 409);
    throw new WorkError('INVALID_LEDGER', '受信资产清单不可读取或已变化', 409);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new WorkError('INVALID_LEDGER', '受信资产清单损坏', 409); }
  return validateLedger(parsed);
}

/* ------------------------------------------------------------------ */
/* Static module reference audit (C2)                                  */
/* ------------------------------------------------------------------ */

export interface ModuleReference {
  instanceId: string;
  file: string;
  line: number;
  column: number;
  signature: string;
  dynamic: boolean;
}

/**
 * Find every `<SpatialModule …>` usage in TS/TSX source. The trusted runtime accepts exactly one
 * literal `instanceId` attribute; spreads, expressions, extra props and duplicate references are
 * recorded so the policy can refuse them.
 */
export function scanModuleReferences(source: string, file: string): ModuleReference[] {
  const references: ModuleReference[] = [];
  const pattern = /<(SpatialModule|SpatialModel([a-f0-9]{32}))\b/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const start = match.index;
    let index = pattern.lastIndex, quote: string | undefined;
    for (; index < source.length; index++) {
      const char = source[index];
      if (quote) { if (char === '\\') index++; else if (char === quote) quote = undefined; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') break;
    }
    const raw = source.slice(pattern.lastIndex, index);
    const dynamic = match[1] === 'SpatialModule' && (raw.includes('{') || raw.includes('...'));
    const literal = match[2] ?? /(?:^|\s)instanceId\s*=\s*"([a-f0-9]{32})"/.exec(raw)?.[1];
    const names = match[1] === 'SpatialModule'
      ? [...raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_-]*)\s*=/g)].map(item => item[1])
      : [];
    const before = source.slice(0, start);
    const line = before.split('\n').length;
    const column = start - before.lastIndexOf('\n');
    references.push({
      instanceId: literal ?? '', file, line, column, dynamic,
      signature: `${file}:${line}:${column}:${raw.replace(/\s+/g, ' ').trim()}`,
    });
    if (names.some(name => name !== 'instanceId')) references[references.length - 1].dynamic = true;
  }
  return references;
}

function moduleTarget(file: string, specifier: string): string | undefined {
  if (specifier.startsWith('/')) return path.posix.normalize(specifier.replace(/^\/+/, '')).toLowerCase();
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)).toLowerCase();
}

function mentionsManagedSpecifier(specifier: string): boolean {
  const segments = specifier.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean);
  return segments.some(segment => {
    const clean = segment.split(/[?#]/, 1)[0];
    return clean === 'scene-modules' || clean === 'spatial-module' || clean.startsWith('spatial-module.');
  });
}

function isUnsupportedAbsoluteSpecifier(specifier: string): boolean {
  const text = specifier.replaceAll('\\', '/').toLowerCase();
  if (text.startsWith('/@fs/') || text.startsWith('@fs/')) return true;
  if (text.startsWith('file:')) return true;
  if (/^[a-z]:/.test(text)) return true;
  if (text.startsWith('//')) return true;
  return text.split('/').some(segment => /^[^/]*~\d+(?:\.[^/]*)?$/.test(segment));
}

function isModuleNamespaceTarget(target: string): boolean {
  return target === 'src/spatial-module' || target.startsWith('src/spatial-module.') || target.startsWith('src/spatial-module/') || target === 'src/scene-modules' || target.startsWith('src/scene-modules/');
}

function literalString(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteral(node) ? node.text : undefined;
}

function globPatternTarget(file: string, pattern: string): string | undefined {
  const positive = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (!positive) return undefined;
  if (positive.startsWith('/')) return path.posix.normalize(positive.replace(/^\/+/, '')).toLowerCase();
  if (positive.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(file), positive)).toLowerCase();
  return path.posix.normalize(positive).toLowerCase();
}

function globIsAllowed(file: string, pattern: string): boolean {
  const target = globPatternTarget(file, pattern);
  if (!target) return false;
  if (mentionsManagedSpecifier(target)) return false;
  const segments = target.split('/');
  if (segments.some(segment => segment === '..' || segment.includes('..'))) return false;
  const meta = ['*', '?', '[', ']', '{', '}', '(', ')', '!', '+', '@', '\\'];
  const first = segments.findIndex(segment => meta.some(char => segment.includes(char)));
  const directory = first < 0 ? path.posix.dirname(target) : segments.slice(0, first).join('/');
  if (!directory.startsWith('src/')) return false;
  const subdirectory = directory.slice(4).split('/')[0];
  if (!subdirectory || subdirectory === 'scene-modules' || subdirectory.startsWith('spatial-module')) return false;
  return true;
}

function isGlobCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (!ts.isMetaProperty(expression.expression) || expression.expression.keywordToken !== ts.SyntaxKind.ImportKeyword) return false;
  return expression.name.text === 'glob' || expression.name.text === 'globEager';
}

function globArguments(args: ts.NodeArray<ts.Expression>): string[] | undefined {
  if (args.length < 1) return undefined;
  const first = args[0];
  const values = ts.isArrayLiteralExpression(first) ? first.elements : [first];
  const patterns: string[] = [];
  for (const value of values) {
    const text = literalString(value);
    if (text === undefined) return undefined;
    patterns.push(text);
  }
  return patterns;
}

/**
 * F3: only the exact server-generated default import may reference a module instance. Aliases,
 * namespace imports, re-exports, dynamic imports, require, createElement/jsx-runtime and extra
 * props on the canonical component are rejected. This runs on every changed non-managed source.
 */
export function auditTrustedImports(source: string, file: string): void {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const canonical = new Map<string, string>();
  const allowed = new Set<ts.Node>();
  const importedCounts = new Map<string, number>();
  const jsxCounts = new Map<string, number>();
  const reject = (message: string): never => { throw new WorkError('MODULE_IMPORT_UNAPPROVED', message, 409); };

  function visitImports(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        if (isUnsupportedAbsoluteSpecifier(specifier.text)) return reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径导入');
        const target = moduleTarget(file, specifier.text);
        const managedTarget = !!target && isModuleNamespaceTarget(target);
        if (managedTarget) {
          if (specifier.text.startsWith('/')) return reject('受信运行时/实例必须使用服务端生成的相对导入，不能使用项目根绝对路径');
          const output = /^src\/scene-modules\/([a-f0-9]{32})\.tsx$/.exec(target);
          if (!output) return reject('只允许通过受信实例组件引用 3D 模块，禁止直接导入运行器、扩展名旁路或目录导入');
          const id = output[1];
          const clause = node.importClause;
          if (!clause || clause.isTypeOnly || clause.namedBindings) return reject('实例组件必须使用固定名字的默认导入');
          const binding = clause.name;
          if (!binding) return reject('实例组件必须使用固定名字的默认导入');
          const local = binding.text;
          if (local !== `SpatialModel${id}`) reject('实例组件导入名必须与服务端生成的名称一致');
          canonical.set(local, id);
          allowed.add(binding);
          importedCounts.set(id, (importedCounts.get(id) ?? 0) + 1);
        }
        if (!managedTarget && mentionsManagedSpecifier(specifier.text)) return reject('受管运行时/实例路径只能使用 server 生成的 canonical 相对导入');
      }
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      if (isUnsupportedAbsoluteSpecifier(node.moduleReference.expression.text)) reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径导入');
      const target = moduleTarget(file, node.moduleReference.expression.text);
      if (target && isModuleNamespaceTarget(target)) reject('不能用 import = require 加载受信实例或运行器');
      if (mentionsManagedSpecifier(node.moduleReference.expression.text)) reject('受管运行时/实例路径只能使用 server 生成的 canonical 相对导入');
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isUnsupportedAbsoluteSpecifier(node.moduleSpecifier.text)) reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径重导出');
      const target = moduleTarget(file, node.moduleSpecifier.text);
      if (target && isModuleNamespaceTarget(target)) reject('不能重导出受信实例或运行器');
      if (mentionsManagedSpecifier(node.moduleSpecifier.text)) reject('受管运行时/实例路径只能使用 server 生成的 canonical 相对导入');
    }
    if (ts.isCallExpression(node)) {
      if (isGlobCall(node)) {
        const patterns = globArguments(node.arguments);
        if (!patterns) return reject('import.meta.glob 参数无法静态证明，请改为明确的字面路径');
        const positive = patterns.filter(pattern => !pattern.startsWith('!'));
        if (!positive.length) return reject('import.meta.glob 需要至少一个正向且可静态证明的普通目录 pattern');
        if (patterns.some(pattern => isUnsupportedAbsoluteSpecifier(pattern.replace(/^!/, '')))) return reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径 glob');
        if (positive.some(pattern => !globIsAllowed(file, pattern))) {
          return reject('import.meta.glob 的静态目录前缀不在普通 src 子目录内，无法证明不会覆盖受管运行时或受信实例');
        }
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const literal = literalString(node.arguments[0]);
        if (literal === undefined) return reject('动态 import 目标无法静态证明，请改为明确的字面路径');
        if (isUnsupportedAbsoluteSpecifier(literal)) return reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径动态导入');
        const target = moduleTarget(file, literal);
        if (target && isModuleNamespaceTarget(target)) return reject('不能用动态 import 加载受信实例或运行器');
        if (mentionsManagedSpecifier(literal)) return reject('受管运行时/实例路径只能使用 server 生成的 canonical 相对导入');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const literal = literalString(node.arguments[0]);
        if (literal === undefined) return reject('require 目标无法静态证明，请改为明确的字面路径');
        if (isUnsupportedAbsoluteSpecifier(literal)) return reject('不支持 /@fs/、file:、盘符、UNC 或 DOS 8.3 绝对路径 require');
        const target = moduleTarget(file, literal);
        if (target && isModuleNamespaceTarget(target)) return reject('不能用 require 加载受信实例或运行器');
        if (mentionsManagedSpecifier(literal)) return reject('受管运行时/实例路径只能使用 server 生成的 canonical 相对导入');
      }
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
      if (['createElement', 'jsx', 'jsxs', '_jsx', '_jsxs'].includes(callee)) {
        const argument = node.arguments[0]?.getText(tree) ?? '';
        if (/SpatialModule|SpatialModel|scene-modules|spatial-module/i.test(argument)) return reject('不能用 createElement/jsx 动态构造受信实例');
      }
    }
    ts.forEachChild(node, visitImports);
  }
  visitImports(tree);

  function visitJsx(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      if (ts.isIdentifier(tag)) {
        const name = tag.text;
        if (name === 'SpatialModule') reject('普通源码不能直接渲染受信运行器');
        const id = canonical.get(name) ?? (name.startsWith('SpatialModel') ? name.slice('SpatialModel'.length) : undefined);
        if (id !== undefined) {
          if (!/^[a-f0-9]{32}$/.test(id) || !canonical.has(name)) reject('实例必须使用服务端生成且已导入的静态组件名');
          const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
          if (!ts.isJsxSelfClosingElement(node) || attributes.properties.length) reject('实例组件必须是无属性的自闭合静态标签');
          allowed.add(tag);
          jsxCounts.set(id, (jsxCounts.get(id) ?? 0) + 1);
        }
      }
    }
    ts.forEachChild(node, visitJsx);
  }
  visitJsx(tree);

  for (const [local, id] of canonical) {
    if ((importedCounts.get(id) ?? 0) !== 1 || (jsxCounts.get(id) ?? 0) !== 1) {
      reject(`实例 ${local} 必须恰好有一个受信导入和一个静态引用`);
    }
  }

  function visitIdentifiers(node: ts.Node) {
    if (ts.isIdentifier(node) && canonical.has(node.text) && !allowed.has(node)) {
      reject('受信实例标识符只能用于唯一静态 JSX 引用，不能传递、别名或动态调用');
    }
    ts.forEachChild(node, visitIdentifiers);
  }
  visitIdentifiers(tree);
}

function indexedReferences(references: ModuleReference[]): Map<string, ModuleReference> {
  const counts = new Map<string, number>();
  const map = new Map<string, ModuleReference>();
  for (const reference of references) {
    if (reference.dynamic || !reference.instanceId) {
      map.set(`${reference.file}:${reference.line}:${reference.column}:dynamic`, reference);
      continue;
    }
    const base = `${reference.file}::${reference.instanceId}`;
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    map.set(`${base}#${occurrence}`, reference);
  }
  return map;
}

function isTsxFile(file: string): boolean { return /\.(?:tsx|ts)$/.test(file) && file.startsWith('src/'); }

async function candidateText(repo: LedgerRepo, candidateId: string, file: string): Promise<string | undefined> {
  try {
    const bytes = await repo.candidateBufferAt(candidateId, file);
    return bytes?.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkError('MODULE_REFERENCE_UNREADABLE', `模块引用文件不可读取：${file}`, 409);
  }
}

export function assertNoUnapprovedReferenceChanges(input: {
  before: ModuleReference[];
  after: ModuleReference[];
  ledger: AssetLedger | undefined;
}): void {
  const { before, after, ledger } = input;
  if ([...before, ...after].some(reference => reference.dynamic)) {
    throw new WorkError('MODULE_REFERENCE_DYNAMIC', '受信 3D 渲染器只接受静态 instanceId，不能使用变量、展开或额外参数', 409);
  }
  const beforeKeys = indexedReferences(before);
  const afterKeys = indexedReferences(after);
  const added = [...afterKeys.entries()].filter(([key]) => !beforeKeys.has(key)).map(([, ref]) => ref);
  const removed = [...beforeKeys.entries()].filter(([key]) => !afterKeys.has(key)).map(([, ref]) => ref);
  const reference = ledger?.reference;
  if (!added.length && !removed.length) {
    if (reference) throw new WorkError('MODULE_REFERENCE_UNAPPROVED', '受信清单声明的实例引用变化没有实际发生', 409);
    return;
  }
  if (!reference) throw new WorkError('MODULE_REFERENCE_UNAPPROVED', '普通改动不能新增、删除或移动已放置的 3D 实例引用', 409);
  if (reference.action === 'add') {
    if (removed.length || added.length !== 1 || added[0].instanceId !== reference.instanceId || added[0].file !== reference.file ||
      (reference.anchor && `${added[0].line}:${added[0].column}` !== reference.anchor)) {
      throw new WorkError('MODULE_REFERENCE_UNAPPROVED', '新增模块必须在声明的唯一锚点添加一次静态引用', 409);
    }
  } else {
    if (added.length || removed.length !== 1 || removed[0].instanceId !== reference.instanceId || removed[0].file !== reference.file ||
      (reference.anchor && `${removed[0].line}:${removed[0].column}` !== reference.anchor)) {
      throw new WorkError('MODULE_REFERENCE_UNAPPROVED', '移除模块必须在声明位置移除唯一引用', 409);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Candidate policy                                                    */
/* ------------------------------------------------------------------ */

function managedReason(path: string): string | undefined {
  return isManagedModulePath(path) ? path : undefined;
}

function entryFor(ledger: AssetLedger | undefined, file: string): LedgerEntry | undefined {
  return ledger?.entries.find(entry => entry.path === file);
}

/** Model-authored source may only change allow-listed source extensions. */
function modelWritable(file: string): boolean {
  return /^src\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tsx|ts|css|json|svg)$/.test(file);
}

const COMPONENT_SOURCE = /^\/\/ Generated by Spatial AI Workbench\. Do not edit\.\nimport \{ SpatialModule \} from '\.\.\/spatial-module\.tsx';\nexport default function SpatialModel([a-f0-9]{32})\(\) \{ return <SpatialModule instanceId="([a-f0-9]{32})" \/>; \}\n$/;

/**
 * A complete `ls-tree -r` listing of one immutable revision whose mode/type/path entries this
 * module validated before issuing. It can only be produced by `auditManagedBaseline`, which
 * derives the file list from the repository itself; no exported function accepts a caller-supplied
 * array, so a fabricated or truncated list can never be registered.
 */
export interface ManagedBaselineListing {
  readonly revision: string;
  readonly files: readonly string[];
}

/** Raw `<mode> <type> <oid>\t<path>` records of one revision (`ls-tree -r -z --full-tree`). */
export interface TreeSource {
  readTree(revision: string): Promise<readonly string[]>;
}

const issuedListings = new WeakMap<object, WeakSet<object>>();

function issueListing(repo: object, revision: string, files: readonly string[]): ManagedBaselineListing {
  const value = Object.freeze({ revision, files: Object.freeze([...files]) });
  let set = issuedListings.get(repo);
  if (!set) { set = new WeakSet<object>(); issuedListings.set(repo, set); }
  set.add(value);
  return value;
}

/** Full 40- or 64-character commit id; `HEAD`, abbreviations and tags never qualify. */
const FULL_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Only a listing issued for this repository and the exact same full commit may stand in for
 * `listTree`. Symbolic, abbreviated, foreign, fabricated or truncated values fall back to a real
 * enumeration: reuse must never be able to hide a file.
 */
function reusableListing(repo: object, revision: string, listing: ManagedBaselineListing | undefined): readonly string[] | undefined {
  if (!listing) return undefined;
  const set = issuedListings.get(repo);
  if (!set || !set.has(listing)) return undefined;
  if (!FULL_COMMIT.test(revision)) return undefined;
  return listing.revision === revision ? listing.files : undefined;
}

/**
 * The only way to obtain a `ManagedBaselineListing`. The file list is read from the repository
 * itself and every record is validated here (mode/type/path and the work allow-list) before the
 * frozen listing is issued for that repo object. Because no parameter carries file names, a
 * caller cannot mint an empty or truncated list for a repository; a listing issued for another
 * repo (or another commit) is ignored by `reusableListing` and the tree is enumerated again.
 */
export async function auditManagedBaseline(
  repo: LedgerRepo & TreeSource,
  revision: string,
  reusable?: ManagedBaselineListing,
): Promise<ManagedBaselineListing> {
  const reusableFiles = reusableListing(repo, revision, reusable);
  if (reusableFiles && reusable) {
    // The same repo+commit listing was validated when it was issued; only the file list is reused,
    // the managed bytes below are still read again.
    await assertManagedTree(repo, revision, reusable);
    return reusable;
  }
  const listing = await repo.readTree(revision);
  const bad: string[] = [];
  const files: string[] = [];
  for (const record of listing) {
    // "<mode> <type> <object>\t<path>": the path is everything after the FIRST tab (review N2).
    const tab = record.indexOf('\t');
    const meta = tab < 0 ? '' : record.slice(0, tab), file = tab < 0 ? record : record.slice(tab + 1);
    const mode = /^(\d{6}) (blob|tree|commit) [0-9a-f]{40,64}$/.exec(meta)?.[1];
    if (!mode || mode === '120000' || mode === '160000' || /[\u0000-\u001f\u007f]/.test(file) || !permittedWorkPath(file)) bad.push(JSON.stringify(file));
    else files.push(file);
  }
  if (bad.length) throw new WorkError('UNSAFE_TRACKED_FILE', `作品版本库跟踪了不允许的文件或链接（${bad.slice(0, 5).join('、')}${bad.length > 5 ? ' 等' : ''}），请人工迁移到干净的版本库`, 409);
  // The listing validated above is complete for this revision and is handed to the managed audit
  // instead of being enumerated a second time; anything unissued or for another revision is
  // ignored there and enumerated again (see reusableListing).
  const issued = issueListing(repo, revision, files);
  await assertManagedTree(repo, revision, issued);
  return issued;
}

/**
 * Validate every managed file in a revision. Only the canonical `.tsx` renderer and the exact
 * generated `<id>.json` / `<id>.tsx` module pair are allowed; any same-name `.ts`/directory or
 * extra file is rejected as a possible shadow.
 */
async function assertManagedBaseline(repo: LedgerRepo, base: string, listing?: ManagedBaselineListing): Promise<void> {
  for (const file of reusableListing(repo, base, listing) ?? await repo.listTree(base)) {
    if (!isManagedModulePath(file)) continue;
    const bytes = await repo.fileBufferAt(base, file);
    if (!bytes) continue;
    if (isCanonicalModuleRenderer(file)) {
      if (!isTrustedRuntimeSource(bytes.toString('utf8'))) throw new WorkError('INVALID_MANAGED_BASELINE', '受信运行时内容不符合约定', 409);
      continue;
    }
    if (normalizeRepoPath(file).startsWith('src/spatial-module')) {
      throw new WorkError('INVALID_MANAGED_BASELINE', `受管运行时命名空间只能包含 canonical .tsx：${file}`, 409);
    }
    const output = /^src\/scene-modules\/([a-f0-9]{32})\.(json|tsx)$/.exec(file);
    if (!output) throw new WorkError('INVALID_MANAGED_BASELINE', `受管目录只能包含 server 生成的实例文件：${file}`, 409);
    const instanceId = output[1], kind = output[2];
    if (kind === 'json') {
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new WorkError('INVALID_MANAGED_BASELINE', `基线模块配置损坏：${file}`, 409); }
      let config: ReturnType<typeof parseSceneModuleConfig>;
      try { config = parseSceneModuleConfig(parsed); } catch { throw new WorkError('INVALID_MANAGED_BASELINE', `基线模块配置不合法：${file}`, 409); }
      if (moduleConfigPath(config.instanceId) !== file) throw new WorkError('INVALID_MANAGED_BASELINE', '基线模块配置与实例编号不一致', 409);
      continue;
    }
    const match = COMPONENT_SOURCE.exec(bytes.toString('utf8'));
    if (!match || match[1] !== match[2] || match[1] !== instanceId || moduleComponentPath(instanceId) !== file) {
      throw new WorkError('INVALID_MANAGED_BASELINE', `受管组件必须由服务端生成：${file}`, 409);
    }
  }
}

/**
 * Verify a candidate against its base commit using the server ledger.
 *
 * Order is fixed: normalize/path safety → managed namespace denial → ordinary src rules. A
 * managed file is released only by an exact path/operation/before/after proof from this
 * candidate's ledger. Unchanged managed baseline files are validated as adopted content, not
 * re-authorized by the candidate (C1).
 */
export async function verifyCandidateLedger(repo: LedgerRepo, candidateId: string, base: string, ledger: AssetLedger | undefined, listing?: ManagedBaselineListing): Promise<void> {
  if (ledger) {
    if (ledger.candidateId !== candidateId || ledger.baseVersion !== base) throw new WorkError('INVALID_LEDGER', '受信资产清单不属于本候选或它的基线', 409);
    validateLedger(ledger);
  }
  await assertManagedBaseline(repo, base, listing);
  const changes = await repo.diffNameStatus(candidateId, base);
  const seen = new Set<string>();
  const renamedSources: Array<{ from: string; to: string }> = [];
  for (const change of changes) {
    if (change.status.startsWith('R') || change.status.startsWith('C')) {
      const from = change.from ?? '', to = change.path;
      for (const file of [from, to]) {
        if (!SAFE_PATH.test(file) || file.includes('..') || file.includes('\\')) throw new WorkError('UNSAFE_CANDIDATE_DIFF', '候选包含越界路径', 409);
        if (managedReason(file)) throw new WorkError('MANAGED_MODULE_DENIED', '模型不能重命名受管模块文件', 409);
      }
      if (!modelWritable(from) || !modelWritable(to)) throw new WorkError('UNSAFE_CANDIDATE_DIFF', '模型只能修改 src/ 下允许的源码文件', 409);
      if ((isTsxFile(from) || isTsxFile(to)) && !isManagedModulePath(from) && !isManagedModulePath(to)) renamedSources.push({ from, to });
      const entry = entryFor(ledger, from) ?? entryFor(ledger, to);
      if (entry) throw new WorkError('INVALID_LEDGER', '受信清单不支持改名', 409);
      continue;
    }
    const file = change.path;
    if (!SAFE_PATH.test(file) || file.includes('..') || file.includes('\\')) throw new WorkError('UNSAFE_CANDIDATE_DIFF', '候选包含越界路径', 409);
    const entry = entryFor(ledger, file);
    if (entry) {
      if (seen.has(file)) throw new WorkError('INVALID_LEDGER', '受信资产条目重复', 409);
      seen.add(file);
      const before = await repo.fileBufferAt(base, file);
      const after = change.status === 'D' ? undefined : await repo.candidateBufferAt(candidateId, file);
      const beforeHash = before ? sha256Bytes(before) : null;
      const afterHash = after ? sha256Bytes(after) : null;
      const expectedOperation = beforeHash && afterHash ? 'modify' : afterHash ? 'create' : 'delete';
      if (entry.operation !== expectedOperation || entry.beforeHash !== beforeHash || entry.afterHash !== afterHash ||
        (after && entry.bytes !== after.byteLength)) {
        throw new WorkError('INVALID_LEDGER', `受信资产与清单不一致：${file}`, 409);
      }
      continue;
    }
    if (managedReason(file)) throw new WorkError('MANAGED_MODULE_DENIED', '模型不能新增、修改或删除受管模块配置、组件或受信渲染器', 409);
    if (!modelWritable(file)) throw new WorkError('UNSAFE_CANDIDATE_DIFF', '模型只能修改 src/ 下允许的源码文件；受信资产必须由服务端登记', 409);
  }
  for (const entry of ledger?.entries ?? []) {
    if (!seen.has(entry.path)) throw new WorkError('INVALID_LEDGER', `受信清单包含未变化的文件：${entry.path}`, 409);
  }
  const changedSources = changes.filter(change => !change.status.startsWith('R') && !change.status.startsWith('C')).map(change => change.path).filter(file => isTsxFile(file) && !isManagedModulePath(file));
  const beforeRefs: ModuleReference[] = [], afterRefs: ModuleReference[] = [];
  const literalModel = /["'`]\/assets\/[A-Za-z0-9_-]+\.glb["'`]/;
  for (const { from, to } of renamedSources) {
    const before = (await repo.fileBufferAt(base, from))?.toString('utf8');
    if (before) beforeRefs.push(...scanModuleReferences(before, from));
    const after = await candidateText(repo, candidateId, to);
    if (after) { auditTrustedImports(after, to); afterRefs.push(...scanModuleReferences(after, to)); }
  }
  for (const file of new Set(changedSources)) {
    const before = (await repo.fileBufferAt(base, file))?.toString('utf8');
    if (before) beforeRefs.push(...scanModuleReferences(before, file));
    const after = await candidateText(repo, candidateId, file);
    if (after) { auditTrustedImports(after, file); afterRefs.push(...scanModuleReferences(after, file)); }
    if (after && literalModel.test(after) && !(before && literalModel.test(before))) {
      throw new WorkError('MODEL_PATH_IN_SOURCE', '模型源码不能直接写入作品资产路径；请使用受信实例配置', 409);
    }
  }
  assertNoUnapprovedReferenceChanges({ before: beforeRefs, after: afterRefs, ledger });
}

/** Validate the managed part of a committed tree without re-authorizing unchanged baseline. */
export async function assertManagedTree(repo: LedgerRepo, revision: string, listing?: ManagedBaselineListing): Promise<void> {
  await assertManagedBaseline(repo, revision, listing);
}
