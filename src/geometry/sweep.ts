import type { BranchDoc, ShapeDoc, Vec3 } from '../model/types';
import { ArcSpline } from './spline';
import { computeFrames, createFrames, type Frames } from './frames';
import { isDetailEmpty, sampleScalar, sampleVec3 } from './fields';
import { fuseBranches, type Tube } from './blend';

export interface SweepQuality {
  /** Rings along the curve (per strand). */
  rings: number;
  /** Vertices around the profile; must be divisible by 4. */
  segments: number;
  /** Rings in each rounded end cap of open curves. */
  capRings: number;
  /** Fuse thorns into the tube with fillets (otherwise they just overlap it). */
  fillets?: boolean;
}

export const QUALITY_INTERACTIVE: SweepQuality = { rings: 480, segments: 40, capRings: 6, fillets: true };
/** Interactive quality without fillets, for drag steps. */
export const QUALITY_DRAG: SweepQuality = { ...QUALITY_INTERACTIVE, fillets: false };
export const QUALITY_EXPORT: SweepQuality = { rings: 1200, segments: 72, capRings: 10, fillets: true };

export interface SweepResult {
  topologyKey: string;
  positions: Float32Array;
  normals: Float32Array;
  /** Canonical triangle list (the BVH reorders its own copy). */
  index: Uint32Array;
  /** Normalized curve parameter per vertex, used to map surface hits back to the curve. */
  tparam: Float32Array;
  strand: Uint8Array;
  /** Final centre line of the tube, one point per ring. */
  centers: Float64Array;
  frames: Frames;
  /** Frames of the undeformed base curve: detail offsets are expressed in these. */
  baseFrames: Frames;
  rings: number;
  closed: boolean;
  /** Bounding sphere of the geometry. */
  center: Vec3;
  boundingRadius: number;
  curveLength: number;
}

export interface EffectiveShape {
  closed: boolean;
  twistTurns: number;
  strandTwist: number;
  /** Profile index shift when the last ring connects back to the first (closed curves). */
  shift: number;
  /** Strand index offset when strands connect back (closed curves). */
  strandShift: number;
  strands: number;
}

/** Applies the constraints needed for a seamless closed tube. */
export function effectiveShape(shape: ShapeDoc, segments: number): EffectiveShape {
  const closed = shape.closed && shape.points.length >= 3;
  const strands = Math.max(1, Math.min(5, Math.round(shape.strands)));
  if (!closed) {
    return { closed, twistTurns: shape.twist, strandTwist: shape.strandTwist, shift: 0, strandShift: 0, strands };
  }
  const halfTurns = Math.round(shape.twist * 2);
  const shift = (((halfTurns * segments) / 2) % segments + segments) % segments;
  const m = strands > 1 ? Math.round(shape.strandTwist * strands) : 0;
  return {
    closed,
    twistTurns: halfTurns / 2,
    strandTwist: strands > 1 ? m / strands : 0,
    shift,
    strandShift: ((m % strands) + strands) % strands,
    strands,
  };
}

export function topologyKeyFor(shape: ShapeDoc, q: SweepQuality): string {
  const e = effectiveShape(shape, q.segments);
  return [q.rings, q.segments, q.capRings, e.strands, e.closed ? 1 : 0, e.shift, e.strandShift, thornCount(shape)].join('|');
}

/** Whether sweeping `shape` at quality `q` fuses its thorns into the tube (single strand only). */
export function hasFillets(shape: ShapeDoc, q: SweepQuality): boolean {
  return !!q.fillets && (shape.blend ?? 1) > 0 && Math.round(shape.strands) <= 1 && thornCount(shape) > 0;
}

/** Rings along each branch (fixed per quality, independent of the branch length). */
export function branchRings(q: SweepQuality): number {
  return Math.max(16, Math.round(q.rings / 6));
}

function activeBranches(shape: ShapeDoc): BranchDoc[] {
  return (shape.branches ?? []).filter((b) => b.points.length > 0).slice(0, MAX_THORNS);
}

export const MAX_THORNS = 24;

/** Number of thorns the shape shows: `thorns` if set, otherwise all designed ones. */
export function thornCount(shape: ShapeDoc): number {
  const n = shape.thorns ?? activeBranches(shape).length;
  return Math.max(0, Math.min(MAX_THORNS, Math.round(n)));
}

