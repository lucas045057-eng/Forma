import type {AssetProvenance,ModelProvenance} from '@spatial/shared';
const hash=/^[a-f0-9]{64}$/;
const preset=/^[a-z0-9_-]{1,80}$/;
export function parseProvenance(value:unknown):ModelProvenance|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const item=value as Record<string,unknown>;
 if(item.schemaVersion!==1||!['fallback','lux3d','unknown'].includes(String(item.kind))||Object.keys(item).some(key=>!['schemaVersion','kind','presetId','sourceTaskId','sourceHash','outputHash','importedAt','note'].includes(key)))return;
 if(typeof item.outputHash!=='string'||!hash.test(item.outputHash))return;
 if(item.sourceHash!==undefined&&(typeof item.sourceHash!=='string'||!hash.test(item.sourceHash)))return;
 if(item.presetId!==undefined&&(typeof item.presetId!=='string'||!preset.test(item.presetId)))return;
 if(item.sourceTaskId!==undefined&&(typeof item.sourceTaskId!=='string'||!/^\d{1,20}$/.test(item.sourceTaskId)))return;
 if(item.importedAt!==undefined&&(typeof item.importedAt!=='string'||item.importedAt.length>40||!Number.isFinite(Date.parse(item.importedAt))))return;
 if(item.note!==undefined&&!['预先生成的Lux3D备用模型，时间未记录','备用资产，预先生成；时间未记录'].includes(String(item.note)))return;
 if(item.kind==='fallback'&&(!item.presetId||!item.sourceHash))return;
 if(item.kind==='lux3d'&&!item.sourceTaskId)return;
 return {schemaVersion:1,kind:item.kind as ModelProvenance['kind'],outputHash:item.outputHash,
  ...(item.presetId?{presetId:String(item.presetId)}:{}),...(item.sourceTaskId?{sourceTaskId:String(item.sourceTaskId)}:{}),
  ...(item.sourceHash?{sourceHash:String(item.sourceHash)}:{}),...(item.importedAt?{importedAt:String(item.importedAt)}:{}),...(item.note?{note:String(item.note)}:{})};
}
export function cleanAssetProvenance(value:AssetProvenance|undefined):AssetProvenance{
 if(!value)return {kind:'unknown'};
 const parsed=parseProvenance({schemaVersion:1,...value});
 if(!parsed)return {kind:'unknown'};
 const {schemaVersion:_schema,note:_note,...provenance}=parsed;return provenance;
}
