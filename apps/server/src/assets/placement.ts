import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import type { FastifyInstance } from 'fastify';
import type { AssetPlacementTarget, ModelProvenance } from '@spatial/shared';
import { isPlacementTarget } from '@spatial/shared';
import {
  adjustSceneModuleConfig,
  defaultSceneModuleConfig,
  type SceneModuleAdjustment,
} from '@spatial/shared/scene-module';
import type { AssetService } from './service.ts';
import type { SceneService } from '../scene/service.ts';
import type { WorkService } from '../work/service.ts';
import type { ModuleSceneService } from '../scene/modules.ts';
import { WorkError } from '../work/repo.ts';
import { readPlainFile } from '../checks/paths.ts';
import { sha256 } from './fallbacks.ts';
import { cleanAssetProvenance } from './provenance.ts';
import { findModuleReference, installAssetFiles } from '../work/asset-module.ts';

interface Session { id: string; assetId: string; baseVersion: string; expiresAt: number; result?: unknown; pending?: Promise<unknown>; fingerprint?: string }
type Classified = { kind: 'replace' } | { kind: 'replace-module'; instanceId: string } | { kind: 'insert' };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkError('INVALID_PLACEMENT', '放置请求必须是对象');
  return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, names: readonly string[]) {
  const extra = Object.keys(input).filter(key => !names.includes(key));
  if (extra.length) throw new WorkError('INVALID_PLACEMENT', `不支持的放置字段：${extra.join('、')}`);
}

