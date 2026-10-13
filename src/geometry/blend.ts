import type { Vec3 } from '../model/types';

/**
 * Fuses thorns into the main tube as one cast piece.
 *
 * Main tube and thorns are swept separately (that keeps needle-sharp tips). Where a thorn leaves
 * the tube, both meshes are cut along their intersection and the parts inside the other tube are
 * dropped. Vertices near the junction are then moved onto the smooth union of both tubes, which
 * turns the crease into a soft fillet, and the two cut edges, which both land on the middle of
 * the fillet, are welded together. The result is a single closed mesh without inner surfaces.
 */

/** A swept tube sampled along its centre line, with the profile axes of every sample. */
export interface Tube {
  n: number;
  closed: boolean;
  /** Centre, wide profile axis, thin profile axis and tangent per sample (xyz). */
  c: Float64Array;
  w: Float64Array;
  h: Float64Array;
  t: Float64Array;
  /** Half-width along the wide axis; the thin axis is `aspect` times that. */
  a: Float64Array;
}

export interface ProfileShape {
  aspect: number;
  /** Superellipse exponent of the profile. */
  exponent: number;
}

/** Closest-sample index from the previous query; neighbouring queries start their search there. */
export interface Hint {
  i: number;
}

const near = { seg: 0, f: 0 };

function dist2(c: Float64Array, i: number, px: number, py: number, pz: number): number {
  const dx = px - c[i * 3], dy = py - c[i * 3 + 1], dz = pz - c[i * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

/** Closest point on the centre line polyline (segment + fraction in `near`), by local descent. */
function closestOnTube(tube: Tube, px: number, py: number, pz: number, hint: Hint): void {
  const { n, c, closed } = tube;
  let i = hint.i < 0 ? 0 : hint.i >= n ? n - 1 : hint.i;
  let best = dist2(c, i, px, py, pz);
  for (let step = 0; step < n; step++) {
    const a = closed ? (i - 1 + n) % n : i - 1;
    const b = closed ? (i + 1) % n : i + 1;
    const da = a >= 0 ? dist2(c, a, px, py, pz) : Infinity;
    const db = b < n ? dist2(c, b, px, py, pz) : Infinity;
    if (da < best && da <= db) {
      i = a;
      best = da;
    } else if (db < best) {
      i = b;
      best = db;
    } else break;
  }
  hint.i = i;
  near.seg = i;
  near.f = 0;
  let bestSeg = Infinity;
  // the two segments next to the closest sample
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? (closed ? (i - 1 + n) % n : i - 1) : i;
    if (s < 0 || (!closed && s >= n - 1)) continue;
    const e = s + 1 === n ? 0 : s + 1;
    const ex = c[e * 3] - c[s * 3], ey = c[e * 3 + 1] - c[s * 3 + 1], ez = c[e * 3 + 2] - c[s * 3 + 2];
    const l2 = ex * ex + ey * ey + ez * ez;
    const vx = px - c[s * 3], vy = py - c[s * 3 + 1], vz = pz - c[s * 3 + 2];
    let f = l2 > 0 ? (vx * ex + vy * ey + vz * ez) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const dx = vx - ex * f, dy = vy - ey * f, dz = vz - ez * f;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestSeg) {
      bestSeg = d;
      near.seg = s;
      near.f = f;
    }
  }
}

/** Gradient direction in the profile plane from the last profileDistance call. */
const pg = { x: 0, y: 1 };

/** First-order distance estimate to a superellipse |x/a|^e + |y/b|^e = 1 (negative inside). */
function profileDistance(x: number, y: number, a: number, b: number, e: number): number {
  const X = Math.abs(x) / a;
  const Y = Math.abs(y) / b;
  const S = Math.pow(X, e) + Math.pow(Y, e);
  if (S < 1e-12) {
    pg.x = 0;
    pg.y = 1;
    return -b;
  }
  const k = Math.pow(S, 1 / e - 1);
  const gx = (k * Math.pow(X, e - 1)) / a;
  const gy = (k * Math.pow(Y, e - 1)) / b;
  const gl = Math.hypot(gx, gy);
  pg.x = x < 0 ? -gx / gl : gx / gl;
  pg.y = y < 0 ? -gy / gl : gy / gl;
  return Math.max((Math.pow(S, 1 / e) - 1) / gl, -b);
}

