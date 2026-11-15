import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,readdir,cp,rm,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {systemEnvironment,repository} from '../safety.mjs';
const execute=promisify(execFile);const roles=['preview','check','asset','frontend-worker'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function snapshot(pids=[],parents=[]){
 const valid=values=>[...new Set(values)].filter(value=>Number.isSafeInteger(value)&&value>0);const ids=valid(pids),ppids=valid(parents);if(!ids.length&&!ppids.length)return [];
 const filter=[...ids.map(pid=>`ProcessId=${pid}`),...ppids.map(pid=>`ParentProcessId=${pid}`)].join(' OR ');
 const script=`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} })`;
 return JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:systemEnvironment(),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:1024*1024})).stdout.trim()||'[]');
}
async function tree(root,ready){
 const found=[{...root,depth:0}];let frontier=found;
 while(frontier.length){const rows=await snapshot([],frontier.map(item=>item.pid));const next=[];for(const item of rows){const parent=frontier.find(value=>value.pid===item.parent);if(parent&&Date.parse(item.created)>=Date.parse(parent.created)&&!found.some(value=>value.pid===item.pid)){const match=ready.find(value=>value.pid===item.pid);const row={...item,role:match?.role??'auxiliary',depth:parent.depth+1};found.push(row);next.push(row);}}frontier=next;}return found;
}
async function waitUntil(read,label,timeoutMs=10000,intervalMs=100){const end=Date.now()+timeoutMs;while(Date.now()<end){const value=await read();if(value)return value;await sleep(intervalMs);}throw new Error(label);}
async function readReady(directory){const result=[];for(const name of await readdir(directory)){if(!/^ready-.*\.json$/.test(name))continue;try{result.push(JSON.parse(await readFile(path.join(directory,name),'utf8')));}catch(error){if(!(error instanceof SyntaxError))throw error;}}return result;}
async function eventLog(directory,role,pid){try{return (await readFile(path.join(directory,`${role}-${pid}.events.jsonl`),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
function streamState(stream){return {destroyed:stream.destroyed,readableEnded:stream.readableEnded,closed:stream.closed,readable:stream.readable};}
function launch(role,directory,mode,log){
 const entry=path.join(repository,'scripts/demo/test-support/orphan-role.mjs');
 const child=spawn(process.execPath,[entry,role,directory,mode],{env:{...systemEnvironment(),DEMO_PLAN:path.join(directory,'plan.json')},stdio:['ignore','pipe','pipe','ipc']});
 let stdout='',stderr='',failure;let result;const nativeEvents=[];
 const state=()=>({exitCode:child.exitCode,signalCode:child.signalCode,connected:child.connected,stdout:streamState(child.stdout),stderr:streamState(child.stderr)});
 const note=(event,extra={})=>{const entry={event,role,pid:child.pid,at:new Date().toISOString(),...extra,state:state()};nativeEvents.push(entry);log.push(entry);};
 const failed=error=>{failure=failure?new AggregateError([failure,error],'Owned process or stream errors'):error;};
 child.stdout.on('data',bytes=>stdout+=String(bytes));child.stderr.on('data',bytes=>stderr+=String(bytes));
 child.on('error',error=>{failed(error);note('error',{error:detail(error)});});child.once('spawn',()=>note('spawn'));child.once('exit',(code,signal)=>note('exit',{code,signal}));child.once('disconnect',()=>note('disconnect'));
 for(const name of ['stdout','stderr'])for(const event of ['end','close','error'])child[name].on(event,value=>{if(event==='error')failed(value);note(`${name}:${event}`,event==='error'?{error:detail(value)}:event==='close'?{hadError:!!value}:{});});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{result={code,signal,stdout,stderr};note('close',{code,signal});resolve(result);}));
 return {child,closed,nativeEvents,state,get result(){return result;},get failure(){return failure;},get stdout(){return stdout;},get stderr(){return stderr;}};
}
function detail(error){return error instanceof AggregateError?{message:error.message,errors:error.errors.map(detail)}:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error);}
export async function runOrphanCase(kind){
 assert.ok(['hard-kill','disconnect-hung','normal-close'].includes(kind));
 const root=await mkdtemp(path.join(tmpdir(),'demo-orphan-case-'));const canonical=await realpath(root);const owner=await lstat(root);const begun=new Date().toISOString();
 const report={kind,pid:process.pid,begun,root,events:[],identities:[],fallbackKills:[],cleanupErrors:[],primary:null};let main;let unrelated;let primary;let known=[];let ready=[];let destination;
 try{
  await writeFile(path.join(root,'plan.json'),'{}');const mode=kind==='normal-close'?'complete':'hung';
  main=launch(kind==='hard-kill'?'parent':'orphan',root,mode,report.events);unrelated=launch('unrelated',root,mode,report.events);
  const required=[...(kind==='hard-kill'?['parent']:[]),'orphan',...roles,'unrelated'];
  ready=await waitUntil(async()=>{if(main.failure||unrelated.failure)throw main.failure??unrelated.failure;if(main.result||unrelated.result)throw new Error(`Role exited before readiness: ${main.stderr} ${unrelated.stderr}`);const records=await readReady(root);return required.every(role=>records.filter(item=>item.role===role).length===1)?records:null;},'All four worker roles must actually be ready before action');
  const native=await snapshot(ready.map(item=>item.pid));
  for(const item of ready){const actual=native.find(row=>row.pid===item.pid);assert.ok(actual,`Ready ${item.role} must have live identity`);assert.equal(actual.parent,item.parent);assert.ok(Date.parse(actual.created)<=Date.parse(item.at));known.push({...actual,role:item.role});}
  const rootRole=kind==='hard-kill'?'parent':'orphan';const mainId=known.find(item=>item.role===rootRole);assert.equal(mainId.pid,main.child.pid);const other=known.find(item=>item.role==='unrelated');assert.equal(other.pid,unrelated.child.pid);
  const family=await tree(mainId,ready);for(const item of family)if(!known.some(row=>row.pid===item.pid))known.push(item);report.identities=known;
  const orphan=known.find(item=>item.role==='orphan');
  for(const role of roles){const matches=family.filter(item=>item.role===role&&String(item.command).includes('orphan-role.mjs')&&String(item.command).split(/\s+/).some(part=>part.replaceAll('"','')===role));assert.equal(matches.length,1,`Own ${role} command/ready identity required`);assert.equal(matches[0].parent,orphan.pid);}
  report.readyAt=new Date().toISOString();report.actionAt=new Date().toISOString();
  if(kind==='hard-kill')main.child.kill('SIGKILL');else if(kind==='disconnect-hung')main.child.send({type:'fixture-orphan-disconnect'});else main.child.send({type:'shutdown'});
  const result=await bounded(main.closed,kind==='normal-close'?15000:20000,'Owned action did not close its actual log-producing process');report.actionResult=result;
  if(main.failure)throw main.failure;
  assert.ok(main.nativeEvents.some(item=>item.event==='exit'),'Actual native process exit must be observed');
  for(const name of ['stdout','stderr'])assert.ok(main.nativeEvents.some(item=>item.event===`${name}:close`),`Actual ${name} close must be observed`);
  if(kind==='hard-kill')assert.notEqual(result.code,0);else if(kind==='disconnect-hung')assert.notEqual(result.code,0);else assert.equal(result.code,0,result.stderr);
  await waitUntil(async()=>{const live=await snapshot(family.map(item=>item.pid));return !live.some(item=>family.some(old=>old.pid===item.pid&&old.created===item.created));},'Every original descendant, including auxiliary processes, must exit',10000,250);
  report.familyGoneBeforeFallback=true;assert.ok((await snapshot([other.pid])).some(item=>item.created===other.created),'Unrelated fixture must remain alive');report.unrelatedAliveBeforeCleanup=true;
  report.orphanEvents=await eventLog(root,'orphan',orphan.pid);let cleanup;
  try{cleanup=JSON.parse(await readFile(path.join(root,`orphan-cleanup-${orphan.pid}.json`),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;cleanup=null;}report.runtimeCleanup=cleanup;
  if(kind==='disconnect-hung'){
   const received=report.orphanEvents.findIndex(item=>item.event==='fixture-disconnect-message');const called=report.orphanEvents.findIndex(item=>item.event==='fixture-disconnect-called');const disconnected=report.orphanEvents.findIndex(item=>item.event==='disconnect');const closing=report.orphanEvents.findIndex(item=>item.event==='close-called'&&item.closeMode==='hung');const exited=report.orphanEvents.findIndex(item=>item.event==='exit'&&item.code===1);
   assert.ok(received>=0&&called>received&&disconnected>called&&closing>disconnected&&exited>closing,'Fixture message must precede role-initiated disconnect, hung close and exit');
   assert.ok(main.nativeEvents.some(item=>item.event==='disconnect'),'Parent must observe native IPC EOF/disconnect');assert.equal(report.orphanEvents.some(item=>item.event==='close-completed'),false);
   assert.match(result.stderr,/DEMO_ORPHAN_TIMEOUT/);assert.equal(cleanup?.parentPid,orphan.pid);assert.equal(cleanup.forced,true);assert.deepEqual(cleanup.errors,[]);assert.deepEqual(cleanup.remaining,[]);
   for(const item of family.filter(value=>roles.includes(value.role)))assert.ok(cleanup.children.some(value=>value.pid===item.pid&&value.created===item.created),`Watchdog cleanup must own ${item.role}`);
  }else if(kind==='normal-close'){
   assert.ok(report.orphanEvents.some(item=>item.event==='close-called'&&item.closeMode==='complete'));assert.ok(report.orphanEvents.some(item=>item.event==='close-completed'&&item.forced===false));assert.doesNotMatch(result.stderr,/DEMO_ORPHAN_TIMEOUT/);assert.equal(cleanup,null);
  }else{
   // Hard-kill validates actual chain exit, not an unobserved watchdog branch. Keep the
   // orphan's real output independently so its absence/presence is evidence, not a premise.
   report.orphanStderr=await readFile(path.join(root,'orphan.stderr.log'),'utf8');
  }
 }catch(error){primary=error;report.primary=detail(error);}
 finally{
  const cleanup=[];
  try{
   ready=await readReady(root);const native=await snapshot([...ready.map(item=>item.pid),main?.child.pid,unrelated?.child.pid]);
   for(const item of ready){const actual=native.find(row=>row.pid===item.pid&&row.parent===item.parent&&Date.parse(row.created)<=Date.parse(item.at));if(actual&&!known.some(value=>value.pid===actual.pid))known.push({...actual,role:item.role});}
   for(const record of [main,unrelated])if(record&&!known.some(item=>item.pid===record.child.pid)){const actual=native.find(item=>item.pid===record.child.pid&&item.parent===process.pid);if(actual)known.push({...actual,role:record===main?'main':'unrelated'});}
   const roots=known.filter(item=>native.some(now=>now.pid===item.pid&&now.created===item.created));for(const ancestor of roots)for(const item of await tree(ancestor,ready))if(!known.some(value=>value.pid===item.pid))known.push(item);
   const current=await snapshot(known.map(item=>item.pid));
   for(const item of [...known].sort((a,b)=>(b.depth??0)-(a.depth??0)))if(current.some(now=>now.pid===item.pid&&now.created===item.created)){try{process.kill(item.pid,'SIGKILL');report.fallbackKills.push({role:item.role,pid:item.pid,created:item.created,reason:item.role==='unrelated'?'final unrelated stop':'failure cleanup; not action proof'});}catch(error){if(error.code!=='ESRCH')throw error;}}
   for(const record of [main,unrelated])if(record){await bounded(record.closed,5000,'Owned fixture handle not settled during cleanup');if(record.failure)throw record.failure;}
   const after=await snapshot(known.map(item=>item.pid));report.remaining=known.filter(item=>after.some(now=>now.pid===item.pid&&now.created===item.created));assert.deepEqual(report.remaining,[]);
  }catch(error){cleanup.push(error);}
  report.identities=known;report.cleanupErrors=cleanup.map(detail);report.finished=new Date().toISOString();
  try{
   for(const [name,record]of [['main',main],['unrelated',unrelated]])if(record){await writeFile(path.join(root,`${name}.captured.stdout.log`),record.stdout);await writeFile(path.join(root,`${name}.captured.stderr.log`),record.stderr);await writeFile(path.join(root,`${name}.native-events.json`),JSON.stringify({events:record.nativeEvents,final:record.state()},null,2)+'\n');}
   await writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n');
   const base=process.env.M4_SCRIPT_RUN_DIR??path.join(repository,'.data','demo-script-evidence',`${process.pid}-${Date.now()}`);destination=path.join(base,'orphan',kind);await mkdir(path.dirname(destination),{recursive:true});await cp(root,destination,{recursive:true,errorOnExist:true,force:false});
  }catch(error){cleanup.push(error);}
  report.cleanupErrors=cleanup.map(detail);report.retained=primary!==undefined||cleanup.length?root:null;
  if(destination)try{await writeFile(path.join(destination,'result.json'),JSON.stringify(report,null,2)+'\n');}catch(error){cleanup.push(error);}
  if(primary===undefined&&!cleanup.length)try{const actual=await lstat(root);assert.equal(actual.isSymbolicLink(),false);assert.equal(await realpath(root),canonical);assert.equal(actual.dev,owner.dev);assert.equal(actual.ino,owner.ino);await rm(root,{recursive:true,force:true});}catch(error){cleanup.push(error);report.cleanupErrors=cleanup.map(detail);report.retained=root;if(destination)try{await writeFile(path.join(destination,'result.json'),JSON.stringify(report,null,2)+'\n');}catch(secondary){cleanup.push(secondary);}}
  const errors=[...(primary===undefined?[]:[primary]),...cleanup];if(errors.length){console.error('[owned orphan fixture]',JSON.stringify({report,cleanup:cleanup.map(detail),retained:root}));throw new AggregateError(errors,'Owned orphan case failed; independent process evidence retained');}
 }
}
