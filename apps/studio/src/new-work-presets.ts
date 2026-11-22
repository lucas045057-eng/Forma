export interface WorkInspiration {
  label: string;
  prompt: string;
}

export interface UploadedWorkFile {
  file: File;
  relPath: string;
}

export const SPATIAL_3D_INSPIRATIONS: readonly WorkInspiration[] = [
  { label: '黑钛耳机 3D 发布页', prompt: '做一个黑钛旗舰无线降噪耳机的深空科技感 3D 新品发布页，突出声学腔体结构与预约体验' },
  { label: '极简月球灯互动展厅', prompt: '做一个北欧极简月球氛围灯的温润家居 3D 互动展厅，突出柔和光影层次与空间仪式感' },
  { label: '客制化键盘空间官网', prompt: '做一个全铝 CNC 客制化机械键盘的赛博工业风 3D 官网，展示结构工艺与限量预约' },
];

export const FREE_WEB_INSPIRATIONS: readonly WorkInspiration[] = [
  { label: '极简建筑事务所官网', prompt: '做一个北欧极简建筑与空间设计事务所官网，包含代表作品分类筛选、设计哲学与预约咨询反馈' },
  { label: '独立咖啡馆品牌主页', prompt: '做一个精品手冲咖啡馆的品牌网页，包含当季豆单风味切换卡片、门店时间与预订试饮按钮' },
  { label: '交互式专注计时工具', prompt: '做一个审美克制的番茄专注与每日待办效率网页工具，支持切换专注模式、交互计数与清单勾选' },
];

export const SAMPLE_IMPORT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>青岚茶室 · 城市静谧空间</title>
  <style>
    .tea-shell { max-width: 980px; margin: 0 auto; padding: 40px 28px 72px; background: #faf8f4; color: #1f2421; }
    .tea-nav { display: flex; justify-content: space-between; align-items: center; padding-bottom: 20px; border-bottom: 1px solid rgba(31,36,33,0.12); }
    .tea-brand { font-size: 20px; font-weight: 700; letter-spacing: 0.06em; }
    .tea-hero { padding: 52px 0 40px; }
    .tea-tag { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #e6ede8; color: #2d5a43; font-size: 12px; font-weight: 600; }
    .tea-hero h1 { font-size: 44px; line-height: 1.18; margin: 16px 0; }
    .tea-hero p { font-size: 16px; line-height: 1.75; color: #4f5953; max-width: 560px; margin: 0 0 28px; }
    .tea-cta { padding: 12px 26px; border-radius: 999px; border: none; background: #234233; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    .tea-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin-top: 24px; }
    .tea-card { padding: 22px; border-radius: 16px; background: #ffffff; border: 1px solid rgba(31,36,33,0.08); }
    .tea-card h3 { margin: 0 0 8px; font-size: 17px; }
    .tea-card p { margin: 0; font-size: 13.5px; line-height: 1.65; color: #5b655f; }
  </style>
</head>
<body>
  <div class="tea-shell">
    <header class="tea-nav">
      <span class="tea-brand">青岚 QINGLAN</span>
      <a href="#rooms">空间导览</a>
    </header>
    <section class="tea-hero">
      <span class="tea-tag">EXISTING WEBPAGE IMPORT</span>
      <h1>在城市喧嚣深处，留一席温润茶事。</h1>
      <p>这是一份从外部直接拉入 Forma 的已有静态网页。你可以点击顶部「开启选取」让大模型直接改写任意段落与配色，也可以从 3D 资产库拖入茶器模型。</p>
      <button class="tea-cta">预约今日茶席</button>
    </section>
    <section id="rooms" class="tea-grid">
      <article class="tea-card">
        <h3>松风庭院</h3>
        <p>自然天光与原木长桌交织，适合二至四人静谈品茗。</p>
      </article>
      <article class="tea-card">
        <h3>山雾茶寮</h3>
        <p>甄选高山乌龙与手作陶器，四时风物皆可入席。</p>
      </article>
      <article class="tea-card">
        <h3>器物展陈</h3>
        <p>支持随时拖入独立 3D 器物模块，实现空间化网页展示。</p>
      </article>
    </section>
  </div>
</body>
</html>`;

const ALLOWED_UPLOAD_EXT = /\.(?:html?|css|tsx|ts|jsx|js|json|svg|png|jpe?g|gif|webp|ico|avif)$/i;
const IGNORED_UPLOAD_SEGMENTS = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|\.env[^/]*)(?:\/|$)/i;

/** Encode binary upload bytes in fixed chunks to avoid call-stack overflow on large buffers. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Filter browser-selected webpage files, dropping build/VCS/secret directories and capping at 250 entries. */
export function collectUploadFiles(list: ArrayLike<File>): UploadedWorkFile[] {
  const collected: UploadedWorkFile[] = [];
  for (const file of Array.from(list)) {
    const relValue: unknown = Reflect.get(file, 'webkitRelativePath');
    const rawRel = (typeof relValue === 'string' && relValue ? relValue : file.name).replaceAll('\\', '/');
    if (IGNORED_UPLOAD_SEGMENTS.test(rawRel)) continue;
    if (!ALLOWED_UPLOAD_EXT.test(rawRel)) continue;
    collected.push({ file, relPath: rawRel });
    if (collected.length >= 250) break;
  }
  return collected;
}
