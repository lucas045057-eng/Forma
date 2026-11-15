import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {prepareDemo} from './prepare.mjs';
import {readPlan} from './runtime.mjs';
import {repository,systemEnvironment} from './safety.mjs';

async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'demo-body-'));const template=path.join(root,'templates/product-page');await mkdir(path.join(template,'src'),{recursive:true});await mkdir(path.join(template,'public'),{recursive:true});
 for(const [name,text]of Object.entries({'index.html':'<div id="root"></div>','package.json':'{"dependencies":{}}','vite.config.ts':'export default {};','tsconfig.json':'{}','src/App.tsx':'export default 1;','public/info.json':'{}','src/.env':'DECOY_SECRET=not-real','public/config.env.local':'DECOY_SECRET=not-real'}))await writeFile(path.join(template,name),text);
 const git=(...args)=>execFileSync('git',['-c','core.longpaths=true',...args],{cwd:root,env:systemEnvironment(),stdio:'pipe'});git('init');git('add','--force','--','templates/product-page');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','local fixture');return {root,template};}
async function child(entry,args=[],options={}){
 const processHandle=spawn(process.execPath,[entry,...args],{env:systemEnvironment(),stdio:['ignore','pipe','pipe'],...options});let stdout='',stderr='';processHandle.stdout?.on('data',bytes=>stdout+=bytes);processHandle.stderr?.on('data',bytes=>stderr+=bytes);
 const closed=new Promise((resolve,reject)=>{processHandle.once('error',reject);processHandle.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});return {processHandle,closed};
}
async function bounded(promise,ms=15_000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture exceeded explicit budget')),ms);})]);}finally{clearTimeout(timer);}}
async function waitFor(read,ms=10_000){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture state deadline exceeded');}
function processIdentities(){const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} })"],{encoding:'utf8',timeout:10_000})||'[]');return value;}
async function settleFixture(record){
 if(!record)return;const table=processIdentities();const root=table.find(item=>item.pid===record.processHandle.pid);const owned=root?[root]:[];
 for(let index=0;index<owned.length;index++)for(const item of table)if(item.parent===owned[index].pid&&Date.parse(item.created)>=Date.parse(owned[index].created)&&!owned.some(old=>old.pid===item.pid))owned.push(item);
 for(const item of owned.reverse())if(processIdentities().some(current=>current.pid===item.pid&&current.created===item.created))process.kill(item.pid,'SIGKILL');
 await bounded(record.closed);assert.equal(processIdentities().some(current=>owned.some(item=>item.pid===current.pid&&item.created===current.created)),false,'Test-owned descendants survived cleanup');
}

