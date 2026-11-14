import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import type { Selection } from '@spatial/shared';

export type ApprovalRuleCode = 'shared_component' | 'global_style' | 'out_of_scope' | 'analysis_uncertain';
export interface ApprovalEvaluation {
  required: boolean;
  ruleCodes: ApprovalRuleCode[];
  affected: string[];
  evidence: string[];
}

interface Binding { module: string; local: string }
interface ExportEntry { local?: string; source?: string; imported?: string }
interface ImportEntry { source: string; imported: string; namespace?: boolean }
interface ModuleInfo {
  file: string;
  source: ts.SourceFile;
  imports: Map<string, ImportEntry>;
  exports: Map<string, ExportEntry>;
  stars: string[];
  references: Set<string>;
  jsx: Array<{ tag: ts.JsxTagNameExpression; at: string }>;
  uncertain: string[];
}

const SOURCE_FILE = /\.(?:tsx|ts|jsx|js)$/i;
const CSS_FILE = /\.css$/i;
const MODULE_CSS = /\.module\.css$/i;
const GLOBAL_CONFIG = /(?:^|\/)(?:scene\.config\.json|theme\.(?:json|ts|tsx|js|jsx))$/i;
const extensions = ['.tsx', '.ts', '.jsx', '.js'];

function gitRead(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error && typeof error.code !== 'number') reject(error);
      else resolve({ code: error?.code ?? 0, stdout });
    });
  });
}

async function gitShow(root: string, baseVersion: string, file: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(baseVersion)) throw new Error('基线版本无效');
  // A missing path and a broken/unreadable repository both make Git exit nonzero. Only the
  // former may remove baseline evidence; every other failure must remain analysis_uncertain.
  const listing = await gitRead(root, ['ls-tree', '-z', baseVersion, '--', file]);
  if (listing.code !== 0) throw new Error('无法读取基线版本库');
  if (!listing.stdout) return undefined;
  const content = await gitRead(root, ['show', `${baseVersion}:${file}`]);
  if (content.code !== 0) throw new Error('无法读取基线文件');
  return content.stdout;
}

async function sourceFiles(root: string) {
  const result = new Map<string, string>();
  const walk = async (folder: string, relative: string) => {
    for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`源码目录含链接：${file}`);
      if (entry.isDirectory()) await walk(folder, file);
      else if (entry.isFile() && SOURCE_FILE.test(file)) result.set(file, await readFile(path.join(folder, file), 'utf8'));
      if (result.size > 500) throw new Error('源码文件过多，无法可靠分析');
    }
  };
  await walk(root, 'src');
  return result;
}

function moduleName(file: string, specifier: string) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  if (!base.startsWith('src/') || base.split('/').includes('..')) return null;
  return base;
}

function resolveModule(specifier: string | undefined, files: Map<string, ModuleInfo>) {
  if (specifier === undefined) return undefined;
  if (specifier === null) return null;
  if (files.has(specifier)) return specifier;
  for (const extension of extensions) {
    if (files.has(specifier + extension)) return specifier + extension;
    if (files.has(`${specifier}/index${extension}`)) return `${specifier}/index${extension}`;
  }
  return null;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind);
}

function tagIdentifier(tag: ts.JsxTagNameExpression): ts.Identifier | undefined {
  if (ts.isIdentifier(tag)) return tag;
  if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) return tag.expression;
  return undefined;
}

