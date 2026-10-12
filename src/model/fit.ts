import type { CameraDoc, ShapeDoc } from './types';
import { sweepShape } from '../geometry/sweep';
import { tanHalfFov } from '../render/view';

const QUICK = { rings: 160, segments: 12, capRings: 2 };

/**
 * Camera that frames the shape tightly: keeps the viewing direction and finds the smallest
 * distance at which every vertex lies inside the frame (with `margin` around it).
 */
export function fitCamera(cam: CameraDoc, shape: ShapeDoc, aspect: number, margin = aspect > 1 ? 1.5 : 1.12): CameraDoc {
  const s = sweepShape(shape, QUICK);
  const c = s.center;
  // camera basis for the current view direction
  let fx = cam.target[0] - cam.position[0];
  let fy = cam.target[1] - cam.position[1];
  let fz = cam.target[2] - cam.position[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(fy) > 0.999) {
    uy = 0;
    uz = -1;
  }
  // right = forward × up, up = right × forward
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  ux = ry * fz - rz * fy;
  uy = rz * fx - rx * fz;
  uz = rx * fy - ry * fx;

  const tanV = tanHalfFov(cam.focalLength) / margin;
  const tanH = tanV * aspect;
  const p = s.positions;
  let dist = 0;
  for (let i = 0; i < p.length; i += 3) {
    const vx = p[i] - c[0];
    const vy = p[i + 1] - c[1];
    const vz = p[i + 2] - c[2];
    const x = vx * rx + vy * ry + vz * rz;
    const y = vx * ux + vy * uy + vz * uz;
    const z = vx * fx + vy * fy + vz * fz;
    // the point at depth (dist + z) must satisfy |x| <= tanH (dist + z) and |y| <= tanV (dist + z)
    dist = Math.max(dist, Math.abs(x) / tanH - z, Math.abs(y) / tanV - z);
  }
  dist = Math.max(dist, s.boundingRadius * 1.2);
  return {
    ...cam,
    target: [c[0], c[1], c[2]],
    position: [c[0] - fx * dist, c[1] - fy * dist, c[2] - fz * dist],
  };
}
