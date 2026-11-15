import {fork} from 'node:child_process';
import {appendFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import path from 'node:path';
import {ownedLifetime} from '../runtime.mjs';
import {systemEnvironment} from '../safety.mjs';

const [role,directory,closeMode]=process.argv.slice(2);
if(!['parent','orphan','preview','check','asset','frontend-worker','unrelated'].includes(role)||!directory||!path.isAbsolute(directory)||!['hung','complete'].includes(closeMode))throw new Error('Owned role fixture arguments invalid');
const env={...systemEnvironment(),DEMO_PLAN:path.join(directory,'plan.json')};
const log=(event,value={})=>appendFileSync(path.join(directory,`${role}-${process.pid}.events.jsonl`),JSON.stringify({event,role,pid:process.pid,parent:process.ppid,at:new Date().toISOString(),connected:!!process.connected,...value})+'\n');
const ready=()=>{log('ready');writeFileSync(path.join(directory,`ready-${role}.json`),JSON.stringify({role,pid:process.pid,parent:process.ppid,at:new Date().toISOString()}));};
process.on('beforeExit',code=>log('beforeExit',{code}));process.on('exit',code=>log('exit',{code}));process.on('disconnect',()=>log('disconnect'));
function spawnRole(next){
 const out=openSync(path.join(directory,`${next}.stdout.log`),'a');const err=openSync(path.join(directory,`${next}.stderr.log`),'a');
 let child;try{child=fork(import.meta.filename,[next,directory,closeMode],{env,execArgv:[],stdio:['ignore',out,err,'ipc']});}finally{closeSync(out);closeSync(err);}
 log('spawned-child',{childPid:child.pid,childRole:next});child.once('error',error=>log('child-error',{childRole:next,error:String(error)}));
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>{log('child-close',{childRole:next,childPid:child.pid,code,signal});resolve({code,signal});}));return {child,closed};
}
if(role==='parent'){
 spawnRole('orphan');setInterval(()=>{},1000);ready();
}else if(role==='orphan'){
 const closers=[];
 const stop=ownedLifetime(async()=>{
  log('close-called',{closeMode});if(closeMode==='hung')return new Promise(()=>{});
  for(const record of closers)if(record.child.exitCode===null&&record.child.signalCode===null)record.child.kill('SIGTERM');
  await Promise.all(closers.map(record=>record.closed));log('close-completed',{forced:stop.forced});
 },{hardTimeoutMs:300});
 for(const worker of ['preview','check','asset','frontend-worker']){const record=spawnRole(worker);if(closeMode==='complete')closers.push(record);}
 ready();
}else{
 if(!['preview','check','asset','frontend-worker','unrelated'].includes(role))throw new Error('Unknown fixture role');
 setInterval(()=>{},1000);ready();
}
