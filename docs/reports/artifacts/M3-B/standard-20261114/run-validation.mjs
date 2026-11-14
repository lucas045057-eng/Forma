import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'.data','m3b-standard-validation-'+Date.now());await mkdir(output,{recursive:true});
function git(args){
  const result=spawnSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true});
  if(result.error||result.status!==0)throw result.error??new Error('git failed');return result.stdout;
}
const files=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(file=>/^(apps|packages|templates)\//.test(file)||file==='pnpm-lock.yaml'||file==='package.json'))].sort();
async function identity(){
  const hashes={};
  for(const file of files)hashes[file]={sha256:createHash('sha256').update(await readFile(path.join(root,file))).digest('hex'),gitBlob:git(['hash-object','--',file]).trim()};
  return {head:git(['rev-parse','HEAD']).trim(),status:git(['status','--short']),hashes};
}
const env={};
for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','ComSpec','USERPROFILE','LOCALAPPDATA','PATHEXT'])if(process.env[key])env[key]=process.env[key];
Object.assign(env,{CI:'true',NO_COLOR:'1',PNPM_DISABLE_SELF_UPDATE_CHECK:'1',
CODING_AGENT_BASE_URL:'http://127.0.0.1:4011',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-coder',LUX3D_BASE:'http://127.0.0.1:4019',LUX3D_API_KEY:'mock-only',
CHECK_BROWSER_EVIDENCE_DIR:path.join(output,'browser-artifacts'),CHECK_LIFECYCLE_EVIDENCE_DIR:path.join(output,'process-artifacts'),CHECK_REAL_EVIDENCE_DIR:path.join(output,'real-service-artifacts')});
const before=await identity(),steps=[];
let exitCode=0;
async function run(name,command,args){
  const pre=await identity();if(JSON.stringify(pre)!==JSON.stringify(before))throw new Error('Source identity changed before '+name);
  const log=createWriteStream(path.join(output,name+'.log')),startedAt=new Date().toISOString();
  console.log('START '+name);
  const child=spawn(command,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let error;child.once('error',e=>{error={code:e.code,message:e.message};});
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  await new Promise(resolve=>log.end(resolve));
  const post=await identity(),identityPreserved=JSON.stringify(post)===JSON.stringify(before);
  steps.push({name,command:[command,...args],cwd:root,pid:child.pid,startedAt,finishedAt:new Date().toISOString(),...result,error,identityPreserved});
  await writeFile(path.join(output,'evidence.json'),JSON.stringify({purpose:'Standard implementation validation, not independent Pi acceptance',before,steps,finished:false},null,2));
  console.log('END '+name+' '+JSON.stringify({...result,identityPreserved}));
  if(result.code!==0||result.signal||error||!identityPreserved)throw new Error(name+' failed');
}
try{
  for(const name of ['typecheck','build','test'])await run('pnpm-'+name,process.env.ComSpec??'cmd.exe',['/d','/s','/c','pnpm.cmd '+name]);
  await run('compiled-native-import',process.execPath,[path.join(root,'.data/m3b-compiled-native.mjs')]);
}catch(error){exitCode=1;console.log(error.message);}
const after=await identity(),identityPreserved=JSON.stringify(after)===JSON.stringify(before);
if(!identityPreserved)exitCode=1;
await writeFile(path.join(output,'evidence.json'),JSON.stringify({purpose:'Standard implementation validation, not independent Pi acceptance',before,after,steps,identityPreserved,finished:true,exitCode},null,2));
console.log(JSON.stringify({output,exitCode,identityPreserved,steps:steps.map(({name,code,signal})=>({name,code,signal}))}));
process.exitCode=exitCode;

