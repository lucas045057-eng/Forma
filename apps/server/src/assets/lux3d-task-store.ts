import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LuxOperation, LuxTask } from '@spatial/shared';
import { writeAtomic } from './atomic-file.ts';
import {assertPlainPath,readPlainFile} from '../checks/paths.ts';

interface TaskState {tasks:LuxTask[]}
type PersistedLuxTask = LuxTask & {keyHash?: string};
const operations:LuxOperation[]=['image-to-3d','text-to-3d','image','four-view','material-transfer','part-split','export','articulation-animation','humanoid-rig','animation-retarget'];
export class LuxTaskStore {
  private tasks:PersistedLuxTask[]=[];
  private writes=Promise.resolve();
  private failure:unknown;
  private readonly directory:string;
  constructor(directory:string){this.directory=directory;}
  async init(){
    await assertPlainPath(this.directory,()=>new Error('任务存储不得包含链接'),true);await mkdir(this.directory,{recursive:true});
    try{
      const bytes=await readPlainFile(path.join(this.directory,'tasks.json'),16*1024*1024,()=>new Error('任务索引路径含链接'),()=>new Error('任务索引超过大小限制'));const value=JSON.parse(bytes.toString('utf8')) as TaskState;
      if(!Array.isArray(value.tasks)||value.tasks.some(task=>!task||typeof task.localId!=='string'||!/^[-a-f0-9]{36}$/.test(task.localId)||!operations.includes(task.operation)||!Array.isArray(task.artifacts)||task.artifacts.some(artifact=>!artifact||!/^(?:[a-f0-9]{64}|opt-[a-f0-9]{60})$/.test(artifact.id)||!['png','jpg','jpeg','webp','glb','zip','usdz','obj_zip','fbx_zip','fbx','ply','stl','3mf','bin'].includes(artifact.format)||!['image','model','archive'].includes(artifact.kind)||!/^[a-f0-9]{64}$/.test(artifact.sha256))||typeof task.parametersHash!=='string'))throw new Error();
      this.tasks=value.tasks;
      for(const task of this.tasks){
        if(task.stage==='uploading'){task.stage='cancelled';task.note='上次在提交生成前中断；没有发出创建请求，请用新的明确操作重新开始';task.updatedAt=new Date().toISOString();}
        else if(task.stage==='submitting'){task.stage='submit_unknown';task.error={code:'SUBMIT_UNCONFIRMED',message:'提交请求结果未确认；不会自动重新创建付费任务'};task.updatedAt=new Date().toISOString();}
      }
      await this.save();
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Lux3D任务索引损坏或不可读取');}
  }
  private save(){const next=this.writes.then(()=>writeAtomic(path.join(this.directory,'tasks.json'),JSON.stringify({tasks:this.tasks},null,2)));this.writes=next.catch(error=>{this.failure??=error;});return next;}
  async idle(){await this.writes;if(this.failure)throw this.failure;}
  list(){return this.tasks.map(task=>structuredClone(task));}
  get(id:string){const task=this.tasks.find(item=>item.localId===id);return task?structuredClone(task):undefined;}
  findKey(keyHash:string){const task=this.tasks.find(item=>item.keyHash===keyHash);return task?structuredClone(task):undefined;}
  async update(task:LuxTask){const index=this.tasks.findIndex(item=>item.localId===task.localId);if(index<0)this.tasks.push(structuredClone(task));else this.tasks[index]=structuredClone(task);await this.save();return structuredClone(task);}
}
