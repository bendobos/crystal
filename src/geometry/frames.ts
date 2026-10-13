/**
 * Rotation-minimizing frames (double reflection method, Wang et al. 2008) along a sampled curve.
 * For closed curves the remaining rotation after one loop (holonomy) is spread evenly along the
 * curve so the frame at the end matches the start and the tube has no seam.
 */
export interface Frames {
  count: number;
  tangent: Float64Array;
  normal: Float64Array;
  binormal: Float64Array;
}

export function computeTangents(pos: Float64Array, count: number, closed: boolean, out: Float64Array): void {
  for (let i = 0; i < count; i++) {
    let a = i - 1;
    let b = i + 1;
    if (closed) {
      a = (a + count) % count;
      b = b % count;
    } else {
      if (a < 0) a = 0;
      if (b >= count) b = count - 1;
    }
    let x = pos[b * 3] - pos[a * 3];
    let y = pos[b * 3 + 1] - pos[a * 3 + 1];
    let z = pos[b * 3 + 2] - pos[a * 3 + 2];
    let l = Math.hypot(x, y, z);
    if (l < 1e-12) {
      // degenerate: reuse the previous tangent
      if (i > 0) {
        x = out[(i - 1) * 3];
        y = out[(i - 1) * 3 + 1];
        z = out[(i - 1) * 3 + 2];
      } else {
        x = 1;
        y = 0;
        z = 0;
      }
      l = Math.hypot(x, y, z);
    }
    out[i * 3] = x / l;
    out[i * 3 + 1] = y / l;
    out[i * 3 + 2] = z / l;
  }
}

export function createFrames(count: number): Frames {
  return {
    count,
    tangent: new Float64Array(count * 3),
    normal: new Float64Array(count * 3),
    binormal: new Float64Array(count * 3),
  };
}

/**
 * Fills `frames` for the curve sampled at `pos` (count points). The first normal is chosen as
 * close as possible to `up` (default: world up).
 */
