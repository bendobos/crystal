import { describe, expect, it } from 'vitest';
import { ArcSpline } from '../src/geometry/spline';
import { computeFrames, createFrames } from '../src/geometry/frames';
import { sweepShape, topologyKeyFor, effectiveShape, type SweepQuality } from '../src/geometry/sweep';
import { createDetail } from '../src/geometry/fields';
import type { ShapeDoc, Vec3 } from '../src/model/types';

function circle(n: number, r = 1): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r, 0] as Vec3;
  });
}

function shape(over: Partial<ShapeDoc> = {}): ShapeDoc {
  return {
    points: circle(8, 1.5),
    closed: true,
    radius: 0.3,
    flatness: 0.4,
    roundness: 0.3,
    twist: 0.5,
    strands: 1,
    strandSpread: 1.2,
    strandTwist: 0,
    detail: null,
    ...over,
  };
}

const Q: SweepQuality = { rings: 120, segments: 24, capRings: 4 };

describe('ArcSpline', () => {
  it('passes through control points and is closed', () => {
    const s = new ArcSpline(circle(8), true);
    const p: Vec3 = [0, 0, 0];
    s.pointAt(0, p);
    expect(p[0]).toBeCloseTo(1, 5);
    s.pointAt(1, p);
    expect(p[0]).toBeCloseTo(1, 5);
    expect(s.length).toBeGreaterThan(2 * Math.PI * 0.98);
    expect(s.length).toBeLessThan(2 * Math.PI * 1.02);
  });

  it('is approximately arc-length parameterised', () => {
    const s = new ArcSpline([[0, 0, 0], [1, 0, 0], [3, 1, 0], [4, 4, 0]], false);
    const a: Vec3 = [0, 0, 0];
    const b: Vec3 = [0, 0, 0];
    const steps = 50;
    const lens: number[] = [];
    for (let i = 0; i < steps; i++) {
      s.pointAt(i / steps, a);
      s.pointAt((i + 1) / steps, b);
      lens.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    const mean = lens.reduce((x, y) => x + y) / steps;
    for (const l of lens) expect(Math.abs(l - mean) / mean).toBeLessThan(0.05);
  });
});

describe('frames', () => {
  it('are orthonormal and continuous on a closed non-planar curve', () => {
    const n = 200;
    const pos = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // (2,3) torus knot: strong torsion, non-zero holonomy
      const r = 2 + Math.cos(3 * a);
      pos[i * 3] = r * Math.cos(2 * a);
      pos[i * 3 + 1] = r * Math.sin(2 * a);
      pos[i * 3 + 2] = Math.sin(3 * a);
    }
    const f = createFrames(n);
    computeFrames(pos, n, true, f);
    for (let i = 0; i < n; i++) {
      const t = [f.tangent[i * 3], f.tangent[i * 3 + 1], f.tangent[i * 3 + 2]];
      const no = [f.normal[i * 3], f.normal[i * 3 + 1], f.normal[i * 3 + 2]];
      expect(Math.hypot(...no)).toBeCloseTo(1, 6);
      expect(t[0] * no[0] + t[1] * no[1] + t[2] * no[2]).toBeCloseTo(0, 6);
      // continuity including the wrap from the last ring back to the first
      const j = (i + 1) % n;
      const dot = no[0] * f.normal[j * 3] + no[1] * f.normal[j * 3 + 1] + no[2] * f.normal[j * 3 + 2];
      expect(dot).toBeGreaterThan(0.9);
    }
  });
});