test('prepare copies only tracked public/source names and leaves decoy env and existing runs untouched',async()=>{
 const f=await fixture();try{const first=await prepareDemo('mock',{repositoryRoot:f.root});const second=await prepareDemo('mock',{repositoryRoot:f.root});assert.notEqual(first.run,second.run);assert.equal(await readFile(path.join(first.work,'src/App.tsx'),'utf8'),'export default 1;');assert.deepEqual(await readdir(path.join(first.work,'src')),['App.tsx']);assert.deepEqual(await readdir(path.join(first.work,'public')),['info.json']);assert.equal(JSON.stringify(first.manifest).includes('DECOY_SECRET'),false);}finally{await rm(f.root,{recursive:true,force:true});}
});
test('prepare refuses a junction in the destination ancestry without following it',async()=>{
 const f=await fixture();const outside=await mkdtemp(path.join(tmpdir(),'demo-outside-'));try{await symlink(outside,path.join(f.root,'.data'),'junction');await assert.rejects(prepareDemo('mock',{repositoryRoot:f.root}));assert.deepEqual(await readdir(outside),[]);}finally{await rm(path.join(f.root,'.data'),{force:true});await rm(f.root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('plan reader refuses escaped paths, duplicate/out-of-range ports and unexpected port names',async()=>{
 const f=await fixture();try{const prepared=await prepareDemo('mock',{repositoryRoot:f.root});const ports={api:21001,studio:21002,main:21003,preview:21004,coding:21005,lux3d:21006,speech:21007};const plan={schemaVersion:1,mode:'mock',run:prepared.run,work:prepared.work,ports};const file=path.join(prepared.run,'plan.json');await writeFile(file,JSON.stringify(plan));assert.equal((await readPlan(file,f.root)).ports.preview,21004);
 for(const changed of [{...plan,work:f.root},{...plan,ports:{...ports,preview:ports.api}},{...plan,ports:{...ports,api:1}},{...plan,ports:{...ports,extra:21008}}]){await writeFile(file,JSON.stringify(changed));await assert.rejects(readPlan(file,f.root));}await assert.rejects(readPlan(path.join(f.root,'plan.json'),f.root));}finally{await rm(f.root,{recursive:true,force:true});}
});
test('network guard refuses domains, private/public/mapped TCP and fetch before native boundaries while loopback remains usable',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'demo-guard-'));let run;try{const probe=path.join(root,'probe.cjs');await writeFile(probe,`
const assert=require('node:assert/strict');const net=require('node:net');const dns=require('node:dns');const promises=require('node:dns/promises');
let tcp=0,callbackDns=0,promiseDns=0,http=0;const original=dns.lookup;const originalAsync=promises.lookup;const connect=net.Socket.prototype.connect;
dns.lookup=function(...args){callbackDns++;return original.apply(this,args)};promises.lookup=function(...args){promiseDns++;return originalAsync.apply(this,args)};
net.Socket.prototype.connect=function(...args){tcp++;return connect.apply(this,args)};global.fetch=async()=>{http++;return {ok:true}};
require(${JSON.stringify(path.join(repository,'scripts/demo/network-guard.cjs'))});
(async()=>{for(const host of ['external.invalid','10.0.0.1','203.0.113.1','::ffff:7f00:1']){assert.throws(()=>new net.Socket().connect({host,port:20001}),{code:'DEMO_NETWORK_DENIED'});await assert.rejects(fetch('http://'+(host.includes(':')?'['+host+']':host)+':20001'),{code:'DEMO_NETWORK_DENIED'});}assert.equal(tcp,0);assert.equal(http,0);
await assert.rejects(promises.lookup('external.invalid'),{code:'DEMO_NETWORK_DENIED'});await new Promise(resolve=>dns.lookup('external.invalid',error=>{assert.equal(error.code,'DEMO_NETWORK_DENIED');resolve()}));assert.equal(callbackDns,0);assert.equal(promiseDns,0);
for(const host of ['10.0.0.1','::ffff:7f00:1']){await promises.lookup(host);await new Promise((resolve,reject)=>dns.lookup(host,error=>error?reject(error):resolve()));}assert.equal(callbackDns,2);assert.equal(promiseDns,2);
const server=net.createServer(socket=>socket.end());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port:server.address().port});socket.once('error',reject);socket.once('close',resolve)});await new Promise(resolve=>server.close(resolve));await fetch('http://127.0.0.1:20001');assert.equal(http,1);assert.equal(server.listening,false);console.log(JSON.stringify({passed:true,tcp,callbackDns,promiseDns,http,serverListening:server.listening}));})().catch(error=>{console.error(error);process.exitCode=1});
`);run=await child(probe);const result=await bounded(run.closed);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).passed,true);}finally{await settleFixture(run);await rm(root,{recursive:true,force:true});}
});

