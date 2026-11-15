import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const exec=promisify(execFile);const root=path.resolve(import.meta.dirname,'..');const expected='97bd68652108b808b8f5de9117ceefd8a8c888f9';
const env={};for(const key of ['PATH','PATHEXT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
const run=path.join(root,'.data','orphan-diagnosis-'+new Date().toISOString().replaceAll(':','-'));
await mkdir(run,{recursive:true});const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest={kind:'focused diagnosis only; not product verification',pid:process.pid,started:new Date().toISOString(),run,expectedHead:expected,scenarios:[],errors:[],exit:1};
const save=()=>writeFile(path.join(run,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
async function git(...args){return (await exec('git',['-c','core.longpaths=true',...args],{cwd:root,env,encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024})).stdout.trim();}
async function identity(){
 const head=await git('rev-parse','HEAD');const status=await git('status','--porcelain','--untracked-files=all');
 const listed=(await git('ls-files','-z','--','apps','packages','templates','scripts','pnpm-lock.yaml','package.json')).split('\0').filter(Boolean);
 const files={};for(const file of listed){if(!/\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|glb|yaml)$/.test(file))continue;if(/(?:^|\/)\.env(?:\.|$)/.test(file))continue;files[file]=sha(await readFile(path.join(root,file)));}
 return {head,status,apps:await git('rev-parse','HEAD:apps'),scripts:await git('rev-parse','HEAD:scripts'),files};
}
async function table(pids,parents=[]){
 const unique=[...new Set(pids)].filter(pid=>Number.isSafeInteger(pid)&&pid>0);const ancestors=[...new Set(parents)].filter(pid=>Number.isSafeInteger(pid)&&pid>0);if(!unique.length&&!ancestors.length)return [];
 const filter=[...unique.map(pid=>`ProcessId=${pid}`),...ancestors.map(pid=>`ParentProcessId=${pid}`)].join(' OR ');
 const script=`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} })`;
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024,windowsHide:true});return JSON.parse(stdout.trim()||'[]');
}
async function ownedTree(roots){
 const owned=[...roots];let frontier=[...roots];for(let level=0;level<8&&frontier.length;level++){
  const rows=await table([],frontier.map(item=>item.pid));const next=[];
  for(const row of rows){const parent=frontier.find(item=>item.pid===row.parent);if(parent&&Date.parse(row.created)>=Date.parse(parent.created)&&!owned.some(item=>item.pid===row.pid)){const item={...row,role:'auxiliary',depth:(parent.depth??0)+1};owned.push(item);next.push(item);}}
  frontier=next;
 }return owned;
}
function start(entry,args,childEnv,role,events){
 const child=spawn(process.execPath,[entry,...args],{env:childEnv,execArgv:[],stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',settled=false,result;
 const stamp=(event,value={})=>events.push({role,event,at:new Date().toISOString(),...value});
 child.once('spawn',()=>stamp('spawn',{pid:child.pid}));child.once('error',error=>stamp('spawn-error',{error:String(error)}));
 child.stdout.on('data',bytes=>{stdout+=String(bytes);stamp('stdout-data',{bytes:bytes.length});});child.stderr.on('data',bytes=>{stderr+=String(bytes);stamp('stderr-data',{bytes:bytes.length});});
 for(const [name,stream]of [['stdout',child.stdout],['stderr',child.stderr]])for(const event of ['end','close'])stream.on(event,()=>stamp(name+'-'+event));
 child.once('exit',(code,signal)=>stamp('exit',{code,signal}));
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{settled=true;result={code,signal,stdout,stderr,at:new Date().toISOString()};stamp('close',result);resolve(result);}));
 return {child,closed,get settled(){return settled;},get result(){return result;},get stdout(){return stdout;},get stderr(){return stderr;}};
}
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function readyFiles(directory){const values=[];for(const name of await readdir(directory)){if(!name.endsWith('.ready.json'))continue;try{values.push(JSON.parse(await readFile(path.join(directory,name),'utf8')));}catch{/* A sync writer may still be completing this particular file. */}}return values;}
async function readEvents(file){try{return (await readFile(file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function scenario(action,closeMode){
 const directory=path.join(run,action+'-'+closeMode);await mkdir(directory);const events=[];const record={action,closeMode,directory,events,observations:[],cleanup:{kills:[],errors:[]},errors:[]};manifest.scenarios.push(record);await save();
 const plan=path.join(directory,'plan.json');await writeFile(plan,'{}\n');const childEnv={...env,DEMO_PLAN:plan};
 const config={directory,env:childEnv,closeMode,runtimeHref:pathToFileURL(path.join(root,'scripts/demo/runtime.mjs')).href,orphanEntry:path.join(directory,'orphan.mjs'),commandFile:path.join(directory,'command.json')};
 const roles=pathToFileURL(path.join(root,'.data/orphan-diag-roles.mjs')).href;
 await writeFile(config.orphanEntry,`import {runOrphan,runWorker} from ${JSON.stringify(roles)};const config=${JSON.stringify(config)};if(process.argv[2])runWorker(config,process.argv[2]);else await runOrphan(config);\n`);
 const parentEntry=path.join(directory,'parent.mjs');await writeFile(parentEntry,`import {runParent} from ${JSON.stringify(roles)};runParent(${JSON.stringify(config)});\n`);
 let parent;let unrelated;let identities=[];
 try{
  parent=start(parentEntry,[],childEnv,'parent',events);unrelated=start(config.orphanEntry,['unrelated'],childEnv,'unrelated',events);
  const wanted=['parent','orphan','preview','check','asset','frontend-worker','unrelated'];let ready=[];const until=Date.now()+15000;
  while(Date.now()<until){ready=await readyFiles(directory);if(wanted.every(role=>ready.filter(item=>item.role===role).length===1))break;if(parent.settled||unrelated.settled)throw new Error('Diagnostic role exited before all workers ready');await delay(100);}
  if(!wanted.every(role=>ready.filter(item=>item.role===role).length===1))throw new Error('Not all four actual worker roles became ready');
  const snapshot=await table(ready.map(item=>item.pid));identities=ready.map(item=>{const native=snapshot.find(row=>row.pid===item.pid);if(!native)throw new Error('Ready role has no live OS identity: '+item.role);return {...native,role:item.role,prefix:item.prefix};});record.identities=identities;
  const orphan=identities.find(item=>item.role==='orphan');const parentId=identities.find(item=>item.role==='parent');
  if(orphan.parent!==parentId.pid||identities.filter(item=>['preview','check','asset','frontend-worker'].includes(item.role)).some(item=>item.parent!==orphan.pid))throw new Error('OS process topology differs from the intended original tree');
  record.allWorkersReadyAt=new Date().toISOString();record.actionAt=new Date().toISOString();
  if(action==='kill'){record.killReturn=parent.child.kill('SIGKILL');events.push({role:'driver',event:'original-parent-SIGKILL',pid:parent.child.pid,at:record.actionAt});}
  else {await writeFile(config.commandFile,JSON.stringify({action:'disconnect'}));events.push({role:'driver',event:'disconnect-command-written',at:record.actionAt});}
  const family=identities.filter(item=>['orphan','preview','check','asset','frontend-worker'].includes(item.role));
  const deadline=Date.now()+20000;let last=[];
  while(Date.now()<deadline){const current=await table(identities.map(item=>item.pid));last=family.filter(item=>current.some(now=>now.pid===item.pid&&now.created===item.created));record.observations.push({at:new Date().toISOString(),parentClosed:parent.settled,remainingFamily:last.map(item=>({role:item.role,pid:item.pid,created:item.created})),unrelatedAlive:current.some(now=>now.pid===unrelated.child.pid&&now.created===identities.find(item=>item.role==='unrelated').created)});if(!last.length)break;await delay(250);}
  record.familyGoneBeforeFallback=last.length===0;
  if(action==='kill'&&!parent.settled)try{await bounded(parent.closed,2000,'Original parent close still pending after family observation');}catch(error){record.errors.push(String(error));}
  const current=await table(identities.map(item=>item.pid));const other=identities.find(item=>item.role==='unrelated');record.unrelatedAliveBeforeCleanup=current.some(item=>item.pid===other.pid&&item.created===other.created);
  record.originalRunClosed=parent.result??{pending:true,stdout:parent.stdout,stderr:parent.stderr};
  record.orphanEvents=await readEvents(orphan.prefix+'.events.jsonl');record.parentEvents=await readEvents(parentId.prefix+'.events.jsonl');
  const mirror=await readFile(orphan.prefix+'.stderr.log','utf8');record.orphanLocalStderr=mirror;record.markerInParentCapturedStderr=parent.stderr.includes('DEMO_ORPHAN_TIMEOUT');record.markerInOrphanLocalStderr=mirror.includes('DEMO_ORPHAN_TIMEOUT');
  try{record.runtimeCleanup=JSON.parse(await readFile(path.join(directory,`orphan-cleanup-${orphan.pid}.json`),'utf8'));}catch(error){if(error.code==='ENOENT')record.runtimeCleanup=null;else throw error;}
  record.closeCalled=record.orphanEvents.some(item=>item.event==='close-called');record.closeCompleted=record.orphanEvents.some(item=>item.event==='close-completed');record.explicitDisconnectObserved=record.parentEvents.some(item=>item.event==='explicit-disconnect-call');
  record.observationComplete=true;
 }catch(error){record.errors.push({message:error.message,stack:error.stack});}
 finally{
  // Even failed readiness must clean roles that have already started, with fresh OS identities.
  try{
   const ready=await readyFiles(directory);const pids=[...ready.map(item=>item.pid),parent?.child.pid,unrelated?.child.pid].filter(Boolean);const current=await table(pids,pids);
   for(const item of ready){const native=current.find(row=>row.pid===item.pid);if(native&&!identities.some(old=>old.pid===item.pid))identities.push({...native,role:item.role,prefix:item.prefix});}
   for(const handle of [parent,unrelated]){if(handle?.child.pid&&!identities.some(item=>item.pid===handle.child.pid)){const native=current.find(item=>item.pid===handle.child.pid);if(native)identities.push({...native,role:handle===parent?'parent':'unrelated'});}}
   // The observed family can include OS helper/conhost descendants not listed by roles.
   // Include only descendants of this fixture, with identity checks, not a process-name sweep.
   identities.push(...await ownedTree(identities));
   record.finalKnownIdentities=identities;
   for(const role of ['preview','check','asset','frontend-worker','orphan','parent','unrelated'])for(const item of identities.filter(value=>value.role===role)){
    const live=(await table([item.pid])).some(now=>now.pid===item.pid&&now.created===item.created);if(live){process.kill(item.pid,'SIGKILL');record.cleanup.kills.push({role,pid:item.pid,created:item.created,reason:'diagnostic fallback or final stop; not autonomous proof'});}
   }
   for(const handle of [parent,unrelated])if(handle)await bounded(handle.closed,5000,'Owned top-level diagnostic process did not close');
   const after=await table(identities.map(item=>item.pid));record.cleanup.remaining=identities.filter(old=>after.some(now=>now.pid===old.pid&&now.created===old.created));if(record.cleanup.remaining.length)record.cleanup.errors.push('Owned identities still alive');
  }catch(error){record.cleanup.errors.push({message:error.message,stack:error.stack});}
  for(const [name,handle]of [['parent',parent],['unrelated',unrelated]])if(handle){await writeFile(path.join(directory,`driver-captured-${name}.stdout.log`),handle.stdout);await writeFile(path.join(directory,`driver-captured-${name}.stderr.log`),handle.stderr);}
  record.finished=new Date().toISOString();await writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2)+'\n');await save();
 }
}
try{
 manifest.before=await identity();if(manifest.before.head!==expected)throw new Error('Frozen implementation HEAD changed');await git('diff','--exit-code');
 await mkdir(path.join(run,'entry'),{recursive:true});for(const name of ['diagnose-orphan-once.mjs','orphan-diag-roles.mjs'])await copyFile(path.join(root,'.data',name),path.join(run,'entry',name));
 manifest.instrumentation=['Own event files use sync writes, no observation timers in orphan','Stream write mirrors and passive exit/stdio listeners may expose extra stdio wrappers; before/after active-resource lists are retained','Hung orphan does not retain worker handles in a new array or add a keepalive timer','Complete close control intentionally kills/awaits its own worker handles','No production file or assertion is changed; unexpected observations do not mean a product pass'];
 await save();for(const action of ['kill','disconnect'])for(const closeMode of ['hung','complete'])await scenario(action,closeMode);
 manifest.after=await identity();manifest.identityUnchanged=JSON.stringify(manifest.before)===JSON.stringify(manifest.after);if(!manifest.identityUnchanged)throw new Error('Source identity changed during diagnosis');
 manifest.exit=manifest.scenarios.every(item=>item.observationComplete&&item.cleanup.errors.length===0)?0:1;
}catch(error){manifest.errors.push({message:error.message,stack:error.stack});manifest.exit=1;}
finally{
 manifest.finished=new Date().toISOString();await save();
 const files=[];async function walk(folder){for(const item of await readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())await walk(file);else if(item.isFile()&&item.name!=='sha256-manifest.json'){const bytes=await readFile(file);files.push({path:path.relative(run,file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}}}await walk(run);await writeFile(path.join(run,'sha256-manifest.json'),JSON.stringify({manifestExcluded:true,files},null,2)+'\n');
 console.log(JSON.stringify({run,exit:manifest.exit,scenarios:manifest.scenarios.map(item=>({action:item.action,closeMode:item.closeMode,observationComplete:item.observationComplete,errors:item.errors,cleanupErrors:item.cleanup.errors})),identityUnchanged:manifest.identityUnchanged}));process.exitCode=manifest.exit;
}
