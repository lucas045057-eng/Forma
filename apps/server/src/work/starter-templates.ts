import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkStarter } from '@spatial/shared';
import { defaultSceneConfig } from '@spatial/shared/scene-config';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../../../templates/product-page/', import.meta.url));

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function escapeJsxText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

async function copyTreePlain(sourceDir: string, destDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    const info = await lstat(from);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await copyTreePlain(from, to);
    } else if (info.isFile()) {
      await writeFile(to, await readFile(from));
    }
  }
}

export async function linkWorkDependencies(targetWorkRoot: string, dependencySourceRoots: string[]): Promise<void> {
  let sourceModules: string | undefined;
  for (const candidate of [...dependencySourceRoots, TEMPLATE_ROOT]) {
    const modulesPath = path.join(candidate, 'node_modules');
    try {
      await lstat(modulesPath);
      sourceModules = modulesPath;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!sourceModules) return;

  const linkFolder = async (from: string, to: string) => {
    const physical = await realpath(from);
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(physical)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) {
        await linkFolder(path.join(physical, entry), path.join(to, entry));
        continue;
      }
      const target = await realpath(path.join(physical, entry));
      await symlink(target, path.join(to, entry), 'junction');
    }
  };
  await linkFolder(sourceModules, path.join(targetWorkRoot, 'node_modules'));
}

function blankProductHeroSource(): string {
  return `import { useEffect, useState } from 'react';
import { ProductScene, sceneRenderSettings } from '@spatial/scene-renderer';
import { useSceneConfig } from '../scene-config-store';

function Placeholder() {
  return (
    <div className="stage-placeholder" role="img" aria-label="三维主舞台占位：可放入或生成 3D 模型" data-testid="product-placeholder">
      <div className="stage-orb" />
      <div className="stage-prism">
        <span className="stage-badge">3D STAGE</span>
        <strong>空间三维主舞台</strong>
        <small>在工作台生成或导入 GLB 模型后即可一键放入此处</small>
      </div>
    </div>
  );
}

export function ProductHero() {
  const config = useSceneConfig();
  const [at, setAt] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState('');
  const modelUrl = config.model ? \`\${import.meta.env.BASE_URL}\${config.model.slice(1)}\` : '';
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setAt(max > 0 ? Math.max(0, Math.min(1, window.scrollY / max)) : 0);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    update();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return (
    <div
      className="product-scene"
      style={{ aspectRatio: sceneRenderSettings.aspectRatio }}
      data-testid="product-scene"
      data-state={modelUrl && loadedUrl === modelUrl ? 'ready' : 'fallback'}
      data-scroll-at={at}
      aria-label="三维互动舞台"
    >
      <ProductScene
        config={config}
        modelUrl={modelUrl}
        scrollAt={at}
        fallback={<Placeholder />}
        onReady={() => setLoadedUrl(modelUrl)}
        onError={() => setLoadedUrl('')}
      />
    </div>
  );
}
`;
}

function blankAppSource(workName: string): string {
  const safeTitle = escapeJsxText(workName.trim() || '未命名空间作品');
  return `import { useState } from 'react';
import { Button } from './components/Button';
import { ProductHero } from './components/ProductHero';

const highlights = [
  { code: '01', title: '一句话生成整页', detail: '在右侧输入产品主题或展厅设想，自动生成完整排版、配色与交互结构。' },
  { code: '02', title: '原生三维主舞台', detail: '右侧内置实时 WebGL 舞台，随时支持图生/文生 3D 模型拖入与布光调节。' },
  { code: '03', title: '局部点选精修', detail: '初版成型后，开启选取点击任意标题、卡片或按钮即可继续精细打磨。' },
];

export default function App() {
  const [feedback, setFeedback] = useState('');
  const [interactions, setInteractions] = useState(0);

  return (
    <main data-spatial-page className="spatial-page">
      <header className="top-nav">
        <a className="brand-mark" href="#hero">${safeTitle}<span>SPATIAL WEB CANVAS</span></a>
        <a className="nav-link" href="#highlights">模块结构</a>
      </header>

      <section id="hero" className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">BLANK 3D WORKSPACE</p>
          <h1>${safeTitle}</h1>
          <p className="lead">
            这是一张干净的 3D 网页画布。你可以在右侧输入一句话直接生成首版完整网页，也可以先放入 3D 模型与调整灯光镜头。
          </p>
          <div className="cta-row">
            <Button
              data-testid="explore-button"
              onClick={() => {
                setInteractions(count => count + 1);
                setFeedback('交互正常 · 可随时生成首版页面或放入 3D 模型');
              }}
            >
              测试画布交互
            </Button>
          </div>
          <output className="status-pill" data-testid="action-status" data-interactions={interactions} aria-live="polite">
            {feedback}
          </output>
        </div>
        <ProductHero />
      </section>

      <section id="highlights" className="feature-strip">
        {highlights.map(item => (
          <article key={item.code} className="feature-card">
            <span className="feature-index">{item.code}</span>
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>

      <footer className="page-footer">${safeTitle} · Powered by Forma Spatial Studio</footer>
    </main>
  );
}
`;
}

