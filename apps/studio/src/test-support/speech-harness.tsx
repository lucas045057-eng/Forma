import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Selection,Task} from '@spatial/shared';
import PointSpeak from '../PointSpeak.tsx';
import {emptyM2State} from '../m2-state.ts';
import type {PickState} from '../pick-state.ts';
import {CenterFixture} from './speech-center.tsx';
function selection(cid:string,baseVersion:string):Selection{return {cid,src:`src/${cid}.tsx:1:1`,baseVersion,bbox:[0,0,10,10],styles:{} as Selection['styles'],instances:1,ancestors:[]};}
function Harness(){
 const [pick,setPick]=useState<PickState>({kind:'ready',selection:selection('A','v1')});const [version,setVersion]=useState('v1');const [blocked,setBlocked]=useState(false);const [mounted,setMounted]=useState(true);const [ready,setReady]=useState(true);const [tasks,setTasks]=useState<Task[]>([]);const lock=useRef<symbol|undefined>(undefined);
 const value={state:{...emptyM2State,version,tasks},syncReady:ready,status:ready?'connected' as const:'reconnecting' as const,
  locked:()=>!!lock.current,acquire:()=>{if(lock.current)return;lock.current=Symbol();return lock.current;},awaiting:()=>{},reload:async()=>{const result=await fetch('/tasks');setTasks(await result.json());lock.current=undefined;}};
 return <CenterFixture value={value}>
  <nav aria-label="component fixture">
   <button data-testid="fixture-refresh" onClick={()=>void value.reload()}>刷新测试任务</button>
   <button data-testid="fixture-A" onClick={()=>setPick({kind:'ready',selection:selection('A',version)})}>选择A</button>
   <button data-testid="fixture-B" onClick={()=>setPick({kind:'ready',selection:selection('B',version)})}>选择B</button>
   <button data-testid="fixture-none" onClick={()=>setPick({kind:'none'})}>不选对象</button>
   <button data-testid="fixture-block" onClick={()=>setBlocked(value=>!value)}>切换隐藏模式</button>
   <button data-testid="fixture-unmount" onClick={()=>setMounted(value=>!value)}>切换挂载</button>
   <button data-testid="fixture-gate" onClick={()=>setReady(value=>!value)}>切换门禁</button>
   <button data-testid="fixture-version" onClick={()=>{setVersion('v2');setPick({kind:'ready',selection:selection('B','v2')});}}>更新版本</button>
  </nav>
  <div hidden={blocked}>{mounted&&<PointSpeak pick={pick} blocked={blocked}/>}</div>
 </CenterFixture>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
