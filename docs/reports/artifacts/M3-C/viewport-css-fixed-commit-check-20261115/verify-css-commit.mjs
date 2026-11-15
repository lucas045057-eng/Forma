import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const expectedHead = '393fe9f98c64822593591301518e246df8aa45e2';
const git = (...args) => execFileSync('git', ['-c','core.longpaths=true',...args], {cwd:root,encoding:'utf8'}).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const output = path.join(root, '.data', `css-commit-check-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(output);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PNPM_HOME','PROGRAMFILES','PROGRAMFILES(X86)'].includes(key.toUpperCase())));
Object.assign(env, {CI:'true',NODE_ENV:'production',npm_config_offline:'true',npm_config_update_notifier:'false'});
async function identity() {
 const files = git('ls-files','--','apps/studio','packages','templates','pnpm-lock.yaml').split('\n').filter(Boolean);
 return {head:git('rev-parse','HEAD'),lockSha256:sha(await readFile(path.join(root,'pnpm-lock.yaml'))),cssSha256:sha(await readFile(path.join(root,'apps/studio/src/scene-editor.css'))),trackedStatus:git('status','--porcelain','--untracked-files=no'),files:Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(path.join(root,file)))])))};
}
const manifest = {expectedHead,pid:process.pid,started:new Date().toISOString(),output,steps:[],exit:1};
const save = () => writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
try {
 manifest.before=await identity();
 if(manifest.before.head!==expectedHead || manifest.before.trackedStatus) throw new Error('Fixed commit is not clean or HEAD differs');
 await save();
 for (const task of ['typecheck','build']) {
  const command = `pnpm --filter @spatial/studio ${task}`;
  const step = {command,started:new Date().toISOString(),before:await identity(),log:`${task}.log`};
  if(JSON.stringify(step.before)!==JSON.stringify(manifest.before)) throw new Error('Source identity changed before command');
  manifest.steps.push(step);
  const log = createWriteStream(path.join(output,step.log));
  const child = spawn(env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',['/d','/s','/c',command],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  step.pid=child.pid;
  child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});
  child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
  await save();
  await new Promise(resolve=>{
   child.once('error',error=>{step.spawnError=String(error);});
   child.once('close',(code,signal)=>{step.exit=code??1;step.signal=signal;log.end(resolve);});
  });
  step.finished=new Date().toISOString();
  step.after=await identity();
  step.identityUnchanged=JSON.stringify(step.before)===JSON.stringify(step.after);
  await save();
  if(step.exit!==0 || !step.identityUnchanged) throw new Error(`${command} failed or fixed identity changed`);
 }
 manifest.exit=0;
} catch(error) {
 manifest.error=String(error);console.error(error);
} finally {
 manifest.finished=new Date().toISOString();
 try {manifest.after=await identity();manifest.identityUnchanged=JSON.stringify(manifest.before)===JSON.stringify(manifest.after);if(!manifest.identityUnchanged) manifest.exit=1;} catch(error) {manifest.identityError=String(error);manifest.exit=1;}
 await save();
 console.log(JSON.stringify({output,head:expectedHead,exit:manifest.exit,steps:manifest.steps.map(({command,pid,exit})=>({command,pid,exit})),identityUnchanged:manifest.identityUnchanged}));
 process.exitCode=manifest.exit;
}
