import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultSceneModuleConfig } from '@spatial/shared/scene-module';
import { auditTrustedImports, scanModuleReferences, verifyCandidateLedger, type AssetLedger, type LedgerRepo } from './asset-ledger.ts';

const instanceId = 'a'.repeat(32);
const baseVersion = 'b'.repeat(40);
const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
const appBase = Buffer.from('export default <main/>;\n');
const appWithRef = Buffer.from(`export default <main><SpatialModule instanceId="${instanceId}"/></main>;\n`);

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function fakeRepo(before: Record<string, Buffer>, after: Record<string, Buffer>): LedgerRepo {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return {
    candidatePath: () => 'C:/candidate',
    async candidateBufferAt(_id, file) { return after[file]; },
    async listTree() { return Object.keys(before); },
    async fileBufferAt(_version, file) { return before[file]; },
    async diffNameStatus() {
      return [...paths].filter(file => {
        const a = before[file], b = after[file];
        return (!a || !b || !a.equals(b));
      }).map(file => ({ status: before[file] ? after[file] ? 'M' : 'D' : 'A', path: file }));
    },
  };
}

function ledger(entries: AssetLedger['entries']): AssetLedger {
  return {
    schemaVersion: 1, candidateId: 'candidate1', baseVersion, intent: 'insert', instanceId,
    entries, reference: { action: 'add', file: 'src/App.tsx', instanceId }, createdAt: '',
  };
}

