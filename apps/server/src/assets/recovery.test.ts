import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMockServer, type MockScenario } from './mock-server.ts';
import { Lux3DClient } from './lux3d.ts';
import { AssetService } from './service.ts';
import { createApp } from '../app.ts';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fixtureProcesses,fixtureFailure,writeFixtureEvidence,fixtureDirectoryIdentity,removeFixtureDirectory,failFixture,type FixtureProcess} from '../test-support/fixture-diagnostics.ts';
import {fileURLToPath} from 'node:url';
import { listenForFetch } from '../test-support/fetch-listener.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); const errors:unknown[]=[];for (const close of cleanups.splice(0).reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Recovery fixture cleanup failed'); });
async function setup(scenario: MockScenario = 'success') {
  const root = resolve(import.meta.dirname, '../../../../.data');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'recovery-test-'));
  const owner=await fixtureDirectoryIdentity(directory);const removeDirectory=()=>removeFixtureDirectory(directory,owner);cleanups.push(removeDirectory);
  const { mock, baseUrl: base } = await listenForFetch(() => createMockServer({ scenario }));
  cleanups.push(() => mock.close());
  const client = new Lux3DClient({ base, key: 'mock-only' });
  return { root, directory, mock, base, client, removeDirectory };
}

it('processes despite stale temporary files, repairs missing ready output without a paid create, and changes its URL', async () => {
  const { directory, mock, base } = await setup();
  const { app, service } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: 1 });
  cleanups.push(() => app.close());
  await mkdir(join(directory, '123'));
  await writeFile(join(directory, '123', 'model.glb.tmp'), 'crash residue');
  await writeFile(join(directory, '123', 'raw.glb.tmp'), 'crash residue');
  const first = (await app.inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId: '123' } })).json();
  await service.idle();
  const ready = service.get(first.id)!;
  expect(ready.status).toBe('ready');
  expect((await app.inject(ready.modelUrl!)).statusCode).toBe(200);
  const file = service.modelPath(first.id)!;
  await rm(file);
  expect((await app.inject(ready.modelUrl!)).json().error.code).toBe('MODEL_MISSING');
  const gets = (await mock.inject('/__stats')).json().gets;
  const repaired = await service.importTask('123');
  expect(repaired.id).toBe(first.id);
  await service.idle();
  expect(service.get(first.id)?.status).toBe('ready');
  expect(service.get(first.id)?.modelUrl).not.toBe(ready.modelUrl);
  expect((await app.inject(service.get(first.id)!.modelUrl!)).statusCode).toBe(200);
  expect((await mock.inject('/__stats')).json()).toEqual({ creates: 0, gets: gets + 1 });
  const names = await readdir(join(directory, '123'));
  expect(names.filter(name => name.endsWith('.tmp')).sort()).toEqual(['model.glb.tmp', 'raw.glb.tmp']);
});
it('detects missing ready models on restart and allows re-import', async () => {
  const { directory, client, mock } = await setup();
  const first = new AssetService({ directory, client, pollMs: 1 });
  await first.init();
  const asset = await first.importTask('123');
  await first.idle(); await first.close();
  await rm(join(directory, '123', 'model.glb'));
  const second = new AssetService({ directory, client, pollMs: 1 });
  cleanups.push(() => second.close());
  await second.init();
  expect(second.get(asset.id)).toMatchObject({ status: 'failed', error: { code: 'MODEL_MISSING' } });
  await second.importTask('123'); await second.idle();
  expect(second.get(asset.id)?.status).toBe('ready');
  expect((await mock.inject('/__stats')).json().creates).toBe(0);
});
it('never repeats a paid request after upstream accepts it but loses the response', async () => {
  const { directory, client, mock } = await setup('response-lost');
  const first = new AssetService({ directory, client });
  await first.init();
  const input = { prompt: 'bottle', version: 'G1-Turbo' as const };
  const asset = await first.submit(input, 'lost-response');
  expect(asset.status).toBe('submit_unknown');
  await first.close();
  const restarted = new AssetService({ directory, client });
  cleanups.push(() => restarted.close());
  await restarted.init();
  expect((await restarted.submit(input, 'lost-response')).id).toBe(asset.id);
  expect((await mock.inject('/__stats')).json().creates).toBe(1);
});
it('does not resubmit after taskId persistence fails, even after restart', async () => {
  const { directory, client, mock, base, removeDirectory } = await setup();
  const env:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  const stages:Array<{phase:string;ms:number}>=[];const started=performance.now();const mark=(phase:string)=>stages.push({phase,ms:performance.now()-started});
  const child=spawn(process.execPath,['--import',new URL('../test-support/asset-persistence-register.mjs',import.meta.url).href,fileURLToPath(new URL('../test-support/asset-persistence-parent.ts',import.meta.url)),directory,base],{env,stdio:['ignore','pipe','pipe','ipc']});
  let stdout='';let stderr='';let childError:Error|undefined;let spawned=false;let ipcDisconnected=false;let primary:unknown;let owner:FixtureProcess|undefined;let restarted:AssetService|undefined;const messages:Array<Record<string,unknown>>=[];
  child.once('spawn',()=>{spawned=true;mark('spawned');});child.stdout!.on('data',chunk=>{stdout+=String(chunk);});child.stderr!.on('data',chunk=>{stderr+=String(chunk);});child.once('error',error=>{childError=error;});
  child.on('message',(value:unknown)=>{if(value&&typeof value==='object'&&'pid'in value&&value.pid===child.pid)messages.push(value as Record<string,unknown>);});
  child.once('exit',(code,signal)=>mark(`exit:${code}:${signal}`));child.once('disconnect',()=>{ipcDisconnected=true;mark('IPC-disconnected');});
  const closed=new Promise<void>(resolveClose=>child.once('close',(code,signal)=>{mark(`closed:${code}:${signal}`);resolveClose();}));
  const diagnostics=()=>JSON.stringify({stages,messages,stdout:stdout.slice(-8000),stderr:stderr.slice(-8000),spawnError:childError?.message,exit:child.exitCode,signal:child.signalCode,connected:child.connected,ipcDisconnected});
  const assertAlive=()=>{if(childError||ipcDisconnected||child.exitCode!==null||child.signalCode!==null||messages.some(message=>message.type==='persistence-fixture-error'))throw new Error(`Persistence fixture early failure: ${diagnostics()}`,{cause:childError});};
  const waitStage=async(name:string,ready:()=>boolean)=>{mark(name);const until=performance.now()+5000;while(performance.now()<until){assertAlive();if(ready())return;await delay(20);}throw new Error(`Persistence fixture stage ${name} timed out: ${diagnostics()}`);};
  const awaitClosed=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Owned persistence fixture did not close: ${diagnostics()}`)),5000);})]);}finally{clearTimeout(timer);}};
  try{
    await waitStage('spawn',()=>spawned);await waitStage('preload',()=>messages.some(message=>message.type==='persistence-preload-stage'&&message.stage==='installed'));
    await waitStage('entry-imported',()=>messages.some(message=>message.type==='persistence-stage'&&message.stage==='entry'));
    mark('identity');const table=await fixtureProcesses([child.pid!]);assertAlive();owner=table.find(item=>item.pid===child.pid);if(!owner)throw new Error(`Persistence fixture identity unavailable while live: ${diagnostics()}`);
    expect(owner.pid).toBe(child.pid);await waitStage('held',()=>messages.some(message=>message.type==='persistence-failure-held'));
    const held=messages.find(message=>message.type==='persistence-failure-held');expect(held).toMatchObject({pid:child.pid,submitError:'disk full',idleError:'disk full',closeError:'disk full',lockPid:child.pid,blockedCode:'INSTANCE_LOCKED'});
    expect(messages.some(message=>message.type==='persistence-preload-stage'&&message.stage==='atomic-wrapper-evaluated')).toBe(true);
    const liveProbe=new AssetService({directory,client});await expect(liveProbe.init()).rejects.toMatchObject({code:'INSTANCE_LOCKED'});
    expect(JSON.parse(await readFile(join(directory,'index.json'),'utf8'))[0].status).toBe('submitting');expect((await mock.inject('/__stats')).json().creates).toBe(1);
    mark('kill');child.kill('SIGKILL');await awaitClosed();expect((await fixtureProcesses([owner.pid])).some(item=>item.created===owner!.created)).toBe(false);
    expect(JSON.parse(await readFile(join(directory,'.instance.lock'),'utf8')).pid).toBe(owner.pid);
    mark('restart');const input={prompt:'bottle',version:'G1' as const};restarted=new AssetService({directory,client,pollMs:1});await restarted.init();
    expect((await restarted.submit(input,'disk-failure')).status).toBe('submit_unknown');expect((await mock.inject('/__stats')).json().creates).toBe(1);
    await restarted.importTask('9000001');await restarted.idle();expect(restarted.get('lux3d-9000001')?.status).toBe('ready');expect((await mock.inject('/__stats')).json().creates).toBe(1);mark('assertions-complete');
  }catch(error){primary=error;}
  const errors:unknown[]=[];mark('cleanup');try{await restarted?.close();}catch(error){errors.push(error);}
  try{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await awaitClosed();if(owner)expect((await fixtureProcesses([owner.pid])).some(item=>item.created===owner!.created)).toBe(false);}catch(error){errors.push(error);}
  try{await writeFixtureEvidence(process.env.D2_RUN_DIR??directory,'asset-recovery',`persistence-${process.pid}.json`,{owner,stages,messages,stdout,stderr,exit:child.exitCode,signal:child.signalCode,primary:primary===undefined?null:fixtureFailure(primary),cleanup:errors.map(fixtureFailure)});}catch(error){errors.push(error);}
  if(primary!==undefined||errors.length){const index=cleanups.indexOf(removeDirectory);if(index!==-1)cleanups.splice(index,1);}
  failFixture(primary,errors,`Persistence fixture failed; retained on failure: ${directory}; ${diagnostics()}`);
},15_000);
it.each(['drip', 'timeout'] as const)('app.close stops %s work and persists a restartable record', async scenario => {
  const { directory, mock, base } = await setup(scenario);
  const { app, service } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: scenario === 'timeout' ? 60_000 : 1, downloadTimeoutMs: 60_000 });
  cleanups.push(() => app.close());
  let downloading = false;
  mock.server.on('request', request => { if (request.url === '/output/model.glb') downloading = true; });
  const asset = await service.importTask('123');
  await vi.waitFor(async () => {
    if (scenario === 'drip') expect(downloading).toBe(true);
    else expect((await mock.inject('/__stats')).json().gets).toBeGreaterThan(0);
  });
  const start = Date.now();
  await app.close();
  expect(Date.now() - start).toBeLessThan(2000);
  const stored = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))[0];
  expect(stored).toMatchObject({ id: asset.id, status: 'polling', error: { code: 'SERVICE_STOPPED' } });
  expect((await mock.inject('/__stats')).json().creates).toBe(0);
  if (scenario === 'drip') expect(await readdir(join(directory, '123'))).toEqual([]);
  const { mock: resumedMock, baseUrl: resumedBase } = await listenForFetch(() => createMockServer());
  cleanups.push(() => resumedMock.close());
  const resumed = new AssetService({ directory, client: new Lux3DClient({ base: resumedBase, key: 'mock-only' }), pollMs: 1 });
  cleanups.push(() => resumed.close());
  await resumed.init(); await resumed.idle();
  expect(resumed.get(asset.id)?.status).toBe('ready');
  expect((await resumedMock.inject('/__stats')).json().creates).toBe(0);
});
it('rejects truncated mock output without publishing a model', async () => {
  const { directory, client } = await setup('truncated');
  const service = new AssetService({ directory, client, pollMs: 1 });
  cleanups.push(() => service.close()); await service.init();
  const asset = await service.importTask('123'); await service.idle();
  expect(service.get(asset.id)).toMatchObject({ status: 'failed', error: { code: 'INVALID_GLB' } });
  expect(await readdir(join(directory, '123'))).toEqual([]);
});
