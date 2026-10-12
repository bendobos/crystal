import type { ShapeDoc, Vec3 } from '../model/types';
import { ArcSpline } from './spline';
import { computeFrames, createFrames, type Frames } from './frames';
import { isDetailEmpty, sampleScalar, sampleVec3 } from './fields';

export interface SweepQuality {
  /** Rings along the curve (per strand). */
  rings: number;
  /** Vertices around the profile; must be divisible by 4. */
  segments: number;
  /** Rings in each rounded end cap of open curves. */
  capRings: number;
}

export const QUALITY_INTERACTIVE: SweepQuality = { rings: 480, segments: 40, capRings: 6 };
export const QUALITY_EXPORT: SweepQuality = { rings: 1200, segments: 72, capRings: 10 };

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
  return [q.rings, q.segments, q.capRings, e.strands, e.closed ? 1 : 0, e.shift, e.strandShift].join('|');
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
  const vertexCount = vertsPerStrand * S;
  const key = topologyKeyFor(shape, q);

  const reuseOk = reuse && reuse.topologyKey === key;
  const positions = reuseOk ? reuse.positions : new Float32Array(vertexCount * 3);
  const normals = reuseOk ? reuse.normals : new Float32Array(vertexCount * 3);
  const tparam = reuseOk ? reuse.tparam : new Float32Array(vertexCount);
  const strandAttr = reuseOk ? reuse.strand : new Uint8Array(vertexCount);
  const index = reuseOk ? reuse.index : buildIndex(eff, q);

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

  const writeRing = (
    s: number,
    seq: number,
    r: number,
    scale: number,
    along: number,
    tVal: number,
  ) => {
    const t = ringT(r);
    const rs = detail ? Math.exp(sampleScalar(detail.radius, t, closed)) : 1;
    const tw = twistTotal * t + (detail ? sampleScalar(detail.twist, t, closed) : 0) + (shape.phase ?? 0);
    const cw = Math.cos(tw);
    const sw = Math.sin(tw);
    const phi = Math.PI * 2 * (s / S + eff.strandTwist * t) + (shape.strandPhase ?? 0);
    const ox = Math.cos(phi) * spread;
    const oy = Math.sin(phi) * spread;
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
      const rs = detail ? Math.exp(sampleScalar(detail.radius, t, closed)) : 1;
      const phi = Math.PI * 2 * (s / S + eff.strandTwist * t) + (shape.strandPhase ?? 0);
      const ox = Math.cos(phi) * spread;
      const oy = Math.sin(phi) * spread;
      const capLen = dir * R * rs * Math.max(aspect, 0.3);
      for (let c = 0; c < 3; c++) {
        positions[v * 3 + c] =
          centers[r * 3 + c] + ox * FN[r * 3 + c] + oy * FB[r * 3 + c] + capLen * FT[r * 3 + c];
      }
    }
  }

  computeNormals(positions, index, normals);

  // --- bounds --------------------------------------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
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

function buildIndex(eff: EffectiveShape, q: SweepQuality): Uint32Array {
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