/** Wide half-width of the tube at the closest point of the last tubeDistance call. */
export let tubeRadius = 0;
/** Unit gradient of the last tubeDistance call. */
export const tubeGradient: Vec3 = [0, 0, 0];

/** Signed distance estimate to a tube's surface. */
export function tubeDistance(tube: Tube, p: ProfileShape, px: number, py: number, pz: number, hint: Hint): number {
  closestOnTube(tube, px, py, pz, hint);
  const s = near.seg;
  const e = (s + 1) % tube.n;
  const f = near.f;
  const g = 1 - f;
  const { c, w, h, t } = tube;
  const s3 = s * 3, e3 = e * 3;
  const dx = px - (c[s3] * g + c[e3] * f);
  const dy = py - (c[s3 + 1] * g + c[e3 + 1] * f);
  const dz = pz - (c[s3 + 2] * g + c[e3 + 2] * f);
  const x = dx * (w[s3] * g + w[e3] * f) + dy * (w[s3 + 1] * g + w[e3 + 1] * f) + dz * (w[s3 + 2] * g + w[e3 + 2] * f);
  const y = dx * (h[s3] * g + h[e3] * f) + dy * (h[s3 + 1] * g + h[e3 + 1] * f) + dz * (h[s3 + 2] * g + h[e3 + 2] * f);
  const z = dx * (t[s3] * g + t[e3] * f) + dy * (t[s3 + 1] * g + t[e3 + 1] * f) + dz * (t[s3 + 2] * g + t[e3 + 2] * f);
  const a = Math.max(tube.a[s] * g + tube.a[e] * f, 1e-5);
  tubeRadius = a;
  const d2 = profileDistance(x, y, a, a * p.aspect, p.exponent);
  // beyond the ends of an open tube
  const out = !tube.closed && ((s === 0 && f === 0 && z < 0) || (s === tube.n - 2 && f === 1 && z > 0)) ? Math.abs(z) : 0;
  let gw = pg.x, gh = pg.y, gt = 0;
  // a changing radius tilts the normal along the tube (the distance scales with the profile)
  {
    const lx = c[e * 3] - c[s * 3], ly = c[e * 3 + 1] - c[s * 3 + 1], lz = c[e * 3 + 2] - c[s * 3 + 2];
    const len = Math.sqrt(lx * lx + ly * ly + lz * lz);
    if (len > 1e-9) gt = ((d2 - (x * pg.x + y * pg.y)) / a) * ((tube.a[e] - tube.a[s]) / len);
  }
  let d = d2;
  if (out > 0) {
    d = d2 > 0 ? Math.hypot(d2, out) : Math.max(d2, out);
    const zs = z < 0 ? -1 : 1;
    if (d2 > 0) {
      gw *= d2 / d;
      gh *= d2 / d;
      gt = gt * (d2 / d) + (zs * out) / d;
    } else if (out > d2) {
      gw = gh = 0;
      gt = zs;
    }
  }
  const gn = Math.hypot(gw, gh, gt) || 1;
  for (let k = 0; k < 3; k++) {
    tubeGradient[k] =
      (gw * (w[s * 3 + k] * g + w[e * 3 + k] * f) + gh * (h[s * 3 + k] * g + h[e * 3 + k] * f) + gt * (t[s * 3 + k] * g + t[e * 3 + k] * f)) /
      gn;
  }
  return d;
}

/** Index of the sample closest to a point (exhaustive; used to seed the local searches). */
export function seedHint(tube: Tube, p: Vec3): Hint {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < tube.n; i++) {
    const d = dist2(tube.c, i, p[0], p[1], p[2]);
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  return { i: bi };
}

/** Tube meshes as written by the sweep, plus the tubes they were swept from. */
export interface FuseInput {
  positions: Float32Array;
  index: Uint32Array;
  tparam: Float32Array;
  strand: Uint8Array;
  /** Vertex range of each branch; everything before the first one belongs to the main tube. */
  branchRanges: [number, number][];
  main: Tube;
  branches: Tube[];
  profile: ProfileShape;
  /** Fillet size in world units. */
  k: number;
}