describe('managed namespace and trusted attachment policy', () => {
  it('refuses model edits to managed config/component even with a syntactically valid src path', async () => {
    const before = { [`src/scene-modules/${instanceId}.json`]: configBytes };
    const after = { [`src/scene-modules/${instanceId}.json`]: Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n') };
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, undefined)).rejects.toMatchObject({ code: 'MANAGED_MODULE_DENIED' });
  });

  it('accepts a managed change only with exact path, operation and before/after bytes', async () => {
    const next = Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n');
    const before = { [`src/scene-modules/${instanceId}.json`]: configBytes, 'src/App.tsx': appBase };
    const after = { [`src/scene-modules/${instanceId}.json`]: next, 'src/App.tsx': appWithRef };
    const correct = ledger([
      { path: `src/scene-modules/${instanceId}.json`, operation: 'modify', role: 'config', beforeHash: hash(configBytes), afterHash: hash(next), bytes: next.length },
      { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length },
    ]);
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, correct)).resolves.toBeUndefined();
    const wrongBytes = ledger([correct.entries[0] && { ...correct.entries[0], afterHash: hash(Buffer.from('different')) }, correct.entries[1]!].filter(Boolean) as AssetLedger['entries']);
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, wrongBytes)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });
  });

  it('refuses a public model file without a trusted entry and accepts an exact create proof', async () => {
    const model = Buffer.from('glTF-not-really');
    const before = { 'src/App.tsx': appBase };
    const after = { 'src/App.tsx': appWithRef, 'public/assets/asset1.glb': model };
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, undefined)).rejects.toMatchObject({ code: 'UNSAFE_CANDIDATE_DIFF' });
    const policy = ledger([
      { path: 'public/assets/asset1.glb', operation: 'create', role: 'model', beforeHash: null, afterHash: hash(model), bytes: model.length, assetId: 'asset1' },
      { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length },
    ]);
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, policy)).resolves.toBeUndefined();
  });

  it('refuses a declared reference change when the source did not change', async () => {
    const before = { 'src/App.tsx': appBase };
    const after = { 'src/App.tsx': appBase };
    await expect(verifyCandidateLedger(fakeRepo(before, after), 'candidate1', baseVersion, ledger([]))).rejects.toMatchObject({ code: 'MODULE_REFERENCE_UNAPPROVED' });
  });

  it('refuses new, duplicate or dynamic instance references without the matching server intent', async () => {
    const base = { 'src/App.tsx': appBase };
    const added = { 'src/App.tsx': appWithRef };
    const noReference = ledger([{ path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length }]);
    const without = ledger([{ path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length }]);
    await expect(verifyCandidateLedger(fakeRepo(base, added), 'candidate1', baseVersion, { ...noReference, reference: null } as AssetLedger)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });
    await expect(verifyCandidateLedger(fakeRepo(base, added), 'candidate1', baseVersion, without)).resolves.toBeUndefined();
    const duplicate = { 'src/App.tsx': Buffer.from(`export default <main><SpatialModule instanceId="${instanceId}"/><SpatialModule instanceId="${instanceId}"/></main>;\n`) };
    await expect(verifyCandidateLedger(fakeRepo(base, duplicate), 'candidate1', baseVersion, withSource(base, duplicate))).rejects.toMatchObject({ code: 'MODULE_IMPORT_UNAPPROVED' });
    const dynamic = { 'src/App.tsx': Buffer.from('export default <main><SpatialModule instanceId={id}/></main>;\n') };
    await expect(verifyCandidateLedger(fakeRepo(base, dynamic), 'candidate1', baseVersion, withSource(base, dynamic))).rejects.toMatchObject({ code: 'MODULE_IMPORT_UNAPPROVED' });
  });

  it('refuses a literal model path written by page source', async () => {
    const base = { 'src/App.tsx': appBase };
    const after = { 'src/App.tsx': Buffer.from('export default <main><ProductScene modelUrl="/assets/asset1.glb"/></main>;\n') };
    const policy = ledger([{ path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(after['src/App.tsx']), bytes: after['src/App.tsx'].length }]);
    await expect(verifyCandidateLedger(fakeRepo(base, after), 'candidate1', baseVersion, policy)).rejects.toMatchObject({ code: 'MODEL_PATH_IN_SOURCE' });
  });

  it('rejects every noncanonical import/route to a module instance', () => {
    const good = `import SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";
export default () => <SpatialModel${instanceId}/>;
`;
    expect(() => auditTrustedImports(good, 'src/App.tsx')).not.toThrow();
    for (const source of [
      `import { SpatialModule as M } from '../spatial-module.tsx'; export default () => <M instanceId="${instanceId}"/>;`,
      `import * as M from './scene-modules/${instanceId}.tsx'; export default () => <M.default/>;`,
      `import X from './scene-modules/${instanceId}.tsx'; export default () => <X/>;`,
      `import SpatialModel${instanceId} from './scene-modules/${instanceId}'; export default () => <SpatialModel${instanceId}/>;`,
      `import SpatialModel${instanceId} from './scene-modules/${instanceId}.tsx'; export default () => <SpatialModel${instanceId} extra="x"/>;`,
      `import SpatialModel${instanceId} from './scene-modules/${instanceId}.tsx'; export default () => createElement(SpatialModel${instanceId});`,
      `export { default } from './scene-modules/${instanceId}.tsx';`,
      `const load = () => import('./scene-modules/${instanceId}.tsx');`,
      `const load = () => require('./spatial-module');`,
      `import { SpatialModule as M } from '/src/spatial-module.tsx'; export default () => <M instanceId="${instanceId}"/>;`,
      `import SpatialModel${instanceId} from '/src/scene-modules/${instanceId}.tsx'; export default () => <SpatialModel${instanceId}/>;`,
      `const files = import.meta.glob('./spatial-module*.tsx', { eager: true });`,
      `const files = import.meta.glob('./scene-modules/*.json', { eager: true });`,
      `const files = import.meta.glob(['./**/*', '!./components/skip']);`,
      `const files = import.meta.glob('/src/spatial-module*');`,
      `const files = import.meta.glob(pattern);`,
      `const load = () => import(name);`,
      `const load = () => require(name);`,
      `const el = createElement('SpatialModule');`,
    ]) expect(() => auditTrustedImports(source, 'src/App.tsx')).toThrow();
  });

  it('allows ordinary DOM, ordinary file imports and ordinary globs', () => {
    for (const source of [
      `const el = document.createElement('div');`,
      `const el = React.createElement(Button);`,
      `const load = () => import('./Section');`,
      `const load = () => require('./image.png');`,
      `const files = import.meta.glob('./components/*.tsx', { eager: true });`,
      `const files = import.meta.glob(['./components/**', '!./components/secret']);`,
    ]) expect(() => auditTrustedImports(source, 'src/App.tsx')).not.toThrow();
  });

  it('rejects a shadow renderer or extra managed file in the baseline', async () => {
    const before = { 'src/spatial-module.ts': Buffer.from('export function SpatialModule(){return null}'), 'src/App.tsx': appBase };
    await expect(verifyCandidateLedger(fakeRepo(before, before), 'candidate1', baseVersion, undefined)).rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
  });

  it('scanner keeps anchor identity and rejects extra renderer props', () => {
    const source = `<main><SpatialModule instanceId="${instanceId}"/><SpatialModule instanceId="${instanceId}" model="/assets/x.glb"/></main>`;
    const refs = scanModuleReferences(source, 'src/App.tsx');
    expect(refs).toHaveLength(2);
    expect(refs[0].instanceId).toBe(instanceId);
    expect(refs[1].dynamic).toBe(true);
  });
});

function withSource(before: Record<string, Buffer>, after: Record<string, Buffer>): AssetLedger {
  const from = before['src/App.tsx']!, to = after['src/App.tsx']!;
  return ledger([{ path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(from), afterHash: hash(to), bytes: to.length }]);
}
