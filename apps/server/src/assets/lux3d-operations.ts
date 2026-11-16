import { createHash } from 'node:crypto';
import type { LuxCapabilities, LuxOperation } from '@spatial/shared';
import { AssetError } from './lux3d.ts';

export type LuxParameters = Record<string, unknown>;
export const ANIMATION_IDS = ['A_TPose','Dance_Loop','Idle_Rail_Call','Idle_TalkingPhone_Loop','Idle_Talking_Loop','Yes','Crouch_Idle_Loop','Idle_FoldArms_Loop','Idle_Lantern_Loop','Idle_Loop','Idle_No_Loop','Idle_Rail_Loop','Idle_Torch_Loop','ClimbUp_1m','Crouch_Fwd_Loop','Jog_Fwd_Loop','Sprint_Loop','Swim_Fwd_Loop','Swim_Idle_Loop','Walk_Formal_Loop','Walk_Loop','Jump_Land','Jump_Loop','Jump_Start','NinjaJump_Idle_Loop','NinjaJump_Land','NinjaJump_Start','Roll','Slide_Exit','Slide_Loop','Slide_Start','Sword_Attack','Sword_Block','Sword_Dash','Sword_Heavy_Combo','Sword_Idle','Sword_Regular_A','Sword_Regular_A_Rec','Sword_Regular_B','Sword_Regular_B_Rec','Sword_Regular_C','Sword_Regular_Combo','Idle_Shield_Break','Idle_Shield_Loop','Shield_Dash','Shield_OneShot','Melee_Hook','Melee_Hook_Rec','Punch_Cross','Punch_Jab','Pistol_Aim_Down','Pistol_Aim_Neutral','Pistol_Aim_Up','Pistol_Idle_Loop','Pistol_Reload','Pistol_Shoot','Spell_Simple_Enter','Spell_Simple_Exit','Spell_Simple_Idle_Loop','Spell_Simple_Shoot','Chest_Open','Consume','Driving_Loop','Farm_Harvest','Farm_PlantSeed','Farm_Watering','Fixing_Kneeling','Interact','OverhandThrow','PickUp_Table','Push_Loop','TreeChopping_Loop','Walk_Carry_Loop','LayToIdle','Sitting_Enter','Sitting_Exit','Sitting_Idle_Loop','Sitting_Talking_Loop','Death01','Hit_Chest','Hit_Head','Hit_Knockback','Zombie_Idle_Loop','Zombie_Scratch','Zombie_Walk_Fwd_Loop'] as const;

export const LUX_OPERATION_ROUTES: Record<LuxOperation,string> = {
  'image-to-3d':'/lux3d/v1/generate/img-to-3d/task/create',
  'text-to-3d':'/lux3d/v1/generate/text-to-3d/task/create',
  image:'/lux3d/v1/generate/multimodal-to-image/task/create',
  'four-view':'/lux3d/v1/generate/image-to-four-view/task/create',
  'material-transfer':'/lux3d/v1/generate/material-transfer/task/create',
  'part-split':'/lux3d/v1/part-split/task/create',
  export:'/lux3d/v1/multi-format-export/task/create',
  'articulation-animation':'/lux3d/v1/articulation-animation/task/create',
  'humanoid-rig':'/lux3d/v1/animations/rig/task/create',
  'animation-retarget':'/lux3d/v1/animations/retarget/task/create',
};
export const LUX_OPERATION_LABELS: Record<LuxOperation,{label:string;description:string}> = {
  'image-to-3d':{label:'图生 3D',description:'1–32张有序图片，G1/G1-Turbo与输出高级选项'},
  'text-to-3d':{label:'文生 3D',description:'文字、风格、可选参考图及输出选项'},
  image:{label:'多模态生图',description:'描述和/或单张参考图，结果可继续建模'},
  'four-view':{label:'四视图',description:'按前斜、后斜、侧面、背面顺序生成'},
  'material-transfer':{label:'材质迁移',description:'已有GLB＋材质参考图，原模型保留'},
  'part-split':{label:'部件拆分',description:'处理GLB结构，不猜节点语义'},
  export:{label:'多格式导出',description:'GLB或Lux3D ZIP，支持USDZ/OBJ/FBX/STL/3MF'},
  'articulation-animation':{label:'关节化与动画',description:'GLB＋运动提示，保留动画结果'},
  'humanoid-rig':{label:'数字人绑骨',description:'已有数字人GLB自动绑骨'},
  'animation-retarget':{label:'动画重定向',description:'已绑骨GLB＋规范动作，可拆分或合并输出'},
};

