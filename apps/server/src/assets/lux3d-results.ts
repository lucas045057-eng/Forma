import type { LuxArtifact, LuxTask } from '@spatial/shared';
import { AssetError } from './lux3d.ts';
import type { LuxParameters } from './lux3d-operations.ts';

export interface LuxOutputSpec {
  url: string;
  kind: LuxArtifact['kind'];
  format: string;
  label?: string;
  animationId?: string;
  animationIds?: string[];
  animationMode?: 'separate' | 'combined';
}

const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp'];
const MODEL_FORMATS = ['glb', 'fbx', 'ply', 'obj', 'stl', '3mf'];
const ARCHIVE_FORMATS = ['zip', 'usdz', 'obj_zip', 'fbx_zip'];

function formatFromUrl(url: string, fallback = 'bin'): string {
  const format = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9_]+)$/)?.[1] ?? fallback;
  if (![...IMAGE_FORMATS, ...MODEL_FORMATS, ...ARCHIVE_FORMATS, 'bin'].includes(format)) throw new AssetError('UNSUPPORTED_OUTPUT', '产物格式不在受支持清单中', 502, 'unknown');
  return format;
}
function kindOf(format: string): LuxArtifact['kind'] {
  if (IMAGE_FORMATS.includes(format)) return 'image';
  if (ARCHIVE_FORMATS.includes(format)) return 'archive';
  return 'model';
}
function output(url: string, format: string, label?: string, extra: Partial<LuxOutputSpec> = {}): LuxOutputSpec {
  return { url, format, kind: kindOf(format), label, ...extra };
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function isPlaceholder(value: unknown): boolean { return !text(value) || text(value) === 'NOT_REQUESTED'; }
function parseJson(value: string, code: string, message: string): unknown {
  try { return JSON.parse(value); } catch { throw new AssetError(code, message, 502, 'unknown'); }
}
function errorJson(value: string): { code?: unknown; message?: unknown } | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const error = (parsed as Record<string, unknown>).error;
  return error && typeof error === 'object' && !Array.isArray(error) ? error as { code?: unknown; message?: unknown } : undefined;
}

