import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Readable } from 'node:stream';
import { AssetError } from './lux3d.ts';
import { assertPlainPath, readPlainFile } from '../checks/paths.ts';
import { writeAtomic } from './atomic-file.ts';

export type UploadKind = 'image' | 'glb' | 'lux-zip';
export interface UploadRecord {
  id: string;
  kind: UploadKind;
  filename: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  createdAt: string;
  rigged?: boolean;
  providerUrl?: string;
  providerUrlExpiresAt?: string;
}
interface UploadIndex { uploads: UploadRecord[] }
const IMAGE_MAX=10*1024*1024,MODEL_MAX=100*1024*1024,PIXEL_MAX=40_960_000;
function publicRecord(record:UploadRecord):UploadRecord { const {...safe}=record;return safe; }
function validateName(value:unknown):string {
  if(typeof value!=='string'||value.length<1||value.length>160||/[\u0000-\u001f\u007f/\\]/.test(value))throw new AssetError('INVALID_UPLOAD_NAME','文件名无效');
  return value;
}
export function validateGlb(bytes:Buffer):void {
  if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a||bytes.readUInt32LE(12)>bytes.length-20)throw new AssetError('INVALID_GLB','上传不是完整的GLB2.0文件');
  let json:{asset?:unknown;buffers?:Array<{uri?:unknown}>;images?:Array<{uri?:unknown}>};
  try{json=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));}catch{throw new AssetError('INVALID_GLB','GLB JSON块损坏');}
  if(!json||typeof json!=='object'||!json.asset||typeof json.asset!=='object')throw new AssetError('INVALID_GLB','GLB缺少asset元数据');
  if((json.buffers!==undefined&&!Array.isArray(json.buffers))||(json.images!==undefined&&!Array.isArray(json.images)))throw new AssetError('INVALID_GLB','GLB资源列表无效');
  for(const resource of [...(json.buffers??[]),...(json.images??[])]){if(!resource||typeof resource!=='object')throw new AssetError('INVALID_GLB','GLB资源描述无效');if(resource.uri!==undefined&&(typeof resource.uri!=='string'||!resource.uri.startsWith('data:')))throw new AssetError('EXTERNAL_GLTF_RESOURCE','GLB不得引用外部资源');}
  const chunks=[];let offset=12;while(offset+8<=bytes.length){const length=bytes.readUInt32LE(offset);offset+=8+length;chunks.push(offset);}if(offset!==bytes.length)throw new AssetError('INVALID_GLB','GLB分块长度不一致');
}
export class LuxUploadStore {
  private records:UploadRecord[]=[];
  private writes=Promise.resolve();
  private writeFailure:unknown;
  private readonly directory:string;
  constructor(directory:string){this.directory=path.join(directory,'lux-uploads');}
  async init(){
    await assertPlainPath(this.directory,()=>new AssetError('UPLOAD_PATH_DENIED','上传存储不得包含链接'),true);await mkdir(this.directory,{recursive:true});
    try{const parsed=JSON.parse(await readFile(path.join(this.directory,'index.json'),'utf8')) as UploadIndex;if(!Array.isArray(parsed.uploads)||parsed.uploads.some(item=>typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id)))throw new Error();this.records=parsed.uploads;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('无法读取上传索引');}
  }
  private save(){const next=this.writes.then(()=>writeAtomic(path.join(this.directory,'index.json'),JSON.stringify({uploads:this.records},null,2)));this.writes=next.catch(error=>{this.writeFailure??=error;});return next;}
  get(id:string){const record=this.records.find(item=>item.id===id);return record?publicRecord(record):undefined;}
  list(){return this.records.map(publicRecord);}
  filePath(id:string){const record=this.records.find(item=>item.id===id);if(!record)throw new AssetError('UPLOAD_NOT_FOUND','上传文件不存在');return path.join(this.directory,`${id}.${record.kind==='glb'?'glb':record.kind==='lux-zip'?'zip':'img'}`);}
  async bytes(id:string,signal?:AbortSignal){const bytes=await readPlainFile(this.filePath(id),MODEL_MAX,()=>new AssetError('UPLOAD_PATH_DENIED','上传路径未通过检查'),()=>new AssetError('UPLOAD_TOO_LARGE','上传超过大小限制'),signal);if(createHash('sha256').update(bytes).digest('hex')!==this.get(id)?.sha256)throw new AssetError('UPLOAD_CHANGED','上传文件字节已变化，请重新选择文件',409);return bytes;}
  async receive(input:{filename:unknown;kind:unknown;stream:Readable;contentLength?:number;signal?:AbortSignal}):Promise<UploadRecord>{
    const filename=validateName(input.filename),kind=input.kind;
    if(kind!=='image'&&kind!=='glb')throw new AssetError('INVALID_UPLOAD_KIND','只接受PNG/JPEG/WebP图片或GLB模型');
    const max=kind==='image'?IMAGE_MAX:MODEL_MAX;
    if(input.contentLength!==undefined&&(!Number.isSafeInteger(input.contentLength)||input.contentLength<1||input.contentLength>max))throw new AssetError('UPLOAD_TOO_LARGE','上传为空或超过大小限制');
    const chunks:Buffer[]=[];let size=0;
    try{
      for await(const chunk of input.stream){input.signal?.throwIfAborted();const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);size+=bytes.length;if(size>max)throw new AssetError('UPLOAD_TOO_LARGE',kind==='image'?'图片超过10MiB限制':'GLB超过100MiB限制');chunks.push(bytes);}
    }catch(error){input.stream.destroy();throw error;}
    if(!size)throw new AssetError('EMPTY_UPLOAD','不能上传空文件');
    if(this.records.length>=500||this.records.reduce((sum,item)=>sum+item.bytes,0)+size>1024*1024*1024)throw new AssetError('UPLOAD_QUOTA','本地上传总量已达1GiB或500份限制，请由操作者管理历史');
    const bytes=Buffer.concat(chunks,size);
    let dimensions:{width?:number;height?:number}={};
    if(kind==='image'){
      let metadata:sharp.Metadata;
      try{metadata=await sharp(bytes,{limitInputPixels:PIXEL_MAX}).metadata();}catch{throw new AssetError('INVALID_IMAGE','图片必须是实际PNG/JPEG/WebP，不能按扩展名或MIME放行');}
      if(!metadata.format||!['png','jpeg','webp'].includes(metadata.format)||!metadata.width||!metadata.height||metadata.width*metadata.height>PIXEL_MAX||(metadata.pages??1)>1)throw new AssetError('INVALID_IMAGE','仅支持PNG/JPEG/WebP，像素总量不得超过4096万');
      try{await sharp(bytes,{limitInputPixels:PIXEL_MAX}).rotate().toBuffer();}catch{throw new AssetError('INVALID_IMAGE','图片解码失败或内容异常');}
      dimensions={width:metadata.width,height:metadata.height};
    }else{validateGlb(bytes);try{const {inspectOriginalModel}=await import('./original-model.ts');await inspectOriginalModel(bytes);}catch{throw new AssetError('INVALID_GLB','GLB未通过本地场景与几何解码校验');}}
    const gltf=kind==='glb'?JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12))) as {skins?:unknown[]}:undefined;
    const id=createHash('sha256').update(randomUUID()).update(bytes).digest('hex');
    const record:UploadRecord={id,kind,filename,bytes:size,sha256:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString(),...(gltf?{rigged:!!gltf.skins?.length}:{}),...dimensions};
    const target=path.join(this.directory,`${id}.${kind==='glb'?'glb':'img'}`);
    await assertPlainPath(target,()=>new AssetError('UPLOAD_PATH_DENIED','上传目录不得包含链接'),true);
    await writeAtomic(target,bytes,input.signal);this.records.push(record);
    try{await this.save();}catch(error){this.records=this.records.filter(item=>item.id!==id);throw error;}
    return publicRecord(record);
  }
  fresh(record:UploadRecord):boolean{
    return !!record.providerUrl&&!!record.providerUrlExpiresAt&&Date.parse(record.providerUrlExpiresAt)>Date.now()+60_000;
  }
  async registerPublished(id:string,url:string):Promise<UploadRecord>{
    const record=this.records.find(item=>item.id===id);if(!record)throw new AssetError('UPLOAD_NOT_FOUND','上传文件不存在');
    if(record.providerUrl&&record.providerUrl!==url&&this.fresh(record))throw new AssetError('UPLOAD_PUBLISH_CONFLICT','同一上传已绑定不同且仍有效的云端地址',409);
    record.providerUrl=url;record.providerUrlExpiresAt=new Date(Date.now()+105*60_000).toISOString();await this.save();
    return publicRecord(record);
  }
  async close(){await this.writes;if(this.writeFailure)throw this.writeFailure;}
  async addLocalArtifact(input:{bytes:Buffer;filename:string;kind:UploadKind}):Promise<UploadRecord>{
    if(input.bytes.length>(input.kind==='image'?IMAGE_MAX:MODEL_MAX))throw new AssetError('UPLOAD_TOO_LARGE','产物超过对应输入大小限制');
    if(this.records.length>=500||this.records.reduce((sum,item)=>sum+item.bytes,0)+input.bytes.length>1024*1024*1024)throw new AssetError('UPLOAD_QUOTA','本地上传总量达到限制');
    if(input.kind==='glb')validateGlb(input.bytes);else if(input.kind==='image')await sharp(input.bytes,{limitInputPixels:PIXEL_MAX}).metadata();else if(input.bytes[0]!==0x50||input.bytes[1]!==0x4b)throw new AssetError('INVALID_ARCHIVE','云端ZIP结果无效');
    const id=createHash('sha256').update(randomUUID()).update(input.bytes).digest('hex');const record:UploadRecord={id,kind:input.kind,filename:validateName(input.filename),bytes:input.bytes.length,sha256:createHash('sha256').update(input.bytes).digest('hex'),createdAt:new Date().toISOString()};
    if(input.kind==='glb'){const gltf=JSON.parse(input.bytes.toString('utf8',20,20+input.bytes.readUInt32LE(12))) as {skins?:unknown[]};record.rigged=!!gltf.skins?.length;}
    await writeAtomic(path.join(this.directory,`${id}.${input.kind==='glb'?'glb':input.kind==='lux-zip'?'zip':'img'}`),input.bytes);this.records.push(record);await this.save();return publicRecord(record);
  }
}
