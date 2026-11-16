import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultSceneModuleConfig } from '@spatial/shared/scene-module';
import { auditTrustedImports, managedBaselineListing, scanModuleReferences, verifyCandidateLedger, type AssetLedger, type LedgerRepo } from './asset-ledger.ts';

const instanceId = 'a'.repeat(32);
const baseVersion = 'b'.repeat(40);
const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
const appBase = Buffer.from('export default <main/>;\n');
const appWithRef = Buffer.from(`import SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";
export default <main><SpatialModel${instanceId}/></main>;
`);

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

function countingRepo(before: Record<string, Buffer>, after: Record<string, Buffer>) {
  const repo = fakeRepo(before, after);
  const state = { listTree: 0 };
  const original = repo.listTree.bind(repo);
  repo.listTree = async (revision: string) => { state.listTree += 1; return original(revision); };
  return { repo, state };
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
      `const files = import.meta.glob('./scene-*/b*.json', { eager: true });`,
      `const files = import.meta.glob('./@(spatial|x)-module.tsx', { eager: true });`,
      `const files = import.meta.glob('./spatial\\-module.tsx', { eager: true });`,
      `import { SpatialModule as M } from '/@fs/E:/work/src/spatial-module.tsx'; export default () => <M instanceId="${instanceId}"/>;`,
      `import { SpatialModule as M } from 'E:/work/src/spatial-module.tsx'; export default () => <M instanceId="${instanceId}"/>;`,
      `import { SpatialModule as M } from 'file:///E:/work/src/spatial-module.tsx'; export default () => <M instanceId="${instanceId}"/>;`,
      `import X from '/@fs/E:/work/src/components/Button.tsx'; export default () => <X/>;`,
      `import X from 'E:/work/src/components/Button.tsx'; export default () => <X/>;`,
      `import X from 'file:///E:/work/src/components/Button.tsx'; export default () => <X/>;`,
      `import X from '//server/share/src/components/Button.tsx'; export default () => <X/>;`,
      `import X from './components/SPATIA~1.TSX'; export default () => <X/>;`,
      `const files = import.meta.glob('./components/{a,..}/*.tsx');`,
      `const files = import.meta.glob('./components/SPATIA~1.TSX');`,
      `const files = import.meta.glob('./*.tsx');`,
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
      `const files = import.meta.glob('./components/{A,B}.tsx');`,
      `import { Card } from './components/spatial-module-card.tsx'; export default () => <Card/>;`,
      `import { Card } from '/src/components/Button.tsx'; export default () => <Card/>;`,
      `import { Card } from './components/scene-modules-card.tsx'; export default () => <Card/>;`,
    ]) expect(() => auditTrustedImports(source, 'src/App.tsx')).not.toThrow();
  });

  it('rejects a shadow renderer or extra managed file in the baseline', async () => {
    const before = { 'src/spatial-module.ts': Buffer.from('export function SpatialModule(){return null}'), 'src/App.tsx': appBase };
    await expect(verifyCandidateLedger(fakeRepo(before, before), 'candidate1', baseVersion, undefined)).rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
  });

  it('reuses only a complete listing from the same repo and full commit, and never skips managed or ledger checks', async () => {
    const shadow = { 'src/spatial-module.ts': Buffer.from('export function SpatialModule(){return null}'), 'src/App.tsx': appBase };
    const same = countingRepo(shadow, shadow);
    const sameCommit = managedBaselineListing(same.repo, baseVersion, Object.keys(shadow));
    await expect(verifyCandidateLedger(same.repo, 'candidate1', baseVersion, undefined, sameCommit))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    // The managed audit still read the shadow bytes through the reused listing: it did not
    // re-enumerate the tree, yet it still rejected the invalid baseline.
    expect(same.state.listTree).toBe(0);

    // A listing issued by another repo is not trusted, even for the same revision.
    const foreign = countingRepo(shadow, shadow);
    await expect(verifyCandidateLedger(foreign.repo, 'candidate1', baseVersion, undefined, sameCommit))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(foreign.state.listTree).toBe(1);

    // Another commit, an abbreviated revision, a fabricated list and a truncated copy all fall back.
    const otherCommitRepo = countingRepo(shadow, shadow);
    const otherCommit = managedBaselineListing(otherCommitRepo.repo, 'c'.repeat(40), Object.keys(shadow));
    await expect(verifyCandidateLedger(otherCommitRepo.repo, 'candidate1', baseVersion, undefined, otherCommit))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(otherCommitRepo.state.listTree).toBe(1);

    const abbreviatedRepo = countingRepo(shadow, shadow);
    const abbreviated = managedBaselineListing(abbreviatedRepo.repo, baseVersion, Object.keys(shadow));
    await expect(verifyCandidateLedger(abbreviatedRepo.repo, 'candidate1', baseVersion.slice(0, 7), undefined, abbreviated))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(abbreviatedRepo.state.listTree).toBe(1);

    const fabricatedRepo = countingRepo(shadow, shadow);
    await expect(verifyCandidateLedger(fabricatedRepo.repo, 'candidate1', baseVersion, undefined, { revision: baseVersion, files: [] }))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(fabricatedRepo.state.listTree).toBe(1);

    const truncatedRepo = countingRepo(shadow, shadow);
    const truncated = managedBaselineListing(truncatedRepo.repo, baseVersion, Object.keys(shadow));
    await expect(verifyCandidateLedger(truncatedRepo.repo, 'candidate1', baseVersion, undefined, { revision: baseVersion, files: truncated.files.slice(0, 1) }))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(truncatedRepo.state.listTree).toBe(1);

    const next = Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n');
    const before = { [`src/scene-modules/${instanceId}.json`]: configBytes, 'src/App.tsx': appBase };
    const after = { [`src/scene-modules/${instanceId}.json`]: next, 'src/App.tsx': appWithRef };
    const positive = countingRepo(before, after);
    const listing = managedBaselineListing(positive.repo, baseVersion, Object.keys(before));
    const correct = ledger([
      { path: `src/scene-modules/${instanceId}.json`, operation: 'modify', role: 'config', beforeHash: hash(configBytes), afterHash: hash(next), bytes: next.length },
      { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length },
    ]);
    await expect(verifyCandidateLedger(positive.repo, 'candidate1', baseVersion, correct, listing)).resolves.toBeUndefined();
    expect(positive.state.listTree).toBe(0);
    const wrongBytes = ledger([{ ...correct.entries[0]!, afterHash: hash(Buffer.from('different')) }, correct.entries[1]!]);
    await expect(verifyCandidateLedger(positive.repo, 'candidate1', baseVersion, wrongBytes, listing)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });

    const wrongBaseRepo = countingRepo(before, after);
    const wrongBase = managedBaselineListing(wrongBaseRepo.repo, 'd'.repeat(40), Object.keys(before));
    await expect(verifyCandidateLedger(wrongBaseRepo.repo, 'candidate1', baseVersion, undefined, wrongBase)).rejects.toMatchObject({ code: 'MANAGED_MODULE_DENIED' });
    expect(wrongBaseRepo.state.listTree).toBe(1);
  });

  it('re-reads candidate bytes on every verification and rejects a change made between them', async () => {
    const next = Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n');
    const before = { [`src/scene-modules/${instanceId}.json`]: configBytes, 'src/App.tsx': appBase };
    const after: Record<string, Buffer> = { [`src/scene-modules/${instanceId}.json`]: next, 'src/App.tsx': appWithRef };
    const { repo, state } = countingRepo(before, after);
    const listing = managedBaselineListing(repo, baseVersion, Object.keys(before));
    const correct = ledger([
      { path: `src/scene-modules/${instanceId}.json`, operation: 'modify', role: 'config', beforeHash: hash(configBytes), afterHash: hash(next), bytes: next.length },
      { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length },
    ]);
    await expect(verifyCandidateLedger(repo, 'candidate1', baseVersion, correct, listing)).resolves.toBeUndefined();
    after[`src/scene-modules/${instanceId}.json`] = Buffer.from(JSON.stringify({ ...config, scale: 3 }, null, 2) + '\n');
    await expect(verifyCandidateLedger(repo, 'candidate1', baseVersion, correct, listing)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });
    expect(state.listTree).toBe(0);
  });

  it('still refuses a renamed file carrying a ledger entry', async () => {
    const renamed: LedgerRepo = {
      ...fakeRepo({ 'src/A.tsx': appBase }, { 'src/B.tsx': appBase }),
      async diffNameStatus() { return [{ status: 'R100', from: 'src/A.tsx', path: 'src/B.tsx' }]; },
      async listTree() { return ['src/A.tsx']; },
    };
    const stale = ledger([{ path: 'src/A.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appBase), bytes: appBase.length }]);
    await expect(verifyCandidateLedger(renamed, 'candidate1', baseVersion, stale)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });
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
