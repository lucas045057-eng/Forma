import {createRequire} from 'node:module';
import path from 'node:path';
import {repository} from './safety.mjs';
const require=createRequire(path.join(repository,'apps/server/package.json'));
const Fastify=require('fastify');
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

function sanitizeJsx(text){
  return String(text ?? '')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('{','&#123;')
    .replaceAll('}','&#125;');
}

function buildBootstrapFiles(instruction){
  const clean = instruction.trim();
  const isTech = /耳机|音箱|键盘|手表|机甲|无人机|相机|眼镜|芯片|数码|黑钛|赛博|科技|audio|cyber|pro/i.test(clean);
  const isWarm = /灯|月球|家居|沙发|椅|建筑|展厅|陶|木|茶|器|咖啡|花|艺术/i.test(clean);

  const brand = isTech ? 'AETHER LABS' : isWarm ? 'LUMEN ATELIER' : 'NOVA SPATIAL';
  const shortTitle = sanitizeJsx(clean.replace(/^(?:帮我|请|给我)?(?:做一个|生成一个|搭建一个|创建|设计)?/, '').slice(0, 22) || '空间三维互动展厅');
  const subtitle = sanitizeJsx(clean);

  const palette = isTech
    ? { bg: '#090c12', surface: '#121824', border: 'rgba(130, 170, 255, 0.16)', text: '#eef3ff', muted: '#8fa0be', accent: '#6ee7ff', btnBg: '#6ee7ff', btnInk: '#06131f', sceneBg: 'linear-gradient(145deg, #111927, #0b101b)' }
    : isWarm
      ? { bg: '#f6f2eb', surface: '#ffffff', border: 'rgba(66, 52, 38, 0.1)', text: '#221c16', muted: '#6e6256', accent: '#9c5a2e', btnBg: '#221c16', btnInk: '#faf6f0', sceneBg: 'linear-gradient(145deg, #ede4d6, #e2d5c3)' }
      : { bg: '#0f1418', surface: '#172026', border: 'rgba(126, 232, 212, 0.18)', text: '#ecf4f6', muted: '#92a7b3', accent: '#76e8d5', btnBg: '#76e8d5', btnInk: '#07221e', sceneBg: 'linear-gradient(145deg, #16232b, #0e171d)' };

  const features = isTech
    ? [
        { no: '01', title: '航空级声学与结构架构', desc: '精密声学腔体与轻量化骨架协同设计，360° 自由拖拽检视每一处倒角细节。' },
        { no: '02', title: '空间音频与动态响应', desc: '自适应环境感知引擎，实时平衡沉浸声场与全天候佩戴舒适度。' },
        { no: '03', title: '模块化定制色系', desc: '支持在工作台一键替换不同材质的 GLB 模型或新增分解展示模块。' },
      ]
    : [
        { no: '01', title: '光影与器物比例', desc: '柔和漫射光勾勒表面肌理，可在场景编辑器中实时调节色温与主光角度。' },
        { no: '02', title: '沉浸式三维交互检视', desc: '支持鼠标拖动旋转、滚轮缩放与多区块独立 3D 模块自由编排。' },
        { no: '03', title: '点选任意局部继续精修', desc: '首版生成后，随时开启选取点击任意文案或卡片，用语音或文字持续迭代。' },
      ];

  const appCode = `import { useState } from 'react';
import { Button } from './components/Button';
import { ProductHero } from './components/ProductHero';

const specs = ${JSON.stringify(features, null, 2)};

export default function App() {
  const [reserved, setReserved] = useState(0);
  const [status, setStatus] = useState('');

  return (
    <main data-spatial-page className="gen-page">
      <header className="gen-nav">
        <a className="gen-brand" href="#top">${brand}<span>SPATIAL EDITION</span></a>
        <a className="gen-link" href="#features">核心亮点</a>
      </header>

      <section id="top" className="gen-hero">
        <div className="gen-copy">
          <p className="gen-eyebrow">FIRST-EDITION 3D EXPERIENCE</p>
          <h1>${shortTitle}</h1>
          <p className="gen-lead">${subtitle}</p>
          <div className="gen-actions">
            <Button
              data-testid="reserve-button"
              onClick={() => {
                setReserved(value => value + 1);
                setStatus('已登记预约体验（演示交互已响应）');
              }}
            >
              立即预约体验
            </Button>
            <Button
              className="button-secondary"
              data-testid="spec-button"
              onClick={() => setStatus('可在右侧打开 3D 资产随时替换或新增三维模型')}
            >
              探索三维细节
            </Button>
          </div>
          <output className="gen-status" data-testid="action-status" data-interactions={reserved} aria-live="polite">
            {status}
          </output>
        </div>
        <ProductHero />
      </section>

      <section id="features" className="gen-grid">
        {specs.map(item => (
          <article key={item.no} className="gen-card">
            <span className="gen-no">{item.no}</span>
            <h2>{item.title}</h2>
            <p>{item.desc}</p>
          </article>
        ))}
      </section>

      <footer className="gen-footer">${brand} · 由一句话空间生成引擎构建首版</footer>
    </main>
  );
}
`;

  const styleCode = `:root {
  font-family: "Inter", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  color: ${palette.text};
  background: ${palette.bg};
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: ${palette.bg};
  color: ${palette.text};
}
.gen-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 28px 32px 64px;
}
.gen-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 22px;
  border-bottom: 1px solid ${palette.border};
}
.gen-brand {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  font-weight: 700;
  font-size: 17px;
  letter-spacing: 0.06em;
  color: ${palette.text};
  text-decoration: none;
}
.gen-brand span {
  font-size: 10px;
  color: ${palette.accent};
  letter-spacing: 0.16em;
}
.gen-link {
  font-size: 13px;
  color: ${palette.muted};
  text-decoration: none;
}
.gen-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(300px, 0.95fr);
  gap: 42px;
  align-items: center;
  padding: 48px 0;
}
.gen-eyebrow {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: ${palette.accent};
}
.gen-copy h1 {
  margin: 0 0 16px;
  font-size: clamp(32px, 4.2vw, 50px);
  line-height: 1.12;
  letter-spacing: -0.02em;
}
.gen-lead {
  margin: 0 0 28px;
  font-size: 15.5px;
  line-height: 1.7;
  color: ${palette.muted};
  max-width: 48ch;
}
.gen-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.button {
  padding: 12px 24px;
  border-radius: 999px;
  border: 1px solid ${palette.btnBg};
  background: ${palette.btnBg};
  color: ${palette.btnInk};
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.button-secondary {
  background: transparent;
  border-color: ${palette.border};
  color: ${palette.text};
}
.gen-status {
  display: block;
  min-height: 22px;
  margin-top: 12px;
  font-size: 12.5px;
  color: ${palette.accent};
}
.product-scene {
  position: relative;
  width: 100%;
  border-radius: 24px;
  overflow: hidden;
  background: ${palette.sceneBg};
  border: 1px solid ${palette.border};
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24);
}
.stage-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px;
  text-align: center;
}
.stage-orb {
  width: 144px;
  height: 144px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, ${palette.accent}, rgba(120, 140, 160, 0.22) 72%);
  margin-bottom: 18px;
  opacity: 0.88;
}
.stage-prism {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 260px;
}
.stage-badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: ${palette.accent};
}
.stage-prism strong { font-size: 15px; }
.stage-prism small { font-size: 12px; color: ${palette.muted}; line-height: 1.5; }
.gen-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}
.gen-card {
  padding: 22px;
  border-radius: 18px;
  background: ${palette.surface};
  border: 1px solid ${palette.border};
}
.gen-no {
  font-size: 11.5px;
  font-weight: 700;
  color: ${palette.accent};
}
.gen-card h2 {
  margin: 8px 0;
  font-size: 16.5px;
}
.gen-card p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: ${palette.muted};
}
.gen-footer {
  margin-top: 52px;
  padding-top: 20px;
  border-top: 1px solid ${palette.border};
  font-size: 12px;
  color: ${palette.muted};
}
@media (max-width: 820px) {
  .gen-hero, .gen-grid { grid-template-columns: 1fr; }
  .gen-page { padding: 20px 18px 44px; }
}
`;

  return { appCode, styleCode };
}

