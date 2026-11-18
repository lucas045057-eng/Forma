import { useEffect, useRef, useState } from 'react';
import type { Asset, LuxCapabilities, LuxOperation, LuxTask } from '@spatial/shared';
import { ProductScene } from '@spatial/scene-renderer';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import { describeError, luxApi, type WorkbenchUpload } from './lux3d-api.ts';
import type { PlacementSession } from './placement-state.ts';
import { DragSessionCache, liveSession } from './drag-session.ts';

const operationNames: Record<LuxOperation, string> = {
  'image-to-3d': '图生3D', 'text-to-3d': '文生3D', image: '多模态生图', 'four-view': '四视图',
  'material-transfer': '材质迁移', 'part-split': '部件拆分', export: '多格式导出',
  'articulation-animation': '关节化与动画', 'humanoid-rig': '数字人绑骨', 'animation-retarget': '动画重定向',
};
const stages: Record<LuxTask['stage'], string> = {
  reserved: '已登记，等待本地处理', uploading: '上传到云端', submitting: '提交中', submit_unknown: '结果待核实（不会自动重提）',
  queued: '等待中', running: '处理中', ready: '结果可查看', failed: '失败', cancelled: '已停止或远端取消',
};
const animationIds = ['A_TPose', 'Dance_Loop', 'Idle_Rail_Call', 'Idle_TalkingPhone_Loop', 'Idle_Talking_Loop', 'Yes', 'Crouch_Idle_Loop', 'Idle_FoldArms_Loop', 'Idle_Lantern_Loop', 'Idle_Loop', 'Idle_No_Loop', 'Idle_Rail_Loop', 'Idle_Torch_Loop', 'ClimbUp_1m', 'Crouch_Fwd_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Swim_Fwd_Loop', 'Swim_Idle_Loop', 'Walk_Formal_Loop', 'Walk_Loop', 'Jump_Land', 'Jump_Loop', 'Jump_Start', 'NinjaJump_Idle_Loop', 'NinjaJump_Land', 'NinjaJump_Start', 'Roll', 'Slide_Exit', 'Slide_Loop', 'Slide_Start', 'Sword_Attack', 'Sword_Block', 'Sword_Dash', 'Sword_Heavy_Combo', 'Sword_Idle', 'Sword_Regular_A', 'Sword_Regular_A_Rec', 'Sword_Regular_B', 'Sword_Regular_B_Rec', 'Sword_Regular_C', 'Sword_Regular_Combo', 'Idle_Shield_Break', 'Idle_Shield_Loop', 'Shield_Dash', 'Shield_OneShot', 'Melee_Hook', 'Melee_Hook_Rec', 'Punch_Cross', 'Punch_Jab', 'Pistol_Aim_Down', 'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Idle_Loop', 'Pistol_Reload', 'Pistol_Shoot', 'Spell_Simple_Enter', 'Spell_Simple_Exit', 'Spell_Simple_Idle_Loop', 'Spell_Simple_Shoot', 'Chest_Open', 'Consume', 'Driving_Loop', 'Farm_Harvest', 'Farm_PlantSeed', 'Farm_Watering', 'Fixing_Kneeling', 'Interact', 'OverhandThrow', 'PickUp_Table', 'Push_Loop', 'TreeChopping_Loop', 'Walk_Carry_Loop', 'LayToIdle', 'Sitting_Enter', 'Sitting_Exit', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Death01', 'Hit_Chest', 'Hit_Head', 'Hit_Knockback', 'Zombie_Idle_Loop', 'Zombie_Scratch', 'Zombie_Walk_Fwd_Loop'];

function readKey(signature: string): string {
  const storageKey = `lux3d-create:${signature}`;
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing) return existing;
    const key = crypto.randomUUID();
    localStorage.setItem(storageKey, key);
    return key;
  } catch { return crypto.randomUUID(); }
}
function clearKey(signature: string) {
  try { localStorage.removeItem(`lux3d-create:${signature}`); } catch { /* private mode: new in-memory key is still used */ }
}

