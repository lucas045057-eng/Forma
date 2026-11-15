import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export function systemEnvironment(source=process.env){return Object.fromEntries(Object.entries(source).filter(([name])=>['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','TMPDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PNPM_HOME'].includes(name.toUpperCase())));}
export function templateNameAllowed(name){return /^[a-zA-Z0-9_.-]+$/.test(name)&&!name.startsWith('.')&&!['node_modules','dist','coverage'].includes(name)&&!/(?:^|\.)(?:env|pem|key|crt|p12|pfx|bak|tmp)(?:\.|$)/i.test(name);}
export function descendant(base,target){const relative=path.relative(path.resolve(base),path.resolve(target));return !!relative&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);}
export function assertMockEndpoint(value){let url;try{url=new URL(value);}catch{throw new Error('Mock endpoint invalid');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash)throw new Error('Mock endpoints must be explicit numeric loopback HTTP');return url.href;}
export function realEnvironment(source=process.env){
 const env=systemEnvironment(source);
 for(const name of ['DASHSCOPE_API_KEY','SPEECH_BASE_URL','SPEECH_MODEL','CODING_AGENT_BASE_URL','CODING_AGENT_API_KEY','CODING_AGENT_MODEL','LUX3D_BASE','LUX3D_API_KEY'])if(source[name])env[name]=source[name];
 env.SPEECH_MODEL=env.SPEECH_MODEL??'qwen3-asr-flash';
 if(!env.DASHSCOPE_API_KEY||!env.SPEECH_BASE_URL)throw new Error('Real mode requires operator-provided Aliyun speech environment; no env file is loaded');
 for(const name of ['CODING_AGENT_BASE_URL','LUX3D_BASE'])if(env[name]){let url;try{url=new URL(env[name]);}catch{throw new Error('Real provider configuration invalid');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Real provider endpoints must be HTTPS without embedded credentials');}
 return env;
}