function jsxAt(source: string, file: string, line: number, column: number): ts.JsxElement | ts.JsxSelfClosingElement {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let position: number;
  try { position = tree.getPositionOfLineAndCharacter(line - 1, column - 1); }
  catch { throw new WorkError('STALE_PLACEMENT_TARGET', '页面源码位置已变化', 409); }
  let anchor: ts.JsxElement | ts.JsxSelfClosingElement | undefined;
  function visit(node: ts.Node) {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && node.getStart(tree) === position) anchor = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!anchor) throw new WorkError('STALE_PLACEMENT_TARGET', '页面源码位置已变化或目标不是 JSX 元素', 409);
  return anchor;
}
function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();
}
function attribute(node: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | undefined {
  const attributes = (ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes).properties;
  for (const item of attributes) {
    if (!ts.isJsxAttribute(item) || item.name.getText() !== name) continue;
    if (item.initializer && ts.isStringLiteral(item.initializer)) return item.initializer.text;
    return '';
  }
  return undefined;
}
function containsTag(node: ts.Node, name: string): boolean {
  let found = false;
  function visit(child: ts.Node) {
    if (found) return;
    if ((ts.isJsxElement(child) && child.openingElement.tagName.getText() === name) ||
      (ts.isJsxSelfClosingElement(child) && child.tagName.getText() === name)) { found = true; return; }
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
function isMainSlot(node: ts.JsxElement | ts.JsxSelfClosingElement, file: string): boolean {
  const tag = tagName(node);
  if (tag === 'ProductHero') return file === 'src/App.tsx';
  return file === 'src/components/ProductHero.tsx' && attribute(node, 'data-testid') === 'product-scene' && containsTag(node, 'ProductScene');
}

function targetFile(target: AssetPlacementTarget): { file: string; line: number; column: number } {
  const match = /^(src\/[A-Za-z0-9_./-]+):([1-9]\d*):([1-9]\d*)$/.exec(target.src);
  if (!match || match[1].split('/').includes('..') || target.src.includes('\\')) throw new WorkError('INVALID_PLACEMENT_TARGET', '目标源码身份无效');
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

/** The server, not the iframe, decides which kind of target was actually hit. */
export async function classifyTarget(input: { work: WorkService; modules: ModuleSceneService; baseVersion: string; target: AssetPlacementTarget }): Promise<Classified> {
  const { work, modules, baseVersion, target } = input;
  if (target.kind === 'replace-module') {
    if (!target.instanceId) throw new WorkError('INVALID_PLACEMENT_TARGET', '替换实例缺少实例编号');
    const instanceId = target.instanceId;
    await modules.get(instanceId);
    await findModuleReference(work.repo.workRoot, instanceId);
    const reported = /^(src\/[A-Za-z0-9_./-]+):/.exec(target.src)?.[1];
    if (!reported || (reported !== 'src/spatial-module.tsx' && !reported.startsWith('src/scene-modules/'))) {
      throw new WorkError('PLACEMENT_TARGET_MISMATCH', '替换实例的目标来源与受信渲染器不一致', 409);
    }
    if (target.src.includes('\\')) throw new WorkError('INVALID_PLACEMENT_TARGET', '目标源码身份无效');
    return { kind: 'replace-module', instanceId };
  }
  const { file, line, column } = targetFile(target);
  const bytes = await work.repo.fileBufferAt(baseVersion, file);
  if (!bytes) throw new WorkError('STALE_PLACEMENT_TARGET', '目标源码在绑定版本中不存在', 409);
  const node = jsxAt(bytes.toString('utf8'), file, line, column);
  const main = isMainSlot(node, file);
  if (target.kind === 'replace') {
    if (!main) throw new WorkError('PLACEMENT_TARGET_MISMATCH', '该位置不是受支持的主 3D 槽位；新增模块请选择普通区域', 409);
    return { kind: 'replace' };
  }
  const tag = tagName(node);
  if (main || tag === 'ProductScene' || tag === 'ProductHero' || tag === 'SpatialModule' || tag.startsWith('SpatialModel')) {
    throw new WorkError('PLACEMENT_TARGET_MISMATCH', '该位置是已有 3D 展示区，请选择替换而不是新增', 409);
  }
  return { kind: 'insert' };
}

async function readAsset(assets: AssetService, assetId: string) {
  const asset = assets.get(assetId);
  const file = assets.modelPath(assetId);
  if (!asset || !file || asset.status !== 'ready') throw new WorkError('ASSET_NOT_READY', '放置需要本站已校验GLB', 409);
  const binary = await readPlainFile(file, 100 * 1024 * 1024, () => new WorkError('ASSET_PATH_DENIED', '模型路径含链接'), () => new WorkError('MODEL_TOO_LARGE', '模型超限'));
  if (!asset.provenance?.outputHash || asset.provenance.outputHash !== sha256(binary)) throw new WorkError('ASSET_CONTENT_CHANGED', '模型字节或来源未通过校验', 409);
  const provenance: ModelProvenance = { schemaVersion: 1, ...cleanAssetProvenance(asset.provenance), outputHash: sha256(binary) };
  return { asset, binary, provenance };
}

export function registerPlacementRoutes(
  app: FastifyInstance,
  assets: AssetService,
  scene: SceneService,
  work: WorkService,
  modules: ModuleSceneService,
  emit: (event: { type: string } & Record<string, unknown>) => unknown,
) {
  const sessions = new Map<string, Session>();
  app.post<{ Body: { assetId: string; baseVersion: string } }>('/assets/placements/sessions', async request => {
    const body = request.body;
    if (!body || typeof body.assetId !== 'string' || typeof body.baseVersion !== 'string' || Object.keys(body).some(key => !['assetId', 'baseVersion'].includes(key))) {
      throw new WorkError('INVALID_PLACEMENT', '放置会话字段无效');
    }
    await readAsset(assets, body.assetId);
    const { version } = await work.version();
    if (version !== body.baseVersion) throw new WorkError('STALE_PLACEMENT', '作品版本已变化', 409);
    for (const [key, value] of sessions) if (value.expiresAt < Date.now()) sessions.delete(key);
    if (sessions.size >= 50) throw new WorkError('PLACEMENT_LIMIT', '放置会话过多，请稍后重试', 429);
    const session: Session = { id: randomUUID(), assetId: body.assetId, baseVersion: version, expiresAt: Date.now() + 120_000 };
    sessions.set(session.id, session);
    return { sessionId: session.id, assetId: session.assetId, baseVersion: version, expiresAt: session.expiresAt };
  });

  app.post<{ Params: { id: string }; Body: { target: AssetPlacementTarget; adjustment?: unknown; force?: boolean } }>('/assets/placements/:id/confirm', async request => {
    const session = sessions.get(request.params.id);
    if (!session) throw new WorkError('PLACEMENT_NOT_FOUND', '放置会话不存在', 404);
    if (session.expiresAt < Date.now()) throw new WorkError('PLACEMENT_EXPIRED', '放置会话已过期', 409);
    const body = record(request.body);
    only(body, ['target', 'adjustment', 'force']);
    if (!isPlacementTarget(body.target)) throw new WorkError('INVALID_PLACEMENT', '目标不符合放置协议');
    const target = body.target as AssetPlacementTarget;
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new WorkError('INVALID_PLACEMENT', 'force 必须为布尔值');
    const fingerprint = JSON.stringify({ target: body.target, adjustment: body.adjustment ?? null, force: body.force === true });
    if (session.fingerprint && session.fingerprint !== fingerprint) throw new WorkError('PLACEMENT_CONFLICT', '同一会话不能确认不同目标或参数', 409);
    if (session.result) return session.result;
    if (session.pending) return session.pending;
    session.fingerprint = fingerprint;
    const operation = work.repo.exclusive(async () => {
      const head = await work.repo.head();
      if (head !== session.baseVersion) throw new WorkError('STALE_PLACEMENT', '作品版本已变化，请重新放置', 409);
      const classified = await classifyTarget({ work, modules, baseVersion: session.baseVersion, target });
      const { asset, binary, provenance } = await readAsset(assets, session.assetId);
      if (classified.kind === 'replace') {
        const change = await scene.adopt(assets, asset.id, body.force === true);
        const { version } = await work.version();
        return { kind: 'replace', change, version };
      }
      if (classified.kind === 'replace-module') {
        if (!asset.metrics?.webReady && body.force !== true) throw new WorkError('MODEL_NOT_WEB_READY', '模型超过网页门槛，先优化或明确强制替换该实例', 409);
        await installAssetFiles({ root: work.repo.workRoot, assetId: asset.id, binary, provenance, parts: asset.metrics?.parts });
        const result = await modules.replaceModel(classified.instanceId, asset.id, session.baseVersion);
        emit({ type: 'version.changed', version: result.version, previous: session.baseVersion, reason: 'module-replace' });
        return { kind: 'replace-module', config: result.config, version: result.version };
      }
      if (!asset.metrics?.webReady && body.force !== true) throw new WorkError('MODEL_NOT_WEB_READY', '模型超过网页门槛，先优化或明确强制新增实例', 409);
      const baseConfig = defaultSceneModuleConfig({ instanceId: '0'.repeat(32), assetId: asset.id });
      const config = body.adjustment === undefined ? baseConfig : adjustSceneModuleConfig(baseConfig, body.adjustment as SceneModuleAdjustment);
      const task = await work.createAssetCandidate({
        baseVersion: session.baseVersion, assetId: asset.id, binary, provenance,
        parts: asset.metrics?.parts, target, config, force: body.force === true,
      });
      return { kind: 'insert', task };
    });
    session.pending = operation;
    try { session.result = await operation; return session.result; }
    catch (error) { session.fingerprint = undefined; throw error; }
    finally { session.pending = undefined; }
  });

  app.get('/assets/modules', async () => work.repo.exclusive(async () => {
    const list = await modules.list();
    return list.map(item => ({ id: item.config.instanceId, config: item.config, canUndo: item.canUndo, stale: item.stale, entries: item.entries }));
  }));
  app.get<{ Params: { id: string } }>('/assets/modules/:id', async request => work.repo.exclusive(() => modules.get(request.params.id)));

  app.post<{ Params: { id: string }; Body: { baseVersion: string; adjustment: unknown } }>('/assets/modules/:id/adjust', async request => {
    const body = record(request.body);
    only(body, ['baseVersion', 'adjustment']);
    if (typeof body.baseVersion !== 'string') throw new WorkError('INVALID_MODULE', '缺少作品版本');
    const result = await modules.adjust(request.params.id, body.adjustment, body.baseVersion);
    emit({ type: 'version.changed', version: result.version, previous: body.baseVersion, reason: 'module-adjust' });
    return result;
  });

  app.post<{ Params: { id: string }; Body: { baseVersion: string } }>('/assets/modules/:id/undo', async request => {
    const body = record(request.body);
    only(body, ['baseVersion']);
    if (typeof body.baseVersion !== 'string') throw new WorkError('INVALID_MODULE', '缺少作品版本');
    const result = await modules.undo(request.params.id, body.baseVersion);
    emit({ type: 'version.changed', version: result.version, previous: body.baseVersion, reason: 'module-undo' });
    return result;
  });

  app.post<{ Params: { id: string }; Body: { baseVersion: string } }>('/assets/modules/:id/remove', async request => {
    const body = record(request.body);
    only(body, ['baseVersion']);
    if (typeof body.baseVersion !== 'string') throw new WorkError('INVALID_MODULE', '缺少作品版本');
    return work.removeModuleCandidate({ baseVersion: body.baseVersion, instanceId: request.params.id });
  });
}