export function parseLuxOutputs(task: LuxTask, raw: Array<{ content: string }>): LuxOutputSpec[] {
  const notes: string[] = [];
  const values = raw.map(item => text(item.content));
  if (task.operation === 'four-view') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '四视图没有任何结果', 502, 'unknown');
    const images = parseJson(content, 'UPSTREAM_FORMAT', '四视图JSON损坏');
    if (!Array.isArray(images) || images.length !== 4 || images.some(item => typeof item !== 'string')) throw new AssetError('UPSTREAM_FORMAT', '四视图必须返回四张图', 502, 'unknown');
    return images.map((url, index) => {
      const format = formatFromUrl(url, 'png');
      if (!IMAGE_FORMATS.includes(format)) throw new AssetError('UNSUPPORTED_OUTPUT', '四视图返回非图片', 502, 'unknown');
      return output(url, format, ['前斜视图', '后斜视图', '侧面', '背面'][index]);
    });
  }
  if (task.operation === 'animation-retarget') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '动作重定向没有任何结果', 502, 'unknown');
    const body = parseJson(content, 'UPSTREAM_FORMAT', '动作JSON损坏') as { actions?: unknown };
    if (!Array.isArray(body.actions) || !body.actions.length) throw new AssetError('UPSTREAM_FORMAT', '动作结果为空', 502, 'unknown');
    const delivered: Array<LuxOutputSpec & { ids: string[] }> = [];
    let failures = 0;
    for (const item of body.actions) {
      if (!item || typeof item !== 'object') throw new AssetError('UPSTREAM_FORMAT', '动作条目无效', 502, 'unknown');
      const action = item as Record<string, unknown>;
      const ids = Array.isArray(action.animation_ids) ? action.animation_ids.filter((id): id is string => typeof id === 'string') :
        typeof action.animation_id === 'string' ? [action.animation_id] : [];
      if (!ids.length) throw new AssetError('UPSTREAM_FORMAT', '动作身份无效', 502, 'unknown');
      if (action.status !== 'success') {
        failures++;
        const error = action.error && typeof action.error === 'object' ? action.error as { code?: unknown; message?: unknown } : undefined;
        notes.push(`未交付动作：${ids.join('、')}${error?.message ? `（${String(error.message)}）` : ''}`);
        continue;
      }
      const url = [action.animationGlbUrl, action.fbxUrl, action.glbUrl, action.url].find(value => typeof value === 'string' && value) as string | undefined;
      if (!url) throw new AssetError('UPSTREAM_FORMAT', '动作缺少URL', 502, 'unknown');
      delivered.push({ ...output(url, formatFromUrl(url, 'glb'), ids.join('、')), ids });
    }
    if (!delivered.length) throw new AssetError('ACTION_DELIVERY_FAILED', '所有动作均未交付；成功产物不存在，请查询原任务，不自动重新创建', 502, 'unknown');
    const combined = delivered.length > 1 && delivered.every(item => item.url === delivered[0].url);
    if (combined) {
      const ids = delivered.flatMap(item => item.ids);
      const first = delivered[0];
      return [{ ...output(first.url, first.format, ids.join('、'), { animationIds: ids, animationMode: 'combined' }) }];
    }
    const result = delivered.map(item => {
      const spec = output(item.url, item.format, item.ids.join('、'), { animationIds: item.ids, animationMode: delivered.length > 1 ? 'separate' : undefined });
      if (item.ids.length === 1) spec.animationId = item.ids[0];
      return spec;
    });
    if (failures) task.note = `${task.note ? task.note + '；' : ''}${notes.join('；')}；成功动作仍保留，可单独使用`;
    return result;
  }
  if (task.operation === 'image') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '图片结果为空', 502, 'unknown');
    const format = formatFromUrl(content, 'png');
    if (!IMAGE_FORMATS.includes(format)) throw new AssetError('UNSUPPORTED_OUTPUT', '单图结果不是图片', 502, 'unknown');
    return [output(content, format, '生成图片')];
  }
  if (task.operation === 'humanoid-rig') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '绑骨结果为空', 502, 'unknown');
    const error = errorJson(content);
    if (error) throw new AssetError('RIG_FAILED', `自动绑骨失败：${String(error.message ?? error.code ?? '模型不满足绑骨要求')}`, 502, 'unknown');
    const format = formatFromUrl(content, 'glb');
    if (format !== 'glb') throw new AssetError('UNSUPPORTED_OUTPUT', '绑骨结果不是GLB', 502, 'unknown');
    return [output(content, 'glb', '已绑骨模型')];
  }
  if (task.operation === 'part-split') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '部件拆分结果为空', 502, 'unknown');
    return [output(content, formatFromUrl(content, 'glb'), '拆分模型')];
  }
  if (task.operation === 'articulation-animation') {
    const content = values.find(value => value && value !== 'NOT_REQUESTED');
    if (!content) throw new AssetError('UPSTREAM_FORMAT', '关节动画结果为空', 502, 'unknown');
    const error = errorJson(content);
    if (error) throw new AssetError('ARTICULATION_FAILED', `关节化动画失败：${String(error.message ?? error.code ?? '未生成结果')}`, 502, 'unknown');
    return [output(content, formatFromUrl(content, 'bin'), '关节动画结果')];
  }

  const parameters = (task as LuxTask & { parameters?: LuxParameters }).parameters;
  const turbo = (task.operation === 'image-to-3d' || task.operation === 'text-to-3d') && parameters?.version === 'G1-Turbo';
  const requested = (parameters?.outputFormat as string[] | undefined)?.length ? parameters!.outputFormat as string[] : ['zip'];
  const slots = task.operation === 'material-transfer' ? ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'] :
    task.operation === 'export' ? ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'] :
    task.operation === 'image-to-3d' || task.operation === 'text-to-3d' ? (turbo ? requested : ['zip', 'glb', 'ply']) : [];
  const result: LuxOutputSpec[] = [];
  for (const [index, value] of values.entries()) {
    const slot = turbo ? undefined : slots[index];
    if (isPlaceholder(value)) {
      if (slot) notes.push(`未请求或未返回格式：${slot}`);
      continue;
    }
    let format = formatFromUrl(value, slot ?? requested[index] ?? 'bin');
    if (format === 'zip' && slot && ['obj_zip', 'fbx_zip'].includes(slot)) format = slot;
    result.push(output(value, format, slot ?? (turbo ? format : undefined)));
  }
  if (notes.length) task.note = `${task.note ? task.note + '；' : ''}${notes.join('；')}`;
  return result;
}