test('mock and real launch both bind the generated preview port and SIGINT ends owned roles without forced shutdown',async()=>{
 const f=await fixture();let run;try{const roles=path.join(f.root,'scripts/demo');await mkdir(roles,{recursive:true});await copyFile(path.join(repository,'scripts/demo/network-guard.cjs'),path.join(roles,'network-guard.cjs'));
 const runtime=pathToFileURL(path.join(repository,'scripts/demo/runtime.mjs')).href;
 for(const role of ['backend','frontends'])await writeFile(path.join(roles,role+'.mjs'),`import {readFile,writeFile} from 'node:fs/promises';import {ownedLifetime} from ${JSON.stringify(runtime)};import path from 'node:path';const plan=JSON.parse(await readFile(process.env.DEMO_PLAN));const keep=setInterval(()=>{},1000);ownedLifetime(async()=>clearInterval(keep));await writeFile(path.join(plan.run,${JSON.stringify(role+'-env.json')}),JSON.stringify({preview:process.env.PREVIEW_ORIGIN_PORT,credentials:!!process.env.DASHSCOPE_API_KEY}));process.send({type:'ready',role:${JSON.stringify(role)},pid:process.pid});`);
 const entry=path.join(f.root,'launch.mjs');await writeFile(entry,`import {launch} from ${JSON.stringify(pathToFileURL(path.join(repository,'scripts/demo/launch.mjs')).href)};import {prepareDemo} from ${JSON.stringify(pathToFileURL(path.join(repository,'scripts/demo/prepare.mjs')).href)};const root=${JSON.stringify(f.root)};process.on('message',message=>{if(message?.type==='fixture-sigint')process.emit('SIGINT')});await launch(process.argv[2],process.argv[2]==='real'?['--allow-real-services']:[],{repositoryRoot:root,prepare:mode=>prepareDemo(mode,{repositoryRoot:root})});if(process.connected)process.disconnect();`);
 for(const mode of ['mock','real']){run=await child(entry,[mode],{env:{...systemEnvironment(),...(mode==='real'?{DASHSCOPE_API_KEY:'fake-only',SPEECH_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1'}:{})},stdio:['ignore','pipe','pipe','ipc']});const manifestFile=await waitFor(async()=>{const base=path.join(f.root,'.data/demo-runs');let folders;try{folders=await readdir(base);}catch{return;}for(const folder of folders.reverse()){const file=path.join(base,folder,'manifest.json');try{const data=JSON.parse(await readFile(file,'utf8'));if(data.mode===mode&&data.status==='running')return file;}catch{}}});const plan=JSON.parse(await readFile(path.join(path.dirname(manifestFile),'plan.json'),'utf8'));const env=JSON.parse(await readFile(path.join(plan.run,'backend-env.json'),'utf8'));assert.equal(env.preview,String(plan.ports.preview));assert.equal(JSON.parse(await readFile(path.join(plan.run,'frontends-env.json'),'utf8')).credentials,false);
 run.processHandle.send({type:'fixture-sigint'});const result=await bounded(run.closed);assert.equal(result.code,0,result.stderr);const final=JSON.parse(await readFile(manifestFile,'utf8'));assert.equal(final.status,'stopped');assert.equal(final.cleanup.children.every(item=>item.forced===false&&item.exit===0),true);run=undefined;}
 }finally{await settleFixture(run);await rm(f.root,{recursive:true,force:true});}
});

test('orphan watchdog terminates identified worker descendants after parent IPC closes, not unrelated processes',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'demo-orphan-'));let run;let unrelated;let identities=[];try{
 const runtime=pathToFileURL(path.join(repository,'scripts/demo/runtime.mjs')).href;const entry=path.join(root,'orphan.mjs');const plan=path.join(root,'plan.json');await writeFile(plan,'{}');
 await writeFile(entry,`import {fork} from 'node:child_process';import {ownedLifetime} from ${JSON.stringify(runtime)};import {writeFile} from 'node:fs/promises';import path from 'node:path';const worker=process.argv[2];if(worker){setInterval(()=>{},1000);}else{ownedLifetime(()=>new Promise(()=>{}),{hardTimeoutMs:300});for(const role of ['preview','check','asset','frontend-worker']){const child=fork(import.meta.filename,[role],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});}await writeFile(path.join(path.dirname(process.env.DEMO_PLAN),'ready'),String(process.pid));}`);
 const parentEntry=path.join(root,'parent.mjs');await writeFile(parentEntry,`import {fork} from 'node:child_process';fork(${JSON.stringify(entry)},[],{execArgv:[],stdio:['ignore','inherit','inherit','ipc']});setInterval(()=>{},1000);`);
 run=await child(parentEntry,[],{env:{...systemEnvironment(),DEMO_PLAN:plan}});unrelated=await child(entry,['unrelated']);const orphanPid=Number(await waitFor(async()=>{try{return await readFile(path.join(root,'ready'),'utf8');}catch{return;}}));
 const table=processIdentities();const workers=table.filter(item=>item.parent===orphanPid);assert.equal(workers.length,4);identities=[table.find(item=>item.pid===orphanPid),...workers];assert.ok(identities[0]);const unrelatedIdentity=table.find(item=>item.pid===unrelated.processHandle.pid);assert.ok(unrelatedIdentity);
 run.processHandle.kill('SIGKILL');const result=await bounded(run.closed,20_000);assert.match(result.stderr,/DEMO_ORPHAN_TIMEOUT/);
 await waitFor(async()=>!processIdentities().some(item=>identities.some(old=>old.pid===item.pid&&old.created===item.created)));assert.ok(processIdentities().some(item=>item.pid===unrelatedIdentity.pid&&item.created===unrelatedIdentity.created));const cleanup=JSON.parse(await readFile(path.join(root,`orphan-cleanup-${orphanPid}.json`),'utf8'));assert.equal(cleanup.forced,true);assert.equal(cleanup.errors.length,0);
 }finally{for(const identity of identities)if(identity&&processIdentities().some(item=>item.pid===identity.pid&&item.created===identity.created))process.kill(identity.pid,'SIGKILL');await settleFixture(run);await settleFixture(unrelated);await rm(root,{recursive:true,force:true});}
});
