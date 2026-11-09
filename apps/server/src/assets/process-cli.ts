import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssetService } from './service.ts';
import { Lux3DClient } from './lux3d.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const [input = 'fallback/lux3d-4969293.glb', id = 'offline-turbo'] = process.argv.slice(2);
const service = new AssetService({ directory: process.env.ASSETS_DIR ?? path.join(root, '.data/assets'), client: new Lux3DClient({}) });
await service.init();
try {
  const asset = await service.importLocal(path.resolve(root, input), id);
  console.log(JSON.stringify(asset, null, 2));
  if (asset.status !== 'ready') process.exitCode = 1;
} finally { await service.close(); }