function freeWebAppSource(workName: string): string {
  const safeTitle = escapeJsxText(workName.trim() || '未命名网页作品');
  return `import { useState } from 'react';
import { Button } from './components/Button';

const sections = [
  { code: '01', title: '自由网页创作', detail: '用自然语言从零生成品牌官网、个人作品集、产品着陆页、互动小工具或活动专题。' },
  { code: '02', title: '点选局部精修', detail: '开启选取即可直接锁定任意标题、段落、卡片或按钮，让真实大模型按需改写。' },
  { code: '03', title: '随时融入 3D', detail: '即便从纯 2D 网页起步，也可随时从左侧 3D 资产库将模型拖入任意区块生成三维模块。' },
];

export default function App() {
  const [feedback, setFeedback] = useState('');
  const [interactions, setInteractions] = useState(0);

  return (
    <main data-spatial-page className="spatial-page">
      <header className="top-nav">
        <a className="brand-mark" href="#hero">${safeTitle}<span>FORMA WEB CANVAS</span></a>
        <a className="nav-link" href="#highlights">创作能力</a>
      </header>

      <section id="hero" className="hero-editorial">
        <p className="eyebrow">FREE WEB WORKSPACE</p>
        <h1>${safeTitle}</h1>
        <p className="lead">
          这是一张自由现代网页画布，不设固定模板限制。在右侧输入你的想法即可直接生成完整网页，或随时点选任意元素继续迭代。
        </p>
        <div className="cta-row">
          <Button
            data-testid="explore-button"
            onClick={() => {
              setInteractions(count => count + 1);
              setFeedback('画布交互就绪 · 在右侧输入描述即可由真实模型生成完整网页');
            }}
          >
            验证页面交互
          </Button>
        </div>
        <output className="status-pill" data-testid="action-status" data-interactions={interactions} aria-live="polite">
          {feedback}
        </output>
      </section>

      <section id="highlights" className="feature-strip">
        {sections.map(item => (
          <article key={item.code} className="feature-card">
            <span className="feature-index">{item.code}</span>
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </article>
        ))}
      </section>

      <footer className="page-footer">${safeTitle} · Powered by Forma Spatial Studio</footer>
    </main>
  );
}
`;
}

function blankStyleSource(): string {
  return `:root {
  color-scheme: light;
  font-family: "Inter", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  color: #171a1f;
  background: #f4f5f7;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(circle at 80% 10%, #e7eef6 0%, #f5f6f8 52%, #eef0f3 100%);
  color: #171a1f;
}
.spatial-page {
  max-width: 1160px;
  margin: 0 auto;
  padding: 28px 32px 64px;
}
.top-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 24px;
  border-bottom: 1px solid rgba(23, 26, 31, 0.08);
}
.brand-mark {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  font-weight: 700;
  font-size: 18px;
  color: #111418;
  text-decoration: none;
}
.brand-mark span {
  font-size: 11px;
  letter-spacing: 0.14em;
  color: #677483;
  font-weight: 600;
}
.nav-link {
  font-size: 13px;
  color: #495462;
  text-decoration: none;
}
.hero-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.05fr) minmax(300px, 0.95fr);
  gap: 40px;
  align-items: center;
  padding: 48px 0;
}
.eyebrow {
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: #2f6f7e;
}
.hero-copy h1 {
  margin: 0 0 16px;
  font-size: clamp(32px, 4.2vw, 52px);
  line-height: 1.12;
  letter-spacing: -0.02em;
}
.lead {
  margin: 0 0 28px;
  font-size: 16px;
  line-height: 1.7;
  color: #4d5866;
  max-width: 48ch;
}
.cta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.button {
  padding: 12px 24px;
  border-radius: 999px;
  border: 1px solid #161b22;
  background: #161b22;
  color: #ffffff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.button-secondary {
  background: transparent;
  color: #161b22;
}
.status-pill {
  display: block;
  min-height: 22px;
  margin-top: 12px;
  font-size: 13px;
  color: #2f6f7e;
}
.product-scene {
  position: relative;
  width: 100%;
  border-radius: 24px;
  overflow: hidden;
  background: linear-gradient(145deg, #e7edf2, #dce4ec);
  border: 1px solid rgba(23, 26, 31, 0.08);
  box-shadow: 0 24px 60px rgba(18, 28, 42, 0.08);
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
  width: 148px;
  height: 148px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, #ffffff, #b9cad8 68%, #8ea4b8 100%);
  box-shadow: 0 22px 44px rgba(34, 54, 74, 0.18);
  margin-bottom: 20px;
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
  color: #2f6f7e;
}
.stage-prism strong {
  font-size: 16px;
  color: #1a222c;
}
.stage-prism small {
  font-size: 12px;
  line-height: 1.5;
  color: #5b6777;
}
.feature-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  padding-top: 16px;
}
.feature-card {
  padding: 22px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(23, 26, 31, 0.07);
}
.feature-index {
  font-size: 12px;
  font-weight: 700;
  color: #2f6f7e;
}
.feature-card h2 {
  margin: 8px 0;
  font-size: 17px;
}
.feature-card p {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: #556070;
}
.page-footer {
  margin-top: 56px;
  padding-top: 20px;
  border-top: 1px solid rgba(23, 26, 31, 0.08);
  font-size: 12px;
  color: #6d7886;
}
.hero-editorial {
  padding: 56px 0 44px;
  max-width: 760px;
}
.hero-editorial h1 {
  margin: 0 0 18px;
  font-size: clamp(34px, 4.6vw, 56px);
  line-height: 1.1;
  letter-spacing: -0.025em;
}
@media (max-width: 820px) {
  .hero-grid, .feature-strip { grid-template-columns: 1fr; }
  .spatial-page { padding: 20px 18px 44px; }
}
`;
}

