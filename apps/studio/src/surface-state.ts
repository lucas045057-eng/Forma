export type StudioSurface = 'canvas' | 'inspector' | 'scene' | 'assets';

export type SurfaceAction =
  | { type: 'toggle-assets' }
  | { type: 'toggle-scene' }
  | { type: 'toggle-inspector' }
  | { type: 'open-inspector' }
  | { type: 'close' }
  | { type: 'pick-started' }
  | { type: 'pick-received' }
  | { type: 'impact-highlight' }
  | { type: 'approval-arrived' }
  | { type: 'placement-started'; fromDrag: boolean }
  | { type: 'work-switched' }
  | { type: 'work-created'; openInspector: boolean }
  | { type: 'escape'; blocked: boolean };

/** Single mutually-exclusive surface state machine for drawers/panels over the spatial canvas. */
export function reduceStudioSurface(current: StudioSurface, action: SurfaceAction): StudioSurface {
  switch (action.type) {
    case 'toggle-assets':
      return current === 'assets' ? 'canvas' : 'assets';
    case 'toggle-scene':
      return current === 'scene' ? 'canvas' : 'scene';
    case 'toggle-inspector':
      return current === 'inspector' ? 'canvas' : 'inspector';
    case 'open-inspector':
    case 'pick-received':
    case 'impact-highlight':
    case 'approval-arrived':
      return 'inspector';
    case 'close':
    case 'work-switched':
      return 'canvas';
    case 'pick-started':
      return current === 'inspector' ? 'inspector' : 'canvas';
    case 'placement-started':
      return action.fromDrag && current === 'assets' ? 'assets' : 'canvas';
    case 'work-created':
      return action.openInspector ? 'inspector' : 'canvas';
    case 'escape':
      return action.blocked ? current : 'canvas';
  }
}

export function surfaceFlags(surface: StudioSurface) {
  return {
    showAssets: surface === 'assets',
    showScene: surface === 'scene',
    inspectorOpen: surface === 'inspector' || surface === 'scene',
  } as const;
}
