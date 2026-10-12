import { DETAIL_SIZE, type DetailFields } from '../model/types';

export function createDetail(): DetailFields {
  return {
    offset: new Float32Array(DETAIL_SIZE * 3),
    radius: new Float32Array(DETAIL_SIZE),
    twist: new Float32Array(DETAIL_SIZE),
  };
}

export function cloneDetail(d: DetailFields): DetailFields {
  return { offset: d.offset.slice(), radius: d.radius.slice(), twist: d.twist.slice() };
}

export function isDetailEmpty(d: DetailFields | null): boolean {
  if (!d) return true;
  for (let i = 0; i < d.radius.length; i++) if (d.radius[i] !== 0 || d.twist[i] !== 0) return false;
  for (let i = 0; i < d.offset.length; i++) if (d.offset[i] !== 0) return false;
  return true;
}

/** Continuous sample position (index space) for normalized curve parameter t. */
function indexAt(t: number, closed: boolean): number {
  return closed ? t * DETAIL_SIZE : t * (DETAIL_SIZE - 1);
}

function wrap(i: number, closed: boolean): number {
  if (closed) return ((i % DETAIL_SIZE) + DETAIL_SIZE) % DETAIL_SIZE;
  return Math.min(Math.max(i, 0), DETAIL_SIZE - 1);
}

export function sampleScalar(field: Float32Array, t: number, closed: boolean): number {
  const x = indexAt(t, closed);
  const i0 = Math.floor(x);
  const f = x - i0;
  return field[wrap(i0, closed)] * (1 - f) + field[wrap(i0 + 1, closed)] * f;
}

export function sampleVec3(field: Float32Array, t: number, closed: boolean, out: [number, number, number]): void {
  const x = indexAt(t, closed);
  const i0 = Math.floor(x);
  const f = x - i0;
  const a = wrap(i0, closed) * 3;
  const b = wrap(i0 + 1, closed) * 3;
  out[0] = field[a] * (1 - f) + field[b] * f;
  out[1] = field[a + 1] * (1 - f) + field[b + 1] * f;
  out[2] = field[a + 2] * (1 - f) + field[b + 2] * f;
}

/** Parameter distance between two curve positions, respecting wrap-around for closed curves. */
export function paramDistance(a: number, b: number, closed: boolean): number {
  let d = Math.abs(a - b);
  if (closed) d = Math.min(d, 1 - d);
  return d;
}

/** Smooth falloff: 1 at the centre, 0 at |d| >= r. */
export function falloff(d: number, r: number): number {
  if (d >= r) return 0;
  const x = d / r;
  const k = 1 - x * x;
  return k * k;
}

/** Calls fn(index, weight) for every field sample inside the brush around t0 (radius in t units). */
export function forEachInBrush(
  t0: number,
  radius: number,
  closed: boolean,
  fn: (index: number, weight: number) => void,
): void {
  for (let i = 0; i < DETAIL_SIZE; i++) {
    const t = closed ? i / DETAIL_SIZE : i / (DETAIL_SIZE - 1);
    const w = falloff(paramDistance(t, t0, closed), radius);
    if (w > 0) fn(i, w);
  }
}

/** One pass of neighbour averaging, weighted by the brush (or everywhere when radius <= 0). */
export function smoothField(field: Float32Array, stride: number, closed: boolean, t0: number, radius: number, amount: number): void {
  const copy = field.slice();
  const n = DETAIL_SIZE;
  for (let i = 0; i < n; i++) {
    const t = closed ? i / n : i / (n - 1);
    const w = radius > 0 ? falloff(paramDistance(t, t0, closed), radius) * amount : amount;
    if (w <= 0) continue;
    const a = wrap(i - 1, closed);
    const b = wrap(i + 1, closed);
    for (let c = 0; c < stride; c++) {
      const avg = (copy[a * stride + c] + 2 * copy[i * stride + c] + copy[b * stride + c]) / 4;
      field[i * stride + c] = copy[i * stride + c] + (avg - copy[i * stride + c]) * Math.min(w, 1);
    }
  }
}
