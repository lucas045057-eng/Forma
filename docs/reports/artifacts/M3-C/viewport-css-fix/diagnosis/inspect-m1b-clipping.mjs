import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(path.resolve('apps/server/package.json'));
const sharp = require('sharp');
const base = '.data/m1b-repro/2026-11-14T21-34-09.744Z';
const report = JSON.parse(readFileSync(`${base}/results.json`, 'utf8'));
function* specs(suites) { for (const suite of suites ?? []) { yield* suite.specs ?? []; yield* specs(suite.suites); } }
const spec = [...specs(report.suites)].find(s => s.file?.includes('04-keyframe') && s.line === 23);
const attachment = spec.tests[0].results[0].attachments.find(a => a.name === 'screenshot');
const screenshot = attachment.path;
const {data, info} = await sharp(screenshot).ensureAlpha().raw().toBuffer({resolveWithObject:true});
// Original failure screenshot: canvas starts at (1020,304), reported size 378.
const x = 1020, y = 304, size = 378;
const pixel = (cx, cy) => [...data.subarray((cy * info.width + cx) * 4, (cy * info.width + cx) * 4 + 3)];
const columns = Array.from({length:6}, (_, i) => {
  const offset = size - 6 + i;
  const colors = new Map();
  for (let row = 0; row < size; row++) { const color = pixel(x + offset, y + row).join(','); colors.set(color, (colors.get(color) ?? 0) + 1); }
  return {offset, colors:[...colors]};
});
const result = {screenshot, canvas:{x,y,size}, columns, fullHeightClippedColumns:2, predictedChangedRatio:2/378,
  measuredChangedRatio:JSON.parse(readFileSync(`${base}/artifacts/consistency-default.json`,'utf8')).diff.aligned.changedRatio};
writeFileSync('.data/m1b-clipping-evidence.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
