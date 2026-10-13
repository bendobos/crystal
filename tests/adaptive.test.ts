import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { countActive, intersectRect, maskSize, projectedRect } from '../src/render/adaptive';
import { basisFromDoc, projectPoint, type FrameView } from '../src/render/view';

const basis = basisFromDoc({ position: [0, 0, 10], target: [0, 0, 0], focalLength: 50 });
const view: FrameView = { surfaceW: 1000, surfaceH: 800, frame: { x: 100, y: 0, w: 800, h: 800 }, tanHalfFov: 12 / 50 };

describe('projectedRect', () => {
  it('covers the projection of every corner of the box', () => {
    const box = new Box3(new Vector3(-1, -0.5, -1), new Vector3(1.5, 0.5, 1));
    const r = projectedRect(box, view, basis, 0)!;
    expect(r).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      const p = new Vector3(i & 1 ? 1.5 : -1, i & 2 ? 0.5 : -0.5, i & 4 ? 1 : -1);
      const q = projectPoint(view, basis, p);
      expect(q.x).toBeGreaterThanOrEqual(r.x);
      expect(q.x).toBeLessThanOrEqual(r.x + r.w);
      expect(q.y).toBeGreaterThanOrEqual(r.y);
      expect(q.y).toBeLessThanOrEqual(r.y + r.h);
    }
    // a small object stays small
    expect(r.w * r.h).toBeLessThan(0.25 * view.surfaceW * view.surfaceH);
  });

  it('is integer, padded and clamped to the surface', () => {
    const box = new Box3(new Vector3(-100, -1, -1), new Vector3(100, 1, 1));
    const r = projectedRect(box, view, basis, 3)!;
    expect(r.x).toBe(0);
    expect(r.x + r.w).toBe(view.surfaceW);
    expect(Number.isInteger(r.y) && Number.isInteger(r.h)).toBe(true);
  });

  it('returns the whole surface when the camera is inside the box', () => {
    const box = new Box3(new Vector3(-20, -20, -20), new Vector3(20, 20, 20));
    expect(projectedRect(box, view, basis)).toEqual({ x: 0, y: 0, w: 1000, h: 800 });
  });

  it('returns null for a box outside the view', () => {
    const box = new Box3(new Vector3(50, -1, -1), new Vector3(52, 1, 1));
    expect(projectedRect(box, view, basis)).toBeNull();
  });
});

describe('mask helpers', () => {
  it('intersects rectangles', () => {
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 8, w: 10, h: 10 })).toEqual({ x: 5, y: 8, w: 5, h: 2 });
    expect(intersectRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBeNull();
  });

  it('sizes and counts blocks', () => {
    expect(maskSize(17, 8)).toEqual([3, 1]);
    expect(countActive(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0, 200, 0, 0, 0]))).toBe(2);
  });
});
