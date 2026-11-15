import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readPlainFile} from '../checks/paths.ts';
import {AssetError} from './lux3d.ts';
export const FALLBACK_PRESETS = [
  {id:'diffuser-split',title:'木间香薰 · 分部件备用',file:'lux3d-split-4969889.glb',hash:'239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0'},
  {id:'diffuser-original',title:'木间香薰 · 原始备用',file:'lux3d-4969293.glb',hash:'7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7'},
  {id:'diffuser-alternate',title:'香薰 · 另一份备用',file:'lux3d-4969298.glb',hash:'09f9085858ace106b7dc5c7b9355320e5d05253a565eb01a73d670c1754ac9bf'},
] as const;
export const DEFAULT_FALLBACK_DIRECTORY=fileURLToPath(new URL('../../../../fallback/',import.meta.url));
export const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function readFallback(directory:string,presetId:string,signal?:AbortSignal,expectedDigests:Readonly<Record<string,string>>={}){
 const preset=FALLBACK_PRESETS.find(item=>item.id===presetId);
 if(!preset)throw new AssetError('UNKNOWN_PRESET','备用资产不存在');
 const binary=await readPlainFile(path.join(directory,preset.file),32*1024*1024,()=>new AssetError('FALLBACK_PATH_DENIED','备用目录或文件不得含链接'),()=>new AssetError('FALLBACK_TOO_LARGE','备用模型超过32MiB'),signal);
 if(binary.length<12||binary.toString('ascii',0,4)!=='glTF'||binary.readUInt32LE(4)!==2||binary.readUInt32LE(8)!==binary.length)throw new AssetError('INVALID_GLB','备用模型不是完整GLB文件');
 const sourceHash=sha256(binary);if(sourceHash!==(expectedDigests[preset.id]??preset.hash))throw new AssetError('FALLBACK_CHANGED','备用材料字节与固定目录记录不符');
 return {preset,binary,sourceHash};
}