export function computeFrames(pos: Float64Array, count: number, closed: boolean, frames: Frames, up?: readonly number[]): void {
  const T = frames.tangent;
  const N = frames.normal;
  const B = frames.binormal;
  computeTangents(pos, count, closed, T);

  // initial normal: perpendicular to the first tangent, as close to world-up as possible
  {
    const tx = T[0];
    const ty = T[1];
    const tz = T[2];
    let ux = 0;
    let uy = 1;
    let uz = 0;
    if (up && Math.abs(up[0] * tx + up[1] * ty + up[2] * tz) < 0.98 * Math.hypot(up[0], up[1], up[2])) {
      ux = up[0];
      uy = up[1];
      uz = up[2];
    } else if (Math.abs(ty) > 0.9) {
      ux = 0;
      uy = 0;
      uz = 1;
    }
    // n = normalize(u - (u·t) t)
    const d = ux * tx + uy * ty + uz * tz;
    let nx = ux - d * tx;
    let ny = uy - d * ty;
    let nz = uz - d * tz;
    const l = Math.hypot(nx, ny, nz);
    nx /= l;
    ny /= l;
    nz /= l;
    N[0] = nx;
    N[1] = ny;
    N[2] = nz;
  }

  const steps = closed ? count : count - 1;
  let rx = N[0];
  let ry = N[1];
  let rz = N[2];
  let endRx = 0;
  let endRy = 0;
  let endRz = 0;
  for (let s = 0; s < steps; s++) {
    const i = s;
    const j = (s + 1) % count;
    const v1x = pos[j * 3] - pos[i * 3];
    const v1y = pos[j * 3 + 1] - pos[i * 3 + 1];
    const v1z = pos[j * 3 + 2] - pos[i * 3 + 2];
    const c1 = v1x * v1x + v1y * v1y + v1z * v1z;
    let nrx = rx;
    let nry = ry;
    let nrz = rz;
    if (c1 > 1e-20) {
      const tix = T[i * 3];
      const tiy = T[i * 3 + 1];
      const tiz = T[i * 3 + 2];
      const k1 = (2 / c1) * (v1x * rx + v1y * ry + v1z * rz);
      const rLx = rx - k1 * v1x;
      const rLy = ry - k1 * v1y;
      const rLz = rz - k1 * v1z;
      const k2 = (2 / c1) * (v1x * tix + v1y * tiy + v1z * tiz);
      const tLx = tix - k2 * v1x;
      const tLy = tiy - k2 * v1y;
      const tLz = tiz - k2 * v1z;
      const v2x = T[j * 3] - tLx;
      const v2y = T[j * 3 + 1] - tLy;
      const v2z = T[j * 3 + 2] - tLz;
      const c2 = v2x * v2x + v2y * v2y + v2z * v2z;
      if (c2 > 1e-20) {
        const k3 = (2 / c2) * (v2x * rLx + v2y * rLy + v2z * rLz);
        nrx = rLx - k3 * v2x;
        nry = rLy - k3 * v2y;
        nrz = rLz - k3 * v2z;
      } else {
        nrx = rLx;
        nry = rLy;
        nrz = rLz;
      }
    }
    // re-orthogonalize against the next tangent to avoid drift
    const tjx = T[j * 3];
    const tjy = T[j * 3 + 1];
    const tjz = T[j * 3 + 2];
    const d = nrx * tjx + nry * tjy + nrz * tjz;
    nrx -= d * tjx;
    nry -= d * tjy;
    nrz -= d * tjz;
    const l = Math.hypot(nrx, nry, nrz) || 1;
    rx = nrx / l;
    ry = nry / l;
    rz = nrz / l;
    if (j === 0) {
      endRx = rx;
      endRy = ry;
      endRz = rz;
    } else {
      N[j * 3] = rx;
      N[j * 3 + 1] = ry;
      N[j * 3 + 2] = rz;
    }
  }

  if (closed) {
    // angle from the propagated end normal back to the start normal, around the start tangent
    const n0x = N[0];
    const n0y = N[1];
    const n0z = N[2];
    const t0x = T[0];
    const t0y = T[1];
    const t0z = T[2];
    const cx = endRy * n0z - endRz * n0y;
    const cy = endRz * n0x - endRx * n0z;
    const cz = endRx * n0y - endRy * n0x;
    const sin = cx * t0x + cy * t0y + cz * t0z;
    const cos = endRx * n0x + endRy * n0y + endRz * n0z;
    const holonomy = Math.atan2(sin, cos);
    for (let i = 1; i < count; i++) {
      rotateAroundTangent(N, T, i, (holonomy * i) / count);
    }
  }

  // binormal = tangent × normal (right-handed: normal × binormal = tangent)
  for (let i = 0; i < count; i++) {
    const tx = T[i * 3];
    const ty = T[i * 3 + 1];
    const tz = T[i * 3 + 2];
    const nx = N[i * 3];
    const ny = N[i * 3 + 1];
    const nz = N[i * 3 + 2];
    B[i * 3] = ty * nz - tz * ny;
    B[i * 3 + 1] = tz * nx - tx * nz;
    B[i * 3 + 2] = tx * ny - ty * nx;
  }
}

function rotateAroundTangent(N: Float64Array, T: Float64Array, i: number, angle: number): void {
  const tx = T[i * 3];
  const ty = T[i * 3 + 1];
  const tz = T[i * 3 + 2];
  const nx = N[i * 3];
  const ny = N[i * 3 + 1];
  const nz = N[i * 3 + 2];
  // b = t × n
  const bx = ty * nz - tz * ny;
  const by = tz * nx - tx * nz;
  const bz = tx * ny - ty * nx;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  N[i * 3] = c * nx + s * bx;
  N[i * 3 + 1] = c * ny + s * by;
  N[i * 3 + 2] = c * nz + s * bz;
}
