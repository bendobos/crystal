import type { CameraDoc, ShapeDoc } from './types';
import { sweepShape } from '../geometry/sweep';
import { tanHalfFov } from '../render/view';

const QUICK = { rings: 120, segments: 12, capRings: 2 };

/** Camera that fits the shape's bounding sphere into the frame, keeping the view direction. */
export function fitCamera(cam: CameraDoc, shape: ShapeDoc, aspect: number, margin = 1.08): CameraDoc {
  const s = sweepShape(shape, QUICK);
  const half = Math.atan(tanHalfFov(cam.focalLength) * Math.min(1, aspect));
  const dist = (s.boundingRadius * margin) / Math.sin(half);
  const dir = [cam.position[0] - cam.target[0], cam.position[1] - cam.target[1], cam.position[2] - cam.target[2]];
  const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const c = s.center;
  return {
    ...cam,
    target: [c[0], c[1], c[2]],
    position: [c[0] + (dir[0] / l) * dist, c[1] + (dir[1] / l) * dist, c[2] + (dir[2] / l) * dist],
  };
}