/** Radius factor towards a sharp tip: u = 1 at full width, 0 at the tip; concave like a thorn. */
function tipShape(u: number): number {
  return Math.max(0.015, Math.pow(Math.sin(Math.min(Math.max(u, 0), 1) * Math.PI * 0.5), 1.5));
}

/** Radius factor of the main tube from `taper` (open curves only). */
function taperAt(t: number, taper: number, closed: boolean): number {
  if (closed || taper <= 0) return 1;
  return tipShape(Math.min(t, 1 - t) / (Math.min(taper, 1) * 0.5));
}

/** Superellipse profile, unit half-width. */
function buildProfile(segments: number, roundness: number, flatness: number): Float64Array {
  const p = 2 + Math.max(0, Math.min(1, roundness)) * 6;
  const aspect = 1 - Math.max(0, Math.min(0.95, flatness)) * 0.88;
  const e = 2 / p;
  const out = new Float64Array(segments * 2);
  for (let j = 0; j < segments; j++) {
    const th = (j / segments) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    out[j * 2] = Math.sign(c) * Math.pow(Math.abs(c), e);
    out[j * 2 + 1] = Math.sign(s) * Math.pow(Math.abs(s), e) * aspect;
  }
  return out;
}

/**
 * Sweeps the shape's profile along its curve. When `reuse` has the same topology its arrays are
 * overwritten in place, which keeps an existing BVH valid for a cheap refit.
 */
