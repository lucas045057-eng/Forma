import {useLayoutEffect,useRef,useState} from 'react';
import type {AssetProvenance,ModelProvenanceView} from '@spatial/shared';
import {api} from './api.ts';
import {useEventCenter} from './EventCenter.tsx';
export function assetOriginLabel(origin?:AssetProvenance){
 if(origin?.kind==='fallback')return '备用资产 · 预先生成';
 if(origin?.kind==='lux3d')return origin.sourceTaskId?`Lux3D 已有任务 ${origin.sourceTaskId}`:'Lux3D 任务';
 return '来源未核实';
}
export default function ModelOriginBadge(){
 const {subscribe,syncReady,status}=useEventCenter();const [view,setView]=useState<ModelProvenanceView>();const sequence=useRef(0);
 useLayoutEffect(()=>{
  if(!syncReady||status!=='connected'){++sequence.current;setView(undefined);return;}
  let disposed=false;let abort:AbortController|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
  const refresh=()=>{
   const request=++sequence.current;abort?.abort();if(timer)clearTimeout(timer);abort=new AbortController();const signal=abort.signal;timer=setTimeout(()=>abort?.abort(),5000);setView(undefined);
   void api<ModelProvenanceView>('/scene/model-provenance',{signal}).then(result=>{
    if(disposed||request!==sequence.current)return;
    if(typeof result.model!=='string'||typeof result.verified!=='boolean'||!result.provenance||!['fallback','lux3d','unknown'].includes(result.provenance.kind))throw new Error('Invalid source');setView(result);
   }).catch(()=>{if(!disposed&&request===sequence.current)setView({model:'',verified:false,provenance:{schemaVersion:1,kind:'unknown'},reason:'来源暂不可核实'});}).finally(()=>{if(request===sequence.current&&timer)clearTimeout(timer);});
  };
  let scheduled=false;const schedule=()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;if(!disposed)refresh();});};
  schedule();const unsubscribe=subscribe(event=>{if(['scene.changed','version.changed','state.reload'].includes(event.type))schedule();});
  return()=>{disposed=true;++sequence.current;abort?.abort();if(timer)clearTimeout(timer);unsubscribe();};
 },[subscribe,syncReady,status]);
 const current=syncReady&&status==='connected'?view:undefined;
 return <span className="model-origin" data-testid="model-provenance" data-model={current?.model??''} data-kind={current?.verified?current.provenance.kind:'unknown'} title={current&&!current.verified&&current.reason?current.reason:undefined} role="status">
  {!syncReady||status!=='connected'?'模型状态待同步':!current?'核验模型中…':current.verified?assetOriginLabel(current.provenance):'模型来源未核实'}
 </span>;
}
