import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';

function telemetry(config,role){
 const prefix=path.join(config.directory,`${role}-${process.pid}`);
 const resources=()=>process.getActiveResourcesInfo();
 const log=(event,details={})=>appendFileSync(prefix+'.events.jsonl',JSON.stringify({event,role,pid:process.pid,ppid:process.ppid,at:new Date().toISOString(),uptime:process.uptime(),connected:!!process.connected,exitCode:process.exitCode??null,resources:resources(),...details})+'\n');
 writeFileSync(prefix+'.stdout.log','');writeFileSync(prefix+'.stderr.log','');
 log('instrument-before-stdio');
 for(const [name,stream]of [['stdout',process.stdout],['stderr',process.stderr]]){
  const descriptor=Object.getOwnPropertyDescriptor(stream,'_handle');if(descriptor?.value)Object.defineProperty(stream,'_handle',{...descriptor,configurable:true});
  const original=stream.write;
  stream.write=function(chunk,...args){const bytes=typeof chunk==='string'?Buffer.from(chunk,typeof args[0]==='string'?args[0]:'utf8'):Buffer.from(chunk);appendFileSync(prefix+'.'+name+'.log',bytes);return original.call(this,chunk,...args);};
  for(const event of ['close','finish','end'])stream.on(event,()=>log('stdio-'+name+'-'+event));
 }
 log('instrument-after-stdio');
 process.on('beforeExit',code=>log('beforeExit',{code}));process.on('exit',code=>log('exit',{code}));
 process.on('disconnect',()=>log('ipc-disconnect'));
 process.on('uncaughtExceptionMonitor',(error,origin)=>log('uncaughtExceptionMonitor',{origin,error:{name:error.name,message:error.message,stack:error.stack,code:error.code}}));
 const ready=()=>{log('ready');writeFileSync(prefix+'.ready.json',JSON.stringify({role,pid:process.pid,ppid:process.ppid,at:new Date().toISOString(),prefix}));};
 return {log,ready};
}

export function runWorker(config,role){
 const {log,ready}=telemetry(config,role);setInterval(()=>{},1000);log('worker-interval-installed');ready();
}
export function runParent(config){
 const {log,ready}=telemetry(config,'parent');
 const child=fork(config.orphanEntry,[],{env:config.env,execArgv:[],stdio:['ignore','inherit','inherit','ipc']});
 child.once('spawn',()=>log('orphan-spawn',{childPid:child.pid,stdio:'inherit stdout/stderr; IPC parent-owned'}));
 child.once('error',error=>log('orphan-error',{error:String(error)}));child.once('exit',(code,signal)=>log('orphan-exit',{childPid:child.pid,code,signal}));child.once('close',(code,signal)=>log('orphan-close',{childPid:child.pid,code,signal}));
 let acted=false;
 // The original parent already keeps a one-second interval. Its only diagnostic addition
 // is reading one owned command file; no extra IPC channel is added to the original path.
 setInterval(()=>{if(!acted&&existsSync(config.commandFile)){const command=JSON.parse(readFileSync(config.commandFile,'utf8'));if(command.action==='disconnect'){acted=true;log('explicit-disconnect-call',{childPid:child.pid,childConnected:child.connected});if(child.connected)child.disconnect();log('explicit-disconnect-return',{childConnected:child.connected});}}},1000);
 ready();
}
export async function runOrphan(config){
 const {ownedLifetime}=await import(config.runtimeHref);const {log,ready}=telemetry(config,'orphan');
 const closingChildren=[];
 const stop=ownedLifetime(async()=>{
  log('close-called',{closeMode:config.closeMode});
  if(config.closeMode==='hung')return new Promise(()=>{});
  for(const item of closingChildren)if(item.child.exitCode===null&&item.child.signalCode===null){log('complete-close-stop-worker',{childPid:item.child.pid});item.child.kill('SIGTERM');}
  await Promise.all(closingChildren.map(item=>item.closed));log('close-completed');
 },{hardTimeoutMs:300});
 for(const role of ['preview','check','asset','frontend-worker']){
  const child=fork(config.orphanEntry,[role],{env:config.env,execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{log('worker-close',{role,childPid:child.pid,code,signal});resolve();}));
  child.once('spawn',()=>log('worker-spawn',{role,childPid:child.pid}));child.once('exit',(code,signal)=>log('worker-exit',{role,childPid:child.pid,code,signal}));child.once('error',error=>log('worker-error',{role,childPid:child.pid,error:String(error)}));
  // Do not retain the hung-case handles in a new array: preserve the original fixture's
  // ownership/reference shape. The complete-close control intentionally needs its handles.
  if(config.closeMode==='complete')closingChildren.push({child,closed});
 }
 log('ownedLifetime-installed',{closing:stop.closing,forced:stop.forced,hardTimeoutMs:300});ready();
}
