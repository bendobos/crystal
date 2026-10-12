import type { Vec3 } from '../model/types';

export interface P2 {
  x: number;
  y: number;
}

/** Resamples a polyline to points spaced `step` apart. */
export function resample(pts: P2[], step: number): P2[] {
  if (pts.length < 2) return pts.slice();
  const out: P2[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let d = step - carry;
    while (d <= seg) {
      const f = d / seg;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > step * 0.3) out.push(last);
  return out;
}

export function polylineLength(pts: P2[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return l;
}

function segIntersect(a: P2, b: P2, c: P2, d: P2): { t: number; u: number } | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

export interface Crossing {
  /** Positions along the polyline (in segment-index units) of both passes. */
  a: number;
  b: number;
}

/** Self-intersections of a polyline (closed: includes the closing segment). */
export function findCrossings(pts: P2[], closed: boolean): Crossing[] {
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const out: Crossing[] = [];
  for (let i = 0; i < segs; i++) {
    for (let j = i + 2; j < segs; j++) {
      if (closed && i === 0 && j === segs - 1) continue; // neighbours across the seam
      const hit = segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
      if (hit) out.push({ a: i + hit.t, b: j + hit.u });
    }
  }
  return out;
}

/**
 * Depth offsets that lift the stroke over/under itself at every crossing, alternating along the
 * stroke like a knot diagram, so the tube never passes through itself.
 */
export function crossingDepths(pts: P2[], closed: boolean, separation: number, width: number): number[] {
  const crossings = findCrossings(pts, closed);
  const visits: { pos: number; c: number }[] = [];
  crossings.forEach((c, k) => {
    visits.push({ pos: c.a, c: k }, { pos: c.b, c: k });
  });
  visits.sort((x, y) => x.pos - y.pos);
  const sign = new Map<string, number>();
  visits.forEach((v, i) => sign.set(`${v.c}:${v.pos}`, i % 2 === 0 ? -1 : 1));
  // a crossing's two visits must have opposite signs; fix where alternation can't satisfy it
  crossings.forEach((c, k) => {
    const sa = sign.get(`${k}:${c.a}`)!;
    const sb = sign.get(`${k}:${c.b}`)!;
    if (sa === sb) sign.set(`${k}:${c.b}`, -sa);
  });
  const n = pts.length;
  const depths = new Array<number>(n).fill(0);
  // cumulative length per point for arc-length falloff
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[n - 1] + (closed ? Math.hypot(pts[0].x - pts[n - 1].x, pts[0].y - pts[n - 1].y) : 0);
  const arcAt = (pos: number) => {
    const i = Math.min(Math.floor(pos), n - 1);
    const f = pos - i;
    const next = i + 1 < n ? cum[i + 1] : total;
    return cum[i] + (next - cum[i]) * f;
  };
  for (const v of visits) {
    const s0 = arcAt(v.pos);
    const sgn = sign.get(`${v.c}:${v.pos}`)!;
    for (let i = 0; i < n; i++) {
      let d = Math.abs(cum[i] - s0);
      if (closed) d = Math.min(d, total - d);
      depths[i] += sgn * separation * Math.exp(-0.5 * (d / width) ** 2);
    }
  }
  return depths;
}

export interface FreehandResult {
  points: Vec3[];
  closed: boolean;
}

/**
 * Converts a screen-space stroke into control points.
 * `unproject(x, y, depth)` maps a screen point plus depth offset (world units along the view
 * direction) to world space.
 */
export function strokeToCurve(
  stroke: P2[],
  unproject: (x: number, y: number, depth: number) => Vec3,
  pxPerUnit: number,
  radius: number,
): FreehandResult | null {
  const lenPx = polylineLength(stroke);
  if (stroke.length < 3 || lenPx < 40) return null;
  const first = stroke[0];
  const last = stroke[stroke.length - 1];
  const closed = lenPx > 160 && Math.hypot(last.x - first.x, last.y - first.y) < Math.max(36, lenPx * 0.08);
  let pts = resample(stroke, 6);
  if (closed) {
    // drop the overlapping tail near the start so the loop closes cleanly
    while (pts.length > 4 && Math.hypot(pts[pts.length - 1].x - first.x, pts[pts.length - 1].y - first.y) < 12) pts.pop();
  }
  pts = smooth(pts, closed, 3);
  const radiusPx = radius * pxPerUnit;
  const depthsPx = crossingDepths(pts, closed, radiusPx * 1.35, Math.max(radiusPx * 1.6, 14));
  // a gentle wave in depth so drawn forms aren't flat; half-period symmetric, so passes that
  // are half a loop apart (typical crossings) keep their separation
  const wave = lenPx * 0.02;
  for (let i = 0; i < pts.length; i++) depthsPx[i] += wave * Math.cos((4 * Math.PI * i) / pts.length);
  // choose evenly spaced control points; dense enough to keep crossings separated
  const spacingPx = Math.max(radiusPx * 1.6, 18);
  const count = Math.max(closed ? 5 : 4, Math.min(36, Math.round(lenPx / spacingPx)));
  const step = Math.floor(pts.length / count) || 1;
  const points: Vec3[] = [];
  for (let i = 0; i < pts.length; i += step) points.push(unproject(pts[i].x, pts[i].y, depthsPx[i] / pxPerUnit));
  if (!closed) {
    const l = pts.length - 1;
    const end = unproject(pts[l].x, pts[l].y, depthsPx[l] / pxPerUnit);
    const prev = points[points.length - 1];
    if (Math.hypot(end[0] - prev[0], end[1] - prev[1], end[2] - prev[2]) > (spacingPx / pxPerUnit) * 0.4) points.push(end);
    else points[points.length - 1] = end;
  }
  return points.length >= (closed ? 3 : 2) ? { points, closed } : null;
}

function smooth(pts: P2[], closed: boolean, passes: number): P2[] {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const n = cur.length;
    cur = cur.map((q, i) => {
      if (!closed && (i === 0 || i === n - 1)) return q;
      const a = cur[(i - 1 + n) % n];
      const b = cur[(i + 1) % n];
      return { x: (a.x + 2 * q.x + b.x) / 4, y: (a.y + 2 * q.y + b.y) / 4 };
    });
  }
  return cur;
}
