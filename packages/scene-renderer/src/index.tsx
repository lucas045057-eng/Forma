import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, TransformControls } from '@react-three/drei';
import { ACESFilmicToneMapping, PCFSoftShadowMap, SRGBColorSpace, Mesh, Texture, type Vector3, type Material, type Object3D, type PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { SceneConfig, Vec3 } from '@spatial/shared/scene-config';
import { applyPartOffsets, partPositions, scenePose } from './pose';
export { scenePose } from './pose';

export const sceneRenderSettings = {
  outputColorSpace: SRGBColorSpace, toneMapping: ACESFilmicToneMapping, exposure: 1,
  shadowMapType: PCFSoftShadowMap, shadowMapSize: 1024, maxDpr: 2,
  aspectRatio: 1, background: '#efe8dc',
} as const;

export function disposeModel(scene: Object3D) {
  const textures = new Set<Texture>();
  const geometries = new Set<Mesh['geometry']>();
  const materials = new Set<Material>();
  scene.traverse(node => {
    if (!(node instanceof Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  const images = new Set<unknown>();
  for (const texture of textures) { images.add(texture.source.data); texture.dispose(); }
  for (const image of images) if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onError?.(); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function Camera({ config }: { config: SceneConfig }) {
  const { camera, invalidate } = useThree();
  useLayoutEffect(() => {
    camera.position.fromArray(config.hero.camera.position);
    camera.lookAt(...config.hero.camera.target);
    (camera as PerspectiveCamera).fov = config.hero.camera.fov;
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, config.hero.camera, invalidate]);
  return null;
}

function Model({ scene, config, scrollAt, onRotationChange }: { scene: Object3D; config: SceneConfig; scrollAt: number; onRotationChange?: (rotation: Vec3) => void }) {
  const [group, setGroup] = useState<Object3D | null>(null);
  const base = useMemo(() => partPositions(scene), [scene]);
  const pose = useMemo(() => scenePose(config, scrollAt), [config, scrollAt]);
  const invalidate = useThree(state => state.invalidate);
  useLayoutEffect(() => {
    applyPartOffsets(scene, base, pose.parts);
    invalidate();
  }, [scene, base, pose, invalidate]);
  return <>
    <group ref={setGroup} name="product-model" rotation={pose.rotation} scale={config.hero.model.scale}><primitive object={scene} dispose={null}/></group>
    {group && onRotationChange && <TransformControls object={group} mode="rotate" onMouseUp={() => onRotationChange([group.rotation.x, group.rotation.y, group.rotation.z])}/>}
  </>;
}

export interface ProductSceneProps {
  config: SceneConfig;
  modelUrl: string;
  scrollAt?: number;
  controls?: boolean;
  onCameraChange?: (camera: SceneConfig['hero']['camera']) => void;
  onRotationChange?: (rotation: Vec3) => void;
  canvasTestId?: string;
  fallback?: ReactNode;
  onReady?: (scene: Object3D) => void;
  onError?: () => void;
  children?: ReactNode;
}

function LoadedScene({ config, modelUrl, scrollAt = 0, controls = false, fallback = null, onReady, onError, children, onCameraChange, onRotationChange, canvasTestId }: ProductSceneProps) {
  const [scene, setScene] = useState<Object3D>();
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  useEffect(() => {
    const abort = new AbortController();
    let owned: Object3D | undefined;
    void (async () => {
      try {
        const response = await fetch(modelUrl, { signal: abort.signal });
        if (!response.ok) throw new Error('Model download failed');
        const bytes = await response.arrayBuffer();
        // Asset processing emits self-contained GLB; never resolve external model resources.
        const loader = new GLTFLoader();
        loader.manager.setURLModifier(url => {
          if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('External model resource rejected');
          return url;
        });
        loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.parseAsync(bytes, '');
        owned = gltf.scene;
        if (abort.signal.aborted) { disposeModel(owned); owned = undefined; return; }
        owned.traverse(node => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
        setScene(owned);
      } catch {
        if (!abort.signal.aborted) { setFailed(true); callbacks.current.onError?.(); }
      }
    })();
    return () => { abort.abort(); if (owned) disposeModel(owned); };
  }, [modelUrl]);
  if (failed) return fallback;
  return <>
    {!scene && fallback}
    <Canvas style={{ position: 'absolute', inset: 0, visibility: scene ? 'visible' : 'hidden' }}
      frameloop="demand" camera={{ position: config.hero.camera.position, fov: config.hero.camera.fov }}
      dpr={[1, sceneRenderSettings.maxDpr]} shadows={{ enabled: true, type: sceneRenderSettings.shadowMapType }} gl={{ antialias: true }}
      onCreated={({ gl }) => { if (canvasTestId) gl.domElement.dataset.testid = canvasTestId; gl.outputColorSpace = sceneRenderSettings.outputColorSpace; gl.toneMapping = sceneRenderSettings.toneMapping; gl.toneMappingExposure = sceneRenderSettings.exposure; }}>
      <color attach="background" args={[sceneRenderSettings.background]}/>
      <Camera config={config}/>
      <ambientLight intensity={config.hero.lights.ambient}/>
      <directionalLight position={config.hero.lights.key.direction} intensity={config.hero.lights.key.intensity}
        color={config.hero.lights.key.color} castShadow shadow-mapSize={[sceneRenderSettings.shadowMapSize, sceneRenderSettings.shadowMapSize]}/>
      {scene && <><Model scene={scene} config={config} scrollAt={scrollAt} onRotationChange={onRotationChange}/><Ready scene={scene} notify={() => callbacks.current.onReady?.(scene)}/></>}
      {controls && <OrbitControls makeDefault target={config.hero.camera.target} minDistance={0.6} maxDistance={5} onEnd={event => {
        const orbit = event?.target as { object: PerspectiveCamera; target: Vector3 } | undefined;
        if (orbit && onCameraChange) onCameraChange({ position: orbit.object.position.toArray() as Vec3, target: orbit.target.toArray() as Vec3, fov: (orbit.object as PerspectiveCamera).fov });
      }}/>}
      {children}
    </Canvas>
  </>;
}
function Ready({ scene, notify }: { scene: Object3D; notify: () => void }) {
  const callback = useRef(notify);
  callback.current = notify;
  useEffect(() => { callback.current(); }, [scene]);
  return null;
}

export function ProductScene(props: ProductSceneProps) {
  if (!props.modelUrl) return props.fallback ?? null;
  return <SceneBoundary key={props.modelUrl} fallback={props.fallback ?? null} onError={props.onError}>
    <LoadedScene {...props}/>
  </SceneBoundary>;
}