export const MAX_ACTIVE_GLB_PREVIEWS = 4;

export function promotePreviewId(manualIds: readonly string[], id: string, limit = MAX_ACTIVE_GLB_PREVIEWS): string[] {
  const cap = Math.max(1, limit);
  return [id, ...manualIds.filter(existing => existing !== id)].slice(0, cap);
}

export function resolveActivePreviewIds(
  orderedIds: readonly string[],
  manualIds: readonly string[],
  limit = MAX_ACTIVE_GLB_PREVIEWS,
): Set<string> {
  const cap = Math.max(1, limit);
  const available = new Set(orderedIds);
  const active = new Set<string>();
  for (const id of manualIds) {
    if (active.size >= cap) break;
    if (available.has(id)) active.add(id);
  }
  for (const id of orderedIds) {
    if (active.size >= cap) break;
    active.add(id);
  }
  return active;
}

export function ArtifactGlbPreview({
  previewUrl,
  active,
  onActivate,
  initialClips = [],
}: {
  previewUrl: string;
  active: boolean;
  onActivate: () => void;
  initialClips?: string[];
}) {
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const [clips, setClips] = useState<string[]>(initialClips);
  const [clip, setClip] = useState(initialClips[0] ?? '');

  useEffect(() => {
    setPlaying(false);
    setClips(initialClips);
    setClip(initialClips[0] ?? '');
  }, [previewUrl]);

  useEffect(() => {
    if (!active) setPlaying(false);
  }, [active]);

  if (!active) {
    return (
      <div className="lux-model-preview-deferred" data-testid="lux-preview-deferred">
        <p className="hint">为保护浏览器显存，已暂停此历史卡片的实时 3D 视口（同时最多开启 {MAX_ACTIVE_GLB_PREVIEWS} 个）。</p>
        <button type="button" onClick={onActivate}>加载 3D 预览</button>
      </div>
    );
  }

  return (
    <>
      <div className="lux-model-preview">
        <ProductScene
          config={defaultSceneConfig}
          modelUrl={previewUrl}
          controls
          animation={{ playing, clip, loop }}
          onAnimations={names => {
            setClips(names);
            setClip(previous => (previous && names.includes(previous) ? previous : names[0] ?? ''));
          }}
        />
      </div>
      <label>动画片段<select value={clip} onChange={event => { setClip(event.target.value); setPlaying(false); }}><option value="">默认（静态）</option>{clips.map(name => <option key={name} value={name}>{name}</option>)}</select></label>
      <label><input type="checkbox" checked={loop} onChange={event => setLoop(event.target.checked)} />循环播放</label>
      <button type="button" onClick={() => setPlaying(previous => !previous)}>{playing ? '暂停动画' : '播放动画'}</button>
    </>
  );
}

