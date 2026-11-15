import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {readPlainFile,assertPlainPath} from '../../apps/server/src/checks/paths.ts';
import {repository,descendant} from './safety.mjs';

export async function readPlan(file,repositoryRoot=repository){
 const base=path.join(repositoryRoot,'.data/demo-runs');const absolute=path.resolve(file);
 if(!descendant(base,absolute)||path.basename(absolute)!=='plan.json')throw new Error('Demo plan outside isolated runs');
 const denied=()=>new Error('Demo plan path invalid');const plan=JSON.parse((await readPlainFile(absolute,32768,denied,denied)).toString('utf8'));
 const run=path.dirname(absolute);if(plan.run!==run||plan.work!==path.join(run,'work')||!['mock','real'].includes(plan.mode))throw new Error('Demo plan identity invalid');
 const names=['api','studio','main','preview','coding','lux3d','speech'];if(plan.schemaVersion!==1||!plan.ports||Object.keys(plan.ports).some(name=>!names.includes(name))||names.some(name=>!(name in plan.ports)))throw new Error('Demo port names invalid');
 const ports=Object.values(plan.ports);if(ports.length!==7||new Set(ports).size!==7||ports.some(port=>!Number.isInteger(port)||port<20000||port>65535))throw new Error('Demo port plan invalid');
 await assertPlainPath(plan.work,denied);return plan;
}
export async function loadPlan(){
 if(!process.send)throw new Error('Demo child requires owned parent IPC');
 return readPlan(process.env.DEMO_PLAN??'',repository);
}

function processTable(){
 if(process.platform==='win32'){
  const script="Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:5000})||'[]');
  return (Array.isArray(value)?value:[value]).filter(Boolean);
 }
 return execFileSync('ps',['-eo','pid=,ppid=,lstart='],{encoding:'utf8',timeout:5000}).split('\n').filter(Boolean).map(line=>{
  const fields=line.trim().split(/\s+/);return {pid:Number(fields[0]),parent:Number(fields[1]),created:new Date(fields.slice(2,7).join(' ')).toISOString()};
 });
}
function descendants(){
 const table=processTable();const children=new Map();for(const item of table){const list=children.get(item.parent)??[];list.push(item);children.set(item.parent,list);}
 const root=table.find(item=>item.pid===process.pid);if(!root)throw new Error('Owned parent creation identity unavailable');
 const owned=[];const queue=[{...root,depth:0}];const seen=new Set([process.pid]);
 for(let index=0;index<queue.length;index++){const current=queue[index];for(const child of children.get(current.pid)??[]){if(seen.has(child.pid)||Date.parse(child.created)<Date.parse(current.created))continue;seen.add(child.pid);const item={...child,depth:current.depth+1};owned.push(item);queue.push(item);}}
 return owned.sort((a,b)=>b.depth-a.depth);
}
function terminateOwnedDescendants(){
 const result={at:new Date().toISOString(),parentPid:process.pid,forced:true,children:[],errors:[]};let owned;
 try{owned=descendants();}catch(error){result.errors.push('Unable to establish owned descendant identities');return result;}
 let current;try{current=processTable();}catch{result.errors.push('Unable to revalidate descendant creation identities');return result;}
 for(const child of owned){if(!current.some(item=>item.pid===child.pid&&item.created===child.created))continue;try{process.kill(child.pid,'SIGKILL');result.children.push(child);}catch(error){if(error?.code!=='ESRCH')result.errors.push(`Owned descendant ${child.pid} did not accept termination`);}}
 try{const after=processTable();result.remaining=owned.filter(child=>after.some(item=>item.pid===child.pid&&item.created===child.created));if(result.remaining.length)result.errors.push('Owned descendants remain after termination');}catch{result.errors.push('Unable to confirm descendant termination');}
 return result;
}

export function ownedLifetime(close,options={}){
 let closing;let disconnected=false;let watchdog;let forcing=false;
 const force=()=>{if(forcing)return;forcing=true;
  console.error('DEMO_ORPHAN_TIMEOUT: owned child exceeded its parent-disconnect shutdown budget');
  const result=terminateOwnedDescendants();const plan=process.env.DEMO_PLAN;
  if(plan&&path.basename(plan)==='plan.json')try{writeFileSync(path.join(path.dirname(path.resolve(plan)),`orphan-cleanup-${process.pid}.json`),JSON.stringify(result,null,2)+'\n');}catch{/* Process is already failing; never claim cleanup succeeded. */}
  process.exitCode=1;process.exit(1);
 };
 const arm=()=>{if(watchdog)return;const budget=options.hardTimeoutMs??50_000;if(!Number.isFinite(budget)||budget<=0)throw new Error('Invalid orphan shutdown budget');watchdog=setTimeout(force,budget);watchdog.unref();};
 const parentGone=()=>{disconnected=true;process.exitCode=1;arm();void stop();};
 const stop=()=>closing??=(async()=>{let settled=false;try{await close();settled=true;process.exitCode=disconnected?1:0;}catch{process.exitCode=1;console.error('Demo shutdown failed; inspect retained run and owned process records.');}finally{if(settled&&watchdog&&!disconnected)clearTimeout(watchdog);if(process.connected){process.off('disconnect',parentGone);process.disconnect();}}})();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(process.connected)process.send({type:'shutdown-intent',pid:process.pid,signal});void stop();});
 process.on('message',message=>{if(message?.type==='shutdown')void stop();});
 process.once('disconnect',parentGone);
 if(process.send&&!process.connected)queueMicrotask(parentGone);
 Object.defineProperty(stop,'closing',{get:()=>!!closing});Object.defineProperty(stop,'forced',{get:()=>forcing});return stop;
}
