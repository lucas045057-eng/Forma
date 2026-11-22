import { useEffect, useRef } from 'react';
import { type ThreeEvent, useThree } from '@react-three/fiber';
import { Sphere, Vector3 } from 'three';
import type { Vec3 } from '@spatial/shared/scene-config';

interface ToggleableControls {
  enabled: boolean;
}

interface PointerCaptureTarget {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
}

function isToggleableControls(value: unknown): value is ToggleableControls {
  return typeof value === 'object' && value !== null && 'enabled' in value && typeof value.enabled === 'boolean';
}

function hasPointerCapture(value: unknown): value is PointerCaptureTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'setPointerCapture' in value &&
    typeof value.setPointerCapture === 'function' &&
    'releasePointerCapture' in value &&
    typeof value.releasePointerCapture === 'function'
  );
}

/** Interactive spherical handle in the 3D scene viewport for aiming the hero key light. */
export default function SceneLightHandle({ direction, change }: { direction: Vec3; change: (direction: Vec3) => void }) {
  const dragging = useRef(false);
  const { controls } = useThree();
  const orbit = isToggleableControls(controls) ? controls : null;
  const center = new Vector3(0, 0.5, 0);
  const radius = 0.65;
  const position = new Vector3(...direction).normalize().multiplyScalar(radius).add(center);

  function stop() {
    dragging.current = false;
    if (orbit) orbit.enabled = true;
  }

  useEffect(() => stop, [orbit]);

  function move(event: ThreeEvent<PointerEvent>) {
    if (!dragging.current) return;
    event.stopPropagation();
    const point = event.ray.intersectSphere(new Sphere(center, radius), new Vector3());
    if (point) change(point.sub(center).normalize().multiplyScalar(5).toArray() as Vec3);
  }

  return (
    <mesh
      position={position}
      onPointerDown={event => {
        event.stopPropagation();
        dragging.current = true;
        if (orbit) orbit.enabled = false;
        if (hasPointerCapture(event.target)) event.target.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={event => {
        event.stopPropagation();
        if (hasPointerCapture(event.target)) event.target.releasePointerCapture(event.pointerId);
        stop();
      }}
    >
      <sphereGeometry args={[0.045, 16, 12]} />
      <meshBasicMaterial color="#ffdd77" />
    </mesh>
  );
}