function object(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetError('INVALID_OPERATION_INPUT','参数必须是JSON对象');
  return value as Record<string,unknown>;
}
function only(input: Record<string,unknown>, names: string[]) {
  const extra=Object.keys(input).filter(key=>!names.includes(key));
  if(extra.length)throw new AssetError('INVALID_OPERATION_INPUT',`不支持的参数：${extra.join('、')}`);
}
function text(value:unknown,name:string,max=4000):string {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new AssetError('INVALID_OPERATION_INPUT',`${name}必须为1–${max}字符的非空字符串`);
  return value.trim();
}
function upload(value:unknown,name:string):string {
  if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new AssetError('INVALID_UPLOAD_REFERENCE',`${name}必须引用本站上传文件`);
  return value;
}
function uploads(value:unknown,name:string,max=1):string[] {
  if(!Array.isArray(value)||value.length<1||value.length>max||new Set(value).size!==value.length)throw new AssetError('INVALID_UPLOAD_REFERENCE',`${name}需按顺序提供1–${max}个不同上传文件`);
  return value.map(item=>upload(item,name));
}
function bool(value:unknown,name:string):boolean|undefined {
  if(value!==undefined&&typeof value!=='boolean')throw new AssetError('INVALID_OPERATION_INPUT',`${name}必须是布尔值`);
  return value as boolean|undefined;
}
function enums<T extends string>(value:unknown,name:string,values:readonly T[],fallback?:T):T|undefined {
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!values.includes(value as T))throw new AssetError('INVALID_OPERATION_INPUT',`${name}不是受支持的选项`);
  return value as T;
}
function formats(value:unknown,allowed:readonly string[]):string[] {
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!allowed.includes(item))||new Set(value).size!==value.length)throw new AssetError('INVALID_OPERATION_INPUT','输出格式不受支持或重复');
  return value as string[];
}
function face(value:unknown):number|undefined {
  if(value===undefined)return;
  if(!Number.isInteger(value)||Number(value)<10000||Number(value)>300000)throw new AssetError('INVALID_OPERATION_INPUT','目标面数须为10000–300000的整数');
  return Number(value);
}
function generation(input:Record<string,unknown>,textRequired:boolean){
  only(input,['prompt','style','imageUploadId','imageUploadIds','version','faceCount','outputFormat','enablePbr','aiPredictSize']);
  const images=input.imageUploadIds!==undefined?uploads(input.imageUploadIds,'imageUploadIds',32):input.imageUploadId!==undefined?uploads([input.imageUploadId],'imageUploadId'):undefined;
  if(input.imageUploadIds!==undefined&&input.imageUploadId!==undefined)throw new AssetError('INVALID_OPERATION_INPUT','单图与多图引用不能同时提供');
  if(textRequired&&images&&images.length>1)throw new AssetError('INVALID_OPERATION_INPUT','文生3D最多一张参考图');
  if(!textRequired&&(input.prompt!==undefined||input.style!==undefined))throw new AssetError('INVALID_OPERATION_INPUT','图生3D不支持prompt或style字段');
  const prompt=textRequired?text(input.prompt,'描述'):input.prompt===undefined?undefined:text(input.prompt,'描述');
  if(!prompt&&!images)throw new AssetError('INVALID_OPERATION_INPUT','至少提供描述或参考图片');
  return {prompt,images,style:enums(input.style,'风格',['photorealistic','cartoon','anime','hand_painted','cyberpunk','fantasy','glass']),version:enums(input.version,'版本',['G1','G1-Turbo'],'G1'),faceCount:face(input.faceCount),outputFormat:input.outputFormat===undefined?['glb']:formats(input.outputFormat,['zip','glb','ply']),enablePbr:bool(input.enablePbr,'PBR'),aiPredictSize:bool(input.aiPredictSize,'AI尺寸预测')};
}
function modelOnly(input:Record<string,unknown>){
  only(input,['modelUploadId']);return {modelUploadId:upload(input.modelUploadId,'modelUploadId')};
}
export function normalizeLuxParameters(operation:LuxOperation,value:unknown):LuxParameters {
  const input=object(value);
  if(operation==='image-to-3d'||operation==='text-to-3d'){
    if(!input.imageUploadId&&!input.imageUploadIds&&operation==='image-to-3d')throw new AssetError('INVALID_OPERATION_INPUT','图生3D需要图片');
    return generation(input,operation==='text-to-3d');
  }
  if(operation==='image'||operation==='four-view'){
    only(input,['prompt','imageUploadId']);const prompt=input.prompt===undefined?undefined:text(input.prompt,'描述');
    const image=input.imageUploadId===undefined?undefined:upload(input.imageUploadId,'imageUploadId');
    if(!prompt&&!image)throw new AssetError('INVALID_OPERATION_INPUT','至少提供描述或参考图片');
    return {prompt,imageUploadId:image};
  }
  if(operation==='material-transfer'){
    only(input,['modelUploadId','imageUploadId','version','outputFormat','aiPredictSize','customSize']);
    const size=input.customSize;
    if(size!==undefined&&(typeof size!=='number'||!Number.isFinite(size)||size<=0||size>1_000_000))throw new AssetError('INVALID_OPERATION_INPUT','customSize必须为正的目标高度（毫米）');
    return {modelUploadId:upload(input.modelUploadId,'modelUploadId'),imageUploadId:upload(input.imageUploadId,'imageUploadId'),version:enums(input.version,'材质版本',['v3.0-standard'],'v3.0-standard'),outputFormat:input.outputFormat===undefined?['zip','glb']:formats(input.outputFormat,['zip','glb','usdz','obj_zip','fbx_zip']),aiPredictSize:bool(input.aiPredictSize,'AI尺寸预测'),customSize:size};
  }
  if(operation==='part-split'||operation==='humanoid-rig')return modelOnly(input);
  if(operation==='export'){
    only(input,['modelUploadId','outputFormat']);
    const output=input.outputFormat===undefined?[]:formats(input.outputFormat,['usdz','obj_zip','fbx_zip','stl','3mf']);
    return {modelUploadId:upload(input.modelUploadId,'modelUploadId'),outputFormat:output};
  }
  if(operation==='articulation-animation'){
    only(input,['modelUploadId','prompt']);return {modelUploadId:upload(input.modelUploadId,'modelUploadId'),prompt:text(input.prompt,'动作描述')};
  }
  if(operation==='animation-retarget'){
    only(input,['modelUploadId','animationIds','animationOutputMode','outFormat','animateInPlace']);
    const ids=formats(input.animationIds,ANIMATION_IDS);
    if(ids.length<1||ids.length>10)throw new AssetError('INVALID_OPERATION_INPUT','请选择1–10个动作ID');
    return {modelUploadId:upload(input.modelUploadId,'modelUploadId'),animationIds:ids,animationOutputMode:enums(input.animationOutputMode,'动作输出方式',['separate','combined'],'separate'),outFormat:enums(input.outFormat,'输出格式',['glb','fbx'],'glb'),animateInPlace:bool(input.animateInPlace,'原地动画')??false};
  }
  throw new AssetError('UNKNOWN_OPERATION','未知的Lux3D操作');
}

