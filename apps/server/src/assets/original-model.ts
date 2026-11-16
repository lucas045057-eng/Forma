import { Document, NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { ModelMetrics } from '@spatial/shared';
import { groupParts } from './parts.ts';
import {MeshoptDecoder} from 'meshoptimizer';
import {validateGlb} from './lux3d-upload.ts';

/** Read-only metrics: original rigs, skins and animation tracks are never transformed away. */
export async function inspectOriginalModel(bytes:Buffer):Promise<ModelMetrics>{
  if(bytes.length<20||bytes.toString('ascii',0,4)!=='glTF'||bytes.readUInt32LE(4)!==2||bytes.readUInt32LE(8)!==bytes.length||bytes.readUInt32LE(16)!==0x4e4f534a)throw new Error('Invalid GLB');
  validateGlb(bytes);await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});const document=await io.readBinary(bytes);
  const positions=new Set(document.getRoot().listMeshes().flatMap(mesh=>mesh.listPrimitives().map(primitive=>primitive.getAttribute('POSITION'))));
  const vertices=[...positions].reduce((sum,accessor)=>sum+(accessor?.getCount()??0),0);
  if(!vertices||!document.getRoot().listScenes().length)throw new Error('Model has no scene geometry');
  const bounds=document.getRoot().listScenes().map(scene=>getBounds(scene));
  const box={min:[0,1,2].map(axis=>Math.min(...bounds.map(value=>value.min[axis]!))),max:[0,1,2].map(axis=>Math.max(...bounds.map(value=>value.max[axis]!)))};
  return {before:{bytes:bytes.length,vertices},after:{bytes:bytes.length,vertices},webReady:bytes.length<=3_000_000&&vertices<=100_000,parts:groupParts(document,document.getRoot().listNodes()),durationMs:0,bounds:box};
}
