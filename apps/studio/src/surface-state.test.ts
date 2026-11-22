import { describe, expect, it } from 'vitest';
import { reduceStudioSurface, surfaceFlags, type StudioSurface, type SurfaceAction } from './surface-state.ts';

const ALL_SURFACES: readonly StudioSurface[] = ['canvas', 'inspector', 'scene', 'assets'];
const ALL_ACTIONS: readonly SurfaceAction[] = [
  { type: 'toggle-assets' },
  { type: 'toggle-scene' },
  { type: 'toggle-inspector' },
  { type: 'open-inspector' },
  { type: 'close' },
  { type: 'pick-started' },
  { type: 'pick-received' },
  { type: 'impact-highlight' },
  { type: 'approval-arrived' },
  { type: 'placement-started', fromDrag: false },
  { type: 'placement-started', fromDrag: true },
  { type: 'work-switched' },
  { type: 'work-created', openInspector: false },
  { type: 'work-created', openInspector: true },
  { type: 'escape', blocked: false },
  { type: 'escape', blocked: true },
];

describe('StudioSurface mutual exclusion invariants', () => {
  it('never permits showAssets to overlap with showScene or inspectorOpen across the entire transition matrix', () => {
    for (const initial of ALL_SURFACES) {
      for (const action of ALL_ACTIONS) {
        const next = reduceStudioSurface(initial, action);
        const flags = surfaceFlags(next);
        expect(flags.showAssets && flags.showScene).toBe(false);
        expect(flags.showAssets && flags.inspectorOpen).toBe(false);
        expect(!flags.showScene || flags.inspectorOpen).toBe(true);
      }
    }
  });

  it('toggles assets, scene, and inspector mutually exclusively and closes on second click', () => {
    let surface: StudioSurface = 'canvas';
    expect(surfaceFlags(surface)).toEqual({ showAssets: false, showScene: false, inspectorOpen: false });

    surface = reduceStudioSurface(surface, { type: 'toggle-assets' });
    expect(surface).toBe('assets');
    surface = reduceStudioSurface(surface, { type: 'toggle-scene' });
    expect(surface).toBe('scene');
    surface = reduceStudioSurface(surface, { type: 'toggle-assets' });
    expect(surface).toBe('assets');
    surface = reduceStudioSurface(surface, { type: 'toggle-assets' });
    expect(surface).toBe('canvas');

    surface = reduceStudioSurface(surface, { type: 'toggle-inspector' });
    expect(surface).toBe('inspector');
    surface = reduceStudioSurface(surface, { type: 'toggle-scene' });
    expect(surface).toBe('scene');
    surface = reduceStudioSurface(surface, { type: 'toggle-scene' });
    expect(surface).toBe('canvas');
  });

  it('handles pick-started, drag vs click placement, escape blocking, and work creation', () => {
    expect(reduceStudioSurface('assets', { type: 'pick-started' })).toBe('canvas');
    expect(reduceStudioSurface('scene', { type: 'pick-started' })).toBe('canvas');
    expect(reduceStudioSurface('inspector', { type: 'pick-started' })).toBe('inspector');

    // Drag placement keeps AssetPanel mounted so browser drag does not abort; click placement closes it.
    expect(reduceStudioSurface('assets', { type: 'placement-started', fromDrag: true })).toBe('assets');
    expect(reduceStudioSurface('assets', { type: 'placement-started', fromDrag: false })).toBe('canvas');

    expect(reduceStudioSurface('inspector', { type: 'escape', blocked: true })).toBe('inspector');
    expect(reduceStudioSurface('inspector', { type: 'escape', blocked: false })).toBe('canvas');

    expect(reduceStudioSurface('assets', { type: 'work-created', openInspector: true })).toBe('inspector');
    expect(reduceStudioSurface('inspector', { type: 'work-created', openInspector: false })).toBe('canvas');
  });
});
