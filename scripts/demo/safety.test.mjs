import {test} from 'node:test';
import assert from 'node:assert/strict';
import {systemEnvironment,realEnvironment,assertMockEndpoint,descendant,templateNameAllowed,safeFailureCode} from './safety.mjs';
import './body.test.mjs';
import './frontend-watch-gate.test.mjs';
import './retained-response.test.mjs';
test('mock child environment drops injected loaders, proxies and real provider keys',()=>{
 const value=systemEnvironment({PATH:'local-tool-path',NODE_OPTIONS:'--require unsafe',HTTPS_PROXY:'http://invalid.example',DASHSCOPE_API_KEY:'fake-canary',CODING_AGENT_API_KEY:'fake-canary',LUX3D_API_KEY:'fake-canary'});assert.deepEqual(value,{PATH:'local-tool-path'});
});
test('mock endpoints never accept domains, private/public addresses, embedded credentials or URL parameters',()=>{
 for(const value of ['https://127.0.0.1:20001','http://localhost:20001','http://10.0.0.1:20001','https://dashscope.aliyuncs.com','http://user@127.0.0.1:20001','http://127.0.0.1:20001/?key=fake'])assert.throws(()=>assertMockEndpoint(value));assert.equal(new URL(assertMockEndpoint('http://127.0.0.1:20001/compatible-mode/v1')).hostname,'127.0.0.1');
});
test('real mode requires Aliyun operator config and never copies arbitrary env to the frontend envelope',()=>{
 assert.throws(()=>realEnvironment({PATH:'local'}),{code:'MISSING_REAL_SPEECH_CONFIG'});
 assert.throws(()=>realEnvironment({PATH:'local',DASHSCOPE_API_KEY:'secret-canary',SPEECH_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',LUX3D_BASE:'http://api.aholo.cn'}),err=>{
  assert.equal(safeFailureCode(err),'INVALID_LUX3D_BASE_URL');
  assert.equal(String(err.message).includes('secret-canary'),false);
  return true;
 });
 const source={PATH:'local',DASHSCOPE_API_KEY:'fake-only',SPEECH_BASE_URL:'https://dashscope.aliyuncs.com/compatible-mode/v1',SPEECH_MODEL:'qwen3-asr-flash',NODE_OPTIONS:'unsafe'};assert.equal(realEnvironment(source).DASHSCOPE_API_KEY,'fake-only');assert.equal(realEnvironment(source).NODE_OPTIONS,undefined);assert.equal(systemEnvironment(source).DASHSCOPE_API_KEY,undefined);
});
test('copy allowlist omits private/cache files and run paths must remain descendants',()=>{
 for(const name of ['.env','.env.local','config.env.local','key.pem','backup.bak','node_modules','.git','../outside'])assert.equal(templateNameAllowed(name),false,name);for(const name of ['App.tsx','scene.config.json','diffuser-4969889.provenance.json'])assert.equal(templateNameAllowed(name),true,name);assert.equal(descendant('/demo','/demo/run/work'),true);assert.equal(descendant('/demo','/demo/../outside'),false);assert.equal(descendant('/demo','/demo'),false);
});