function parseModule(file: string, text: string): ModuleInfo {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const info: ModuleInfo = { file, source, imports: new Map(), exports: new Map(), stars: [], references: new Set(), jsx: [], uncertain: [] };
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diagnostic of diagnostics) info.uncertain.push(`${file}:${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1} 解析失败`);
  const reference = (node: ts.StringLiteralLike) => moduleName(file, node.text);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = reference(statement.moduleSpecifier);
      if (target) info.references.add(target);
      const clause = statement.importClause;
      if (!clause || !target) continue;
      if (clause.name) info.imports.set(clause.name.text, { source: target, imported: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) info.imports.set(bindings.name.text, { source: target, imported: '*', namespace: true });
      else if (bindings) for (const element of bindings.elements) {
        info.imports.set(element.name.text, { source: target, imported: (element.propertyName ?? element.name).text });
      }
    } else if (ts.isExportDeclaration(statement)) {
      const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? reference(statement.moduleSpecifier) : undefined;
      if (target) info.references.add(target);
      if (!statement.exportClause) {
        if (target) info.stars.push(target);
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        info.uncertain.push(`${file} 使用命名空间再导出，无法可靠追踪组件`);
      } else {
        for (const element of statement.exportClause.elements) {
          const exported = element.name.text, imported = (element.propertyName ?? element.name).text;
          info.exports.set(exported, target ? { source: target, imported } : { local: imported });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      if (statement.isExportEquals) info.uncertain.push(`${file} 使用 export =，无法可靠分析`);
      else info.exports.set('default', { local: ts.isIdentifier(statement.expression) ? statement.expression.text : '' });
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      const local = statement.name?.text ?? '';
      if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) info.exports.set('default', { local });
      if (statement.name) info.exports.set(local, { local });
    } else if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) info.uncertain.push(`${file} 使用解构导出，无法可靠追踪组件`);
        else info.exports.set(declaration.name.text, { local: declaration.name.text });
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) info.uncertain.push(`${file} 含动态模块加载，无法可靠确定引用关系`);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const at = source.getLineAndCharacterOfPosition(node.tagName.getStart(source));
      info.jsx.push({ tag: node.tagName, at: `${file}:${at.line + 1}:${at.character + 1}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return info;
}

function resolveExport(files: Map<string, ModuleInfo>, file: string, name: string, seen = new Set<string>()): Binding | undefined | null {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const info = files.get(file);
  if (!info) return null;
  const entry = info.exports.get(name);
  if (entry?.local !== undefined) return { module: file, local: entry.local };
  if (entry?.source !== undefined) {
    const target = resolveModule(entry.source, files);
    return target ? resolveExport(files, target, entry.imported ?? name, seen) : null;
  }
  if (name !== 'default') {
    for (const star of info.stars) {
      const target = resolveModule(star, files);
      if (!target) return null;
      const resolved = resolveExport(files, target, name, new Set(seen));
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function analyze(files: Map<string, string>) {
  const modules = new Map<string, ModuleInfo>();
  for (const [file, text] of files) modules.set(file, parseModule(file, text));
  const resolveImport = (entry: ImportEntry): Binding | undefined | null => {
    const target = resolveModule(entry.source, modules);
    return target ? resolveExport(modules, target, entry.imported) : null;
  };
  const bindingForTag = (info: ModuleInfo, tag: ts.JsxTagNameExpression): Binding | undefined | null => {
    const identifier = tagIdentifier(tag);
    if (!identifier || !/^[A-Z]/.test(identifier.text)) return undefined;
    const imported = info.imports.get(identifier.text);
    if (imported) {
      if (ts.isPropertyAccessExpression(tag)) {
        if (!imported.namespace || !ts.isIdentifier(tag.name)) return null;
        const target = resolveModule(imported.source, modules);
        return target ? resolveExport(modules, target, tag.name.text) : null;
      }
      return imported.namespace ? null : resolveImport(imported);
    }
    return { module: info.file, local: identifier.text };
  };
  return { modules, bindingForTag };
}

function addRule(codes: Set<ApprovalRuleCode>, affected: Set<string>, evidence: Set<string>, code: ApprovalRuleCode, files: string[], detail: string) {
  codes.add(code);
  for (const file of files) affected.add(file);
  evidence.add(detail);
}

/** Evaluate only the real pending diff. Static analysis is run on both base and draft trees. */
export async function evaluateApproval(options: {
  root: string;
  baseVersion: string;
  changedFiles: string[];
  selection?: Selection;
}): Promise<ApprovalEvaluation> {
  const { root, baseVersion, selection } = options;
  const changedFiles = [...new Set(options.changedFiles)].sort();
  const codes = new Set<ApprovalRuleCode>(), affected = new Set<string>(), evidence = new Set<string>();
  if (!changedFiles.length) return { required: false, ruleCodes: [], affected: [], evidence: [] };
  const allowed = new Set(selection ? [selection.src, ...(Array.isArray(selection.ancestors) ? selection.ancestors : [])]
    .map(src => src.replace(/:\d+:\d+$/, '')) : []);
  const outside = changedFiles.filter(file => !allowed.has(file));
  if (outside.length) addRule(codes, affected, evidence, 'out_of_scope', outside,
    selection ? `实际改动超出选中文件及其祖先：${outside.join('、')}` : `没有选中对象，非空改动范围未知：${outside.join('、')}`);
  const global = changedFiles.filter(file => (CSS_FILE.test(file) && !MODULE_CSS.test(file)) || GLOBAL_CONFIG.test(file));
  if (global.length) addRule(codes, affected, evidence, 'global_style', global, `全局样式或主题/场景配置发生变化：${global.join('、')}`);

  const sourceChanges = changedFiles.filter(file => SOURCE_FILE.test(file));
  if (sourceChanges.length) {
    let draft: Map<string, string> | undefined;
    try { draft = await sourceFiles(root); }
    catch (error) {
      addRule(codes, affected, evidence, 'analysis_uncertain', sourceChanges,
        `草稿静态分析失败，保守请示：${error instanceof Error ? error.message.replaceAll(root, '<作品>') : '未知解析错误'}`);
    }
    if (draft) {
      const base = new Map(draft);
      let baseError: unknown;
      try {
        for (const file of sourceChanges) {
          if (!/^src\/[A-Za-z0-9_./-]+$/.test(file) || file.split('/').includes('..')) throw new Error(`改动路径无法安全分析：${file}`);
          const content = await gitShow(root, baseVersion, file);
          if (content === undefined) base.delete(file); else base.set(file, content);
        }
      } catch (error) { baseError = error; }
      if (baseError) addRule(codes, affected, evidence, 'analysis_uncertain', sourceChanges,
        `基线静态分析失败，保守请示：${baseError instanceof Error ? baseError.message.replaceAll(root, '<作品>') : '未知解析错误'}`);
      const sides: Array<['基线' | '草稿', Map<string, string>]> = baseError ? [['草稿', draft]] : [['基线', base], ['草稿', draft]];
      for (const [label, snapshot] of sides) {
        try {
          const { modules, bindingForTag } = analyze(snapshot);
          const unresolved = [...modules.values()].flatMap(info => [
            ...info.uncertain,
            ...[...info.references].filter(reference => resolveModule(reference, modules) === null).map(() => `${info.file} 含无法解析的本地模块引用`),
          ]);
          for (const file of sourceChanges) {
            const info = modules.get(file);
            if (!info) continue;
            const consumers = [...modules.values()].filter(other => other.file !== file &&
              [...other.references].some(reference => resolveModule(reference, modules) === file)).map(other => other.file);
            if (consumers.length >= 2) addRule(codes, affected, evidence, 'shared_component', [file, ...consumers],
              `${label}中 ${file} 被 ${consumers.length} 个使用方引用：${consumers.join('、')}`);
            const exported = new Set([...info.exports.keys()].flatMap(name => {
              const binding = resolveExport(modules, file, name);
              return binding ? [`${binding.module}\0${binding.local}`] : [];
            }));
            if (!exported.size) continue;
            const locations: string[] = [];
            for (const other of modules.values()) for (const usage of other.jsx) {
              const binding = bindingForTag(other, usage.tag);
              if (binding && exported.has(`${binding.module}\0${binding.local}`)) locations.push(usage.at);
              else if (binding === null) unresolved.push(`${other.file} 的 JSX 组件来源无法确定`);
            }
            if (locations.length >= 2) addRule(codes, affected, evidence, 'shared_component', [file, ...locations],
              `${label}中 ${file} 的导出组件有 ${locations.length} 次 JSX 使用：${locations.join('、')}`);
          }
          if (unresolved.length) addRule(codes, affected, evidence, 'analysis_uncertain', sourceChanges,
            `${label}静态分析不完整，保守请示：${[...new Set(unresolved)].slice(0, 8).join('；')}`);
        } catch (error) {
          addRule(codes, affected, evidence, 'analysis_uncertain', sourceChanges,
            `${label}静态分析失败，保守请示：${error instanceof Error ? error.message.replaceAll(root, '<作品>') : '未知解析错误'}`);
        }
      }
    }
  }
  const selectedFile = selection?.src.replace(/:\d+:\d+$/, '');
  if (selection && selectedFile && changedFiles.includes(selectedFile) && Number.isInteger(selection.instances) && selection.instances > 1) {
    addRule(codes, affected, evidence, 'shared_component', [selectedFile], `选中对象上报 ${selection.instances} 个实例；该值仅作保守辅助证据`);
  }
  const ruleCodes = [...codes];
  return { required: ruleCodes.length > 0, ruleCodes, affected: [...affected].sort(), evidence: [...evidence].sort() };
}
