import {describe,it,expect} from 'vitest';
import {LUX_OPERATION_ROUTES,normalizeLuxParameters,providerBody,ANIMATION_IDS,luxParametersFingerprint} from './lux3d-operations.ts';
import {parseProviderJson} from './provider-json.ts';
import type {LuxOperation} from '@spatial/shared';
const image='a'.repeat(64),model='b'.repeat(64),url='https://qhstaticssl.kujiale.com/image.png',glb='https://qhstaticssl.kujiale.com/model.glb';
const refs=new Map([[image,url],[model,glb]]);
const cases:Array<[LuxOperation,Record<string,unknown>,Record<string,unknown>]>=[
 ['image-to-3d',{imageUploadIds:[image],version:'G1-Turbo',outputFormat:['glb'],faceCount:10000},{img:url,version:'G1-Turbo',outputFormat:['glb'],faceCount:10000}],
 ['text-to-3d',{prompt:'wood chair',imageUploadId:image,style:'glass'},{prompt:'wood chair',img:url,style:'glass',version:'G1',outputFormat:['glb']}],
 ['image',{prompt:'chair'},{prompt:'chair'}],['four-view',{imageUploadId:image},{img:url}],
 ['material-transfer',{modelUploadId:model,imageUploadId:image,version:'v3.0-standard'},{meshUrl:glb,img:url,version:'v3.0-standard',outputFormat:['zip','glb']}],
 ['part-split',{modelUploadId:model},{glbUrl:glb}],['export',{modelUploadId:model,outputFormat:['3mf','stl']},{modelUrl:glb,outputFormat:['3mf','stl']}],
 ['articulation-animation',{modelUploadId:model,prompt:'open lid'},{glbUrl:glb,prompt:'open lid'}],
 ['humanoid-rig',{modelUploadId:model},{modelUrl:glb}],
 ['animation-retarget',{modelUploadId:model,animationIds:['Idle_Loop'],animationOutputMode:'combined',outFormat:'fbx',animateInPlace:true},{rigModelUrl:glb,animationIds:['Idle_Loop'],animationOutputMode:'combined',outFormat:'fbx',animateInPlace:true}],
];
describe('official ten-operation request boundaries',()=>{
 for(const [operation,input,expected]of cases)it(operation+' maps its own required fields',()=>{expect(providerBody(operation,normalizeLuxParameters(operation,input),refs)).toMatchObject(expected);expect(LUX_OPERATION_ROUTES[operation]).toContain('/task/create');});
 it('keeps ordered multi-image inputs and rejects mixed single/multi fields',()=>{const second='c'.repeat(64);const parameters=normalizeLuxParameters('image-to-3d',{imageUploadIds:[image,second],version:'G1'});expect(providerBody('image-to-3d',parameters,new Map([...refs,[second,'https://qhstaticssl.kujiale.com/second.png']]))).toMatchObject({imgs:[url,'https://qhstaticssl.kujiale.com/second.png']});expect(()=>normalizeLuxParameters('image-to-3d',{imageUploadId:image,imageUploadIds:[image]})).toThrow();});
 it('text-only never sends empty imgs and multi-image text is rejected',()=>{expect(providerBody('text-to-3d',normalizeLuxParameters('text-to-3d',{prompt:'chair'}),refs)).not.toHaveProperty('imgs');expect(()=>normalizeLuxParameters('text-to-3d',{prompt:'chair',imageUploadIds:[image,model]})).toThrow();});
 it('rejects client URLs, unsupported fields, output aliases and duplicate actions',()=>{for(const input of [{imageUploadId:'https://example.invalid/file.png'},{imageUploadId:image,glbUrl:'x'},{imageUploadId:image,faceCount:9999},{imageUploadId:image,version:'G2'}])expect(()=>normalizeLuxParameters('image-to-3d',input)).toThrow();expect(()=>normalizeLuxParameters('export',{modelUploadId:model,outputFormat:['glb']})).toThrow();expect(()=>normalizeLuxParameters('animation-retarget',{modelUploadId:model,animationIds:['Idle_Loop','Idle_Loop']})).toThrow();expect(()=>normalizeLuxParameters('animation-retarget',{modelUploadId:model,animationIds:['made-up']})).toThrow();});
 it('normalizes key order while preserving list order in fingerprints',()=>{const first=normalizeLuxParameters('image',{prompt:'chair',imageUploadId:image});const second=normalizeLuxParameters('image',{imageUploadId:image,prompt:'chair'});expect(luxParametersFingerprint('image',first)).toBe(luxParametersFingerprint('image',second));expect(ANIMATION_IDS).toContain('Zombie_Walk_Fwd_Loop');});
});
describe('lossless provider IDs',()=>{
 it('preserves int64 before floating point rounding and leaves strings untouched',()=>{expect(parseProviderJson('{"c":"0","d":9223372036854775807,"text":"1234567890123456789","status":3}')).toEqual({c:'0',d:'9223372036854775807',text:'1234567890123456789',status:3});});
 it('does not corrupt escaped quotes or exponent syntax',()=>{expect(parseProviderJson('{"text":"a\\\"9223372036854775807","value":1.25e2}')).toMatchObject({value:125});expect(()=>parseProviderJson('{"d":bad}')).toThrow();});
});
