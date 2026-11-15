# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 03-undo.spec.ts >> 撤回 >> 界面写入 → 撤回：配置与网页画面都恢复
- Location: tests\e2e\m1b\03-undo.spec.ts:13:3

# Error details

```
Error: 尺寸不一致：378x378 vs 378x341
```

# Test source

```ts
  1   | import { createRequire } from 'node:module';
  2   | import path from 'node:path';
  3   | import type { Page } from '@playwright/test';
  4   | import { SERVER_DIR } from './env';
  5   | 
  6   | /** 图像处理复用后端已有的 sharp（不新增依赖）。 */
  7   | const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));
  8   | const sharp = requireFromServer('sharp') as (input: Buffer | string) => any;
  9   | 
  10  | export interface Rect { x: number; y: number; width: number; height: number }
  11  | 
  12  | export interface Region {
  13  |   png: Buffer;
  14  |   /** 相对画布左上角的偏移（画布可能有一部分在视口外） */
  15  |   offset: { x: number; y: number };
  16  |   width: number;
  17  |   height: number;
  18  | }
  19  | 
  20  | /**
  21  |  * 截取视口内的一块区域（不做 Playwright 的“先滚进视图”，避免改变滚动位置进而改变 at）。
  22  |  * 允许区域部分在视口外，会自动裁到可见部分并记录偏移。
  23  |  */
  24  | export async function captureRegion(page: Page, rect: Rect): Promise<Region> {
  25  |   const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  26  |   const left = Math.max(0, Math.floor(rect.x));
  27  |   const top = Math.max(0, Math.floor(rect.y));
  28  |   const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  29  |   const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  30  |   const width = Math.max(0, right - left);
  31  |   const height = Math.max(0, bottom - top);
  32  |   const shot = await page.screenshot();
  33  |   const png = await sharp(shot).extract({ left, top, width, height }).png().toBuffer();
  34  |   return { png, offset: { x: left - rect.x, y: top - rect.y }, width, height };
  35  | }
  36  | 
  37  | export interface ImageDiff {
  38  |   meanAbsDiff: number;
  39  |   maxDiff: number;
  40  |   /** 单通道差 > 24 的像素比例 */
  41  |   changedRatio: number;
  42  |   pixels: number;
  43  | }
  44  | 
  45  | /** 把两张图缩放到同一尺寸后逐像素比较（两边画布 CSS 尺寸不同，归一化后比较构图）。 */
  46  | export async function compareNormalized(a: Buffer, b: Buffer, size = 512): Promise<ImageDiff> {
  47  |   const left = await sharp(a).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  48  |   const right = await sharp(b).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  49  |   return diffRaw(left.data, right.data);
  50  | }
  51  | 
  52  | /** 直接比较同尺寸的两块图。 */
  53  | export async function comparePixels(a: Buffer, b: Buffer): Promise<ImageDiff> {
  54  |   const left = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  55  |   const right = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  56  |   if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
  57  |     throw new Error(`尺寸不一致：${left.info.width}x${left.info.height} vs ${right.info.width}x${right.info.height}`);
  58  |   }
  59  |   return diffRaw(left.data, right.data);
  60  | }
  61  | 
  62  | export interface AlignedDiff extends ImageDiff {
  63  |   shift: { x: number; y: number };
  64  |   tried: Array<{ x: number; y: number; changedRatio: number }>;
  65  | }
  66  | 
  67  | /**
  68  |  * 同尺寸比较，但允许整体平移 1–2 像素：两个视口的画布在页面里的坐标是小数，
  69  |  * 按整数像素截图后会有亚像素偏移，不平移就会把边缘像素误算成差异。
  70  |  */
  71  | export async function compareAligned(a: Buffer, b: Buffer, maxShift = 3): Promise<AlignedDiff> {
  72  |   const left = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  73  |   const right = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  74  |   if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
> 75  |     throw new Error(`尺寸不一致：${left.info.width}x${left.info.height} vs ${right.info.width}x${right.info.height}`);
      |           ^ Error: 尺寸不一致：378x378 vs 378x341
  76  |   }
  77  |   const width = left.info.width;
  78  |   const height = left.info.height;
  79  |   let best: AlignedDiff | null = null;
  80  |   const tried: AlignedDiff['tried'] = [];
  81  |   for (let dy = -maxShift; dy <= maxShift; dy += 1) {
  82  |     for (let dx = -maxShift; dx <= maxShift; dx += 1) {
  83  |       let sum = 0;
  84  |       let changed = 0;
  85  |       let maxDiff = 0;
  86  |       let pixels = 0;
  87  |       for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y += 1) {
  88  |         for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x += 1) {
  89  |           const i = (y * width + x) * 4;
  90  |           const j = ((y - dy) * width + (x - dx)) * 4;
  91  |           const d = Math.max(
  92  |             Math.abs(left.data[i] - right.data[j]),
  93  |             Math.abs(left.data[i + 1] - right.data[j + 1]),
  94  |             Math.abs(left.data[i + 2] - right.data[j + 2]),
  95  |           );
  96  |           pixels += 1;
  97  |           sum += d;
  98  |           if (d > 24) changed += 1;
  99  |           if (d > maxDiff) maxDiff = d;
  100 |         }
  101 |       }
  102 |       const candidate: AlignedDiff = {
  103 |         shift: { x: dx, y: dy },
  104 |         meanAbsDiff: sum / pixels,
  105 |         maxDiff,
  106 |         changedRatio: changed / pixels,
  107 |         pixels,
  108 |         tried,
  109 |       };
  110 |       tried.push({ x: dx, y: dy, changedRatio: candidate.changedRatio });
  111 |       if (!best || candidate.changedRatio < best.changedRatio) best = candidate;
  112 |     }
  113 |   }
  114 |   return best as AlignedDiff;
  115 | }
  116 | 
  117 | function diffRaw(left: Buffer, right: Buffer): ImageDiff {
  118 |   let sum = 0;
  119 |   let changed = 0;
  120 |   let maxDiff = 0;
  121 |   const pixels = Math.floor(left.length / 4);
  122 |   for (let index = 0; index < pixels * 4; index += 4) {
  123 |     const d = Math.max(
  124 |       Math.abs(left[index] - right[index]),
  125 |       Math.abs(left[index + 1] - right[index + 1]),
  126 |       Math.abs(left[index + 2] - right[index + 2]),
  127 |     );
  128 |     sum += d;
  129 |     if (d > 24) changed += 1;
  130 |     if (d > maxDiff) maxDiff = d;
  131 |   }
  132 |   return { meanAbsDiff: sum / pixels, maxDiff, changedRatio: changed / pixels, pixels };
  133 | }
  134 | 
  135 | export interface Silhouette {
  136 |   width: number;
  137 |   height: number;
  138 |   background: [number, number, number];
  139 |   /** 非背景像素的包围盒（图像坐标） */
  140 |   bbox: { minX: number; minY: number; maxX: number; maxY: number };
  141 |   widthPx: number;
  142 |   heightPx: number;
  143 |   pixelCount: number;
  144 | }
  145 | 
  146 | /** 以左上角像素为背景色，找出非背景像素的包围盒（用于量测模型在画布里的高度/顶边）。 */
  147 | export async function silhouette(png: Buffer): Promise<Silhouette> {
  148 |   const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  149 |   const background: [number, number, number] = [data[0], data[1], data[2]];
  150 |   let minX = info.width;
  151 |   let minY = info.height;
  152 |   let maxX = -1;
  153 |   let maxY = -1;
  154 |   let pixelCount = 0;
  155 |   for (let y = 0; y < info.height; y += 1) {
  156 |     for (let x = 0; x < info.width; x += 1) {
  157 |       const index = (y * info.width + x) * 4;
  158 |       const d = Math.max(
  159 |         Math.abs(data[index] - background[0]),
  160 |         Math.abs(data[index + 1] - background[1]),
  161 |         Math.abs(data[index + 2] - background[2]),
  162 |       );
  163 |       if (d <= 20) continue;
  164 |       pixelCount += 1;
  165 |       if (x < minX) minX = x;
  166 |       if (x > maxX) maxX = x;
  167 |       if (y < minY) minY = y;
  168 |       if (y > maxY) maxY = y;
  169 |     }
  170 |   }
  171 |   return {
  172 |     width: info.width, height: info.height, background,
  173 |     bbox: { minX, minY, maxX, maxY },
  174 |     widthPx: maxX - minX + 1, heightPx: maxY - minY + 1, pixelCount,
  175 |   };
```