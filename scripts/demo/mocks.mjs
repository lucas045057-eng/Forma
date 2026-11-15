import {createRequire} from 'node:module';
import path from 'node:path';
import {repository} from './safety.mjs';
const require=createRequire(path.join(repository,'apps/server/package.json'));
const Fastify=require('fastify');
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
export function codingMock(){
 const app=Fastify({logger:false,bodyLimit:4*1024*1024});const sessions=new Map();
 app.post('/chat/completions',async(request,reply)=>{
  if(request.headers.authorization!=='Bearer mock-only')return reply.code(401).send({error:{message:'Mock key required'}});
  const session=request.headers['x-opencode-session'];if(typeof session!=='string')return reply.code(400).send({error:{message:'Session required'}});
  const count=(sessions.get(session)??0)+1;sessions.set(session,count);
  let instruction='';try{instruction=JSON.parse(request.body?.messages?.find(message=>message.role==='user')?.content??'{}').instruction??'';}catch{}
  const action=instruction.includes('标题')?{file:'src/App.tsx',old:'<h1>给生活，<br/>留一点香气。</h1>',next:'<h1>把森林，<br/>带回家。</h1>'}:/共享|圆角/.test(instruction)?{file:'src/components/Button.tsx',old:'<button type="button"',next:'<button style={{borderRadius:12}} type="button"'}:/下移|移动|购买区/.test(instruction)?{file:'src/App.tsx',old:'<div className="actions">',next:'<div className="actions" style={{paddingTop:16}}>'}:undefined;
  const calls=!action?[tool('finish','finish',{summary:'离线模拟仅支持购买区下移、标题改动、共享按钮圆角三条固定示例；未理解任意指令'})]:count===1?[tool('read','read_file',{path:action.file})]:count===2?[tool('replace','replace_in_file',{path:action.file,old:action.old,new:action.next})]:[tool('finish','finish',{summary:'固定模拟示例已写入候选；尚需真实检查与用户采用'})];
  return {id:`mock-${count}`,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:calls},finish_reason:'tool_calls'}]};
 });
 return app;
}
export function speechMock(){
 const app=Fastify({logger:false,bodyLimit:6*1024*1024});
 app.post('/compatible-mode/v1/chat/completions',async(request,reply)=>{
  if(request.headers.authorization!=='Bearer mock-only')return reply.code(401).send({error:{message:'Mock key required'}});
  if(request.body?.model!=='qwen3-asr-flash'||request.body?.stream!==false)return reply.code(400).send({error:{message:'Mock speech contract invalid'}});
  return {choices:[{message:{content:'把购买区向下移动一点'}}]};
 });return app;
}
