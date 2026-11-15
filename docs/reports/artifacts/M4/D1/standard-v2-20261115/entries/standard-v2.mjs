import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const expectedHead='d005c23edd2e7e5efda5a0c5086cb2d370dabc0b';
const productHead='cb2237a40da8aa7a5ebe720085038e558fdb8f73';
const proofRelative='docs/reports/artifacts/M4/D1/guard-targeted-20261115/validated-guard-identity.json';
const run=`d1-standard-v2-${new Date().toISOString().replaceAll(':','-')}`;const output=path.join(root,'.data',run);await mkdir(output);
const git=(...args)=>execFileSync('git',['-c','core.longpaths=true',...args],{cwd:root,encoding:'utf8'}).trim();
const sha=value=>createHash('sha256').update(value).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PNPM_HOME','PROGRAMFILES','PROGRAMFILES(X86)'].includes(key.toUpperCase())));
Object.assign(env,{CI:'true',npm_config_offline:'true',npm_config_update_notifier:'false',LUX3D_BASE:'http://127.0.0.1:9',LUX3D_API_KEY:'mock-only',CODING_AGENT_BASE_URL:'http://127.0.0.1:9',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-only',DASHSCOPE_API_KEY:'',SPEECH_BASE_URL:'',SPEECH_MODEL:'qwen3-asr-flash',D1_RUN_DIR:output,D1_GUARD_LOG:path.join(output,'network-denied.jsonl'),NODE_OPTIONS:`--require="${path.join(root,'.data/d1-loopback.cjs').replaceAll('\\','/')}"`});
async function identity(){
 const files=git('ls-files','--','apps','packages','templates','tests','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','tsconfig.json','playwright*.ts').split('\n').filter(Boolean);
 files.push('.data/d1-loopback.cjs','.data/d1-standard-v2.mjs');
 return {head:git('rev-parse','HEAD'),appsTree:git('rev-parse','HEAD:apps'),lockSha256:sha(await readFile(path.join(root,'pnpm-lock.yaml'))),status:git('status','--porcelain'),files:Object.fromEntries(await Promise.all(files.sort().map(async filename=>[filename,sha(await readFile(path.join(root,filename)))])))};
}
const manifest={mode:'D1-fixed-docs-HEAD-with-explicitly-validated-guard-v2',expectedHead,productHead,proofRelative,pid:process.pid,started:new Date().toISOString(),run,steps:[],exit:1};const save=()=>writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
try{
 manifest.before=await identity();
 if(manifest.before.head!==expectedHead||manifest.before.status)throw new Error('Fixed docs commit must be clean');
 const proof=JSON.parse(await readFile(path.join(root,proofRelative),'utf8'));
 if(proof.productHead!==productHead||manifest.before.files['.data/d1-loopback.cjs']!==proof.guardSha256)throw new Error('Guard does not match the archived targeted proof');
 manifest.proof=proof;
 const proofDirectory=path.dirname(path.join(root,proofRelative));
 const inventory=JSON.parse(await readFile(path.join(proofDirectory,'sha256-manifest.json'),'utf8'));
 for(const file of inventory.files)if(sha(await readFile(path.join(proofDirectory,file.path)))!==file.sha256)throw new Error(`Archived guard payload differs ${file.path}`);
 for(const [file,hash] of [['guard-verification.json',proof.guardProbeSha256],['download-results.json',proof.downloadReportSha256]])if(sha(await readFile(path.join(proofDirectory,file)))!==hash)throw new Error(`Proof payload identity mismatch ${file}`);
 manifest.archivedProofPayloadsVerified=inventory.files.length;
 const old=JSON.parse(await readFile(path.join(root,'docs/reports/artifacts/M4/D1/standard-20261115-guard-interference/manifest.json'),'utf8'));
 for(const [file,hash] of Object.entries(old.before.files))if(file!=='.data/d1-loopback.cjs'&&sha(await readFile(path.join(root,file)))!==hash)throw new Error(`Original product/test changed ${file}`);
 manifest.originalProductTestsVerified=Object.keys(old.before.files).length-1;
 const oldEntry=path.join(root,'docs/reports/artifacts/M4/D1/standard-20261115-guard-interference/standard-entry-before.mjs');
 if(sha(await readFile(oldEntry))!==old.before.files['.data/d1-standard.mjs'])throw new Error('Old standard entry has drifted');
 await save();
 for(const [name,command] of [['typecheck','pnpm typecheck'],['build','pnpm build'],['test','pnpm test']]){
  const step={name,command,started:new Date().toISOString(),before:await identity()};manifest.steps.push(step);
  if(JSON.stringify(step.before)!==JSON.stringify(manifest.before))throw new Error('Identity changed before command');
  const log=createWriteStream(path.join(output,`${name}.log`));const child=spawn(env.ComSpec??env.COMSPEC??'cmd.exe',['/d','/s','/c',command],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});step.pid=child.pid;await save();
  child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
  await new Promise(resolve=>{child.once('error',error=>{step.spawnError=String(error);});child.once('close',(code,signal)=>{step.exit=code??1;step.signal=signal;log.end(resolve);});});
  step.finished=new Date().toISOString();step.after=await identity();step.identityUnchanged=JSON.stringify(step.before)===JSON.stringify(step.after);await save();
  if(step.exit!==0||!step.identityUnchanged){manifest.stoppedAt=name;throw new Error(`${name} failed; remaining commands not executed`);}
 }
 manifest.exit=0;
}catch(error){manifest.error=String(error);console.error(error);}
finally{
 manifest.after=await identity();manifest.identityUnchanged=JSON.stringify(manifest.before)===JSON.stringify(manifest.after);if(!manifest.identityUnchanged)manifest.exit=1;
 manifest.finished=new Date().toISOString();await save();const files=[];for(const name of await readdir(output)){const bytes=await readFile(path.join(output,name));files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
 await writeFile(path.join(output,'sha256-manifest.json'),JSON.stringify({excluded:['sha256-manifest.json'],files},null,2)+'\n');
 console.log(JSON.stringify({output,head:expectedHead,guard:manifest.proof?.guardSha256,exit:manifest.exit,stoppedAt:manifest.stoppedAt,identityUnchanged:manifest.identityUnchanged}));process.exitCode=manifest.exit;
}