export function sweepShape(shape: ShapeDoc, q: SweepQuality, reuse?: SweepResult | null): SweepResult {
  const eff = effectiveShape(shape, q.segments);
  const closed = eff.closed;
  const N = q.rings;
  const M = q.segments;
  const K = closed ? 0 : q.capRings;
  const S = eff.strands;
  const Q = N + 2 * K; // rings per strand including caps
  const poles = closed ? 0 : 2;
  const vertsPerStrand = Q * M + poles;
  const NB = branchRings(q);
  const vertsPerBranch = (NB + 2 * q.capRings) * M + 2;
  const mainVerts = vertsPerStrand * S;
  const blend = Math.max(0, shape.blend ?? 1);
  // fillet meshes change their vertex count with every edit, so they never reuse buffers
  const blending = hasFillets(shape, q);
  const baseKey = topologyKeyFor(shape, q);
  const reuseOk = !blending && reuse && reuse.topologyKey === baseKey;

  // --- centre line -------------------------------------------------------------------------
  const spline = new ArcSpline(shape.points, closed, Math.max(32, Math.ceil((N * 2) / shape.points.length)));
  const ringT = (r: number) => (closed ? r / N : r / (N - 1));
  const base = new Float64Array(N * 3);
  const tmp: Vec3 = [0, 0, 0];
  for (let r = 0; r < N; r++) {
    spline.pointAt(ringT(r), tmp);
    base[r * 3] = tmp[0];
    base[r * 3 + 1] = tmp[1];
    base[r * 3 + 2] = tmp[2];
  }

  const detail = isDetailEmpty(shape.detail) ? null : shape.detail;
  let centers = base;
  const baseFrames = reuseOk ? reuse.baseFrames : createFrames(N);
  computeFrames(base, N, closed, baseFrames);
  let frames = baseFrames;
  if (detail) {
    centers = new Float64Array(N * 3);
    const o: [number, number, number] = [0, 0, 0];
    const BN = frames.normal;
    const BB = frames.binormal;
    const BT = frames.tangent;
    for (let r = 0; r < N; r++) {
      sampleVec3(detail.offset, ringT(r), closed, o);
      for (let c = 0; c < 3; c++) {
        centers[r * 3 + c] = base[r * 3 + c] + o[0] * BN[r * 3 + c] + o[1] * BB[r * 3 + c] + o[2] * BT[r * 3 + c];
      }
    }
    // frames follow the deformed centre line so the profile stays perpendicular to the tube
    frames = reuseOk && reuse.frames !== reuse.baseFrames ? reuse.frames : createFrames(N);
    computeFrames(centers, N, closed, frames);
  }

  // --- rings ---------------------------------------------------------------------------------
  const R = shape.radius;
  const profile = buildProfile(M, shape.roundness, shape.flatness);
  const aspect = 1 - Math.max(0, Math.min(0.95, shape.flatness)) * 0.88;
  const spread = S > 1 ? shape.strandSpread * R : 0;
  const twistTotal = eff.twistTurns * Math.PI * 2;
  const FN = frames.normal;
  const FB = frames.binormal;
  const FT = frames.tangent;
  const taper = shape.taper ?? 0;
  /** Radius factor of the main tube at t: brush detail and tapered ends. */
  const radiusScale = (t: number) => (detail ? Math.exp(sampleScalar(detail.radius, t, closed)) : 1) * taperAt(t, taper, closed);

  // --- thorns: the designed ones, thinned out or topped up to the requested count -------------
  /** Sideways (within the curve's plane) and tangent directions at curve parameter t. */
  const planeNormal = curvePlaneNormal(centers, N);
  const axesAt = (t: number) => {
    const r = Math.round(closed ? t * N : t * (N - 1)) % N;
    const along = [FT[r * 3], FT[r * 3 + 1], FT[r * 3 + 2]];
    const n = planeNormal;
    let wide = [n[1] * along[2] - n[2] * along[1], n[2] * along[0] - n[0] * along[2], n[0] * along[1] - n[1] * along[0]];
    const l = Math.hypot(wide[0], wide[1], wide[2]);
    // tangent along the plane normal (rare): fall back to the profile's normal
    wide = l > 1e-3 ? wide.map((x) => x / l) : [FN[r * 3], FN[r * 3 + 1], FN[r * 3 + 2]];
    return { wide, along };
  };
  const branches = resolveThorns(activeBranches(shape), thornCount(shape));

  function resolveThorns(designed: BranchDoc[], count: number): BranchDoc[] {
    const dist = (a: number, b: number) => {
      const d = Math.abs(a - b);
      return closed ? Math.min(d, 1 - d) : d;
    };
    // order the designed thorns so that every prefix is spread along the curve (removing
    // thorns thins them out evenly instead of dropping one end)
    const rest = designed.map((_, i) => i);
    const order: number[] = [];
    while (rest.length) {
      let best = 0, bestD = -Infinity;
      rest.forEach((i, k) => {
        const d = order.length ? Math.min(...order.map((o) => dist(designed[o].t, designed[i].t))) : -Math.abs(designed[i].t - 0.5);
        if (d > bestD) {
          bestD = d;
          best = k;
        }
      });
      order.push(rest.splice(best, 1)[0]);
    }
    const out = order.slice(0, count).map((i) => designed[i]);
    const sides: number[] = out.map((b) => {
      const { wide } = axesAt(b.t);
      const p = b.points[b.points.length - 1];
      return p[0] * wide[0] + p[1] * wide[1] + p[2] * wide[2] < 0 ? -1 : 1;
    });
    // new thorns go into the largest gap
    const centroid = [0, 0, 0];
    for (let r = 0; r < N; r++) for (let c = 0; c < 3; c++) centroid[c] += centers[r * 3 + c] / N;
    const lo = closed ? 0 : 0.08 + taper * 0.2;
    const hi = closed ? 1 : 1 - lo;
    while (out.length < count) {
      const ts = out.map((b) => b.t).sort((a, b) => a - b);
      let t = closed ? 0 : (lo + hi) / 2;
      let spacing = closed ? 1 : (hi - lo) / 2;
      if (ts.length && closed) {
        spacing = -1;
        ts.forEach((a, i) => {
          const gap = (i + 1 < ts.length ? ts[i + 1] : ts[0] + 1) - a;
          if (gap / 2 > spacing) {
            spacing = gap / 2;
            t = (a + gap / 2) % 1;
          }
        });
      } else if (ts.length) {
        // ends count double: a thorn there has no neighbour on the outside
        const cands: [number, number][] = [[lo, ts[0] - lo], [hi, hi - ts[ts.length - 1]]];
        for (let i = 0; i + 1 < ts.length; i++) cands.push([(ts[i] + ts[i + 1]) / 2, (ts[i + 1] - ts[i]) / 2]);
        [t, spacing] = cands.reduce((a, b) => (b[1] > a[1] ? b : a));
      }
      // closed shapes: always outwards (a crown); open ones: the side with fewer thorns nearby
      let side: number;
      if (closed) {
        const { wide } = axesAt(t);
        const r = Math.round(t * N) % N;
        let d = 0;
        for (let c = 0; c < 3; c++) d += (centers[r * 3 + c] - centroid[c]) * wide[c];
        side = d < 0 ? -1 : 1;
      } else {
        let balance = 0;
        out.forEach((b, i) => (balance += sides[i] * Math.exp(-((dist(b.t, t) / 0.15) ** 2))));
        side = balance > 1e-3 ? -1 : balance < -1e-3 ? 1 : out.length % 2 ? 1 : -1;
      }
      out.push(sickle(t, Math.max(spacing, 0) * spline.length, side));
      sides.push(side);
    }
    return out;
  }

  /** A generated thorn: a sickle in the profile's plane, curving towards the curve's end. */
  function sickle(t: number, spacing: number, side: number): BranchDoc {
    const { wide, along } = axesAt(t);
    const rs = Math.min(1, radiusScale(t));
    // long enough to clear the tube (its local half-width) and reach well into the gap
    const L = R * radiusScale(t) + Math.min(7 * R, Math.max(4 * R, 2.5 * spacing)) * (0.6 + 0.4 * rs);
    const points: Vec3[] = [];
    const p = [0, 0, 0];
    for (const f of [1 / 3, 2 / 3, 1]) {
      const a = 0.35 + 0.75 * f * f;
      for (let c = 0; c < 3; c++) p[c] += (side * wide[c] * Math.cos(a) + along[c] * Math.sin(a)) * (L / 3);
      points.push([p[0], p[1], p[2]]);
    }
    return { t, points, width: Math.max(0.25, Math.min(0.75, 0.4 + (0.3 * L) / (7 * R)) * rs) };
  }

  // --- branches: centre lines, frames and radii ----------------------------------------------
  const branchTubes: Tube[] = branches.map((b) => {
    const t0 = Math.min(Math.max(b.t, 0), 1);
    // anchor on the deformed centre line
    const rf = closed ? t0 * N : t0 * (N - 1);
    const r0 = Math.min(Math.floor(rf), N - 1);
    const r1 = closed ? (r0 + 1) % N : Math.min(r0 + 1, N - 1);
    const f = rf - Math.floor(rf);
    const anchor: Vec3 = [0, 1, 2].map((c) => centers[r0 * 3 + c] * (1 - f) + centers[r1 * 3 + c] * f) as Vec3;
    const pts: Vec3[] = [anchor, ...b.points.map((o) => [anchor[0] + o[0], anchor[1] + o[1], anchor[2] + o[2]] as Vec3)];
    const bs = new ArcSpline(pts, false, Math.max(32, Math.ceil((NB * 2) / pts.length)));
    const bc = new Float64Array(NB * 3);
    for (let i = 0; i < NB; i++) {
      bs.pointAt(i / (NB - 1), tmp);
      bc[i * 3] = tmp[0];
      bc[i * 3 + 1] = tmp[1];
      bc[i * 3 + 2] = tmp[2];
    }
    // the branch profile lies flat in the same plane as the main profile at the anchor
    const rn = Math.round(rf) % N;
    const tw = twistTotal * t0 + (detail ? sampleScalar(detail.twist, t0, closed) : 0) + (shape.phase ?? 0);
    const thin = [0, 1, 2].map((c) => -Math.sin(tw) * FN[rn * 3 + c] + Math.cos(tw) * FB[rn * 3 + c]);
    const dx = bc[3] - bc[0], dy = bc[4] - bc[1], dz = bc[5] - bc[2];
    const bFrames = createFrames(NB);
    computeFrames(bc, NB, false, bFrames, [thin[1] * dz - thin[2] * dy, thin[2] * dx - thin[0] * dz, thin[0] * dy - thin[1] * dx]);
    // thorn profile: full width at the anchor, narrowing to a point
    const a = new Float64Array(NB);
    for (let i = 0; i < NB; i++) a[i] = R * b.width * tipShape(1 - i / (NB - 1));
    return { n: NB, closed: false, c: bc, w: bFrames.normal, h: bFrames.binormal, t: bFrames.tangent, a };
  });

  /** The main tube as distance-field input, with the twisted profile axes (single strand). */
  function mainTube(): Tube {
    const c = centers, w = new Float64Array(N * 3), h = new Float64Array(N * 3);
    const a = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      const t = ringT(r);
      const tw = twistTotal * t + (detail ? sampleScalar(detail.twist, t, closed) : 0) + (shape.phase ?? 0);
      const cw = Math.cos(tw), sw = Math.sin(tw);
      for (let k = 0; k < 3; k++) {
        const n = FN[r * 3 + k], b = FB[r * 3 + k];
        w[r * 3 + k] = cw * n + sw * b;
        h[r * 3 + k] = -sw * n + cw * b;
      }
      a[r] = R * radiusScale(t);
    }
    return { n: N, closed, c, w, h, t: FT, a };
  }

  // --- buffers ---------------------------------------------------------------------------------
  const tubeVerts = mainVerts + branches.length * vertsPerBranch;
  let positions = reuseOk ? reuse.positions : new Float32Array(tubeVerts * 3);
  let normals = reuseOk ? reuse.normals : new Float32Array(tubeVerts * 3);
  let tparam = reuseOk ? reuse.tparam : new Float32Array(tubeVerts);
  let strandAttr = reuseOk ? reuse.strand : new Uint8Array(tubeVerts);
  let index = reuseOk ? reuse.index : buildIndex(eff, q, branches.length);
  let key = baseKey;

  const writeRing = (
    s: number,
    seq: number,
    r: number,
    scale: number,
    along: number,
    tVal: number,
  ) => {
    const t = ringT(r);
    const rs = radiusScale(t);
    const tw = twistTotal * t + (detail ? sampleScalar(detail.twist, t, closed) : 0) + (shape.phase ?? 0);
    const cw = Math.cos(tw);
    const sw = Math.sin(tw);
    const phi = Math.PI * 2 * (s / S + eff.strandTwist * t) + (shape.strandPhase ?? 0);
    // strands converge towards tapered tips
    const ox = Math.cos(phi) * spread * taperAt(t, taper, closed);
    const oy = Math.sin(phi) * spread * taperAt(t, taper, closed);
    const nx = FN[r * 3], ny = FN[r * 3 + 1], nz = FN[r * 3 + 2];
    const bx = FB[r * 3], by = FB[r * 3 + 1], bz = FB[r * 3 + 2];
    const tx = FT[r * 3], ty = FT[r * 3 + 1], tz = FT[r * 3 + 2];
    const capLen = along * R * rs * Math.max(aspect, 0.3);
    const cx = centers[r * 3] + ox * nx + oy * bx + capLen * tx;
    const cy = centers[r * 3 + 1] + ox * ny + oy * by + capLen * ty;
    const cz = centers[r * 3 + 2] + ox * nz + oy * bz + capLen * tz;
    const k = R * rs * scale;
    const v0 = s * vertsPerStrand + seq * M;
    for (let j = 0; j < M; j++) {
      const px = profile[j * 2];
      const py = profile[j * 2 + 1];
      const qx = (px * cw - py * sw) * k;
      const qy = (px * sw + py * cw) * k;
      const v = (v0 + j) * 3;
      positions[v] = cx + qx * nx + qy * bx;
      positions[v + 1] = cy + qx * ny + qy * by;
      positions[v + 2] = cz + qx * nz + qy * bz;
      tparam[v0 + j] = tVal;
      strandAttr[v0 + j] = s;
    }
  };

  for (let s = 0; s < S; s++) {
    for (let r = 0; r < N; r++) writeRing(s, K + r, r, 1, 0, ringT(r));
    if (!closed) {
      for (let k = 1; k <= K; k++) {
        const a = (k / (K + 1)) * (Math.PI / 2);
        // start cap: seq K-k is k steps before ring 0
        writeRing(s, K - k, 0, Math.cos(a), -Math.sin(a), 0);
        writeRing(s, K + N - 1 + k, N - 1, Math.cos(a), Math.sin(a), 1);
      }
      // poles
      const ps = s * vertsPerStrand + Q * M;
      writePole(ps, 0, -1);
      writePole(ps + 1, N - 1, 1);
      tparam[ps] = 0;
      tparam[ps + 1] = 1;
      strandAttr[ps] = s;
      strandAttr[ps + 1] = s;
    }

    function writePole(v: number, r: number, dir: number) {
      const t = ringT(r);
      const rs = radiusScale(t);
      const phi = Math.PI * 2 * (s / S + eff.strandTwist * t) + (shape.strandPhase ?? 0);
      const ox = Math.cos(phi) * spread * taperAt(t, taper, closed);
      const oy = Math.sin(phi) * spread * taperAt(t, taper, closed);
      const capLen = dir * R * rs * Math.max(aspect, 0.3);
      for (let c = 0; c < 3; c++) {
        positions[v * 3 + c] =
          centers[r * 3 + c] + ox * FN[r * 3 + c] + oy * FB[r * 3 + c] + capLen * FT[r * 3 + c];
      }
    }
  }

  // --- branch rings ---------------------------------------------------------------------------
  const KB = q.capRings;
  const QB = NB + 2 * KB;
  branchTubes.forEach((bt, bi) => {
    const t0 = Math.min(Math.max(branches[bi].t, 0), 1);
    const bc = bt.c, bRadius = bt.a;
    const v0 = mainVerts + bi * vertsPerBranch;
    const BN = bt.w, BB = bt.h, BT = bt.t;
    const writeBranchRing = (seq: number, i: number, scale: number, along: number) => {
      const k = bRadius[i] * scale;
      const capLen = along * bRadius[i] * Math.max(aspect, 0.3);
      const cx = bc[i * 3] + capLen * BT[i * 3];
      const cy = bc[i * 3 + 1] + capLen * BT[i * 3 + 1];
      const cz = bc[i * 3 + 2] + capLen * BT[i * 3 + 2];
      const vs = v0 + seq * M;
      for (let j = 0; j < M; j++) {
        const qx = profile[j * 2] * k;
        const qy = profile[j * 2 + 1] * k;
        const v = (vs + j) * 3;
        positions[v] = cx + qx * BN[i * 3] + qy * BB[i * 3];
        positions[v + 1] = cy + qx * BN[i * 3 + 1] + qy * BB[i * 3 + 1];
        positions[v + 2] = cz + qx * BN[i * 3 + 2] + qy * BB[i * 3 + 2];
        tparam[vs + j] = t0;
        strandAttr[vs + j] = 0;
      }
    };
    for (let i = 0; i < NB; i++) writeBranchRing(KB + i, i, 1, 0);
    for (let k = 1; k <= KB; k++) {
      const a = (k / (KB + 1)) * (Math.PI / 2);
      writeBranchRing(KB - k, 0, Math.cos(a), -Math.sin(a));
      writeBranchRing(KB + NB - 1 + k, NB - 1, Math.cos(a), Math.sin(a));
    }
    const ps = v0 + QB * M;
    for (const [v, i, dir] of [[ps, 0, -1], [ps + 1, NB - 1, 1]]) {
      const capLen = dir * bRadius[i] * Math.max(aspect, 0.3);
      for (let c = 0; c < 3; c++) positions[v * 3 + c] = bc[i * 3 + c] + capLen * BT[i * 3 + c];
      tparam[v] = t0;
      strandAttr[v] = 0;
    }
  });

  // --- fuse thorns into the tube --------------------------------------------------------------
  let smoothed: { v: Uint32Array; n: Float32Array } | null = null;
  if (blending) {
    const fused = fuseBranches({
      positions,
      index,
      tparam,
      strand: strandAttr,
      branchRanges: branches.map((_, bi) => [mainVerts + bi * vertsPerBranch, mainVerts + (bi + 1) * vertsPerBranch]),
      main: mainTube(),
      branches: branchTubes,
      profile: { aspect, exponent: 2 + Math.max(0, Math.min(1, shape.roundness)) * 6 },
      k: blend * R,
    });
    if (fused) {
      ({ positions, index, tparam } = fused);
      strandAttr = fused.strand;
      normals = new Float32Array(positions.length);
      smoothed = { v: fused.smoothed, n: fused.smoothedNormals };
      key = `${baseKey}|fused${positions.length / 3}/${index.length / 3}`;
    }
  }

  computeNormals(positions, index, normals);
  // fillet vertices carry exact normals of the smooth union
  if (smoothed) {
    for (let i = 0; i < smoothed.v.length; i++) normals.set(smoothed.n.subarray(i * 3, i * 3 + 3), smoothed.v[i] * 3);
  }

  // --- bounds --------------------------------------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const boundingRadius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;

  return {
    topologyKey: key,
    positions,
    normals,
    index,
    tparam,
    strand: strandAttr,
    centers,
    frames,
    baseFrames,
    rings: N,
    closed,
    center,
    boundingRadius,
    curveLength: spline.length,
  };
}

