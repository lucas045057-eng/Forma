import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {AssetService} from './service.ts';
import {Lux3DClient} from './lux3d.ts';
import {sha256,readFallback} from './fallbacks.ts';
import {SceneService} from '../scene/service.ts';
import {defaultSceneConfig} from '@spatial/shared/scene-config';
import {createApp} from '../app.ts';
const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{const errors:unknown[]=[];for(const close of cleanups.splice(0).reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Fallback fixture cleanup failed');});
function binary(){const bytes=Buffer.alloc(12);bytes.write('glTF');bytes.writeUInt32LE(2,4);bytes.writeUInt32LE(12,8);return bytes;}
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'fallback-dev-'));cleanups.push(()=>rm(root,{recursive:true,force:true}));const preset=path.join(root,'presets');await mkdir(preset);const bytes=binary();await writeFile(path.join(preset,'lux3d-split-4969889.glb'),bytes);
 const client=new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'});const remote=vi.spyOn(client,'getTask');
 const process=vi.fn(async(input:string,output:string)=>{await copyFile(input,output);return {before:{bytes:12,vertices:0},after:{bytes:12,vertices:0},durationMs:0,bounds:{min:[0,0,0],max:[1,1,1]},webReady:true};});
 const service=new AssetService({directory:path.join(root,'assets'),fallbackDirectory:preset,presetDigests:{'diffuser-split':sha256(bytes)},client,process});await service.init();cleanups.push(()=>service.close());return {root,preset,bytes,service,remote,process};
}
it('fixed fallback concurrent imports deduplicate and publish hashes without calling Lux3D',async()=>{
 const f=await fixture();const [a,b]=await Promise.all([f.service.importFallback('diffuser-split'),f.service.importFallback('diffuser-split')]);expect(a.id).toBe(b.id);await f.service.idle();const asset=f.service.get(a.id)!;
 expect(f.process).toHaveBeenCalledOnce();expect(f.remote).not.toHaveBeenCalled();expect(asset.provenance).toMatchObject({kind:'fallback',presetId:'diffuser-split',sourceHash:sha256(f.bytes),outputHash:sha256(f.bytes)});expect(JSON.stringify(asset)).not.toContain(f.root);expect((await f.service.listFallbacks()).find(p=>p.id==='diffuser-original')?.available).toBe(false);
});
it('a changed but complete preset file cannot silently become another trusted fallback',async()=>{
 const f=await fixture();const changed=Buffer.concat([f.bytes,Buffer.from([1])]);changed.writeUInt32LE(changed.length,8);await writeFile(path.join(f.preset,'lux3d-split-4969889.glb'),changed);await expect(f.service.importFallback('diffuser-split')).rejects.toMatchObject({code:'FALLBACK_CHANGED'});expect(f.process).not.toHaveBeenCalled();expect(f.remote).not.toHaveBeenCalled();
});
it('junction ancestors are rejected before a fixed preset can be read',async()=>{
 const f=await fixture();const linked=path.join(f.root,'linked');await symlink(f.preset,linked,'junction');await expect(readFallback(linked,'diffuser-split')).rejects.toMatchObject({code:'FALLBACK_PATH_DENIED'});await expect(f.service.importFallback('../outside')).rejects.toMatchObject({code:'UNKNOWN_PRESET'});
});
it('source follows the actual work model across new service state, undo and binary tampering',async()=>{
 const f=await fixture();const work=path.join(f.root,'work');await mkdir(path.join(work,'src'),{recursive:true});const original={...structuredClone(defaultSceneConfig),model:'/assets/original.glb'};await writeFile(path.join(work,'src/scene.config.json'),JSON.stringify(original));
 const asset=await f.service.importFallback('diffuser-split');await f.service.idle();const scene=new SceneService({workRoot:work,historyDirectory:path.join(f.root,'history')});await scene.adopt(f.service,asset.id,false);
 expect((await scene.modelProvenance()).verified).toBe(true);const another=new SceneService({workRoot:work,historyDirectory:path.join(f.root,'other-history')});expect((await another.modelProvenance()).provenance.kind).toBe('fallback');
 const model=path.join(work,'public/assets',`${asset.id}.glb`);await writeFile(model,Buffer.from('changed'));expect((await scene.modelProvenance()).verified).toBe(false);await writeFile(model,f.bytes);await scene.undo();expect((await scene.modelProvenance()).model).toBe(original.model);
});
it('close retains its barrier until an admitted local processor has really settled',async()=>{
 const f=await fixture();let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
 f.process.mockImplementation(async(input,output)=>{entered();await gate;await copyFile(input,output);return {before:{bytes:12,vertices:0},after:{bytes:12,vertices:0},durationMs:0,bounds:{min:[0,0,0],max:[1,1,1]},webReady:true};});
 const asset=await f.service.importFallback('diffuser-split');await started;let closed=false;const closing=f.service.close().then(()=>{closed=true;});try{await Promise.resolve();expect(closed).toBe(false);}finally{release();}await closing;expect(f.service.get(asset.id)?.status).toBe('cancelled');expect(f.service.get(asset.id)?.modelUrl).toBeUndefined();
});
it('fallback HTTP refuses client paths, URLs and provenance fields without creating work',async()=>{
 const f=await fixture();const work=path.join(f.root,'http-work');await mkdir(path.join(work,'src'),{recursive:true});await writeFile(path.join(work,'src/app.ts'),'export const a=1;');
 const {app}=await createApp({workRoot:work,workDataDirectory:path.join(f.root,'http-data'),dataDirectory:path.join(f.root,'http-assets'),historyDirectory:path.join(f.root,'http-history'),fallbackDirectory:f.preset,base:'http://127.0.0.1:9',key:'mock-only'});cleanups.push(()=>app.close());
 for(const body of [{path:'/secret'},{url:'https://invalid.example'},{provenance:{kind:'lux3d'}}]){const response=await app.inject({method:'POST',url:'/assets/fallbacks/diffuser-split/import',payload:body});expect(response.statusCode).toBe(400);}
 expect((await app.inject('/assets')).json()).toEqual([]);expect((await app.inject('/assets/fallbacks')).json()).toEqual(expect.arrayContaining([expect.objectContaining({id:'diffuser-split',available:false})]));
});