describe('sweep', () => {
  it('produces a closed, consistently oriented mesh (Möbius half twist)', () => {
    const res = sweepShape(shape(), Q);
    expect(res.positions.length / 3).toBe(Q.rings * Q.segments);
    // watertight: every edge is shared by exactly two triangles, in opposite directions
    const edges = new Map<string, number>();
    for (let i = 0; i < res.index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = res.index[i + e];
        const b = res.index[i + ((e + 1) % 3)];
        const k = `${a}-${b}`;
        edges.set(k, (edges.get(k) ?? 0) + 1);
      }
    }
    for (const [k, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = k.split('-');
      expect(edges.get(`${b}-${a}`)).toBe(1);
    }
  });

  it('has outward-facing normals', () => {
    const res = sweepShape(shape({ twist: 0, flatness: 0 }), Q);
    // for a torus in the xy plane, the normal points away from the tube centre line
    let bad = 0;
    for (let v = 0; v < res.positions.length / 3; v++) {
      const x = res.positions[v * 3];
      const y = res.positions[v * 3 + 1];
      const z = res.positions[v * 3 + 2];
      const a = Math.atan2(y, x);
      const cx = Math.cos(a) * 1.5;
      const cy = Math.sin(a) * 1.5;
      const d = (x - cx) * res.normals[v * 3] + (y - cy) * res.normals[v * 3 + 1] + z * res.normals[v * 3 + 2];
      if (d <= 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('open tubes with caps are watertight', () => {
    const res = sweepShape(
      shape({ closed: false, points: [[0, 0, 0], [1, 1, 0], [2, 0, 1], [3, 1, 0]], strands: 2, twist: 0.3 }),
      Q,
    );
    const edges = new Map<string, number>();
    for (let i = 0; i < res.index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = res.index[i + e];
        const b = res.index[i + ((e + 1) % 3)];
        edges.set(`${a}-${b}`, (edges.get(`${a}-${b}`) ?? 0) + 1);
      }
    }
    for (const [k, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = k.split('-');
      expect(edges.has(`${b}-${a}`)).toBe(true);
    }
  });

  it('tapered tubes with thorns are watertight and end in points', () => {
    const s = shape({
      closed: false,
      points: [[0, -2, 0], [0.3, 0, 0], [0, 2, 0]],
      taper: 0.6,
      branches: [
        { t: 0.4, width: 0.7, points: [[0.8, 0.3, 0], [1.4, 1, 0]] },
        { t: 0.7, width: 0.5, points: [[-0.9, 0.4, 0.1]] },
      ],
    });
    const res = sweepShape(s, Q);
    const edges = new Map<string, number>();
    for (let i = 0; i < res.index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = res.index[i + e];
        const b = res.index[i + ((e + 1) % 3)];
        edges.set(`${a}-${b}`, (edges.get(`${a}-${b}`) ?? 0) + 1);
      }
    }
    for (const [k, count] of edges) {
      expect(count).toBe(1);
      const [a, b] = k.split('-');
      expect(edges.has(`${b}-${a}`)).toBe(true);
    }
    // every vertex is referenced (branches are fully indexed)
    const used = new Uint8Array(res.positions.length / 3);
    for (const v of res.index) used[v] = 1;
    expect(used.every((u) => u === 1)).toBe(true);
    // the thorn tip reaches its last control point (anchor + offset)
    const anchor = new ArcSpline(s.points, false).pointAt(0.4, [0, 0, 0]);
    let best = Infinity;
    for (let v = 0; v < res.positions.length / 3; v++) {
      best = Math.min(
        best,
        Math.hypot(res.positions[v * 3] - anchor[0] - 1.4, res.positions[v * 3 + 1] - anchor[1] - 1, res.positions[v * 3 + 2] - anchor[2]),
      );
    }
    expect(best).toBeLessThan(0.15);
    expect(topologyKeyFor(s, Q)).not.toBe(topologyKeyFor({ ...s, branches: [] }, Q));
  });

  it('keeps topology when only continuous parameters change (refit-safe)', () => {
    const a = shape();
    const k1 = topologyKeyFor(a, Q);
    const detail = createDetail();
    detail.radius[10] = 0.5;
    detail.offset[30] = 0.2;
    const b = { ...a, radius: 0.5, flatness: 0.8, points: circle(8, 2), detail };
    expect(topologyKeyFor(b, Q)).toBe(k1);
    const r1 = sweepShape(a, Q);
    const r2 = sweepShape(b, Q, r1);
    expect(r2.positions).toBe(r1.positions);
    expect(r2.index).toBe(r1.index);
  });

  it('snaps closed twist and strand winding so the seam connects', () => {
    const e = effectiveShape(shape({ twist: 0.7, strands: 3, strandTwist: 0.4 }), 24);
    expect(e.twistTurns).toBe(0.5);
    expect(e.shift).toBe(12);
    expect(e.strandTwist).toBeCloseTo(1 / 3);
    expect(e.strandShift).toBe(1);
  });

  it('seam vertices of a multi-strand closed tube coincide with the continuation', () => {
    const s = shape({ strands: 3, strandTwist: 1 / 3, strandSpread: 1.5, twist: 1 });
    const res = sweepShape(s, Q);
    // the triangle edge across the seam should be about as long as a regular ring step
    let maxLen = 0;
    for (let i = 0; i < res.index.length; i += 3) {
      const a = res.index[i] * 3;
      const c = res.index[i + 2] * 3;
      const l = Math.hypot(
        res.positions[a] - res.positions[c],
        res.positions[a + 1] - res.positions[c + 1],
        res.positions[a + 2] - res.positions[c + 2],
      );
      maxLen = Math.max(maxLen, l);
    }
    expect(maxLen).toBeLessThan(0.2);
  });
});
