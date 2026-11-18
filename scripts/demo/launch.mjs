import {fork} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {randomInt} from 'node:crypto';
import path from 'node:path';
import {repository,systemEnvironment,realEnvironment,codedError,safeFailureCode} from './safety.mjs';
import {prepareDemo} from './prepare.mjs';
const timeout=(promise,ms,label,code)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(code?codedError(code,label):new Error(label)),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
export async function launch(mode,args=[],options={}){
 if(process.env.NODE_OPTIONS||process.execArgv.length)throw codedError('RUNTIME_INJECTION_BLOCKED','Start demo without inherited Node loader/runtime injections');
 if(mode==='real'&&!args.includes('--allow-real-services'))throw codedError('REAL_AUTH_FLAG_MISSING','Real mode requires --allow-real-services and a separately authorized usage budget; no service started');
 const backendEnv=mode==='real'?realEnvironment():{...systemEnvironment(),LUX3D_API_KEY:'mock-only',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-coder',DASHSCOPE_API_KEY:'',SPEECH_BASE_URL:'',SPEECH_MODEL:'qwen3-asr-flash'};
 const {run,work,manifest}=await (options.prepare??prepareDemo)(mode);const values=new Set();while(values.size<7)values.add(randomInt(20000,65536));const ports=Object.fromEntries(['api','studio','main','preview','coding','lux3d','speech'].map((name,index)=>[name,[...values][index]]));
 backendEnv.PREVIEW_ORIGIN_PORT=String(ports.preview);
 const plan={schemaVersion:1,mode,run,work,ports};const planFile=path.join(run,'plan.json');await writeFile(planFile,JSON.stringify(plan,null,2)+'\n',{flag:'wx'});
 manifest.credentials={speech:mode==='real'&&!!backendEnv.DASHSCOPE_API_KEY,coding:mode==='real'&&!!backendEnv.CODING_AGENT_API_KEY,lux3d:mode==='real'&&!!backendEnv.LUX3D_API_KEY};manifest.mockServices=mode==='mock';manifest.children=[];manifest.ports=ports;
 const save=()=>writeFile(path.join(run,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');const owned=[];let shutting;let interruptRequested=false;const repositoryRoot=options.repositoryRoot??repository;
 async function shutdown(){
  if(shutting)return shutting;
  shutting=(async()=>{const problems=[];for(const record of [...owned].reverse()){
   if(record.child.exitCode===null&&record.child.signalCode===null){try{if(record.child.connected)record.child.send({type:'shutdown'});}catch{problems.push(`${record.role}: shutdown IPC failed`);}}
   try{await timeout(record.closed,45000,'Owned child did not close');}catch{record.forced=true;problems.push(`${record.role}: forced shutdown`);record.child.kill('SIGKILL');try{await timeout(record.closed,5000,'Owned child still alive');}catch{problems.push(`${record.role}: process did not settle`);}}
   if(record.child.exitCode!==0||record.child.signalCode!==null)problems.push(`${record.role}: unsuccessful exit`);
  }
  manifest.status=problems.length?'cleanup_failed':manifest.interruption&&!interruptRequested?'interrupted':'stopped';manifest.finishedAt=new Date().toISOString();manifest.cleanup={problems,children:owned.map(record=>({role:record.role,pid:record.child.pid,startedAt:record.startedAt,exit:record.child.exitCode,signal:record.child.signalCode,forced:!!record.forced,startupFailure:record.failure,stderrObserved:!!record.stderrObserved,stderrCodes:record.stderrCodes??[]})),note:'Only directly owned ChildProcess handles are signalled; no global PID/port kills. Retained runs are never removed.'};await save();process.exitCode=problems.length||manifest.interruption&&!interruptRequested?1:0;
  })();return shutting;
 }
 function start(role,environment){
  const record={role,startedAt:new Date().toISOString()};const child=fork(path.join(repositoryRoot,`scripts/demo/${role}.mjs`),[],{cwd:repositoryRoot,env:{...environment,DEMO_PLAN:planFile,NODE_ENV:'development',DEMO_NETWORK_LOG:path.join(run,`${role}-network-denied.jsonl`)},execArgv:role==='frontends'||mode==='mock'?['--require',path.join(repositoryRoot,'scripts/demo/network-guard.cjs')]:[],stdio:['ignore','ignore','pipe','ipc']});record.child=child;owned.push(record);
  record.closed=new Promise(resolve=>{child.once('close',(code,signal)=>{record.exit={code,signal};resolve();if(!shutting&&!interruptRequested){manifest.interruption={role,exit:code,signal,at:new Date().toISOString()};process.exitCode=1;void shutdown();}});});
  child.stderr.on('data',bytes=>{record.stderrObserved=true;record.stderrCodes=[...new Set([...(record.stderrCodes??[]),...(String(bytes).match(/\b(?:ERR_[A-Z0-9_]{1,48}|EADDRINUSE|EACCES|ENOENT)\b/g)??[])])];});
  const ready=new Promise((resolve,reject)=>{child.once('error',reject);child.on('message',message=>{if(message?.pid!==child.pid)return;if(message.type==='shutdown-intent'&&['SIGINT','SIGTERM'].includes(message.signal)){interruptRequested=true;void shutdown();return;}if(message.role!==role)return;if(message.type==='ready')resolve();if(message.type==='startup-error'&&/^[A-Z0-9_]{1,64}$/.test(message.code)&&/^[a-z-]{1,40}$/.test(message.stage)){record.failure={code:message.code,stage:message.stage};reject(codedError(message.code,'Owned child startup failed'));}});child.once('exit',code=>reject(codedError('CHILD_EXITED_BEFORE_READY',`${role} exited before ready (${code})`)));});
  manifest.children.push({role,pid:child.pid,startedAt:record.startedAt});return timeout(ready,60000,`${role} startup did not finish`,'CHILD_STARTUP_TIMEOUT');
 }
 const onSignal=()=>{interruptRequested=true;void shutdown();};
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,onSignal);
 try{
  manifest.status='starting';await save();await start('backend',backendEnv);if(shutting)throw codedError('STARTUP_INTERRUPTED','Demo startup interrupted');await save();await start('frontends',systemEnvironment());if(shutting)throw codedError('STARTUP_INTERRUPTED','Demo startup interrupted');
  manifest.status='running';manifest.startedAt=new Date().toISOString();await save();console.log(`Demo mode=${mode}; Studio=http://127.0.0.1:${ports.studio}; retained run=${run}`);
  console.log(mode==='mock'?'Speech and coding are fixed local substitutes. Not real recognition or generation.':'Aliyun speech uses operator-supplied backend configuration. No paid task is submitted automatically.');
  await Promise.all(owned.map(record=>record.closed));await shutdown();
 }catch(error){const code=safeFailureCode(error)??owned.find(record=>record.failure?.code)?.failure?.code;manifest.startupFailure='Startup failed. Check safe provider configuration, local ports and locked dependencies; no existing work was changed.';if(code)manifest.startupFailureCode=code;await shutdown();process.exitCode=1;console.error(code?`${manifest.startupFailure} [code=${code}]`:manifest.startupFailure);}
 finally{for(const signal of ['SIGINT','SIGTERM'])process.off(signal,onSignal);}
}
