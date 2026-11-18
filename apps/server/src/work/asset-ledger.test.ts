import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultSceneModuleConfig } from '@spatial/shared/scene-module';
import { auditManagedBaseline, auditTrustedImports, scanModuleReferences, verifyCandidateLedger, type AssetLedger, type LedgerRepo, type TreeSource } from './asset-ledger.ts';

const instanceId = 'a'.repeat(32);
const baseVersion = 'b'.repeat(40);
const config = defaultSceneModuleConfig({ instanceId, assetId: 'asset1' });
const configBytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
const appBase = Buffer.from('export default <main/>;\n');
const appWithRef = Buffer.from(`import SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";
export default <main><SpatialModel${instanceId}/></main>;
`);

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

function fakeRepo(before: Record<string, Buffer>, after: Record<string, Buffer>): LedgerRepo & TreeSource {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return {
    candidatePath: () => 'C:/candidate',
    async candidateBufferAt(_id, file) { return after[file]; },
    async readTree() { return Object.keys(before).map(file => `100644 blob ${'0'.repeat(40)}\t${file}`); },
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
  const state = { listTree: 0, readTree: 0 };
  const originalListTree = repo.listTree.bind(repo);
  const originalReadTree = repo.readTree.bind(repo);
  repo.listTree = async (revision: string) => { state.listTree += 1; return originalListTree(revision); };
  repo.readTree = async (revision: string) => { state.readTree += 1; return originalReadTree(revision); };
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

  it('issues a listing only from the repository tree and reuses it only for the same repo and full commit', async () => {
    const validTree = () => ({ [`src/scene-modules/${instanceId}.json`]: configBytes, 'src/App.tsx': appBase });
    const shadow = { 'src/spatial-module.ts': Buffer.from('export function SpatialModule(){return null}'), 'src/App.tsx': appBase };

    // Issuance always reads the real tree; no exported call accepts a caller-supplied file list.
    const issuedTree = validTree();
    const issuedRepo = countingRepo(issuedTree, validTree());
    const listing = await auditManagedBaseline(issuedRepo.repo, baseVersion);
    expect(issuedRepo.state.readTree).toBe(1);
    expect(issuedRepo.state.listTree).toBe(0);

    // Same repo + full commit: the file list is reused, the managed bytes are still re-read.
    await expect(verifyCandidateLedger(issuedRepo.repo, 'candidate1', baseVersion, undefined, listing)).resolves.toBeUndefined();
    expect(issuedRepo.state.listTree).toBe(0);
    issuedTree[`src/scene-modules/${instanceId}.json`] = Buffer.from('{"broken":true}');
    await expect(verifyCandidateLedger(issuedRepo.repo, 'candidate1', baseVersion, undefined, listing))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(issuedRepo.state.listTree).toBe(0);

    // The listing is bound to the repo that issued it, even for an identical revision.
    const foreign = countingRepo(validTree(), validTree());
    await expect(verifyCandidateLedger(foreign.repo, 'candidate1', baseVersion, undefined, listing)).resolves.toBeUndefined();
    expect(foreign.state.listTree).toBe(1);

    // Another commit and an abbreviated revision are not reused either.
    const otherCommitRepo = countingRepo(validTree(), validTree());
    const otherCommit = await auditManagedBaseline(otherCommitRepo.repo, 'c'.repeat(40));
    await expect(verifyCandidateLedger(otherCommitRepo.repo, 'candidate1', baseVersion, undefined, otherCommit)).resolves.toBeUndefined();
    expect(otherCommitRepo.state.listTree).toBe(1);

    const abbreviatedRepo = countingRepo(validTree(), validTree());
    const abbreviated = await auditManagedBaseline(abbreviatedRepo.repo, baseVersion);
    await expect(verifyCandidateLedger(abbreviatedRepo.repo, 'candidate1', baseVersion.slice(0, 7), undefined, abbreviated)).resolves.toBeUndefined();
    expect(abbreviatedRepo.state.listTree).toBe(1);

    // A hand-written or truncated list is never trusted: the shadow tree is enumerated and rejected.
    const fabricatedRepo = countingRepo(shadow, shadow);
    await expect(verifyCandidateLedger(fabricatedRepo.repo, 'candidate1', baseVersion, undefined, { revision: baseVersion, files: [] }))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(fabricatedRepo.state.listTree).toBe(1);

    const truncatedRepo = countingRepo(shadow, shadow);
    await expect(verifyCandidateLedger(truncatedRepo.repo, 'candidate1', baseVersion, undefined, { revision: baseVersion, files: listing.files.slice(0, 0) }))
      .rejects.toMatchObject({ code: 'INVALID_MANAGED_BASELINE' });
    expect(truncatedRepo.state.listTree).toBe(1);

    const next = Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n');
    const before = validTree();
    const after = { [`src/scene-modules/${instanceId}.json`]: next, 'src/App.tsx': appWithRef };
    const positive = countingRepo(before, after);
    const positiveListing = await auditManagedBaseline(positive.repo, baseVersion);
    const correct = ledger([
      { path: `src/scene-modules/${instanceId}.json`, operation: 'modify', role: 'config', beforeHash: hash(configBytes), afterHash: hash(next), bytes: next.length },
      { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appBase), afterHash: hash(appWithRef), bytes: appWithRef.length },
    ]);
    await expect(verifyCandidateLedger(positive.repo, 'candidate1', baseVersion, correct, positiveListing)).resolves.toBeUndefined();
    expect(positive.state.listTree).toBe(0);
    const wrongBytes = ledger([{ ...correct.entries[0]!, afterHash: hash(Buffer.from('different')) }, correct.entries[1]!]);
    await expect(verifyCandidateLedger(positive.repo, 'candidate1', baseVersion, wrongBytes, positiveListing)).rejects.toMatchObject({ code: 'INVALID_LEDGER' });

    const wrongBase = await auditManagedBaseline(positive.repo, 'd'.repeat(40));
    await expect(verifyCandidateLedger(positive.repo, 'candidate1', baseVersion, undefined, wrongBase)).rejects.toMatchObject({ code: 'MANAGED_MODULE_DENIED' });
    expect(positive.state.listTree).toBe(1);
  });

  it('re-reads candidate bytes on every verification and rejects a change made between them', async () => {
    const next = Buffer.from(JSON.stringify({ ...config, scale: 2 }, null, 2) + '\n');
    const before = { [`src/scene-modules/${instanceId}.json`]: configBytes, 'src/App.tsx': appBase };
    const after: Record<string, Buffer> = { [`src/scene-modules/${instanceId}.json`]: next, 'src/App.tsx': appWithRef };
    const { repo, state } = countingRepo(before, after);
    const listing = await auditManagedBaseline(repo, baseVersion);
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

  it('allows placing a second 3D module, removing one of multiple modules, and editing lines above an existing module', async () => {
    const secondId = 'c'.repeat(32);
    const secondConfig = defaultSceneModuleConfig({ instanceId: secondId, assetId: 'asset1' });
    const secondConfigBytes = Buffer.from(JSON.stringify(secondConfig, null, 2) + '\n');
    const componentA = Buffer.from(`// Generated by Spatial AI Workbench. Do not edit.\nimport { SpatialModule } from '../spatial-module.tsx';\nexport default function SpatialModel${instanceId}() { return <SpatialModule instanceId="${instanceId}" />; }\n`);
    const componentC = Buffer.from(`// Generated by Spatial AI Workbench. Do not edit.\nimport { SpatialModule } from '../spatial-module.tsx';\nexport default function SpatialModel${secondId}() { return <SpatialModule instanceId="${secondId}" />; }\n`);

    const appWithOne = Buffer.from(
      `import SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";\nexport default () => <main>\n  <section id="a"><h1>Title</h1></section>\n  <SpatialModel${instanceId}/>\n</main>;\n`,
    );
    const appWithTwo = Buffer.from(
      `import SpatialModel${secondId} from "./scene-modules/${secondId}.tsx";\nimport SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";\nexport default () => <main>\n  <section id="a"><h1>Title</h1><SpatialModel${secondId}/></section>\n  <SpatialModel${instanceId}/>\n</main>;\n`,
    );
    const addedSecondRef = scanModuleReferences(appWithTwo.toString('utf8'), 'src/App.tsx').find(r => r.instanceId === secondId)!;

    const beforeTree = {
      [`src/scene-modules/${instanceId}.json`]: configBytes,
      [`src/scene-modules/${instanceId}.tsx`]: componentA,
      'src/App.tsx': appWithOne,
    };
    const afterTree = {
      ...beforeTree,
      [`src/scene-modules/${secondId}.json`]: secondConfigBytes,
      [`src/scene-modules/${secondId}.tsx`]: componentC,
      'src/App.tsx': appWithTwo,
    };
    const secondLedger: AssetLedger = {
      schemaVersion: 1,
      candidateId: 'candidate1',
      baseVersion,
      intent: 'insert',
      instanceId: secondId,
      entries: [
        { path: `src/scene-modules/${secondId}.json`, operation: 'create', role: 'config', beforeHash: null, afterHash: hash(secondConfigBytes), bytes: secondConfigBytes.length, assetId: 'asset1', instanceId: secondId },
        { path: `src/scene-modules/${secondId}.tsx`, operation: 'create', role: 'component', beforeHash: null, afterHash: hash(componentC), bytes: componentC.length, instanceId: secondId },
        { path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(appWithOne), afterHash: hash(appWithTwo), bytes: appWithTwo.length, instanceId: secondId },
      ],
      reference: { action: 'add', file: 'src/App.tsx', instanceId: secondId, anchor: `${addedSecondRef.line}:${addedSecondRef.column}` },
      createdAt: '',
    };
    await expect(verifyCandidateLedger(fakeRepo(beforeTree, afterTree), 'candidate1', baseVersion, secondLedger)).resolves.toBeUndefined();

    // Ordinary AI edit adding lines above an existing placed 3D module must pass when the module stays intact in the same file.
    const appWithEditedHeader = Buffer.from(
      `import SpatialModel${instanceId} from "./scene-modules/${instanceId}.tsx";\nexport default () => <main>\n  <header>\n    <p>New Banner</p>\n  </header>\n  <section id="a"><h1>Updated</h1></section>\n  <SpatialModel${instanceId}/>\n</main>;\n`,
    );
    await expect(verifyCandidateLedger(fakeRepo(beforeTree, { ...beforeTree, 'src/App.tsx': appWithEditedHeader }), 'candidate1', baseVersion, undefined)).resolves.toBeUndefined();

    // Ordinary AI edit deleting an existing placed 3D module without ledger is still rejected.
    const appDeletedModule = Buffer.from(`export default () => <main><section id="a"><h1>Updated</h1></section></main>;\n`);
    await expect(verifyCandidateLedger(fakeRepo(beforeTree, { ...beforeTree, 'src/App.tsx': appDeletedModule }), 'candidate1', baseVersion, undefined)).rejects.toMatchObject({ code: 'MODULE_REFERENCE_UNAPPROVED' });
  });
});

function withSource(before: Record<string, Buffer>, after: Record<string, Buffer>): AssetLedger {
  const from = before['src/App.tsx']!, to = after['src/App.tsx']!;
  return ledger([{ path: 'src/App.tsx', operation: 'modify', role: 'source', beforeHash: hash(from), afterHash: hash(to), bytes: to.length }]);
}
