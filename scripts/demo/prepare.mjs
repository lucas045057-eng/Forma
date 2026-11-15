import {mkdir,realpath,symlink,writeFile,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertPlainPath,readPlainFile} from '../../apps/server/src/checks/paths.ts';
import {descendant,systemEnvironment,templateNameAllowed} from './safety.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const denied=()=>new Error('Demo source/destination must be a plain workspace path');
export async function prepareDemo(mode,options={}){
 const repository=options.repositoryRoot??path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 if(!['mock','real'].includes(mode))throw new Error('Unknown demo mode');
 const base=path.join(repository,'.data/demo-runs');const run=path.join(base,`${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}`);
 if(!descendant(base,run))throw denied();await assertPlainPath(run,denied,true);await mkdir(base,{recursive:true});await mkdir(run);await assertPlainPath(run,denied);
 const work=path.join(run,'work');await mkdir(work);
 const manifest={schemaVersion:1,mode,status:'preparing',createdAt:new Date().toISOString(),head:execFileSync('git',['-c','core.longpaths=true','rev-parse','HEAD'],{cwd:repository,env:systemEnvironment(),encoding:'utf8'}).trim(),work,files:[],dependencies:[],credentials:{speech:false,coding:false,lux3d:false},realParticipants:false,rehearsalExecuted:false};
 const save=()=>writeFile(path.join(run,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');await save();
 const template=path.join(repository,'templates/product-page');
 try{
  async function copyFile(relative){const bytes=await readPlainFile(path.join(template,relative),32*1024*1024,denied,()=>new Error('Demo source exceeds 32MiB'));const target=path.join(work,relative);if(!descendant(work,target))throw denied();await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});manifest.files.push({path:relative.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}
  const tracked=execFileSync('git',['-c','core.longpaths=true','ls-files','-z','--','templates/product-page/src','templates/product-page/public'],{cwd:repository,env:systemEnvironment()}).toString('utf8').split('\0').filter(Boolean);
  for(const file of ['index.html','package.json','vite.config.ts','tsconfig.json'])await copyFile(file);
  for(const file of tracked){const relative=path.relative(template,path.join(repository,file));if(!descendant(template,path.join(repository,file))||!relative.split(path.sep).every(templateNameAllowed))continue;await copyFile(relative);}
  const metadata=JSON.parse(await readFile(path.join(work,'package.json'),'utf8'));const packages=new Set([...Object.keys(metadata.dependencies??{}),...Object.keys(metadata.devDependencies??{})]);
  for(const name of packages){if(!/^(?:@[a-z0-9_-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))throw denied();const actual=await realpath(path.join(template,'node_modules',name));if(!descendant(path.join(repository,'packages'),actual)&&!descendant(path.join(repository,'node_modules'),actual))throw new Error('Dependency outside this checkout; install locked workspace dependencies before preparing demo');const target=path.join(work,'node_modules',name);await mkdir(path.dirname(target),{recursive:true});await symlink(actual,target,process.platform==='win32'?'junction':'dir');manifest.dependencies.push({name,target:actual});}
  manifest.status='prepared';await save();return {run,work,manifest};
 }catch(error){manifest.status='preparation_failed';manifest.failure='Preparation did not complete; partial run retained, no service started';await save();throw new Error(`Demo preparation failed; original and partial files preserved at ${run}`,{cause:error});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.env.NODE_OPTIONS)throw new Error('Clear NODE_OPTIONS before preparing demo');
 try{const result=await prepareDemo(process.argv[2]??'mock');console.log(JSON.stringify({mode:result.manifest.mode,run:result.run,status:result.manifest.status}));}catch{console.error('Demo preparation failed; no existing work was reset or removed.');process.exitCode=1;}
}