export function codingMock(){
 const app=Fastify({logger:false,bodyLimit:4*1024*1024});const sessions=new Map();
 app.post('/chat/completions',async(request,reply)=>{
  if(request.headers.authorization!=='Bearer mock-only')return reply.code(401).send({error:{message:'Mock key required'}});
  const session=request.headers['x-opencode-session'];if(typeof session!=='string')return reply.code(400).send({error:{message:'Session required'}});
  const count=(sessions.get(session)??0)+1;sessions.set(session,count);
  let instruction='';let isBootstrap=false;
  try{
    const parsed=JSON.parse(request.body?.messages?.find(message=>message.role==='user')?.content??'{}');
    instruction=parsed.instruction??'';
    isBootstrap=parsed.mode==='bootstrap-first-edition-3d-webpage';
  }catch{}

  if(isBootstrap){
    const {appCode,styleCode}=buildBootstrapFiles(instruction);
    const calls=count===1
      ?[tool('list','list_files',{})]
      :count===2
        ?[tool('write-app','write_file',{path:'src/App.tsx',content:appCode}),tool('write-css','write_file',{path:'src/style.css',content:styleCode})]
        :[tool('finish','finish',{summary:`已根据需求生成首版 3D 网页「${instruction.slice(0,24)}」，检查通过后即可采用生效`})];
    return {id:`mock-boot-${count}`,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:null,tool_calls:calls},finish_reason:'tool_calls'}]};
  }

  const action=instruction.includes('标题')?{file:'src/App.tsx',old:'<h1>给生活，<br/>留一点香气。</h1>',next:'<h1>把森林，<br/>带回家。</h1>'}:/共享|圆角/.test(instruction)?{file:'src/components/Button.tsx',old:'<button type="button"',next:'<button style={{borderRadius:12}} type="button"'}:/下移|移动|购买区/.test(instruction)?{file:'src/App.tsx',old:'<div className="actions">',next:'<div className="actions" style={{paddingTop:16}}>'}:undefined;
  const calls=!action?[tool('finish','finish',{summary:'离线模拟仅支持购买区下移、标题改动、共享按钮圆角三条固定示例；新建作品可使用“一句话生成首版 3D 网页”'})]:count===1?[tool('read','read_file',{path:action.file})]:count===2?[tool('replace','replace_in_file',{path:action.file,old:action.old,new:action.next})]:[tool('finish','finish',{summary:'固定模拟示例已写入候选；尚需真实检查与用户采用'})];
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
