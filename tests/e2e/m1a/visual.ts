import { createRequire } from 'node:module';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { SERVER_DIR } from './env';

/** 图像处理复用后端已有的 sharp（不新增依赖）。 */
const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));
const sharp = requireFromServer('sharp') as (input: Buffer | string) => any;

export interface Rect { x: number; y: number; width: number; height: number }

export interface Region {
  png: Buffer;
  /** 相对画布左上角的偏移（画布可能有一部分在视口外） */
  offset: { x: number; y: number };
  width: number;
  height: number;
}

/**
 * 截取视口内的一块区域（不做 Playwright 的“先滚进视图”，避免改变滚动位置进而改变 at）。
 * 允许区域部分在视口外，会自动裁到可见部分并记录偏移。
 */
export async function captureRegion(page: Page, rect: Rect): Promise<Region> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  const shot = await page.screenshot();
  const png = await sharp(shot).extract({ left, top, width, height }).png().toBuffer();
  return { png, offset: { x: left - rect.x, y: top - rect.y }, width, height };
}

export interface ImageDiff {
  meanAbsDiff: number;
  maxDiff: number;
  /** 单通道差 > 24 的像素比例 */
  changedRatio: number;
  pixels: number;
}

/** 把两张图缩放到同一尺寸后逐像素比较（两边画布 CSS 尺寸不同，归一化后比较构图）。 */
export async function compareNormalized(a: Buffer, b: Buffer, size = 512): Promise<ImageDiff> {
  const left = await sharp(a).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(b).resize(size, size, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return diffRaw(left.data, right.data);
}

/** 直接比较同尺寸的两块图。 */
export async function comparePixels(a: Buffer, b: Buffer): Promise<ImageDiff> {
  const left = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
    throw new Error(`尺寸不一致：${left.info.width}x${left.info.height} vs ${right.info.width}x${right.info.height}`);
  }
  return diffRaw(left.data, right.data);
}

export interface AlignedDiff extends ImageDiff {
  shift: { x: number; y: number };
  tried: Array<{ x: number; y: number; changedRatio: number }>;
}

/**
 * 同尺寸比较，但允许整体平移 1–2 像素：两个视口的画布在页面里的坐标是小数，
 * 按整数像素截图后会有亚像素偏移，不平移就会把边缘像素误算成差异。
 */
export async function compareAligned(a: Buffer, b: Buffer, maxShift = 3): Promise<AlignedDiff> {
  const left = await sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const right = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (left.info.width !== right.info.width || left.info.height !== right.info.height) {
    throw new Error(`尺寸不一致：${left.info.width}x${left.info.height} vs ${right.info.width}x${right.info.height}`);
  }
  const width = left.info.width;
  const height = left.info.height;
  let best: AlignedDiff | null = null;
  const tried: AlignedDiff['tried'] = [];
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      let sum = 0;
      let changed = 0;
      let maxDiff = 0;
      let pixels = 0;
      for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y += 1) {
        for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x += 1) {
          const i = (y * width + x) * 4;
          const j = ((y - dy) * width + (x - dx)) * 4;
          const d = Math.max(
            Math.abs(left.data[i] - right.data[j]),
            Math.abs(left.data[i + 1] - right.data[j + 1]),
            Math.abs(left.data[i + 2] - right.data[j + 2]),
          );
          pixels += 1;
          sum += d;
          if (d > 24) changed += 1;
          if (d > maxDiff) maxDiff = d;
        }
      }
      const candidate: AlignedDiff = {
        shift: { x: dx, y: dy },
        meanAbsDiff: sum / pixels,
        maxDiff,
        changedRatio: changed / pixels,
        pixels,
        tried,
      };
      tried.push({ x: dx, y: dy, changedRatio: candidate.changedRatio });
      if (!best || candidate.changedRatio < best.changedRatio) best = candidate;
    }
  }
  return best as AlignedDiff;
}

function diffRaw(left: Buffer, right: Buffer): ImageDiff {
  let sum = 0;
  let changed = 0;
  let maxDiff = 0;
  const pixels = Math.floor(left.length / 4);
  for (let index = 0; index < pixels * 4; index += 4) {
    const d = Math.max(
      Math.abs(left[index] - right[index]),
      Math.abs(left[index + 1] - right[index + 1]),
      Math.abs(left[index + 2] - right[index + 2]),
    );
    sum += d;
    if (d > 24) changed += 1;
    if (d > maxDiff) maxDiff = d;
  }
  return { meanAbsDiff: sum / pixels, maxDiff, changedRatio: changed / pixels, pixels };
}

export interface Silhouette {
  width: number;
  height: number;
  background: [number, number, number];
  /** 非背景像素的包围盒（图像坐标） */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  widthPx: number;
  heightPx: number;
  pixelCount: number;
}

/** 以左上角像素为背景色，找出非背景像素的包围盒（用于量测模型在画布里的高度/顶边）。 */
export async function silhouette(png: Buffer): Promise<Silhouette> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const background: [number, number, number] = [data[0], data[1], data[2]];
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let pixelCount = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = (y * info.width + x) * 4;
      const d = Math.max(
        Math.abs(data[index] - background[0]),
        Math.abs(data[index + 1] - background[1]),
        Math.abs(data[index + 2] - background[2]),
      );
      if (d <= 20) continue;
      pixelCount += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    width: info.width, height: info.height, background,
    bbox: { minX, minY, maxX, maxY },
    widthPx: maxX - minX + 1, heightPx: maxY - minY + 1, pixelCount,
  };
}

export async function imageStats(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = new Set<number>();
  let sum = 0;
  let sumSquares = 0;
  const pixels = info.width * info.height;
  for (let index = 0; index < data.length; index += 4) {
    colors.add((data[index] << 16) | (data[index + 1] << 8) | data[index + 2]);
    sum += data[index] + data[index + 1] + data[index + 2];
    sumSquares += data[index] ** 2 + data[index + 1] ** 2 + data[index + 2] ** 2;
  }
  const mean = sum / (pixels * 3);
  const variance = sumSquares / (pixels * 3) - mean ** 2;
  return { width: info.width, height: info.height, uniqueColors: colors.size, mean, stdDev: Math.sqrt(Math.max(0, variance)) };
}