/** Normal of the plane that fits the sampled curve best (its least spread direction). */
function curvePlaneNormal(c: Float64Array, n: number): Vec3 {
  const m = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) m[k] += c[i * 3 + k] / n;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += (c[i * 3 + a] - m[a]) * (c[i * 3 + b] - m[b]);
  }
  // the two main directions by power iteration; the normal is perpendicular to both
  const power = (M: number[], v: number[]) => {
    for (let it = 0; it < 40; it++) {
      const w = [0, 1, 2].map((a) => M[a * 3] * v[0] + M[a * 3 + 1] * v[1] + M[a * 3 + 2] * v[2]);
      const l = Math.hypot(w[0], w[1], w[2]) || 1;
      v = w.map((x) => x / l);
    }
    return v;
  };
  const e1 = power(C, [0.6, 0.7, 0.4]);
  const l1 = [0, 1, 2].reduce((s, a) => s + e1[a] * (C[a * 3] * e1[0] + C[a * 3 + 1] * e1[1] + C[a * 3 + 2] * e1[2]), 0);
  const C2 = C.map((x, i) => x - l1 * e1[Math.floor(i / 3)] * e1[i % 3]);
  const e2 = power(C2, [-0.3, 0.5, 0.8]);
  const nv = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(nv[0], nv[1], nv[2]) || 1;
  return [nv[0] / l, nv[1] / l, nv[2] / l];
}