export function luxInputRefs(operation:LuxOperation,parameters:LuxParameters):string[] {
  if(operation==='image-to-3d'||operation==='text-to-3d')return [...(parameters.images as string[]|undefined??[])];
  return ['modelUploadId','imageUploadId'].map(key=>parameters[key] as string|undefined).filter((value):value is string=>typeof value==='string');
}
export function luxParametersFingerprint(operation:LuxOperation,parameters:LuxParameters):string {
  return createHash('sha256').update(JSON.stringify({operation,parameters})).digest('hex');
}
export function providerBody(operation:LuxOperation,parameters:LuxParameters,urls:ReadonlyMap<string,string>):Record<string,unknown>{
  const ref=(id:string)=>{const url=urls.get(id);if(!url)throw new AssetError('UPLOAD_NOT_PUBLISHED','上传尚未发布，不能创建任务');return url;};
  if(operation==='image-to-3d'||operation==='text-to-3d'){
    const images=((parameters.images as string[]|undefined)??[]).map(ref);
    return {...(parameters.prompt?{prompt:parameters.prompt}:{}),...(parameters.style?{style:parameters.style}:{}),
      ...(images.length===1?{img:images[0]}:images.length>1?{imgs:images,version:parameters.version}:{}),...(parameters.version?{version:parameters.version}:{}),
      ...(parameters.faceCount?{faceCount:parameters.faceCount}:{}),outputFormat:parameters.outputFormat,
      ...(parameters.enablePbr!==undefined?{enablePbr:parameters.enablePbr}:{}),...(parameters.aiPredictSize!==undefined?{aiPredictSize:parameters.aiPredictSize}:{}),
      };
  }
  if(operation==='image'||operation==='four-view')return {...(parameters.prompt?{prompt:parameters.prompt}:{}),...(parameters.imageUploadId?{img:ref(parameters.imageUploadId as string)}:{})};
  if(operation==='material-transfer')return {img:ref(parameters.imageUploadId as string),meshUrl:ref(parameters.modelUploadId as string),version:parameters.version,outputFormat:parameters.outputFormat,...(parameters.aiPredictSize!==undefined?{aiPredictSize:parameters.aiPredictSize}:{}),...(parameters.customSize!==undefined?{customSize:parameters.customSize}:{})};
  if(operation==='part-split')return {glbUrl:ref(parameters.modelUploadId as string)};
  if(operation==='export')return {modelUrl:ref(parameters.modelUploadId as string),outputFormat:parameters.outputFormat};
  if(operation==='articulation-animation')return {glbUrl:ref(parameters.modelUploadId as string),prompt:parameters.prompt};
  if(operation==='humanoid-rig')return {modelUrl:ref(parameters.modelUploadId as string)};
  return {rigModelUrl:ref(parameters.modelUploadId as string),animationIds:parameters.animationIds,animationOutputMode:parameters.animationOutputMode,outFormat:parameters.outFormat,animateInPlace:parameters.animateInPlace};
}
export function luxCapabilities(configured:boolean,gateway:{active:string;legacy:boolean}={active:'api.aholo.cn',legacy:false}):LuxCapabilities {
  return {
    gateway:'api.aholo.cn',activeGateway:gateway.active,legacyGateway:gateway.legacy,configured,
    billingNotice:'生成、材质/动画处理和部分导出可能按你的Lux3D账户计费，以平台为准；只有点击本次创建按钮才会把输入上传到云端并提交一次，不自动重发结果未知的任务。上传会产生可公开访问的资源链接，工作台目前不提供云端删除。',
    operations:Object.entries(LUX_OPERATION_LABELS).map(([operation,info])=>({operation:operation as LuxOperation,...info})),
    upload:{imageMaxBytes:10*1024*1024,modelMaxBytes:100*1024*1024,maxImages:32,maxImagePixels:40_960_000},
    limits:{activeLocalTasks:2,maxImages:32,maxActions:10},
  };
}
