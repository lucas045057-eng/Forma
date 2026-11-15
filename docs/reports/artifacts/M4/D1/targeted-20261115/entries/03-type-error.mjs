import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const run = `d1-green-${new Date().toISOString().replaceAll(':','-')}`;
const output = path.join(root,'.data',run);
await mkdir(output);
const git = (...args) => execFileSync('git',['-c','core.longpaths=true',...args],{cwd:root,encoding:'utf8'}).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PNPM_HOME','PROGRAMFILES','PROGRAMFILES(X86)'].includes(key.toUpperCase())));
Object.assign(env,{CI:'true',npm_config_offline:'true',npm_config_update_notifier:'false',LUX3D_BASE:'http://127.0.0.1:9',LUX3D_API_KEY:'mock-only',CODING_AGENT_BASE_URL:'http://127.0.0.1:9',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-only',DASHSCOPE_API_KEY:'',SPEECH_BASE_URL:'',SPEECH_MODEL:'qwen3-asr-flash',D1_RUN_DIR:output,D1_GUARD_LOG:path.join(output,'network-denied.jsonl'),NODE_OPTIONS:`--require="${path.join(root,'.data/d1-loopback.cjs').replaceAll('\\','/')}"`});
async function identity() {
 const files = new Set(git('ls-files','--','apps','packages','templates','pnpm-lock.yaml').split('\n').filter(Boolean));
 for(const name of await readdir(path.join(root,'apps/server/src/speech'))) if(name.endsWith('.ts')) files.add(`apps/server/src/speech/${name}`);
 for(const filename of ['.data/d1-loopback.cjs','.data/d1-green.mjs','docs/reports/M4-D1-impl.md']) files.add(filename);
 return {head:git('rev-parse','HEAD'),appsTree:git('rev-parse','HEAD:apps'),lockSha256:sha(await readFile(path.join(root,'pnpm-lock.yaml'))),status:git('status','--porcelain'),files:Object.fromEntries(await Promise.all([...files].sort().map(async filename=>[filename,sha(await readFile(path.join(root,filename)))])))};
}
const manifest={mode:'D1-draft-targeted-GREEN-and-scoped-types',pid:process.pid,started:new Date().toISOString(),run,steps:[],exit:1};
const save=()=>writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
try {
 manifest.before=await identity();
 if(manifest.before.head!=='d6ec495fa6bb9cf30961dfb2e7240ee03c606e40') throw new Error('Unexpected fixed baseline');
 const commands = [
  ['shared-typecheck','pnpm --filter @spatial/shared typecheck'],
  ['server-typecheck','pnpm --filter @spatial/server typecheck'],
  ['studio-typecheck','pnpm --filter @spatial/studio typecheck'],
  ['speech-tests',`pnpm --filter @spatial/server exec vitest run src/speech/routes.test.ts src/speech/boundary.test.ts src/speech/lifecycle.test.ts --bail=1 --reporter=verbose --reporter=json --outputFile=../../.data/${run}/server-results.json`,'server-results.json'],
  ['proxy-test',`pnpm --filter @spatial/studio exec vitest run src/dev-proxy.test.ts --bail=1 --reporter=verbose --reporter=json --outputFile=../../.data/${run}/studio-results.json`,'studio-results.json'],
 ];
 for(const [name,command,reportName] of commands) {
  const step={name,command,started:new Date().toISOString(),before:await identity()};manifest.steps.push(step);
  if(JSON.stringify(step.before)!==JSON.stringify(manifest.before)) throw new Error('Identity changed before command');
  const log=createWriteStream(path.join(output,`${name}.log`));
  const child=spawn(env.ComSpec??env.COMSPEC??'cmd.exe',['/d','/s','/c',command],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  step.pid=child.pid;await save();
  child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});
  child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
  await new Promise(resolve=>{
   child.once('error',error=>{step.spawnError=String(error);});
   child.once('close',(code,signal)=>{step.exit=code??1;step.signal=signal;log.end(resolve);});
  });
  step.finished=new Date().toISOString();step.after=await identity();step.identityUnchanged=JSON.stringify(step.before)===JSON.stringify(step.after);await save();
  if(step.exit!==0 || !step.identityUnchanged) {manifest.stoppedAt=name;throw new Error(`${name} failed; remaining stages not executed`);}
  if(reportName) {
   const report=JSON.parse(await readFile(path.join(output,reportName),'utf8'));
   const assertions=report.testResults.flatMap(suite=>suite.assertionResults);
   step.actualTests={files:report.testResults.length,assertions:assertions.length,passed:assertions.filter(a=>a.status==='passed').length};
   if(!assertions.length || assertions.some(a=>a.status!=='passed'||a.failureMessages?.length) || report.testResults.some(s=>s.status!=='passed'||s.message)) throw new Error('Test report contains non-passed assertions or suite errors');
   await save();
  }
 }
 manifest.exit=0;
} catch(error) {manifest.error=String(error);console.error(error);}
finally {
 manifest.after=await identity();manifest.identityUnchanged=JSON.stringify(manifest.before)===JSON.stringify(manifest.after);
 if(!manifest.identityUnchanged) {manifest.exit=1;manifest.identityError='Frozen source changed';}
 manifest.finished=new Date().toISOString();await save();
 const inventory=[];
 for(const filename of await readdir(output)) {const bytes=await readFile(path.join(output,filename));inventory.push({path:filename,bytes:bytes.length,sha256:sha(bytes)});}
 await writeFile(path.join(output,'sha256-manifest.json'),JSON.stringify({excluded:['sha256-manifest.json'],files:inventory},null,2)+'\n');
 console.log(JSON.stringify({output,exit:manifest.exit,stoppedAt:manifest.stoppedAt,identityUnchanged:manifest.identityUnchanged}));process.exitCode=manifest.exit;
}
