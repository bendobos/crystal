import type { Vec3 } from '../model/types';

const ALPHA = 0.5; // centripetal Catmull-Rom: no cusps or self-intersections within a segment

/**
 * Centripetal Catmull-Rom spline through control points, re-parameterised by arc length so
 * that rings of the swept tube are spaced evenly.
 */
export class ArcSpline {
  readonly closed: boolean;
  readonly length: number;
  private readonly pts: Vec3[];
  private readonly segments: number;
  /** Cumulative arc length at each table entry; entry i corresponds to global param i / perSeg. */
  private readonly table: Float64Array;
  private readonly perSeg: number;

  constructor(points: Vec3[], closed: boolean, samplesPerSegment = 64) {
    if (points.length < 2) throw new Error('ArcSpline needs at least two points');
    this.closed = closed && points.length >= 3;
    this.pts = points;
    this.segments = this.closed ? points.length : points.length - 1;
    this.perSeg = samplesPerSegment;

    const n = this.segments * samplesPerSegment;
    const table = new Float64Array(n + 1);
    const prev: Vec3 = [0, 0, 0];
    const cur: Vec3 = [0, 0, 0];
    this.evalGlobal(0, prev);
    for (let i = 1; i <= n; i++) {
      this.evalGlobal(i / samplesPerSegment, cur);
      const dx = cur[0] - prev[0];
      const dy = cur[1] - prev[1];
      const dz = cur[2] - prev[2];
      table[i] = table[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      prev[0] = cur[0];
      prev[1] = cur[1];
      prev[2] = cur[2];
    }
    this.table = table;
    this.length = table[n];
  }

  /** Global spline parameter (0..segments) for normalized arc length t in [0, 1]. */
  paramAt(t: number): number {
    const table = this.table;
    const s = Math.min(Math.max(t, 0), 1) * this.length;
    let lo = 0;
    let hi = table.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (table[mid] < s) lo = mid;
      else hi = mid;
    }
    const span = table[hi] - table[lo];
    const f = span > 0 ? (s - table[lo]) / span : 0;
    return (lo + f) / this.perSeg;
  }

  /** Position at normalized arc length t in [0, 1]. */
  pointAt(t: number, out: Vec3): Vec3 {
    return this.evalGlobal(this.paramAt(t), out);
  }

  private point(i: number): Vec3 {
    const pts = this.pts;
    const n = pts.length;
    if (this.closed) return pts[((i % n) + n) % n];
    if (i < 0) {
      // reflect the second point through the first so the end tangent is natural
      const a = pts[0];
      const b = pts[1];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    if (i >= n) {
      const a = pts[n - 1];
      const b = pts[n - 2];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return pts[i];
  }

  /** Evaluate at global parameter u in [0, segments]. */
  evalGlobal(u: number, out: Vec3): Vec3 {
    let seg = Math.floor(u);
    if (seg >= this.segments) seg = this.segments - 1;
    if (seg < 0) seg = 0;
    const f = u - seg;
    return catmullRom(this.point(seg - 1), this.point(seg), this.point(seg + 1), this.point(seg + 2), f, out);
  }
}

function knot(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  return Math.max(Math.pow(dx * dx + dy * dy + dz * dz, ALPHA / 2), 1e-4);
}

/** Barry–Goldman pyramidal evaluation of a centripetal Catmull-Rom segment between p1 and p2. */
export function catmullRom(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, f: number, out: Vec3): Vec3 {
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * f;
  for (let c = 0; c < 3; c++) {
    const a1 = ((t1 - t) / (t1 - t0)) * p0[c] + ((t - t0) / (t1 - t0)) * p1[c];
    const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
    const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
    const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
    const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
    out[c] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
  }
  return out;
}