export async function scaffoldRuntimeBase(input: {
  targetWorkRoot: string;
  name: string;
  dependencySourceRoots?: string[];
  linkDeps?: boolean;
}): Promise<void> {
  const { targetWorkRoot, name, dependencySourceRoots = [], linkDeps = true } = input;
  await mkdir(targetWorkRoot, { recursive: true });
  for (const configFile of ['package.json', 'vite.config.ts', 'tsconfig.json']) {
    await writeFile(path.join(targetWorkRoot, configFile), await readFile(path.join(TEMPLATE_ROOT, configFile)));
  }
  const safeTitle = escapeHtml(name.trim() || '未命名空间作品');
  const html = `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${safeTitle}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`;
  await writeFile(path.join(targetWorkRoot, 'index.html'), html);
  await mkdir(path.join(targetWorkRoot, 'src', 'components'), { recursive: true });
  await mkdir(path.join(targetWorkRoot, 'public', 'assets'), { recursive: true });

  for (const sharedSrc of ['src/main.tsx', 'src/scene-config-store.ts', 'src/spatial-module.tsx', 'src/components/Button.tsx']) {
    await writeFile(path.join(targetWorkRoot, sharedSrc), await readFile(path.join(TEMPLATE_ROOT, sharedSrc)));
  }
  const blankScene = { ...structuredClone(defaultSceneConfig), model: '', scroll: [] };
  await writeFile(path.join(targetWorkRoot, 'src', 'scene.config.json'), JSON.stringify(blankScene, null, 2) + '\n');
  await writeFile(path.join(targetWorkRoot, 'src', 'components', 'ProductHero.tsx'), blankProductHeroSource());
  if (linkDeps) {
    await linkWorkDependencies(targetWorkRoot, dependencySourceRoots);
  }
}

export async function scaffoldWorkDirectory(input: {
  targetWorkRoot: string;
  starter: WorkStarter;
  name: string;
  dependencySourceRoots?: string[];
}): Promise<void> {
  const { targetWorkRoot, starter, name, dependencySourceRoots = [] } = input;
  await mkdir(targetWorkRoot, { recursive: true });

  if (starter === 'product-page') {
    for (const configFile of ['package.json', 'vite.config.ts', 'tsconfig.json']) {
      await writeFile(path.join(targetWorkRoot, configFile), await readFile(path.join(TEMPLATE_ROOT, configFile)));
    }
    await writeFile(path.join(targetWorkRoot, 'index.html'), await readFile(path.join(TEMPLATE_ROOT, 'index.html')));
    await copyTreePlain(path.join(TEMPLATE_ROOT, 'src'), path.join(targetWorkRoot, 'src'));
    await copyTreePlain(path.join(TEMPLATE_ROOT, 'public'), path.join(targetWorkRoot, 'public'));
    await linkWorkDependencies(targetWorkRoot, dependencySourceRoots);
    return;
  }

  await scaffoldRuntimeBase({ targetWorkRoot, name, dependencySourceRoots, linkDeps: false });
  await writeFile(
    path.join(targetWorkRoot, 'src', 'App.tsx'),
    starter === 'free-web' ? freeWebAppSource(name) : blankAppSource(name),
  );
  await writeFile(path.join(targetWorkRoot, 'src', 'style.css'), blankStyleSource());
  await linkWorkDependencies(targetWorkRoot, dependencySourceRoots);
}
