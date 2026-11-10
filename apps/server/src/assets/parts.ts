import { getBounds, type Document, type Node } from '@gltf-transform/core';

export interface PartsMetadata {
  recognized: boolean;
  reason?: string;
  nodes: Array<{ sourceIndex: number; name: string; bounds: { min: number[]; max: number[] } }>;
  lid?: string;
}

/** Classify only unambiguous upright diffuser geometry in normalized world coordinates. */
export function groupParts(document: Document, sourceNodes: Node[]): PartsMetadata {
  const candidates = sourceNodes.filter((node) => node.getMesh());
  const entries = candidates.map((node) => ({
    node, sourceIndex: sourceNodes.indexOf(node), bounds: getBounds(node),
  }));
  const metadata: PartsMetadata = {
    recognized: false,
    nodes: entries.map(({ node, sourceIndex, bounds }) => ({ sourceIndex, name: node.getName(), bounds })),
  };
  const fail = (reason: string) => {
    // An unrecognized source model must not smuggle in a pre-existing marker.
    for (const node of sourceNodes) {
      const { spatialPart, ...extras } = node.getExtras() as Record<string, unknown>;
      if (spatialPart !== undefined) node.setExtras(extras);
    }
    return { ...metadata, reason };
  };
  if (entries.length < 3) return fail('Expected body, cap and at least one reed');
  const scenes = document.getRoot().listScenes();
  if (scenes.length !== 1 || candidates.some((node) => node.listChildren().length || node.getSkin())) {
    return fail('Unsupported multi-scene, nested mesh or skinned geometry');
  }
  if (document.getRoot().listAnimations().length) return fail('Animated geometry cannot be safely regrouped');
  const size = (entry: typeof entries[number]) => entry.bounds.max.map((v, i) => v - entry.bounds.min[i]!);
  if (entries.some((entry) => size(entry).some((v) => !Number.isFinite(v) || v <= 0))) {
    return fail('Invalid or degenerate part bounds');
  }
  const volume = (entry: typeof entries[number]) => size(entry).reduce((a, b) => a * b, 1);
  const sorted = [...entries].sort((a, b) => a.bounds.min[1] - b.bounds.min[1]);
  const body = sorted[0]!;
  const tolerance = 0.02;
  const bodySize = size(body);
  // Splayed reeds can have a slightly larger AABB than the solid body.
  // Require a uniquely lowest, broad body whose volume is near the maximum.
  if (volume(body) < Math.max(...entries.map(volume)) * 0.9
    || bodySize[1]! > Math.max(bodySize[0]!, bodySize[2]!) * 2
    || entries.some((entry) => entry !== body && entry.bounds.min[1] <= body.bounds.min[1] + tolerance)) {
    return fail('No unique lowest, near-largest-volume body');
  }
  const caps = entries.filter((entry) => {
    if (entry === body) return false;
    const s = size(entry);
    return Math.abs(entry.bounds.min[1] - body.bounds.max[1]) <= tolerance
      && s[0]! >= bodySize[0]! * 0.45 && s[2]! >= bodySize[2]! * 0.45
      && s[0]! <= bodySize[0]! * 1.1 && s[2]! <= bodySize[2]! * 1.1
      && s[1]! <= Math.min(s[0]!, s[2]!)
      && [0, 2].every((axis) => entry.bounds.min[axis]! >= body.bounds.min[axis]! - tolerance
        && entry.bounds.max[axis]! <= body.bounds.max[axis]! + tolerance);
  });
  if (caps.length !== 1) return fail('No unique broad cap touching the body top');
  const cap = caps[0]!;
  const reeds = entries.filter((entry) => entry !== body && entry !== cap);
  if (!reeds.every((entry) => {
    const s = size(entry);
    return s[1]! >= Math.max(s[0]!, s[2]!) * 2
      && entry.bounds.max[1] > cap.bounds.max[1] + tolerance
      && entry.bounds.min[1] >= cap.bounds.min[1] - tolerance
      && entry.bounds.min[1] <= cap.bounds.max[1] + tolerance
      && [0, 2].every((axis) => entry.bounds.min[axis]! <= cap.bounds.max[axis]!
        && entry.bounds.max[axis]! >= cap.bounds.min[axis]!);
  })) return fail('Remaining geometry is not unambiguously upward reeds');

  const moving = [cap, ...reeds];
  const matrices = moving.map(({ node }) => node.getWorldMatrix());
  // Node.setMatrix stores TRS. Refuse matrices with shear instead of changing their world geometry.
  const probe = document.createNode();
  const representable = matrices.every((matrix) => {
    probe.setMatrix(matrix);
    return probe.getMatrix().every((v, i) => Math.abs(v - matrix[i]!) < 1e-6);
  });
  probe.dispose();
  if (!representable) return fail('World transforms contain shear that cannot be preserved');
  const lid = document.createNode('lid');
  scenes[0]!.addChild(lid);
  body.node.setName('body');
  cap.node.setName('cap');
  reeds.forEach(({ node }, index) => node.setName(`reed_${index + 1}`));
  moving.forEach(({ node }, index) => {
    lid.addChild(node);
    node.setMatrix(matrices[index]!);
  });
  // The renderer animates only nodes carrying this marker, never nodes that merely share a name.
  for (const node of [lid, body.node, cap.node, ...reeds.map((entry) => entry.node)]) {
    node.setExtras({ ...node.getExtras(), spatialPart: node.getName() });
  }
  return {
    recognized: true, lid: 'lid',
    nodes: entries.map(({ node, sourceIndex, bounds }) => ({ sourceIndex, name: node.getName(), bounds })),
  };
}
