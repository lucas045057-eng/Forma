import assert from 'node:assert/strict';
import {spawn,fork,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {appendFileSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {systemEnvironment} from '../scripts/demo/safety.mjs';
const execute=promisify(execFile);const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=path.join(root,'.data/orphan-handle-close-diagnosis-20261116');
const out=path.join(base,'probe-'+new Date().toISOString().replaceAll(':','-'));await mkdir(out);
const env=systemEnvironment();const entry=path.join(root,'scripts/demo/test-support/orphan-role.mjs');const roles=['preview','check','asset','frontend-worker'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const deadline=Date.now()+110000;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=['scripts/demo/runtime.mjs','scripts/demo/launch.mjs','scripts/demo/body.test.mjs','scripts/demo/test-support/orphan-case.mjs','scripts/demo/test-support/orphan-role.mjs'];
const identity=async()=>Object.fromEntries(await Promise.all(frozen.map(async name=>[name,hash(await readFile(path.join(root,name)))])));
const report={started:new Date().toISOString(),pid:process.pid,node:process.version,head:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',env}).trim(),identityBefore:await identity(),variants:[],errors:[],out};
await writeFile(path.join(out,'node-internal-child-process.cjs.txt'),process.binding('natives')['internal/child_process']);
async function snapshot(pids=[],parents=[]){const valid=values=>[...new Set(values)].filter(n=>Number.isSafeInteger(n)&&n>0);const filter=[...valid(pids).map(n=>`ProcessId=${n}`),...valid(parents).map(n=>`ParentProcessId=${n}`)].join(' OR ');if(!filter)return[];const script=`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} })`;return JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',windowsHide:true,timeout:5000})).stdout.trim()||'[]');}
async function descendants(parent){const found=[{...parent,depth:0}];let frontier=found;while(frontier.length){const next=[];for(const row of await snapshot([],frontier.map(x=>x.pid))){const owner=frontier.find(x=>x.pid===row.parent);if(owner&&Date.parse(row.created)>=Date.parse(owner.created)&&!found.some(x=>x.pid===row.pid)){const item={...row,depth:owner.depth+1};found.push(item);next.push(item);}}frontier=next;}return found;}
async function readyRecords(dir){const result=[];for(const name of await readdir(dir)){if(!/^ready-.*\.json$/.test(name))continue;try{result.push(JSON.parse(await readFile(path.join(dir,name),'utf8')));}catch(error){if(!(error instanceof SyntaxError))throw error;}}return result;}
const describe=e=>({name:e?.name,message:e?.message,stack:e?.stack});
function streamState(s){return s?{destroyed:s.destroyed,readableEnded:s.readableEnded,readable:s.readable,closed:s.closed,pending:s.pending}:null;}
function state(c){return{pid:c.pid,exitCode:c.exitCode,signalCode:c.signalCode,connected:c.connected,channelPresent:!!c.channel,closesNeeded:c._closesNeeded,closesGot:c._closesGot,stdout:streamState(c.stdout),stderr:streamState(c.stderr)};}
function launch(dir,role,variant,record){const fileMode=variant==='spawn-file'&&role==='orphan';const fds=fileMode?[openSync(path.join(dir,'main.stdout.log'),'a'),openSync(path.join(dir,'main.stderr.log'),'a')]:[];const stdio=['ignore',...(fileMode?fds:['pipe','pipe']),'ipc'];const options={env:{...env,DEMO_PLAN:path.join(dir,'plan.json')},execArgv:[],stdio};let child;try{child=variant==='fork-pipe'&&role==='orphan'?fork(entry,[role,dir,'hung'],options):spawn(process.execPath,[entry,role,dir,'hung'],options);}finally{for(const fd of fds)closeSync(fd);}
 const events=path.join(dir,role+'.native-events.jsonl');const event=(name,extra={})=>{appendFileSync(events,JSON.stringify({at:new Date().toISOString(),event:name,...extra,state:state(child)})+'\n');};const handle={child,event,exitSeen:false,closeSeen:false};
 for(const name of ['spawn','exit','close','disconnect','error'])child.on(name,(...args)=>{if(name==='exit')handle.exitSeen=true;if(name==='close')handle.closeSeen=true;event('child:'+name,{args:args.map(x=>x instanceof Error?describe(x):x)});});
 for(const name of ['stdout','stderr'])if(child[name]){child[name].on('data',bytes=>{appendFileSync(path.join(dir,role+'.captured.'+name+'.log'),bytes);event(name+':data',{bytes:bytes.length});});for(const ev of ['end','close','error'])child[name].on(ev,error=>event(name+':'+ev,error?{error:describe(error)}:{}));}
 event('listeners-installed',{transport:role==='orphan'?variant:'spawn-pipe'});record.handles??=[];record.handles.push({role,pid:child.pid});return handle;
}
for(const variant of ['spawn-pipe','fork-pipe','spawn-file']){
 const dir=path.join(out,variant);await mkdir(dir);await writeFile(path.join(dir,'plan.json'),'{}');const record={variant,started:new Date().toISOString(),errors:[],fallbackKills:[]};report.variants.push(record);let main,other,known=[],ready=[];
 try{
  main=launch(dir,'orphan',variant,record);other=launch(dir,'unrelated','spawn-pipe',record);
  const readyDeadline=Date.now()+10000;while(true){if(Date.now()>Math.min(deadline,readyDeadline))throw new Error('Four worker readiness deadline');ready=await readyRecords(dir);if(['orphan',...roles,'unrelated'].every(role=>ready.filter(x=>x.role===role).length===1))break;if(main.exitSeen||other.exitSeen)throw new Error('Role exited before readiness');await sleep(50);}
  const native=await snapshot(ready.map(x=>x.pid));for(const item of ready){const actual=native.find(x=>x.pid===item.pid);assert.ok(actual,'Ready process must have live identity');assert.equal(actual.parent,item.parent);assert.ok(Date.parse(actual.created)<=Date.parse(item.at));known.push({...actual,role:item.role});}
  const parent=known.find(x=>x.role==='orphan');assert.equal(parent.pid,main.child.pid);const unrelated=known.find(x=>x.role==='unrelated');assert.equal(unrelated.pid,other.child.pid);
  const family=await descendants(parent);for(const item of family){const existing=known.find(x=>x.pid===item.pid);if(existing)Object.assign(existing,{depth:item.depth});else known.push({...item,role:'auxiliary'});}
  for(const role of roles){const required=known.find(x=>x.role===role);assert.equal(required.parent,parent.pid);assert.ok(family.some(x=>x.pid===required.pid&&x.created===required.created));}
  record.identities=known;record.readyAt=new Date().toISOString();main.event('before-action');main.child.disconnect();main.event('after-disconnect-call');record.actionAt=new Date().toISOString();
  const observeUntil=Date.now()+8000;let sample=0;while(Date.now()<observeUntil){if(Date.now()>deadline)throw new Error('Overall observation deadline');main.event('sample',{sample:sample++});if(main.closeSeen)break;await sleep(250);}
  main.event('observation-end');record.main={exitSeen:main.exitSeen,closeSeen:main.closeSeen,state:state(main.child)};
  const alive=await snapshot(known.map(x=>x.pid));record.familyRemainingBeforeFallback=family.filter(x=>alive.some(y=>y.pid===x.pid&&y.created===x.created));record.unrelatedAliveBeforeCleanup=alive.some(x=>x.pid===unrelated.pid&&x.created===unrelated.created);assert.ok(record.unrelatedAliveBeforeCleanup,'Unrelated identity must survive action');
  try{record.runtimeCleanup=JSON.parse(await readFile(path.join(dir,'orphan-cleanup-'+parent.pid+'.json'),'utf8'));}catch(error){record.runtimeCleanupReadError=describe(error);}
 }catch(error){record.errors.push(describe(error));}
 finally{
  try{
   ready=await readyRecords(dir);const rows=await snapshot([...ready.map(x=>x.pid),main?.child.pid,other?.child.pid]);
   for(const item of ready){const actual=rows.find(x=>x.pid===item.pid&&x.parent===item.parent&&Date.parse(x.created)<=Date.parse(item.at));if(actual&&!known.some(x=>x.pid===actual.pid))known.push({...actual,role:item.role});}
   for(const h of [main,other])if(h&&!known.some(x=>x.pid===h.child.pid)){const actual=rows.find(x=>x.pid===h.child.pid&&x.parent===process.pid);if(actual)known.push({...actual,role:h===main?'orphan':'unrelated'});}
   for(const ancestor of [...known])if(rows.some(x=>x.pid===ancestor.pid&&x.created===ancestor.created))for(const item of await descendants(ancestor))if(!known.some(x=>x.pid===item.pid))known.push({...item,role:'auxiliary'});
   for(const item of [...known].sort((a,b)=>(b.depth??0)-(a.depth??0))){const live=await snapshot([item.pid]);if(live.some(x=>x.pid===item.pid&&x.created===item.created)){process.kill(item.pid,'SIGKILL');record.fallbackKills.push({...item,reason:item.role==='unrelated'?'final unrelated stop':'fallback; not action evidence'});}}
   await sleep(300);const live=await snapshot(known.map(x=>x.pid));record.remainingAfterCleanup=known.filter(x=>live.some(y=>y.pid===x.pid&&y.created===x.created));assert.deepEqual(record.remainingAfterCleanup,[]);
   for(const h of [main,other])if(h){h.event('cleanup-end');record[h===main?'mainFinal':'unrelatedFinal']={exitSeen:h.exitSeen,closeSeen:h.closeSeen,state:state(h.child)};}
  }catch(error){record.errors.push(describe(error));}
  record.identities=known;record.finished=new Date().toISOString();await writeFile(path.join(dir,'observation.json'),JSON.stringify(record,null,2)+'\n');
 }
 if(record.remainingAfterCleanup?.length||!record.remainingAfterCleanup) {report.errors.push({variant,message:'Cleanup unconfirmed; stop controls'});break;}
}
report.identityAfter=await identity();report.changed=frozen.filter(file=>report.identityBefore[file]!==report.identityAfter[file]);report.finished=new Date().toISOString();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const manifest=[];async function collect(dir,prefix=''){for(const item of await readdir(dir,{withFileTypes:true})){const rel=path.join(prefix,item.name);if(item.isDirectory())await collect(path.join(dir,item.name),rel);else if(item.isFile())manifest.push({file:rel.replaceAll('\\','/'),sha256:hash(await readFile(path.join(dir,item.name)))});}}await collect(out);await writeFile(path.join(out,'sha256-manifest.json'),JSON.stringify({excludesSelf:true,files:manifest},null,2)+'\n');
console.log(JSON.stringify({out,changed:report.changed,variants:report.variants.map(x=>({variant:x.variant,errors:x.errors,main:x.main,remaining:x.remainingAfterCleanup})),errors:report.errors}));process.exitCode=report.changed.length||report.errors.length||report.variants.some(x=>x.errors.length)?1:0;
