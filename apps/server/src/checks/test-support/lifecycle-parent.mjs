import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRealExecutor } from '../worker.ts';
import { copyAudited } from '../snapshot.ts';
import { writeArtifact, readArtifact } from '../artifacts.ts';
let worker;
const original=cp.spawn;
cp.spawn=function(...args) { const child=original(...args); if(args[0]===process.execPath && args[1].some(arg=>String(arg).includes('worker-entry.')))worker=child; return child; };
syncBuiltinESMExports();
const directory=process.argv[2];
const browserMode=process.argv[3]==='browser';
const candidateRoot=path.join(directory,'candidate');
await mkdir(path.join(candidateRoot,'src'),{recursive:true});
await writeFile(path.join(candidateRoot,'src/main.tsx'),browserMode?
  "import {createRoot} from 'react-dom/client';import {useState} from 'react';function App(){const [n,set]=useState(0);return <main><div data-testid='product-scene' data-state='fallback'><div data-testid='product-placeholder'>Fallback</div></div><button data-testid='buy-button' onClick={()=>set(n+1)}>Buy</button><output data-testid='action-status' data-purchases={n}>{n?'Added':''}</output></main>};createRoot(document.getElementById('root')).render(<App/>);":
  "import {createRoot} from 'react-dom/client';createRoot(document.getElementById('root')).render(<main>lifecycle</main>);");
await writeFile(path.join(candidateRoot,'src/scene.config.json'),await readFile(new URL('../../../../../templates/product-page/src/scene.config.json',import.meta.url)));
const buildRoot=path.join(directory,'snapshot');
const snapshot=await copyAudited(candidateRoot,buildRoot),controller=new AbortController();
const runId=randomUUID().replaceAll('-',''),executor=createRealExecutor();
const ctx={runId,candidateRoot,buildRoot,snapshot,signal:controller.signal,buildTimeoutMs:120000,browserTimeoutMs:30000,artifactsDir:directory,writeArtifact:(name,data)=>writeArtifact(directory,runId,name,data)};
try {
  const schema=await executor.schema(ctx);
  if(schema.status!=='passed')throw new Error(schema.message);
  const build=await executor.build(ctx);
  if(build.status!=='passed')throw new Error(build.message);
  let url;
  if(browserMode){
    const smoke=await executor.smoke(ctx);if(smoke.status!=='passed')throw new Error(smoke.message);
    url=JSON.parse((await readArtifact(directory,runId,'smoke.json')).buffer.toString()).url;
  }
  process.send({kind:'built',workerPid:worker.pid,runId,url});
} catch(error) {process.send({kind:'failure',message:error.message});await executor.stop(runId);process.exit(1);}
process.on('message',async message=>{if(message==='stop'){await executor.stop(runId);process.exit(0);}});
process.on('disconnect',()=>process.exit(0));

