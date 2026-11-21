import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function smoothStep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * Renders the Forma Spatial Canvas emblem at `size x size`:
 * - Near-black rounded squircle tile (#141413) with subtle inner rim (#2a2a26)
 * - Isometric spatial wireframe frame & stylized "F" monogram in lime green (#d4ff33)
 * - Selection node dot in warm ivory (#f2efe9) at top-right corner
 */
export function renderFormaIconPng(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 1.25 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;

      const tileDist = sdRoundedBox(u, v, 0.5, 0.5, 0.45, 0.45, 0.21);
      const tileAlpha = 1 - smoothStep(-aa, aa, tileDist);
      if (tileAlpha <= 0) continue;

      // Subtle radial gradient on dark tile (#141413 -> #1d1d1b)
      const radial = Math.hypot(u - 0.35, v - 0.28);
      let r = Math.round(28 - radial * 10);
      let g = Math.round(28 - radial * 10);
      let b = Math.round(26 - radial * 10);

      // Subtle border glow inside the tile edge
      const borderMask = (1 - smoothStep(-aa * 2.2, 0, tileDist)) * smoothStep(-0.045, -0.01, tileDist);
      r = Math.round(r * (1 - borderMask * 0.45) + 212 * (borderMask * 0.45));
      g = Math.round(g * (1 - borderMask * 0.45) + 255 * (borderMask * 0.45));
      b = Math.round(b * (1 - borderMask * 0.45) + 51 * (borderMask * 0.45));

      // Spatial perspective grid / frame accent (subtle dark-lime frame)
      const frameDist = Math.abs(sdRoundedBox(u, v, 0.5, 0.5, 0.33, 0.33, 0.09)) - 0.011;
      const frameMask = (1 - smoothStep(-aa, aa, frameDist)) * 0.22;
      r = Math.round(r * (1 - frameMask) + 212 * frameMask);
      g = Math.round(g * (1 - frameMask) + 255 * frameMask);
      b = Math.round(b * (1 - frameMask) + 51 * frameMask);

      // Bold spatial "F" glyph + node link
      const strokeRadius = 0.052;
      const dStem = sdSegment(u, v, 0.33, 0.27, 0.33, 0.74);
      const dTop = sdSegment(u, v, 0.33, 0.27, 0.67, 0.27);
      const dMid = sdSegment(u, v, 0.33, 0.50, 0.57, 0.50);
      // Spatial diagonal connector from mid bar to top-right anchor node
      const dLink = sdSegment(u, v, 0.57, 0.50, 0.69, 0.68) + 0.022;

      const fDist = Math.min(dStem, dTop, dMid, dLink) - strokeRadius;
      const fMask = 1 - smoothStep(-aa, aa, fDist);
      if (fMask > 0) {
        r = Math.round(r * (1 - fMask) + 212 * fMask);
        g = Math.round(g * (1 - fMask) + 255 * fMask);
        b = Math.round(b * (1 - fMask) + 51 * fMask);
      }

      // Spatial anchor node at (0.69, 0.68) in warm ivory (#f2efe9) with lime ring
      const nodeDist = Math.hypot(u - 0.69, v - 0.68);
      const ringMask = 1 - smoothStep(0.068 - aa, 0.068 + aa, nodeDist);
      if (ringMask > 0) {
        r = Math.round(r * (1 - ringMask) + 212 * ringMask);
        g = Math.round(g * (1 - ringMask) + 255 * ringMask);
        b = Math.round(b * (1 - ringMask) + 51 * ringMask);
      }
      const coreMask = 1 - smoothStep(0.036 - aa, 0.036 + aa, nodeDist);
      if (coreMask > 0) {
        r = Math.round(r * (1 - coreMask) + 242 * coreMask);
        g = Math.round(g * (1 - coreMask) + 239 * coreMask);
        b = Math.round(b * (1 - coreMask) + 233 * coreMask);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, r));
      rgba[idx + 1] = Math.max(0, Math.min(255, g));
      rgba[idx + 2] = Math.max(0, Math.min(255, b));
      rgba[idx + 3] = Math.round(tileAlpha * 255);
    }
  }

  return encodeRgbaToPng(size, size, rgba);
}

export function buildIcoBuffer(sizes = [16, 32, 48, 256]) {
  const pngBuffers = sizes.map(s => ({ size: s, data: renderFormaIconPng(s) }));
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirEntries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  pngBuffers.forEach((frame, i) => {
    const base = i * 16;
    dirEntries[base] = frame.size === 256 ? 0 : frame.size;
    dirEntries[base + 1] = frame.size === 256 ? 0 : frame.size;
    dirEntries[base + 2] = 0; // palette
    dirEntries[base + 3] = 0; // reserved
    dirEntries.writeUInt16LE(1, base + 4); // color planes
    dirEntries.writeUInt16LE(32, base + 6); // bits per pixel
    dirEntries.writeUInt32LE(frame.data.length, base + 8);
    dirEntries.writeUInt32LE(offset, base + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, dirEntries, ...pngBuffers.map(f => f.data)]);
}

export function ensureFormaIcons(rootDir = repoRoot) {
  const icoBuffer = buildIcoBuffer([16, 32, 48, 256]);
  const desktopAssetDir = path.join(rootDir, 'desktop/assets');
  const studioPublicDir = path.join(rootDir, 'apps/studio/public');

  mkdirSync(desktopAssetDir, { recursive: true });
  mkdirSync(studioPublicDir, { recursive: true });

  const desktopIcoPath = path.join(desktopAssetDir, 'forma.ico');
  const studioFaviconPath = path.join(studioPublicDir, 'favicon.ico');

  writeFileSync(desktopIcoPath, icoBuffer);
  writeFileSync(studioFaviconPath, icoBuffer);

  return { desktopIcoPath, studioFaviconPath, bytes: icoBuffer.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ensureFormaIcons();
  console.log(`Generated Forma icon (${result.bytes} bytes) -> ${result.desktopIcoPath}`);
}
