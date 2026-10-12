import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import type { CameraDoc } from '../model/types';

/** A rectangle in pixels; y measured from the top. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Describes how a frame (the export format's crop) maps onto a canvas or tile, matching exactly
 * how the tracer generates camera rays. Coordinates here use a top-left origin.
 */
export interface FrameView {
  /** Size of the surface being rendered (canvas or tile), pixels. */
  surfaceW: number;
  surfaceH: number;
  /** The frame inside that surface (may extend outside for tiles). */
  frame: Rect;
  tanHalfFov: number;
}

export function tanHalfFov(focalLength: number): number {
  // full-frame equivalent, 24 mm sensor height
  return 12 / Math.max(focalLength, 1);
}

export interface CameraBasis {
  position: Vector3;
  right: Vector3;
  up: Vector3;
  forward: Vector3;
}

export function basisFromDoc(cam: CameraDoc): CameraBasis {
  const position = new Vector3(...cam.position);
  const target = new Vector3(...cam.target);
  const forward = target.clone().sub(position).normalize();
  let worldUp = new Vector3(0, 1, 0);
  if (Math.abs(forward.y) > 0.999) worldUp = new Vector3(0, 0, -1);
  const right = new Vector3().crossVectors(forward, worldUp).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  return { position, right, up, forward };
}

export function basisFromCamera(camera: PerspectiveCamera): CameraBasis {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  return {
    position: new Vector3(e[12], e[13], e[14]),
    right: new Vector3(e[0], e[1], e[2]).normalize(),
    up: new Vector3(e[4], e[5], e[6]).normalize(),
    forward: new Vector3(-e[8], -e[9], -e[10]).normalize(),
  };
}

/** Ray direction for a surface pixel (top-left origin, pixel units). */
export function rayDirection(view: FrameView, basis: CameraBasis, px: number, py: number, out = new Vector3()): Vector3 {
  const u = (px - view.frame.x) / view.frame.w;
  const v = 1 - (py - view.frame.y) / view.frame.h;
  const aspect = view.frame.w / view.frame.h;
  const nx = (u * 2 - 1) * view.tanHalfFov * aspect;
  const ny = (v * 2 - 1) * view.tanHalfFov;
  return out
    .copy(basis.forward)
    .addScaledVector(basis.right, nx)
    .addScaledVector(basis.up, ny)
    .normalize();
}

/** Projects a world point to surface pixels (top-left origin). Returns depth along forward. */
export function projectPoint(view: FrameView, basis: CameraBasis, p: Vector3): { x: number; y: number; depth: number } {
  const d = p.clone().sub(basis.position);
  const z = d.dot(basis.forward);
  const aspect = view.frame.w / view.frame.h;
  const nx = d.dot(basis.right) / (z * view.tanHalfFov * aspect);
  const ny = d.dot(basis.up) / (z * view.tanHalfFov);
  return {
    x: view.frame.x + ((nx + 1) / 2) * view.frame.w,
    y: view.frame.y + (1 - (ny + 1) / 2) * view.frame.h,
    depth: z,
  };
}

/**
 * Off-centre projection matrix equivalent to the tracer's rays for the whole surface, so raster
 * overlays and camera controls agree with the traced image.
 */
export function projectionFor(view: FrameView, near: number, far: number, out = new Matrix4()): Matrix4 {
  const aspect = view.frame.w / view.frame.h;
  const toNdcX = (px: number) => ((px - view.frame.x) / view.frame.w) * 2 - 1;
  const toNdcY = (py: number) => (1 - (py - view.frame.y) / view.frame.h) * 2 - 1;
  const left = toNdcX(0) * view.tanHalfFov * aspect * near;
  const right = toNdcX(view.surfaceW) * view.tanHalfFov * aspect * near;
  const top = toNdcY(0) * view.tanHalfFov * near;
  const bottom = toNdcY(view.surfaceH) * view.tanHalfFov * near;
  return out.makePerspective(left, right, top, bottom, near, far);
}

/** Fits a frame of the given aspect ratio into an area with a margin, centred. */
export function fitFrame(area: Rect, aspect: number, margin: number): Rect {
  const aw = Math.max(1, area.w - margin * 2);
  const ah = Math.max(1, area.h - margin * 2);
  let w = aw;
  let h = w / aspect;
  if (h > ah) {
    h = ah;
    w = h * aspect;
  }
  return { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, w, h };
}