function buildIndex(eff: EffectiveShape, q: SweepQuality, branchCount: number): Uint32Array {
  const main = buildTubeIndex(eff, q);
  if (branchCount === 0) return main;
  // branches are single open tubes appended after the main tube's vertices
  const open: EffectiveShape = { closed: false, twistTurns: 0, strandTwist: 0, shift: 0, strandShift: 0, strands: 1 };
  const bq: SweepQuality = { ...q, rings: branchRings(q) };
  const tube = buildTubeIndex(open, bq);
  const vertsPerBranch = (bq.rings + 2 * q.capRings) * q.segments + 2;
  const mainVerts = (eff.closed ? q.rings * q.segments : (q.rings + 2 * q.capRings) * q.segments + 2) * eff.strands;
  const index = new Uint32Array(main.length + tube.length * branchCount);
  index.set(main);
  for (let b = 0; b < branchCount; b++) {
    const off = main.length + b * tube.length;
    const base = mainVerts + b * vertsPerBranch;
    for (let i = 0; i < tube.length; i++) index[off + i] = tube[i] + base;
  }
  return index;
}

function buildTubeIndex(eff: EffectiveShape, q: SweepQuality): Uint32Array {
  const closed = eff.closed;
  const N = q.rings;
  const M = q.segments;
  const K = closed ? 0 : q.capRings;
  const S = eff.strands;
  const Q = N + 2 * K;
  const poles = closed ? 0 : 2;
  const vertsPerStrand = Q * M + poles;
  const quadRows = closed ? N : Q - 1;
  const triCount = S * (quadRows * M * 2 + (closed ? 0 : 2 * M));
  const index = new Uint32Array(triCount * 3);
  let o = 0;
  for (let s = 0; s < S; s++) {
    const base = s * vertsPerStrand;
    for (let qi = 0; qi < quadRows; qi++) {
      let nextBase = base;
      let nextSeq = qi + 1;
      let shift = 0;
      if (closed && qi === N - 1) {
        nextBase = ((s + eff.strandShift) % S) * vertsPerStrand;
        nextSeq = 0;
        shift = eff.shift;
      }
      for (let j = 0; j < M; j++) {
        const j1 = (j + 1) % M;
        const a = base + qi * M + j;
        const b = base + qi * M + j1;
        const c = nextBase + nextSeq * M + ((j + shift) % M);
        const d = nextBase + nextSeq * M + ((j1 + shift) % M);
        index[o++] = a;
        index[o++] = b;
        index[o++] = c;
        index[o++] = b;
        index[o++] = d;
        index[o++] = c;
      }
    }
    if (!closed) {
      const ps = base + Q * M;
      const pe = ps + 1;
      const last = base + (Q - 1) * M;
      for (let j = 0; j < M; j++) {
        const j1 = (j + 1) % M;
        index[o++] = ps;
        index[o++] = base + j1;
        index[o++] = base + j;
        index[o++] = last + j;
        index[o++] = last + j1;
        index[o++] = pe;
      }
    }
  }
  return index;
}

/** Area-weighted vertex normals. */
export function computeNormals(positions: Float32Array, index: Uint32Array, out: Float32Array): void {
  out.fill(0);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const e1x = positions[b] - positions[a];
    const e1y = positions[b + 1] - positions[a + 1];
    const e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a];
    const e2y = positions[c + 1] - positions[a + 1];
    const e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l;
    out[i + 1] /= l;
    out[i + 2] /= l;
  }
}
