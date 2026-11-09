import { Document, getBounds } from '@gltf-transform/core';
import { expect, it } from 'vitest';
import { groupParts } from './parts.ts';

function fixture() {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const root = document.createNode('original-root').setTranslation([0.1, 0, -0.1]);
  scene.addChild(root);
  const box = (name: string, min: number[], max: number[]) => {
    const positions = document.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([...min, ...max]));
    const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute('POSITION', positions));
    const node = document.createNode(name).setMesh(mesh);
    root.addChild(node);
    return node;
  };
  // Intentionally shuffled to require geometry rather than source ordering.
  const reed = box('original-reed', [-0.01, 0.39, -0.01], [0.01, 1, 0.01]);
  const cap = box('original-cap', [-0.15, 0.39, -0.15], [0.15, 0.5, 0.15]);
  const body = box('original-body', [-0.2, 0, -0.2], [0.2, 0.4, 0.2]);
  return { document, scene, root, reed, cap, body };
}

it('infers parts from bounds and preserves world transforms when grouping the lid', () => {
  const { document, scene, root, cap, reed, body } = fixture();
  root.setScale([0.9, 1, 0.9]);
  const source = document.getRoot().listNodes();
  const bounds = getBounds(scene);
  const matrices = [cap, reed, body].map((node) => node.getWorldMatrix());
  const result = groupParts(document, source);
  expect(result.recognized).toBe(true);
  expect(result.lid).toBe('lid');
  expect(result.nodes.map(({ sourceIndex, name }) => ({ sourceIndex, name }))).toEqual([
    { sourceIndex: source.indexOf(reed), name: 'reed_1' },
    { sourceIndex: source.indexOf(cap), name: 'cap' },
    { sourceIndex: source.indexOf(body), name: 'body' },
  ]);
  const lid = document.getRoot().listNodes().find((node) => node.getName() === 'lid')!;
  expect(lid.listChildren()).toEqual([cap, reed]);
  [cap, reed, body].forEach((node, i) => {
    node.getWorldMatrix().forEach((value, j) => expect(value).toBeCloseTo(matrices[i]![j]!, 6));
  });
  expect(getBounds(scene)).toEqual(bounds);
});

it('leaves names and hierarchy unchanged when cap or reeds cannot be inferred', () => {
  const { document, root, cap } = fixture();
  cap.setTranslation([0, 0.2, 0]);
  const source = document.getRoot().listNodes();
  const names = source.map((node) => node.getName());
  const children = root.listChildren();
  const result = groupParts(document, source);
  expect(result.recognized).toBe(false);
  expect(result.reason).toBeTruthy();
  expect(source.map((node) => node.getName())).toEqual(names);
  expect(root.listChildren()).toEqual(children);
  expect(document.getRoot().listNodes()).toEqual(source);
});

it('refuses non-upright remaining geometry without partial renaming', () => {
  const { document, reed } = fixture();
  reed.setScale([20, 1, 1]);
  const source = document.getRoot().listNodes();
  const names = source.map((node) => node.getName());
  expect(groupParts(document, source).recognized).toBe(false);
  expect(source.map((node) => node.getName())).toEqual(names);
});
