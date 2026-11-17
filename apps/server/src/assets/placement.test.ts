import { expect, it } from 'vitest';
import { classifyTarget } from './placement.ts';
import type { WorkService } from '../work/service.ts';
import type { ModuleSceneService } from '../scene/modules.ts';

const source = 'export function ProductHero(){return <div data-testid="product-scene"><ProductScene/></div>;}\n';
const column = source.indexOf('<div') + 1;
const work = { repo: { workRoot: 'C:/work', fileBufferAt: async () => Buffer.from(source) } } as unknown as WorkService;
const modules = {} as ModuleSceneService;
const baseVersion = 'a'.repeat(40);

it('identifies the real main slot from source, not from the iframe-declared kind', async () => {
  const target = { kind: 'replace' as const, src: `src/components/ProductHero.tsx:1:${column}`, cid: 'div', ancestors: [], position: 'inside' as const };
  await expect(classifyTarget({ work, modules, baseVersion, target })).resolves.toEqual({ kind: 'replace' });
  await expect(classifyTarget({ work, modules, baseVersion, target: { ...target, kind: 'insert' } })).rejects.toMatchObject({ code: 'PLACEMENT_TARGET_MISMATCH' });
});

it('rejects replace hints on an ordinary element and accepts it only as an insert', async () => {
  const button = 'export default ()=> <main><button>购买</button></main>;\n';
  const localWork = { repo: { workRoot: 'C:/work', fileBufferAt: async () => Buffer.from(button) } } as unknown as WorkService;
  const column = button.indexOf('<button') + 1;
  const target = { kind: 'replace' as const, src: `src/App.tsx:1:${column}`, cid: 'button', ancestors: [], position: 'after' as const };
  await expect(classifyTarget({ work: localWork, modules, baseVersion, target })).rejects.toMatchObject({ code: 'PLACEMENT_TARGET_MISMATCH' });
  await expect(classifyTarget({ work: localWork, modules, baseVersion, target: { ...target, kind: 'insert' } })).resolves.toEqual({ kind: 'insert' });
});

it('rejects stale or missing source instead of guessing a nearby target', async () => {
  const target = { kind: 'insert' as const, src: 'src/App.tsx:999:1', cid: 'Node', ancestors: [], position: 'after' as const };
  await expect(classifyTarget({ work, modules, baseVersion, target })).rejects.toMatchObject({ code: 'STALE_PLACEMENT_TARGET' });
  const missing = { repo: { workRoot: 'C:/work', fileBufferAt: async () => undefined } } as unknown as WorkService;
  await expect(classifyTarget({ work: missing, modules, baseVersion, target })).rejects.toMatchObject({ code: 'STALE_PLACEMENT_TARGET' });
});
