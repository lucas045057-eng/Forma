import { useEffect, useState } from 'react';
import type { SceneModuleConfig } from '@spatial/shared/scene-module';
import { useEventCenter } from './EventCenter.tsx';
import { describeError, luxApi, type ModuleRecord } from './lux3d-api.ts';

type Draft = {
  widthPercent: number;
  align: 'start' | 'center' | 'end';
  offsetX: number;
  offsetY: number;
  rotationY: number;
  cameraPosition: [number, number, number];
  cameraTarget: [number, number, number];
  fov: number;
  scale: number;
  clip: string;
  playing: boolean;
  loop: boolean;
};

function draftOf(config: SceneModuleConfig): Draft {
  return {
    widthPercent: config.layout.widthPercent, align: config.layout.align, offsetX: config.layout.offsetX, offsetY: config.layout.offsetY,
    rotationY: config.rotation[1], scale: config.scale,
    cameraPosition: [...config.camera.position] as [number, number, number],
    cameraTarget: [...config.camera.target] as [number, number, number],
    fov: config.camera.fov,
    clip: config.animation.clip, playing: config.animation.playing, loop: config.animation.loop,
  };
}

export default function AssetModuleControls() {
  const { state, syncReady, status, reload, acquire, awaiting } = useEventCenter();
  const [modules, setModules] = useState<ModuleRecord[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void luxApi.modules().then(value => {
      if (!active) return;
      setModules(value);
      setSelected(current => value.some(item => item.id === current) ? current : '');
    }).catch(cause => { if (active) setError(describeError(cause)); });
    return () => { active = false; };
  }, [state.version]);

  const current = modules.find(item => item.id === selected);
  useEffect(() => { setDraft(current ? draftOf(current.config) : undefined); }, [current?.id, state.version]);

  async function apply() {
    if (!selected || !draft || busy || !syncReady || status !== 'connected') return;
    const token = acquire(['work']);
    if (!token) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await luxApi.adjustModule(selected, state.version, {
        layout: { widthPercent: draft.widthPercent, align: draft.align, offsetX: draft.offsetX, offsetY: draft.offsetY },
        rotation: [current?.config.rotation[0] ?? 0, draft.rotationY, current?.config.rotation[2] ?? 0],
        scale: draft.scale,
        camera: { position: draft.cameraPosition, target: draft.cameraTarget, fov: draft.fov },
        animation: { clip: draft.clip, playing: draft.playing, loop: draft.loop },
      });
      setNotice('已保存本实例调整，并创建新的作品版本；主作品其他实例不会一起变化。');
    } catch (cause) { setError(describeError(cause)); }
    finally { awaiting(token); try { await reload(); } catch (cause) { setError(describeError(cause)); } setBusy(false); }
  }

  async function undo() {
    if (!selected || busy || !syncReady || status !== 'connected') return;
    const token = acquire(['work']);
    if (!token) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await luxApi.undoModule(selected, state.version);
      setNotice('已撤回该实例上一次调整。');
    } catch (cause) { setError(describeError(cause)); }
    finally { awaiting(token); try { await reload(); } catch (cause) { setError(describeError(cause)); } setBusy(false); }
  }

  async function remove() {
    if (!selected || busy || !syncRequired()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await luxApi.removeModule(selected, state.version);
      setNotice('已创建“移除该实例”的候选任务；仍需批准、检查和采用，主作品暂不变。');
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }
  function syncRequired() { return syncReady && status === 'connected'; }

  return <details className="asset-module-controls">
    <summary>调整网页独立 3D 实例</summary>
    <p>每个实例独立读写。保存调整会立即写入作品并生成一个可撤回的实例历史步骤；移除会走普通候选门禁。</p>
    <select aria-label="独立模块" value={selected} onChange={event => setSelected(event.target.value)}>
      <option value="">选择已有模块</option>
      {modules.map(item => <option value={item.id} key={item.id}>{item.id.slice(0, 8)} · {item.stale ? '历史游标已失效' : item.canUndo ? `可撤回 ${item.entries} 步` : '无调整历史'}</option>)}
    </select>
    {current?.stale && <p role="status">该实例历史游标已失效：可以重新载入后保存新的调整，但旧撤回不会覆盖当前作品。</p>}
    {current && draft && <>
      <label>宽度（%）<input type="number" min={10} max={100} value={draft.widthPercent} onChange={event => setDraft({ ...draft, widthPercent: Number(event.target.value) })} /></label>
      <label>Y 角度<input type="number" step={0.1} value={draft.rotationY} onChange={event => setDraft({ ...draft, rotationY: Number(event.target.value) })} /></label>
      <label>比例<input type="number" min={0.01} max={100} step={0.1} value={draft.scale} onChange={event => setDraft({ ...draft, scale: Number(event.target.value) })} /></label>
      <label>对齐<select value={draft.align} onChange={event => setDraft({ ...draft, align: event.target.value as Draft['align'] })}>
        <option value="start">左</option><option value="center">居中</option><option value="end">右</option>
      </select></label>
      <label>水平偏移（px）<input type="number" min={-500} max={500} value={draft.offsetX} onChange={event => setDraft({ ...draft, offsetX: Number(event.target.value) })} /></label>
      <label>上下偏移（px）<input type="number" min={-500} max={500} value={draft.offsetY} onChange={event => setDraft({ ...draft, offsetY: Number(event.target.value) })} /></label>
      <label>相机位置 X<input type="number" step={0.1} value={draft.cameraPosition[0]} onChange={event => setDraft({ ...draft, cameraPosition: [Number(event.target.value), draft.cameraPosition[1], draft.cameraPosition[2]] as [number, number, number] })} /></label>
      <label>相机位置 Z<input type="number" step={0.1} value={draft.cameraPosition[2]} onChange={event => setDraft({ ...draft, cameraPosition: [draft.cameraPosition[0], draft.cameraPosition[1], Number(event.target.value)] as [number, number, number] })} /></label>
      <label>相机目标 X<input type="number" step={0.1} value={draft.cameraTarget[0]} onChange={event => setDraft({ ...draft, cameraTarget: [Number(event.target.value), draft.cameraTarget[1], draft.cameraTarget[2]] as [number, number, number] })} /></label>
      <label>相机目标 Z<input type="number" step={0.1} value={draft.cameraTarget[2]} onChange={event => setDraft({ ...draft, cameraTarget: [draft.cameraTarget[0], draft.cameraTarget[1], Number(event.target.value)] as [number, number, number] })} /></label>
      <label>视角 FOV<input type="number" min={1} max={120} value={draft.fov} onChange={event => setDraft({ ...draft, fov: Number(event.target.value) })} /></label>
      <label>默认动画片段<input value={draft.clip} onChange={event => setDraft({ ...draft, clip: event.target.value })} placeholder="留空保持静态" /></label>
      <label><input type="checkbox" checked={draft.playing} onChange={event => setDraft({ ...draft, playing: event.target.checked })} />加载后播放</label>
      <label><input type="checkbox" checked={draft.loop} onChange={event => setDraft({ ...draft, loop: event.target.checked })} />循环</label>
      <button type="button" disabled={busy || !syncRequired()} onClick={() => void apply()}>保存模块调整</button>
      <button type="button" disabled={busy || !syncRequired() || !current.canUndo} onClick={() => void undo()}>撤回该实例上一次调整</button>
      <button type="button" disabled={busy || !syncRequired()} onClick={() => void remove()}>创建移除候选</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
