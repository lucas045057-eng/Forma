/**
 * 真实编码字节的 fixture：1x1 PNG 与合法 GLB（静态 / 动画 / 蒙皮）。
 *
 * 生成用产品同版本依赖 @gltf-transform/core（只读使用，不改依赖/锁）。
 * 每个 GLB 都做「写盘 → 用同一 NodeIO 读回 → 结构/数值校验」，校验通过才写 fixtures.json；
 * 校验结果与文件 SHA 落在 fixtures/validation.json，供启动前置留证（不冒充 E2E 通过）。
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const pngBytes = () => Buffer.from(PNG_BASE64, 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function requireFrom(repoRoot, specifier) {
  return createRequire(path.join(repoRoot, 'apps', 'server', 'package.json'))(specifier);
}

function triangleDocument({ Document }) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor('positions').setType('VEC3')
    .setArray(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const mesh = document.createMesh('triangle').addPrimitive(document.createPrimitive().setAttribute('POSITION', positions));
  const node = document.createNode('triangle').setMesh(mesh);
  document.createScene('scene').addChild(node);
  return document;
}

function animatedDocument({ Document }) {
  const document = triangleDocument({ Document });
  const buffer = document.getRoot().listBuffers()[0];
  const node = document.getRoot().listNodes()[0];
  // 时间严格递增；旋转为**单位四元数**（绕 Y 轴 0.5rad），避免非规范姿态。
  const half = 0.25;
  const input = document.createAccessor('time').setType('SCALAR').setArray(new Float32Array([0, 0.5, 1])).setBuffer(buffer);
  const output = document.createAccessor('rotation').setType('VEC4')
    .setArray(new Float32Array([
      0, 0, 0, 1,
      0, Math.sin(half), 0, Math.cos(half),
      0, 0, 0, 1,
    ])).setBuffer(buffer);
  const animation = document.createAnimation('walk');
  const sampler = document.createAnimationSampler('walk-rotation').setInput(input).setOutput(output).setInterpolation('LINEAR');
  const channel = document.createAnimationChannel('walk-rotation').setTargetNode(node).setTargetPath('rotation').setSampler(sampler);
  animation.addSampler(sampler);
  animation.addChannel(channel);
  return document;
}

function skinnedDocument({ Document }) {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = document.createAccessor('positions').setType('VEC3')
    .setArray(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 1, 0])).setBuffer(buffer);
  // 三个顶点全部绑定到唯一关节：索引 0，权重 1。
  const joints = document.createAccessor('joints').setType('VEC4')
    .setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).setBuffer(buffer);
  const weights = document.createAccessor('weights').setType('VEC4')
    .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute('POSITION', positions).setAttribute('JOINTS_0', joints).setAttribute('WEIGHTS_0', weights);
  const mesh = document.createMesh('skinned-triangle').addPrimitive(primitive);
  const joint = document.createNode('joint');
  const inverseBind = document.createAccessor('inverseBind').setType('MAT4')
    .setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer);
  const skin = document.createSkin('skin').addJoint(joint).setInverseBindMatrices(inverseBind);
  const skinnedNode = document.createNode('skinned').setMesh(mesh).setSkin(skin);
  const scene = document.createScene('scene');
  scene.addChild(skinnedNode);
  scene.addChild(joint);
  return document;
}

const norm4 = (array, index) => Math.hypot(array[index * 4], array[index * 4 + 1], array[index * 4 + 2], array[index * 4 + 3]);

function assert(condition, message) {
  if (!condition) throw new Error(`fixture validation failed: ${message}`);
}

function validateStatic(document) {
  const scenes = document.getRoot().listScenes();
  assert(scenes.length === 1, 'expected exactly one scene');
  const meshes = document.getRoot().listMeshes();
  assert(meshes.length === 1, 'expected exactly one mesh');
  const primitive = meshes[0].listPrimitives()[0];
  assert(primitive.getAttribute('POSITION')?.getCount() === 3, 'expected 3 positions');
  assert(document.getRoot().listNodes().filter((node) => node.getMesh() === meshes[0]).length === 1, 'mesh must be referenced by exactly one node');
  return { scenes: scenes.length, meshes: meshes.length, positions: 3 };
}

function validateAnimated(document) {
  const animations = document.getRoot().listAnimations();
  assert(animations.length === 1, 'expected exactly one animation');
  const animation = animations[0];
  assert(animation.listChannels().length === 1, 'expected exactly one channel');
  assert(animation.listSamplers().length === 1, 'expected exactly one sampler');
  const channel = animation.listChannels()[0];
  assert(channel.getTargetNode(), 'channel target node missing');
  assert(channel.getTargetPath() === 'rotation', `unexpected channel path ${channel.getTargetPath()}`);
  assert(channel.getSampler() === animation.listSamplers()[0], 'channel sampler mismatch');
  const sampler = channel.getSampler();
  const times = sampler.getInput()?.getArray();
  const values = sampler.getOutput()?.getArray();
  assert(times && values, 'sampler input/output missing');
  assert(times.length === 3, `expected 3 keyframes, got ${times.length}`);
  assert(times[0] < times[1] && times[1] < times[2], `time must strictly increase, got ${Array.from(times)}`);
  assert(sampler.getInterpolation() === 'LINEAR', `unexpected interpolation ${sampler.getInterpolation()}`);
  assert(values.length === times.length * 4, 'rotation track must be VEC4 per keyframe');
  for (let index = 0; index < times.length; index += 1) {
    assert(Math.abs(norm4(values, index) - 1) < 1e-3, `rotation keyframe ${index} is not a unit quaternion (norm ${norm4(values, index)})`);
  }
  return { animations: 1, channels: 1, samplers: 1, keyframes: times.length, times: Array.from(times), quaternionNorms: Array.from(times, (_t, index) => Number(norm4(values, index).toFixed(6))) };
}

function validateSkinned(document) {
  const skins = document.getRoot().listSkins();
  assert(skins.length === 1, 'expected exactly one skin');
  const skin = skins[0];
  const joints = skin.listJoints();
  assert(joints.length === 1, `expected exactly one joint, got ${joints.length}`);
  const preSkinNodes = document.getRoot().listNodes().filter((node) => node.getSkin() === skin);
  assert(preSkinNodes.length === 1, 'exactly one node must use the skin');
  const mesh = preSkinNodes[0].getMesh();
  assert(mesh, 'skinned node has no mesh');
  assert(document.getRoot().listNodes().filter((node) => node.getMesh() === mesh).length === 1, 'mesh must be referenced by exactly one node');
  const primitive = mesh.listPrimitives()[0];
  const positions = primitive.getAttribute('POSITION');
  const jointsAttribute = primitive.getAttribute('JOINTS_0');
  const weightsAttribute = primitive.getAttribute('WEIGHTS_0');
  assert(positions && jointsAttribute && weightsAttribute, 'skinned primitive must carry POSITION/JOINTS_0/WEIGHTS_0');
  const vertexCount = positions.getCount();
  assert(jointsAttribute.getCount() === vertexCount, `JOINTS_0 count ${jointsAttribute.getCount()} != vertices ${vertexCount}`);
  assert(weightsAttribute.getCount() === vertexCount, `WEIGHTS_0 count ${weightsAttribute.getCount()} != vertices ${vertexCount}`);
  assert(jointsAttribute.getType() === 'VEC4' && weightsAttribute.getType() === 'VEC4', 'joints/weights must be VEC4');
  const jointIndices = jointsAttribute.getArray();
  const weightValues = weightsAttribute.getArray();
  assert(jointIndices && weightValues, 'joints/weights arrays missing');
  const jointSet = new Set(joints);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let sum = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const index = jointIndices[vertex * 4 + slot];
      const weight = weightValues[vertex * 4 + slot];
      sum += weight;
      if (weight > 0) assert(index < joints.length, `vertex ${vertex} references joint index ${index} out of range`);
    }
    assert(Math.abs(sum - 1) < 1e-3, `vertex ${vertex} weights sum to ${sum}`);
  }
  const inverseBind = skin.getInverseBindMatrices();
  assert(inverseBind && inverseBind.getCount() === joints.length, 'inverseBindMatrices count must match joints');
  const scene = document.getRoot().listScenes()[0];
  const sceneNodes = new Set();
  const visit = (node) => { sceneNodes.add(node); for (const child of node.listChildren()) visit(child); };
  for (const node of scene.listChildren()) visit(node);
  for (const joint of jointSet) assert(sceneNodes.has(joint), 'skin joint must be part of the scene graph');
  return { skins: 1, joints: joints.length, vertices: vertexCount, jointSlots: 4, weightSum: 1 };
}

export async function writeFixtures(repoRoot, target) {
  const { Document, NodeIO } = requireFrom(repoRoot, '@gltf-transform/core');
  mkdirSync(target, { recursive: true });
  const io = new NodeIO();
  const documents = [
    ['triangle.glb', triangleDocument({ Document }), validateStatic],
    ['animated.glb', animatedDocument({ Document }), validateAnimated],
    ['skinned.glb', skinnedDocument({ Document }), validateSkinned],
  ];
  const files = [];
  const checks = [];
  for (const [name, document, validate] of documents) {
    const binary = Buffer.from(await io.writeBinary(document));
    writeFileSync(path.join(target, name), binary);
    // 用同一 NodeIO 读回校验：写出去的字节必须能被解析且结构/数值合法。
    const readBack = await io.readBinary(new Uint8Array(binary));
    const report = validate(readBack);
    checks.push({ file: name, ok: true, bytes: binary.length, sha256: sha256(binary), ...report });
    files.push({ name, bytes: binary.length, sha256: sha256(binary) });
  }
  const image = pngBytes();
  writeFileSync(path.join(target, 'image.png'), image);
  files.push({ name: 'image.png', bytes: image.length, sha256: sha256(image) });

  const validation = { at: new Date().toISOString(), nodeIO: '@gltf-transform/core (same install as server)', files: checks };
  writeFileSync(path.join(target, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  // fixtures.json 最后写：它同时是「fixtures 可用」的哨兵。
  writeFileSync(path.join(target, 'fixtures.json'), `${JSON.stringify({ createdAt: new Date().toISOString(), validated: true, files }, null, 2)}\n`);
  return { files, checks };
}

export function readFixtureManifest(target) {
  return JSON.parse(readFileSync(path.join(target, 'fixtures.json'), 'utf8'));
}