export interface FusedMesh {
  positions: Float32Array;
  index: Uint32Array;
  tparam: Float32Array;
  strand: Uint8Array;
  /** Vertices moved onto the fillet surface, with their exact normals. */
  smoothed: Uint32Array;
  smoothedNormals: Float32Array;
}

/** Returns the fused mesh, or null when the junctions don't form clean loops (then the caller
 * keeps the overlapping tubes, which the tracer still renders as one solid). */
export function fuseBranches(input: FuseInput): FusedMesh | null {
  const { positions, index, main, branches, profile, k } = input;
  const V0 = positions.length / 3;
  const B = branches.length;

  // which part every vertex belongs to: -1 main tube, b >= 0 branch b
  const part = new Int16Array(V0).fill(-1);
  input.branchRanges.forEach(([a, b], bi) => part.fill(bi, a, b));

  // branch bounding boxes, grown by the fillet size
  const boxes = branches.map((t) => {
    let r = 0;
    for (let i = 0; i < t.n; i++) r = Math.max(r, t.a[i]);
    const m = r + k * 1.5;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < t.n; i++) {
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], t.c[i * 3 + c] - m);
        hi[c] = Math.max(hi[c], t.c[i * 3 + c] + m);
      }
    }
    return { lo, hi };
  });
  const inBox = (b: number, x: number, y: number, z: number) => {
    const { lo, hi } = boxes[b];
    return x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] && z >= lo[2] && z <= hi[2];
  };
  const hm: Hint = seedHint(main, [main.c[0], main.c[1], main.c[2]]);
  const hb: Hint[] = branches.map((t) => ({ i: Math.floor(t.n / 2) }));

  // --- 1. which side of the other tube every vertex lies on ------------------------------------
  const side = new Float64Array(V0);
  /** For main-tube vertices: the branch they are closest to inside (-1: none). */
  const cutBy = new Int16Array(V0).fill(-1);
  for (let v = 0; v < V0; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const pb = part[v];
    hm.i = Math.min(main.n - 1, Math.round(input.tparam[v] * (main.closed ? main.n : main.n - 1)));
    if (pb < 0) {
      let s = Infinity;
      for (let b = 0; b < B; b++) {
        if (!inBox(b, x, y, z)) continue;
        const d = tubeDistance(branches[b], profile, x, y, z, hb[b]);
        if (d < s) {
          s = d;
          cutBy[v] = b;
        }
      }
      side[v] = s;
    } else side[v] = tubeDistance(main, profile, x, y, z, hm);
  }

  /** Whether the last field evaluation was inside a blend zone. */
  let blended = false;
  /** Unit gradient (`g`) and its length (`gl`) of the last field evaluation. */
  const g = [0, 0, 0];
  let gl = 1;
  /**
   * Smooth union of the main tube and the branches relevant for a vertex of part `pb` (a branch
   * vertex only blends with its own branch). The fillet never gets larger than the thinner part
   * is thick: a thin tip running close to the tube would otherwise grow a web towards it.
   */
  const field = (x: number, y: number, z: number, pb: number): number => {
    const dm = tubeDistance(main, profile, x, y, z, hm);
    const am = tubeRadius;
    let gx = tubeGradient[0], gy = tubeGradient[1], gz = tubeGradient[2];
    blended = false;
    let f = dm;
    for (let b = 0; b < B; b++) {
      if (pb >= 0 ? b !== pb : !inBox(b, x, y, z)) continue;
      const db = tubeDistance(branches[b], profile, x, y, z, hb[b]);
      const kk = Math.min(k, 1.2 * Math.min(am, tubeRadius));
      if (Math.abs(f - db) >= kk) {
        if (db < f) {
          f = db;
          gx = tubeGradient[0];
          gy = tubeGradient[1];
          gz = tubeGradient[2];
        }
        continue;
      }
      blended = true;
      // quadratic smooth minimum and its partial derivatives
      const h = (kk - Math.abs(f - db)) / kk;
      const wf = f <= db ? 1 - h / 2 : h / 2;
      const wb = 1 - wf;
      gx = wf * gx + wb * tubeGradient[0];
      gy = wf * gy + wb * tubeGradient[1];
      gz = wf * gz + wb * tubeGradient[2];
      f = Math.min(f, db) - h * h * kk * 0.25;
    }
    gl = Math.hypot(gx, gy, gz) || 1;
    g[0] = gx / gl;
    g[1] = gy / gl;
    g[2] = gz / gl;
    return f;
  };
  /** Surface normal by central differences (the analytic gradient ignores the tubes' bending). */
  const exactNormal = (x: number, y: number, z: number, pb: number, out: Float64Array, o: number) => {
    const e = k * 0.003;
    const nx = field(x + e, y, z, pb) - field(x - e, y, z, pb);
    const ny = field(x, y + e, z, pb) - field(x, y - e, z, pb);
    const nz = field(x, y, z + e, pb) - field(x, y, z - e, pb);
    const l = Math.hypot(nx, ny, nz) || 1;
    out[o] = nx / l;
    out[o + 1] = ny / l;
    out[o + 2] = nz / l;
  };

  /** Starts the main tube's closest-point search at the vertex's curve parameter (for branch
   * vertices that is the anchor). */
  const mainSamples = main.closed ? main.n : main.n - 1;
  const seed = (v: number) => {
    hm.i = Math.min(main.n - 1, Math.round(tparamAll[v] * mainSamples));
  };
  let vpart: ArrayLike<number> = part;
  let tparamAll: ArrayLike<number> = input.tparam;

  const kept = new Uint8Array(V0);
  // a crossing can only be fused when both meshes are cut there; a needle tip thinner than the
  // tube's triangles leaves no hole in the tube, so such a branch part is kept and just overlaps
  for (let pass = 0; pass < 8; pass++) {
    const r = attempt();
    if (r === null || 'positions' in r) return r;
    release(r);
  }
  return null;

  /**
   * Resolves an unpaired branch loop by flipping the smaller of the two regions it separates:
   * a small part inside the tube (e.g. a needle tip) is kept and just overlaps, a small part
   * outside (a bit of the root poking through a thin tube) is dropped.
   */
  function release(seeds: { inside: number[]; outside: number[] }): void {
    const adj = new Map<number, number[]>();
    for (let i = 0; i < index.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = index[i + e], b = index[i + ((e + 1) % 3)];
        if (part[a] < 0 || side[a] < 0 !== side[b] < 0) continue;
        let l = adj.get(a);
        if (!l) adj.set(a, (l = []));
        l.push(b);
      }
    }
    const flood = (start: number[], limit: number): number[] | null => {
      const seen = new Set<number>(start);
      const stack = [...start];
      while (stack.length) {
        const v = stack.pop()!;
        for (const n of adj.get(v) ?? []) {
          if (seen.has(n)) continue;
          if (seen.size >= limit) return null;
          seen.add(n);
          stack.push(n);
        }
      }
      return [...seen];
    };
    const inner = flood(seeds.inside, V0)!;
    const outer = flood(seeds.outside, inner.length);
    if (outer) for (const v of outer) side[v] = -1;
    else
      for (const v of inner) {
        side[v] = Infinity;
        kept[v] = 1;
      }
  }

  /** Cuts, smooths and welds; returns the two sides of an unpaired branch loop instead. */
  function attempt(): FusedMesh | { inside: number[]; outside: number[] } | null {
    // --- 2. cut every triangle along the intersection, keeping the outside parts --------------
    const pos: number[] = Array.from(positions);
    const tp: number[] = Array.from(input.tparam);
    const st: number[] = Array.from(input.strand);
    const vp: number[] = Array.from(part);
    vpart = vp;
    tparamAll = tp;
    /** For cut vertices: the original vertex on the inside of the cut edge. */
    const cutInside = new Map<number, number>();
    const cutOutside = new Map<number, number>();
    const cuts = new Map<number, number>();
    const snapped = new Set<number>();
    const cut = (a: number, b: number): number => {
      const key = a < b ? a * V0 + b : b * V0 + a;
      const known = cuts.get(key);
      if (known !== undefined) return known;
      const f = side[a] / (side[a] - side[b]);
      // a cut right next to the kept vertex would leave a sliver: move that vertex onto the cut
      const o = side[a] < 0 ? b : a;
      const fo = o === a ? f : 1 - f;
      if (fo < 0.3) {
        if (!snapped.has(o)) {
          for (let c = 0; c < 3; c++) pos[o * 3 + c] = pos[a * 3 + c] + (pos[b * 3 + c] - pos[a * 3 + c]) * f;
          snapped.add(o);
        }
        cuts.set(key, o);
        cutInside.set(o, o === a ? b : a);
        cutOutside.set(o, o);
        return o;
      }
      const id = pos.length / 3;
      for (let c = 0; c < 3; c++) pos.push(pos[a * 3 + c] + (pos[b * 3 + c] - pos[a * 3 + c]) * f);
      tp.push(tp[a] + (tp[b] - tp[a]) * f);
      st.push(st[a]);
      vp.push(vp[a]);
      cuts.set(key, id);
      cutInside.set(id, side[a] < 0 ? a : b);
      cutOutside.set(id, side[a] < 0 ? b : a);
      return id;
    };
    const tris: number[] = [];
    for (let i = 0; i < index.length; i += 3) {
      const t = [index[i], index[i + 1], index[i + 2]];
      const inside = t.map((v) => side[v] >= 0);
      const n = inside.filter(Boolean).length;
      if (n === 3) tris.push(t[0], t[1], t[2]);
      else if (n === 1 || n === 2) {
        // rotate so that the odd vertex comes first; winding stays the same
        let r = 0;
        while (inside[r] === (n !== 1)) r++;
        const a = t[r], b = t[(r + 1) % 3], c = t[(r + 2) % 3];
        const ab = cut(a, b), ac = cut(a, c);
        const add = (p: number, q: number, r: number) => {
          if (p !== q && q !== r && r !== p) tris.push(p, q, r);
        };
        if (n === 1) add(a, ab, ac);
        else {
          add(ab, b, c);
          add(ab, c, ac);
        }
      }
    }
    const V = pos.length / 3;

    // --- 3. the cut edges form one closed loop per junction and side ------------------------
    // outgoing edges per vertex (compressed rows), to find edges without a reverse twin
    const start = new Int32Array(V + 1);
    for (const v of tris) start[v + 1]++;
    for (let v = 0; v < V; v++) start[v + 1] += start[v];
    const fill = start.slice(0, V);
    const out = new Int32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) out[fill[tris[i + e]]++] = tris[i + ((e + 1) % 3)];
    }
    const hasEdge = (a: number, b: number) => {
      for (let q = start[a]; q < start[a + 1]; q++) if (out[q] === b) return true;
      return false;
    };
    const next = new Map<number, number>();
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = tris[i + e], b = tris[i + ((e + 1) % 3)];
        if (hasEdge(b, a)) continue;
        if (next.has(a)) return null; // not manifold
        next.set(a, b);
      }
    }
    const loops: number[][] = [];
    const seen = new Set<number>();
    for (const startV of next.keys()) {
      if (seen.has(startV)) continue;
      const loop: number[] = [];
      let v = startV;
      while (!seen.has(v)) {
        seen.add(v);
        loop.push(v);
        const n = next.get(v);
        if (n === undefined) return null;
        v = n;
      }
      if (v !== startV || loop.length < 3) return null;
      loops.push(loop);
    }

    // --- 4. pair every main-tube loop with the branch loop cut at the same junction ----------
    const centroid = (loop: number[]) => {
      const c = [0, 0, 0];
      for (const v of loop) for (let i = 0; i < 3; i++) c[i] += pos[v * 3 + i] / loop.length;
      return c;
    };
    const mainLoops = loops.filter((l) => vpart[l[0]] < 0);
    const branchLoops = loops.filter((l) => vpart[l[0]] >= 0);
    const mc = mainLoops.map(centroid);
    const bc = branchLoops.map(centroid);
    // the branch that cut each main-tube loop
    const loopBranch = mainLoops.map((l) => {
      const votes = new Map<number, number>();
      for (const v of l) {
        const b = cutBy[cutInside.get(v) ?? v];
        votes.set(b, (votes.get(b) ?? 0) + 1);
      }
      return [...votes].sort((x, y) => y[1] - x[1])[0][0];
    });
    const pairs: [number, number, number][] = [];
    mc.forEach((m, i) =>
      bc.forEach((b, j) => {
        if (vpart[branchLoops[j][0]] !== loopBranch[i]) return;
        pairs.push([i, j, (m[0] - b[0]) ** 2 + (m[1] - b[1]) ** 2 + (m[2] - b[2]) ** 2]);
      }),
    );
    pairs.sort((x, y) => x[2] - y[2]);
    const mainOf = new Int32Array(branchLoops.length).fill(-1);
    const matched = new Uint8Array(mainLoops.length);
    for (const [i, j] of pairs) {
      if (matched[i] || mainOf[j] >= 0) continue;
      matched[i] = 1;
      mainOf[j] = i;
    }
    if (matched.some((m) => !m)) return null;
    const unpaired = branchLoops.filter((_, j) => mainOf[j] < 0);
    if (unpaired.length) {
      const l = unpaired[0];
      return { inside: l.map((v) => cutInside.get(v)!), outside: l.map((v) => cutOutside.get(v)!) };
    }

    // --- 5. move vertices near junctions onto the smooth union ------------------------------
    const used = new Uint8Array(V);
    for (const v of tris) used[v] = 1;
    /**
     * Moves a vertex onto the smooth union along the field's gradient. With `damp` < 1 the first
     * steps are partial, so vertices follow the curved gradient lines instead of straight
     * Newton steps (those can cross near the crease and fold triangles).
     */
    const project = (v: number, steps: number, damp = 1) => {
      const pb = vpart[v];
      seed(v);
      let x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      let f = field(x, y, z, pb);
      for (let it = 0; it < steps && Math.abs(f) > k * 1e-5; it++) {
        const w = it < steps - 3 ? damp : 1;
        const s = Math.max(-k, Math.min(k, (w * f) / Math.max(gl, 1e-6)));
        x -= g[0] * s;
        y -= g[1] * s;
        z -= g[2] * s;
        f = field(x, y, z, pb);
      }
      pos[v * 3] = x;
      pos[v * 3 + 1] = y;
      pos[v * 3 + 2] = z;
    };
    const smoothed: number[] = [];
    for (let v = 0; v < V; v++) {
      if (!used[v] || (v < V0 && kept[v])) continue;
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      if (vpart[v] < 0 && !boxes.some((_, b) => inBox(b, x, y, z))) continue;
      field(x, y, z, vpart[v]);
      if (!blended) continue;
      project(v, 8, 0.4);
      // vertices that barely moved keep their tube shading and need no evening out
      const moved = Math.hypot(pos[v * 3] - x, pos[v * 3 + 1] - y, pos[v * 3 + 2] - z);
      if (moved > k * 0.004 || v >= V0) smoothed.push(v);
    }

    // --- 6. weld the paired loops ------------------------------------------------------------
    // both loops run along the same curve (in opposite directions); merge them into one vertex
    // sequence and split each boundary triangle so that both sides share every vertex
    const boundaryTri = new Map<number, number>();
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const u = tris[i + e], w = tris[i + ((e + 1) % 3)];
        if (next.get(u) === w) boundaryTri.set(u * V + w, i);
      }
    }
    const remap = new Map<number, number>();
    branchLoops.forEach((bl, j) => weld(mainLoops[mainOf[j]], bl));
    // merged vertices take their partner's index; collapsed triangles disappear
    {
      let o = 0;
      for (let i = 0; i < tris.length; i += 3) {
        const t0 = remap.get(tris[i]) ?? tris[i], t1 = remap.get(tris[i + 1]) ?? tris[i + 1], t2 = remap.get(tris[i + 2]) ?? tris[i + 2];
        if (t0 === t1 || t1 === t2 || t2 === t0) continue;
        tris[o++] = t0;
        tris[o++] = t1;
        tris[o++] = t2;
      }
      tris.length = o;
    }

    /**
     * Welds two loops that run along the same curve in opposite directions: the denser loop
     * stays, each vertex of the other one is merged into its nearest vertex there (in order
     * along the curve), and gaps get fans, so both sides share the seam's vertices.
     */
    function weld(A0: number[], B0: number[]): void {
      const [C, D] = A0.length >= B0.length ? [A0, B0] : [B0, A0];
      const m = C.length, n = D.length;
      const P = (v: number, c: number) => pos[v * 3 + c];
      /** Closest point on segment i of C (c_i -> c_i+1) as fraction, and squared distance. */
      const onSeg = (i: number, v: number): [number, number] => {
        const a0 = C[i % m], a1 = C[(i + 1) % m];
        const ex = P(a1, 0) - P(a0, 0), ey = P(a1, 1) - P(a0, 1), ez = P(a1, 2) - P(a0, 2);
        const l2 = ex * ex + ey * ey + ez * ez;
        const dot = (P(v, 0) - P(a0, 0)) * ex + (P(v, 1) - P(a0, 1)) * ey + (P(v, 2) - P(a0, 2)) * ez;
        const f = l2 > 0 ? Math.min(1, Math.max(0, dot / l2)) : 0;
        const dx = P(a0, 0) + ex * f - P(v, 0), dy = P(a0, 1) + ey * f - P(v, 1), dz = P(a0, 2) + ez * f - P(v, 2);
        return [f, dx * dx + dy * dy + dz * dz];
      };
      // D walked backwards runs forwards along C; give each vertex a monotone parameter on C
      let j0 = 0, bd = Infinity;
      for (let q = 0; q < n; q++) {
        const d = Math.min(onSeg(0, D[q])[1], onSeg(m - 1, D[q])[1]);
        if (d < bd) {
          bd = d;
          j0 = q;
        }
      }
      const dAt = (q: number) => D[(((j0 - q) % n) + n) % n];
      let cur = 0;
      const window = Math.max(4, Math.ceil(m / 6));
      const target = new Int32Array(n);
      for (let q = 0; q < n; q++) {
        let best = cur, bestD = Infinity;
        for (let i = Math.floor(cur); i < Math.min(m, Math.floor(cur) + window); i++) {
          const [f, d] = onSeg(i, dAt(q));
          if (d < bestD) {
            bestD = d;
            best = i + f;
          }
        }
        cur = Math.max(cur, best);
        target[q] = Math.round(cur) % m;
      }
      for (let q = 0; q < n; q++) remap.set(dAt(q), C[target[q]]);
      // D's own edges D[x] -> D[x+1] run backwards along C: fill the C vertices they skip
      for (let x = 0; x < n; x++) {
        const u = D[x], w = D[(x + 1) % n];
        const iu = C.indexOf(remap.get(u)!), iw = C.indexOf(remap.get(w)!);
        if (iu < 0 || iw < 0) continue;
        // endpoints keep their own index until the final remap, so later lookups still match
        const inner: number[] = [];
        for (let i = (iu - 1 + m) % m; i !== iw && i !== iu; i = (i - 1 + m) % m) inner.push(C[i]);
        if (iu !== iw && inner.length) replaceEdge(u, w, [u, ...inner, w]);
      }
    }

    /** Replaces the triangle with boundary edge u -> w by a fan through `chain` (u ... w). */
    function replaceEdge(u: number, w: number, chain: number[]): void {
      const t = boundaryTri.get(u * V + w);
      if (t === undefined) return;
      let e = 0;
      while (e < 3 && tris[t + e] !== u) e++;
      if (e === 3) return;
      const x = tris[t + ((e + 2) % 3)];
      tris[t] = chain[0];
      tris[t + 1] = chain[1];
      tris[t + 2] = x;
      for (let c = 1; c + 1 < chain.length; c++) tris.push(chain[c], chain[c + 1], x);
      // the triangle's other edges now live in the first and last fan triangles
      const last = chain.length > 2 ? tris.length - 3 : t;
      if (next.get(x) === u) boundaryTri.set(x * V + u, t);
      if (next.get(w) === x) boundaryTri.set(w * V + x, last);
    }

    // --- 7. even out the fillet: the cut edges travel further than their neighbours, which can
    // fold triangles; relax the moved vertices along the surface and project them back --------
    // vertices merged away by the weld are no longer used
    used.fill(0);
    for (const v of tris) used[v] = 1;
    const moved = smoothed.filter((v) => used[v]);
    smoothed.length = 0;
    smoothed.push(...moved);
    const isSmoothed = new Uint8Array(V);
    for (const v of smoothed) isSmoothed[v] = 1;
    const nbrs = new Map<number, Set<number>>();
    for (let i = 0; i < tris.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const u = tris[i + e], w = tris[i + ((e + 1) % 3)];
        if (isSmoothed[u]) {
          let l = nbrs.get(u);
          if (!l) nbrs.set(u, (l = new Set()));
          l.add(w);
        }
        if (isSmoothed[w]) {
          let l = nbrs.get(w);
          if (!l) nbrs.set(w, (l = new Set()));
          l.add(u);
        }
      }
    }
    const normal = new Float64Array(V * 3);
    /** Moves v towards the mean of its neighbours (weight w) and back onto the surface. */
    const relax = (v: number, w: number) => {
      const l = nbrs.get(v)!;
      let x = 0, y = 0, z = 0;
      for (const q of l) {
        x += pos[q * 3];
        y += pos[q * 3 + 1];
        z += pos[q * 3 + 2];
      }
      pos[v * 3] += w * (x / l.size - pos[v * 3]);
      pos[v * 3 + 1] += w * (y / l.size - pos[v * 3 + 1]);
      pos[v * 3 + 2] += w * (z / l.size - pos[v * 3 + 2]);
      project(v, 2);
    };
    for (let it = 0; it < 3; it++) for (const v of smoothed) relax(v, 0.5);
    const setNormal = (v: number) => {
      seed(v);
      exactNormal(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], vpart[v], normal, v * 3);
    };
    for (const v of smoothed) setNormal(v);

    // untangle: relax the corners of triangles that still face against the surface normal
    const trisOf = new Map<number, number[]>();
    let check: number[] = [];
    for (let i = 0; i < tris.length; i += 3) {
      let near = false;
      for (let e = 0; e < 3; e++) {
        const v = tris[i + e];
        if (!isSmoothed[v]) continue;
        near = true;
        let l = trisOf.get(v);
        if (!l) trisOf.set(v, (l = []));
        l.push(i);
      }
      if (near) check.push(i);
    }
    /** Whether triangle i faces against the normals of its moved corners. */
    const folded = (i: number) => {
      let d = 0;
      const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (let e = 0; e < 3; e++) {
        const q = tris[i + e];
        if (isSmoothed[q]) d += nx * normal[q * 3] + ny * normal[q * 3 + 1] + nz * normal[q * 3 + 2];
      }
      return d < 0;
    };
    for (let round = 0; round < 40 && check.length; round++) {
      const bad = new Set<number>();
      for (const i of check) {
        if (!folded(i)) continue;
        for (let e = 0; e < 3; e++) if (isSmoothed[tris[i + e]]) bad.add(tris[i + e]);
      }
      if (!bad.size) break;
      // include the neighbours so the fold can open up; recheck only what moved
      const region = new Set(bad);
      for (const v of bad) for (const q of nbrs.get(v)!) if (isSmoothed[q]) region.add(q);
      for (const v of region) relax(v, 0.8);
      for (const v of region) setNormal(v);
      const again = new Set<number>();
      for (const v of region) for (const i of trisOf.get(v) ?? []) again.add(i);
      check = [...again];
    }

    const smoothedNormals: number[] = [];
    for (const v of smoothed) smoothedNormals.push(normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2]);

    return {
      positions: new Float32Array(pos),
      index: new Uint32Array(tris),
      tparam: new Float32Array(tp),
      strand: Uint8Array.from(st),
      smoothed: new Uint32Array(smoothed),
      smoothedNormals: new Float32Array(smoothedNormals),
    };
  }
}
