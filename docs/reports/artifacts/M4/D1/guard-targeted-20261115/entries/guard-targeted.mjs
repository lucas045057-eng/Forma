import {spawn,execFileSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const expectedHead='cb2237a40da8aa7a5ebe720085038e558fdb8f73';
const run=`d1-guard-targeted-${new Date().toISOString().replaceAll(':','-')}`;const output=path.join(root,'.data',run);await mkdir(output);
const git=(...args)=>execFileSync('git',['-c','core.longpaths=true',...args],{cwd:root,encoding:'utf8'}).trim();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PNPM_HOME','PROGRAMFILES','PROGRAMFILES(X86)'].includes(key.toUpperCase())));
Object.assign(env,{CI:'true',npm_config_offline:'true',npm_config_update_notifier:'false',LUX3D_BASE:'http://127.0.0.1:9',LUX3D_API_KEY:'mock-only',CODING_AGENT_BASE_URL:'http://127.0.0.1:9',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-only',DASHSCOPE_API_KEY:'',SPEECH_BASE_URL:'',SPEECH_MODEL:'qwen3-asr-flash',D1_RUN_DIR:output,D1_GUARD_LOG:path.join(output,'download-network-denied.jsonl'),NODE_OPTIONS:`--require="${path.join(root,'.data/d1-loopback.cjs').replaceAll('\\','/')}"`});
const probeEnv={...env,D1_GUARD_LOG:path.join(output,'guard-probe-denied.jsonl')};
// The probe unconditionally loads this exact guard after installing safe lower-boundary canaries.
// Native network operations start only after require; download uses the normal preload unchanged.
delete probeEnv.NODE_OPTIONS;
async function identity(){
 const files=git('ls-files','--','apps','packages','templates','tests','pnpm-lock.yaml','package.json','pnpm-workspace.yaml','tsconfig.json','playwright*.ts').split('\n').filter(Boolean);
 files.push('.data/d1-loopback.cjs','.data/d1-standard.mjs','.data/d1-guard-probe.cjs','.data/d1-guard-targeted.mjs');
 return {head:git('rev-parse','HEAD'),status:git('status','--porcelain'),files:Object.fromEntries(await Promise.all(files.sort().map(async name=>[name,sha(await readFile(path.join(root,name)))])))};
}
const manifest={mode:'DNS-literal-only-guard-fix-targeted',expectedHead,pid:process.pid,started:new Date().toISOString(),run,steps:[],exit:1};const save=()=>writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
try{
 manifest.before=await identity();if(manifest.before.head!==expectedHead)throw new Error('Product commit changed');
 const previous=JSON.parse(await readFile(path.join(root,'.data/d1-standard-2026-11-15T06-46-35.875Z/manifest.json'),'utf8'));
 for(const [file,hash] of Object.entries(previous.before.files))if(file!=='.data/d1-loopback.cjs'&&sha(await readFile(path.join(root,file)))!==hash)throw new Error(`Original product/test/entry byte changed: ${file}`);
 const oldGuard=await readFile(path.join(root,'docs/reports/artifacts/M4/D1/standard-20261115-guard-interference/guard-before.cjs'),'utf8');
 const guard=await readFile(path.join(root,'.data/d1-loopback.cjs'),'utf8');
 const expected=oldGuard.replace('if (allowed(host)) return lookup.apply(this, arguments);',"if (allowed(host) || (typeof host === 'string' && net.isIP(host))) return lookup.apply(this, arguments);").replace('return allowed(host) ? asyncLookup.call(this, host, options) : Promise.reject(reject(host));',"return allowed(host) || (typeof host === 'string' && net.isIP(host)) ? asyncLookup.call(this, host, options) : Promise.reject(reject(host));");
 if(expected!==guard||sha(Buffer.from(oldGuard))!==previous.before.files['.data/d1-loopback.cjs'])throw new Error('Guard differs beyond the two DNS literal branches');
 manifest.guardChange={beforeSha256:sha(Buffer.from(oldGuard)),afterSha256:sha(Buffer.from(guard)),onlyTwoDnsLiteralBranchesChanged:true,originalProductAndTestsUnchanged:true,oldStandardEntryAndIdentityGateUnchanged:true};
 await writeFile(path.join(output,'guard-before.cjs'),oldGuard);await writeFile(path.join(output,'guard-after.cjs'),guard);
 await writeFile(path.join(output,'guard-probe.cjs'),await readFile(path.join(root,'.data/d1-guard-probe.cjs')));
 const commands=[
  ['guard-probe',process.execPath,['.data/d1-guard-probe.cjs'],probeEnv,'node .data/d1-guard-probe.cjs'],
  ['download',env.ComSpec??env.COMSPEC??'cmd.exe',['/d','/s','/c',`pnpm --filter @spatial/server exec vitest run src/assets/download.test.ts --reporter=verbose --reporter=json --outputFile=../../.data/${run}/download-results.json`],env,'pnpm --filter @spatial/server exec vitest run src/assets/download.test.ts'],
 ];
 for(const [name,binary,args,childEnv,command] of commands){
  const step={name,command,argv:args,guardActivation:name==='guard-probe'?'explicit guarded require after canaries, before network':'NODE_OPTIONS preload',started:new Date().toISOString()};manifest.steps.push(step);
  if(JSON.stringify(await identity())!==JSON.stringify(manifest.before))throw new Error('Frozen identity changed before command');
  const log=createWriteStream(path.join(output,`${name}.log`));const child=spawn(binary,args,{cwd:root,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});step.pid=child.pid;await save();
  child.stdout.on('data',bytes=>{log.write(bytes);process.stdout.write(bytes);});child.stderr.on('data',bytes=>{log.write(bytes);process.stderr.write(bytes);});
  await new Promise(resolve=>{child.once('error',error=>{step.spawnError=String(error);});child.once('close',(code,signal)=>{step.exit=code??1;step.signal=signal;log.end(resolve);});});
  step.finished=new Date().toISOString();await save();
  if(step.exit!==0){manifest.stoppedAt=name;throw new Error(`${name} failed; no later stage scheduled`);}
  if(name==='guard-probe'){
   const report=JSON.parse(await readFile(path.join(output,'guard-verification.json'),'utf8'));
   if(report.exit!==0||report.serverListening||report.checks.length!==5||report.checks.some(check=>!check.passed))throw new Error('Guard probe report failed');
   const denied=(await readFile(path.join(output,'guard-probe-denied.jsonl'),'utf8')).trim().split('\n');if(denied.length!==28)throw new Error('Unexpected guard negative probe count');
   step.probeChecks=report.checks.length;step.intentionalDenials=denied.length;
  }else{
   const report=JSON.parse(await readFile(path.join(output,'download-results.json'),'utf8'));const assertions=report.testResults.flatMap(suite=>suite.assertionResults);
   step.actualTests={files:report.testResults.length,passed:assertions.filter(a=>a.status==='passed').length,total:assertions.length};
   if(report.testResults.length!==1||assertions.length!==11||assertions.some(a=>a.status!=='passed'||a.failureMessages?.length)||report.testResults.some(s=>s.status!=='passed'||s.message))throw new Error('Original 11 download tests did not all pass');
   try {const denied=await readFile(path.join(output,'download-network-denied.jsonl'),'utf8');if(denied.trim())throw new Error('Unexpected denial in original download suite');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await save();
 }
 manifest.exit=0;
 const guardProof=await readFile(path.join(output,'guard-verification.json'));const downloadProof=await readFile(path.join(output,'download-results.json'));
 await writeFile(path.join(output,'validated-guard-identity.json'),JSON.stringify({productHead:expectedHead,guardSha256:manifest.guardChange.afterSha256,previousGuardSha256:manifest.guardChange.beforeSha256,guardProbeSha256:sha(guardProof),downloadReportSha256:sha(downloadProof),originalProductAndTestsUnchanged:true,note:'New guard identity is proved only by this targeted run, not by old speech GREEN. Standard full rerun is not scheduled here; its gate must explicitly reference this evidence after review.'},null,2)+'\n');
}catch(error){manifest.error=String(error);console.error(error);}
finally{
 manifest.after=await identity();manifest.identityUnchanged=JSON.stringify(manifest.before)===JSON.stringify(manifest.after);if(!manifest.identityUnchanged)manifest.exit=1;
 manifest.finished=new Date().toISOString();await save();const files=[];
 for(const name of await readdir(output)){const bytes=await readFile(path.join(output,name));files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
 await writeFile(path.join(output,'sha256-manifest.json'),JSON.stringify({excluded:['sha256-manifest.json'],files},null,2)+'\n');
 console.log(JSON.stringify({output,exit:manifest.exit,stoppedAt:manifest.stoppedAt,guardChange:manifest.guardChange,identityUnchanged:manifest.identityUnchanged}));process.exitCode=manifest.exit;
}
