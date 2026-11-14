import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.data', 'm3b-review-fixes-red-' + Date.now());
await mkdir(output, { recursive: true });
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const tsc = require.resolve('typescript/bin/tsc');
const git = args => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw r.error ?? new Error('git failed');
  return r.stdout.trim();
};
const files = ['apps/server/package.json','pnpm-lock.yaml','apps/server/src/work/repo.ts','packages/shared/src/index.ts','apps/server/src/work/service.ts','apps/server/src/work/checks.test.ts','apps/server/src/app.ts',
  ...(await readdir(path.join(root,'apps/server/src/checks'))).filter(n=>n.endsWith('.ts')).map(n=>'apps/server/src/checks/'+n)];
async function identity() {
  const hashes = {};
  for (const file of files) hashes[file] = { sha256: createHash('sha256').update(await readFile(path.join(root,file))).digest('hex'), gitBlob: git(['hash-object','--',file]) };
  return { head:git(['rev-parse','HEAD']),status:git(['status','--short']),hashes };
}
const env = {};
for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','ComSpec','USERPROFILE','LOCALAPPDATA']) if(process.env[key]) env[key]=process.env[key];
Object.assign(env,{CI:'true',CODING_AGENT_BASE_URL:'http://127.0.0.1:4011',CODING_AGENT_API_KEY:'mock-only',CODING_AGENT_MODEL:'mock-coder',LUX3D_BASE:'http://127.0.0.1:4019',LUX3D_API_KEY:'mock-only'});
const before=await identity(), stages=[];
async function run(name, executable, args, cwd) {
  const log=createWriteStream(path.join(output,name+'.log')),startedAt=new Date().toISOString();
  console.log('START '+name);
  const child=spawn(executable,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
  let error;child.once('error',e=>{error={code:e.code,message:e.message};});
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  await new Promise(resolve=>log.end(resolve));
  stages.push({name,command:[executable,...args],cwd,pid:child.pid,startedAt,finishedAt:new Date().toISOString(),...result,error});
  console.log('END '+name+' '+JSON.stringify(result));
  if(result.code!==0) throw new Error(name+' failed');
}
let exitCode=0;
try {
  await run('types-first',process.execPath,[tsc,'-p',path.join(root,'apps/server/tsconfig.json')],root);
  await run('worker-contracts',process.execPath,[vitest,'run','src/checks/browser-boundary.test.ts','src/checks/worker-stop-failure.test.ts','src/work/checks.test.ts','--testNamePattern','blocks .*PeerConnection|forced termination|cleanup failure on cancel','--reporter=json','--outputFile',path.join(output,'tests.json')],path.join(root,'apps/server'));



} catch(error) { exitCode=1;console.log(error.message); }
const after=await identity();
let counts;
try {const r=JSON.parse(await readFile(path.join(output,'tests.json'),'utf8')); counts={total:r.numTotalTests,passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests};}catch{}
const identityPreserved=JSON.stringify(before)===JSON.stringify(after);
if(!identityPreserved)exitCode=1;
await writeFile(path.join(output,'evidence.json'),JSON.stringify({purpose:'Claude S-1 WebRTC UDP and S-2 failed termination RED contracts; fake UDP and fake process transport only',before,after,identityPreserved,stages,counts,exitCode},null,2));
console.log(JSON.stringify({output,counts,stages:stages.map(({name,code,signal})=>({name,code,signal})),identityPreserved,exitCode}));
process.exitCode=exitCode;

