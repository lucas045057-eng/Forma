import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,lstat,realpath,rm} from 'node:fs/promises';
import path from 'node:path';

export interface FixtureProcess {pid:number;parent:number;created:string;command:string}
const execute=promisify(execFile);
/** One asynchronous, filtered OS snapshot per ownership stage; never blocks the Vitest thread. */
export async function fixtureProcesses(pids:number[],parentPid?:number):Promise<FixtureProcess[]>{
 const values=[...new Set(pids)];for(const pid of [...values,...(parentPid===undefined?[]:[parentPid])])if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Invalid fixture PID query');
 const filters=values.map(pid=>`ProcessId=${pid}`);if(parentPid!==undefined)filters.push(`ParentProcessId=${parentPid}`);if(!filters.length)return [];
 const script=`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filters.join(' OR ')}' | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} })`;
 const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
 const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024,windowsHide:true});
 const value:unknown=JSON.parse(stdout.trim()||'[]');if(!Array.isArray(value))throw new Error('Fixture process snapshot was not an array');
 if(!value.every(item=>item&&Number.isSafeInteger(item.pid)&&Number.isSafeInteger(item.parent)&&typeof item.created==='string'&&Number.isFinite(Date.parse(item.created))))throw new Error('Invalid fixture process identity');return value.map(item=>({...item,command:typeof item.command==='string'?item.command:''})) as FixtureProcess[];
}
export function fixtureFailure(error:unknown):unknown{
 if(error instanceof AggregateError)return {name:error.name,message:error.message,stack:error.stack,errors:error.errors.map(fixtureFailure)};
 return error instanceof Error?{name:error.name,message:error.message,stack:error.stack,...('code'in error?{code:String(error.code)}:{}),...('signal'in error?{signal:String(error.signal)}:{}),...('stdout'in error?{stdout:String(error.stdout).slice(-16000)}:{}),...('stderr'in error?{stderr:String(error.stderr).slice(-16000)}:{})}:String(error);
}
export async function writeFixtureEvidence(base:string,folder:string,name:string,value:unknown){
 const directory=path.join(base,folder);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,name),JSON.stringify(value,null,2)+'\n');
}
export async function fixtureDirectoryIdentity(root:string){const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Fixture root is not a plain directory');return {canonical:await realpath(root),dev:info.dev,ino:info.ino};}
export async function removeFixtureDirectory(root:string,owner:Awaited<ReturnType<typeof fixtureDirectoryIdentity>>){
 const actual=await fixtureDirectoryIdentity(root);if(actual.canonical!==owner.canonical||actual.dev!==owner.dev||actual.ino!==owner.ino)throw new Error('Fixture directory ownership changed; retained');await rm(root,{recursive:true,force:true});
}
export function failFixture(primary:unknown,cleanup:unknown[],label:string){
 const errors=[...(primary===undefined?[]:[primary]),...cleanup];if(!errors.length)return;
 console.error(label,JSON.stringify({primary:primary===undefined?null:fixtureFailure(primary),cleanup:cleanup.map(fixtureFailure)}));
 throw new AggregateError(errors,label);
}
