import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@spatial/scene-renderer', () => ({
  ProductScene: ({ modelUrl, animation }: { modelUrl: string; animation?: { playing: boolean; clip?: string; loop?: boolean } }) => (
    <div
      data-testid="mock-product-scene"
      data-model-url={modelUrl}
      data-clip={animation?.clip ?? ''}
      data-playing={String(Boolean(animation?.playing))}
    />
  ),
}));

import {
  ArtifactGlbPreview,
  MAX_ACTIVE_GLB_PREVIEWS,
  promotePreviewId,
  resolveActivePreviewIds,
} from './Lux3DWorkbench.tsx';

describe('Lux3DWorkbench WebGL budget and isolated animation previews', () => {
  it('activates up to MAX_ACTIVE_GLB_PREVIEWS newest GLB cards automatically and evicts oldest on manual promotion', () => {
    const ordered = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const initial = resolveActivePreviewIds(ordered, []);
    expect(initial.size).toBe(MAX_ACTIVE_GLB_PREVIEWS);
    expect([...initial]).toEqual(['a1', 'a2', 'a3', 'a4']);

    let manual = promotePreviewId([], 'a6');
    const afterOne = resolveActivePreviewIds(ordered, manual);
    expect(afterOne.size).toBe(MAX_ACTIVE_GLB_PREVIEWS);
    expect(afterOne.has('a6')).toBe(true);
    expect([...afterOne]).toEqual(['a6', 'a1', 'a2', 'a3']);

    manual = promotePreviewId(manual, 'a5');
    const afterTwo = resolveActivePreviewIds(ordered, manual);
    expect(afterTwo.size).toBe(MAX_ACTIVE_GLB_PREVIEWS);
    expect([...afterTwo]).toEqual(['a5', 'a6', 'a1', 'a2']);

    // Stale manual IDs that are no longer in the task list are ignored cleanly.
    const afterPrune = resolveActivePreviewIds(['a2', 'a3'], ['deleted-id', 'a3']);
    expect([...afterPrune]).toEqual(['a3', 'a2']);
  });

  it('keeps animation clip lists isolated per artifact card and renders deferred placeholder when inactive', () => {
    const firstHtml = renderToStaticMarkup(
      <ArtifactGlbPreview previewUrl="/model-1.glb" active onActivate={() => {}} initialClips={['Walk_Loop', 'Run_Loop']} />,
    );
    const secondHtml = renderToStaticMarkup(
      <ArtifactGlbPreview previewUrl="/model-2.glb" active onActivate={() => {}} initialClips={['Dance_Loop']} />,
    );
    const deferredHtml = renderToStaticMarkup(
      <ArtifactGlbPreview previewUrl="/model-3.glb" active={false} onActivate={() => {}} initialClips={['Idle_Loop']} />,
    );

    expect(firstHtml).toContain('data-model-url="/model-1.glb"');
    expect(firstHtml).toContain('data-clip="Walk_Loop"');
    expect(firstHtml).toContain('<option value="Walk_Loop" selected="">Walk_Loop</option>');
    expect(firstHtml).not.toContain('Dance_Loop');

    expect(secondHtml).toContain('data-model-url="/model-2.glb"');
    expect(secondHtml).toContain('data-clip="Dance_Loop"');
    expect(secondHtml).toContain('<option value="Dance_Loop" selected="">Dance_Loop</option>');
    expect(secondHtml).not.toContain('Walk_Loop');

    expect(deferredHtml).toContain('data-testid="lux-preview-deferred"');
    expect(deferredHtml).toContain('加载 3D 预览');
    expect(deferredHtml).not.toContain('data-testid="mock-product-scene"');
  });
});