export default function Lux3DWorkbench({ assets, onPlace, onPreparePlace }: {
  assets: Asset[];
  onPlace?: (asset: Asset, session?: PlacementSession, drag?: boolean) => void;
  onPreparePlace?: (asset: Asset) => Promise<PlacementSession>;
}) {
  const [dragSessions, setDragSessions] = useState<Record<string, PlacementSession>>({});
  const [sessionCache] = useState(() => new DragSessionCache());
  const [remote, setRemote] = useState<Array<{ providerTaskId: string; status: number; created?: string }>>([]);
  const [remotePage, setRemotePage] = useState(1);
  const [capabilities, setCapabilities] = useState<LuxCapabilities>();
  const [operation, setOperation] = useState<LuxOperation>('image-to-3d');
  const [uploads, setUploads] = useState<WorkbenchUpload[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [version, setVersion] = useState('G1');
  const [style, setStyle] = useState('photorealistic');
  const [faceCount, setFaceCount] = useState(100000);
  const [formats, setFormats] = useState<string[]>(['glb']);
  const [pbr, setPbr] = useState(true);
  const [predict, setPredict] = useState(true);
  const [customSize, setCustomSize] = useState(1000);
  const [actions, setActions] = useState<string[]>(['Idle_Loop']);
  const [mode, setMode] = useState('separate');
  const [outFormat, setOutFormat] = useState('glb');
  const [inPlace, setInPlace] = useState(false);
  const [tasks, setTasks] = useState<LuxTask[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualPreviewIds, setManualPreviewIds] = useState<string[]>([]);
  const submitKey = useRef<{ signature: string; key: string } | undefined>(undefined);
  const orderedGlbPreviewIds = tasks.flatMap(task =>
    task.artifacts.filter(artifact => artifact.format === 'glb' && !!artifact.previewUrl).map(artifact => artifact.id),
  );
  const activeGlbPreviewIds = resolveActivePreviewIds(orderedGlbPreviewIds, manualPreviewIds);

  useEffect(() => {
    let active = true;
    void luxApi.uploads().then(value => { if (active) setUploads(value); }).catch(cause => { if (active) setError(describeError(cause)); });
    const refresh = () => luxApi.tasks().then(value => { if (active) setTasks(value); }).catch(cause => { if (active) setError(describeError(cause)); });
    void luxApi.capabilities().then(value => { if (active) setCapabilities(value); }).catch(cause => { if (active) setError(describeError(cause)); });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  async function upload(files: FileList | File[]) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const selection = Array.from(files);
      if (!selection.length) return;
      const incoming = selection.filter(file => !file.name.toLowerCase().endsWith('.glb'));
      if (images.length + incoming.length > 32) throw new Error('最多选择 32 张有序图片，请先移除多余输入');
      const result: WorkbenchUpload[] = [];
      for (const file of selection) {
        if (!/\.(png|jpe?g|webp|glb)$/i.test(file.name)) throw new Error('只接受 PNG/JPEG/WebP 图片或 GLB 模型');
        result.push(await luxApi.upload(file));
      }
      setUploads(previous => [...previous, ...result]);
      setImages(previous => [...previous, ...result.filter(item => item.kind === 'image').map(item => item.id)].slice(0, 32));
      if (result.some(item => item.kind === 'glb')) setModel(result.find(item => item.kind === 'glb')!.id);
      setNotice('文件只保存在本站本地暂存区，尚未上传云端，也不会计费。');
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }

  function parameters(): Record<string, unknown> {
    if (operation === 'image-to-3d') return { imageUploadIds: images, version, faceCount, outputFormat: formats.filter(item => ['zip', 'glb', 'ply'].includes(item)), enablePbr: pbr, aiPredictSize: predict };
    if (operation === 'text-to-3d') return { prompt, style, ...(images[0] ? { imageUploadId: images[0] } : {}), version, faceCount, outputFormat: formats.filter(item => ['zip', 'glb', 'ply'].includes(item)), enablePbr: pbr, aiPredictSize: predict };
    if (operation === 'image' || operation === 'four-view') return { ...(prompt ? { prompt } : {}), ...(images[0] ? { imageUploadId: images[0] } : {}) };
    if (operation === 'material-transfer') return { modelUploadId: model, imageUploadId: images[0], version: 'v3.0-standard', outputFormat: formats.filter(item => ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'].includes(item)), aiPredictSize: predict, ...(!predict ? { customSize } : {}) };
    if (operation === 'export') return { modelUploadId: model, outputFormat: formats.filter(item => ['usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'].includes(item)) };
    if (operation === 'articulation-animation') return { modelUploadId: model, prompt };
    if (operation === 'animation-retarget') return { modelUploadId: model, animationIds: actions, animationOutputMode: mode, outFormat, animateInPlace: inPlace };
    return { modelUploadId: model };
  }

  const needsModel = ['material-transfer', 'part-split', 'export', 'articulation-animation', 'humanoid-rig', 'animation-retarget'].includes(operation);
  const needsPrompt = ['text-to-3d', 'articulation-animation'].includes(operation);
  const selectedModel = uploads.find(item => item.id === model);
  const missing =
    needsModel && !model ? '请上传或从结果选择 GLB 模型'
      : operation === 'animation-retarget' && !selectedModel?.rigged ? '请先选择已绑骨 GLB；未绑骨模型可先使用数字人绑骨'
        : operation === 'material-transfer' && !images.length ? '请先上传材质图片'
          : needsPrompt && !prompt.trim() ? '请填写描述'
            : (operation === 'image' || operation === 'four-view') && !images.length && !prompt.trim() ? '请提供图片或描述'
              : operation === 'image-to-3d' && !images.length ? '请先拖入图片'
                : operation === 'animation-retarget' && !actions.length ? '请选择至少一个动作 ID'
                  : ['image-to-3d', 'text-to-3d'].includes(operation) && !formats.includes('glb') ? '主流程需要在输出格式中勾选 glb，才能把模型放入网页' : operation === 'export' && !formats.some(item => ['usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'].includes(item)) ? '请选择至少一种导出格式'
                  : '';

  async function create() {
    if (busy || missing) return;
    setBusy(true); setError(''); setNotice('');
    const args = parameters();
    const signature = JSON.stringify({ operation, args });
    if (submitKey.current?.signature !== signature) submitKey.current = { signature, key: readKey(signature) };
    const idempotencyKey = submitKey.current!.key;
    try {
      const task = await luxApi.create(operation, args, idempotencyKey);
      setTasks(previous => [task, ...previous.filter(item => item.localId !== task.localId)]);
      if (task.stage === 'submit_unknown') setNotice('提交结果未知：已保留本次幂等键，不会自动重提。请先按原任务编号查询或在历史中由你明确关联。');
    } catch (cause) {
      setError(`${describeError(cause)}；重试会保持原幂等键，不会自动重复提交。`);
      if (cause && typeof cause === 'object' && (cause as { code?: string }).code === 'IDEMPOTENCY_CONFLICT') submitKey.current = undefined;
    } finally { setBusy(false); }
  }

  function replacement() {
    const signature = JSON.stringify({ operation, args: parameters() });
    clearKey(signature);
    submitKey.current = undefined;
    setNotice('已准备新一轮创作；仍需再次点击创建才会上传并计费提交。');
  }

  async function useInput(task: string, artifact: string) {
    try {
      const result = await luxApi.useInput(task, artifact);
      setUploads(previous => [...previous, result]);
      if (result.kind === 'image') setImages(previous => [...previous, result.id].slice(0, 32));
      else setModel(result.id);
      setNotice('已把原始产物加入本地暂存区；下一次云操作会在点击生成后才上传原件。');
    } catch (cause) { setError(describeError(cause)); }
  }

  async function prepare(asset: Asset) {
    if (!onPreparePlace) return;
    try {
      await sessionCache.ensure(asset.id, () => onPreparePlace(asset));
      setDragSessions(sessionCache.snapshot());
    } catch (cause) { setError(describeError(cause)); }
  }

  return <section className="lux-workbench" data-testid="lux-workbench">
    <h3>从图片创作 3D</h3>
    <div className="lux-dropzone" tabIndex={0}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
      onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void upload(event.dataTransfer.files); }}>
      <p>把图片或 GLB 拖到这里，也可以选择文件。拖入只会本地暂存，不会上传云端或计费。</p>
      <input type="file" data-testid="lux-files" accept="image/png,image/jpeg,image/webp,.glb" multiple disabled={busy}
        onChange={event => { if (event.target.files) void upload(event.target.files); event.target.value = ''; }} />
    </div>
    <details>
      <summary>选择已上传的图片（保持顺序）</summary>
      {uploads.filter(item => item.kind === 'image').map(item => <label key={item.id}>
        <input type="checkbox" checked={images.includes(item.id)} onChange={event => setImages(previous => event.target.checked ? [...previous, item.id].slice(0, 32) : previous.filter(id => id !== item.id))} />
        {item.filename}
      </label>)}
    </details>
    {images.length > 0 && <div className="lux-input-order">{images.map((id, index) => <div key={id}>
      <img src={`/assets/uploads/${id}/preview`} alt={`参考图${index + 1}`} width={48} height={48} />
      <span>{index + 1} · {uploads.find(item => item.id === id)?.filename ?? id.slice(0, 8)}</span>
      <button type="button" disabled={index === 0} onClick={() => setImages(previous => { const next = [...previous];[next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>向前</button>
      <button type="button" onClick={() => setImages(previous => previous.filter(value => value !== id))}>移除</button>
    </div>)}</div>}
    <label>可选描述<textarea aria-label="Lux3D描述" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={4000} /></label>
    {operation === 'image-to-3d' && <p className="hint">官方图生3D接口不接受描述；需要描述时请点击下面的“改用文生3D”。</p>}
    {operation === 'image-to-3d' && prompt.trim() && <button type="button" onClick={() => { setOperation('text-to-3d'); setNotice('已切换为文生3D，并保留第一张参考图；不会自动提交。'); }}>改用文生3D（保留参考图）</button>}
    <details>
      <summary>高级工具与参数</summary>
      <label>工具<select data-testid="lux-operation" value={operation} onChange={event => { setOperation(event.target.value as LuxOperation); submitKey.current = undefined; setFormats(event.target.value === 'export' ? [] : ['glb']); }}>{Object.entries(operationNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      {needsModel && <label>输入模型<select aria-label="输入GLB" value={model} onChange={event => setModel(event.target.value)}>
        <option value="">选择本站上传的 GLB</option>
        {uploads.filter(item => item.kind === 'glb' || (operation === 'export' && item.kind === 'lux-zip')).map(item => <option key={item.id} value={item.id}>{item.filename}{item.rigged ? '（已绑骨）' : ''}</option>)}
      </select></label>}
      {['image-to-3d', 'text-to-3d'].includes(operation) && <>
        <label>模型版本<select value={version} onChange={event => setVersion(event.target.value)}><option>G1</option><option>G1-Turbo</option></select></label>
        <label>目标面数<input type="number" min={10000} max={300000} step={1000} value={faceCount} onChange={event => setFaceCount(Number(event.target.value))} /></label>
        <label><input type="checkbox" checked={pbr} onChange={event => setPbr(event.target.checked)} />PBR材质</label>
      </>}
      {operation === 'text-to-3d' && <label>风格<select value={style} onChange={event => setStyle(event.target.value)}>{['photorealistic', 'cartoon', 'anime', 'hand_painted', 'cyberpunk', 'fantasy', 'glass'].map(value => <option key={value}>{value}</option>)}</select></label>}
      {['image-to-3d', 'text-to-3d', 'material-transfer'].includes(operation) && <>
        <label><input type="checkbox" checked={predict} onChange={event => setPredict(event.target.checked)} />AI尺寸预测</label>
        {operation === 'material-transfer' && !predict && <label>目标高度（毫米）<input type="number" min={1} value={customSize} onChange={event => setCustomSize(Number(event.target.value))} /></label>}
      </>}
      {['image-to-3d', 'text-to-3d', 'material-transfer', 'export'].includes(operation) && <fieldset>
        <legend>输出格式</legend>
        {(operation === 'export' ? ['usdz', 'obj_zip', 'fbx_zip', 'stl', '3mf'] : operation === 'material-transfer' ? ['zip', 'glb', 'usdz', 'obj_zip', 'fbx_zip'] : ['zip', 'glb', 'ply']).map(value => <label key={value}>
          <input type="checkbox" checked={formats.includes(value)} onChange={event => setFormats(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value))} />{value}
        </label>)}
        {operation === 'export' && <p className="hint">GLB 导出必须至少选择一种目标格式；此接口不接受 glb 作为导出格式。</p>}
      </fieldset>}
      {operation === 'animation-retarget' && <>
        <label>选择 1–10 个动作<select multiple aria-label="动作ID" value={actions} onChange={event => setActions(Array.from(event.target.selectedOptions, option => option.value).slice(0, 10))}>{animationIds.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>动作交付<select value={mode} onChange={event => setMode(event.target.value)}><option value="separate">每动作一个文件</option><option value="combined">合并为多动画片段</option></select></label>
        <label>动画格式<select value={outFormat} onChange={event => setOutFormat(event.target.value)}><option>glb</option><option>fbx</option></select></label>
        <label><input type="checkbox" checked={inPlace} onChange={event => setInPlace(event.target.checked)} />原地动画</label>
      </>}
    </details>
    <p className="hint">{capabilities?.billingNotice ?? '点击创建会把输入上传到云端并提交一次可能计费的任务；拖入、选参数和刷新都不会创建任务。'}</p>
    {capabilities?.legacyGateway && <p role="status">当前配置指向旧网关 {capabilities.activeGateway}。新能力按官方 api.aholo.cn 规范实现，不会自动改域或重试付费请求。</p>}
    {capabilities && <p className="hint">本地同时最多处理 {capabilities.limits.activeLocalTasks} 个任务；满额时新请求会被明确拒绝，不会静默排队或提交。</p>}
    {missing && <p role="status">{missing}</p>}
    {notice && <p role="status">{notice}</p>}
    <button type="button" data-testid="lux-create" disabled={busy || !!missing || capabilities?.configured !== true} onClick={() => void create()}>
      {busy ? '处理中…' : operation === 'image-to-3d' ? '生成模型' : `创建${operationNames[operation]}任务`}
    </button>
    <button type="button" disabled={busy} onClick={replacement}>明确开始同参数的新创作</button>
    {capabilities && !capabilities.configured && <p role="status">后端未配置 Lux3D 密钥，请由操作者私密配置。</p>}
    {error && <p role="alert">{error}</p>}

    <details>
      <summary>云端已有任务历史（只查询）</summary>
      <p>先在高级工具选中原任务的操作类型，再导入结果；不会重新生成。</p>
      <label>页码<input type="number" min={1} max={100} value={remotePage} onChange={event => setRemotePage(Number(event.target.value))} /></label>
      <button type="button" onClick={() => void luxApi.remoteHistory(remotePage).then(setRemote).catch(cause => setError(describeError(cause)))}>查询云端历史</button>
      {remote.map(item => <div key={item.providerTaskId}>
        <span>{item.providerTaskId} · 状态{item.status}</span>
        <button type="button" onClick={() => void luxApi.importExisting(operation, item.providerTaskId).then(task => setTasks(previous => [task, ...previous.filter(value => value.localId !== task.localId)])).catch(cause => setError(describeError(cause)))}>按{operationNames[operation]}导入</button>
      </div>)}
    </details>

    <h3>创作历史</h3>
    {tasks.map(task => <article key={task.localId} className="lux-result" data-testid="lux-task" data-stage={task.stage}>
      <strong>{operationNames[task.operation]} · {stages[task.stage]}</strong>
      <p>{new Date(task.createdAt).toLocaleString()}</p>
      {['running', 'queued'].includes(task.stage) && <>
        <progress aria-label="处理中" />
        <button type="button" onClick={() => void luxApi.stop(task.localId).then(updated => setTasks(previous => previous.map(item => item.localId === updated.localId ? updated : item))).catch(cause => setError(describeError(cause)))}>只停止本地等待（远端可能继续）</button>
      </>}
      {task.note && <p role="status">{task.note}</p>}
      {task.error && <p role="alert">{task.error.message}{task.error.classification === 'unknown' ? '（结果未知，不会自动重提）' : ''}</p>}
      {task.stage === 'submit_unknown' && <>
        <button type="button" onClick={() => void luxApi.resume(task.localId).then(updated => setTasks(previous => previous.map(item => item.localId === updated.localId ? updated : item))).catch(cause => setError(describeError(cause)))}>只查询恢复，不重新创建</button>
        <p className="hint">下面只是时间上可能对应的任务；不会自动认领，必须由你逐个确认关联。</p>
        {task.resumeCandidates?.map(item => <button type="button" key={item.providerTaskId} onClick={() => void luxApi.link(task.localId, item.providerTaskId).then(updated => setTasks(previous => previous.map(value => value.localId === updated.localId ? updated : value))).catch(cause => setError(describeError(cause)))}>确认关联已有任务 {item.providerTaskId}（状态{item.status}）</button>)}
      </>}
      {task.manualLink && <p className="hint">此任务由你在 {new Date(task.manualLink.at).toLocaleString()} 明确关联；不是自动恢复的原提交证明。</p>}
      {task.artifacts.length > 0 && <button type="button" onClick={() => void luxApi.refresh(task.localId).then(updated => setTasks(previous => previous.map(item => item.localId === updated.localId ? updated : item))).catch(cause => setError(describeError(cause)))}>刷新产物链接并补齐本地文件</button>}
      {task.artifacts.map(artifact => {
        const asset = assets.find(item => item.id === artifact.assetId);
        const session = asset ? liveSession(dragSessions, asset.id) : undefined;
        const canDrag = !!asset && !!session && session.expiresAt > Date.now() && asset.metrics?.webReady === true;
        const clipsLabel = artifact.animationIds?.length ? ` · 片段 ${artifact.animationIds.join('、')}` : artifact.animationId ? ` · 片段 ${artifact.animationId}` : '';
        return <div key={artifact.id} className="lux-artifact"
          draggable={canDrag}
          onClick={() => { if (asset && asset.metrics?.webReady === true && onPreparePlace) void prepare(asset); }}
          onPointerEnter={() => { if (asset && asset.metrics?.webReady === true && onPreparePlace) void prepare(asset); }}
          onFocus={() => { if (asset && asset.metrics?.webReady === true && onPreparePlace) void prepare(asset); }}
          onDragStart={event => {
            const current = asset ? sessionCache.live(asset.id) : undefined;
            if (!asset || !current || current.expiresAt <= Date.now()) { event.preventDefault(); return; }
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-spatial-asset', JSON.stringify({ sessionId: current.sessionId, assetId: asset.id }));
            onPlace?.(asset, current, true);
          }}>
          <p>{artifact.label ?? artifact.format} · {(artifact.bytes / 1e6).toFixed(2)}MB · {artifact.variant === 'original' ? '原始产物' : '网页优化件（原始产物保留）'}{clipsLabel}{artifact.animationMode ? ` · ${artifact.animationMode === 'combined' ? '合并交付' : '分文件交付'}` : ''}</p>
          {artifact.kind === 'image' && artifact.previewUrl && <img src={artifact.previewUrl} alt={artifact.label ?? 'Lux3D创作图片'} loading="lazy" />}
          {artifact.format === 'glb' && artifact.previewUrl && <>
            <ArtifactGlbPreview
              previewUrl={artifact.previewUrl}
              active={activeGlbPreviewIds.has(artifact.id)}
              onActivate={() => setManualPreviewIds(previous => promotePreviewId(previous, artifact.id))}
            />
            {asset && <button type="button" disabled={!onPlace} onClick={() => onPlace?.(asset)}>放入网页</button>}
          </>}
          <a href={artifact.downloadUrl} download>下载 {artifact.format} 原件</a>
          {artifact.variant === 'original' && (artifact.kind === 'image' || artifact.format === 'glb' || artifact.format === 'zip') && <button type="button" onClick={() => void useInput(task.localId, artifact.id)}>用作下一次输入（原件）</button>}
          {artifact.format !== 'glb' && artifact.kind !== 'image' && <p className="hint">此格式只提供原件下载，不能假作 GLB 网页采用。</p>}
        </div>;
      })}
    </article>)}
  </section>;
}
