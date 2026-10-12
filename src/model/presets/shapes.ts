import type { ShapeDoc, Vec3 } from '../types';
import { mulberry32 } from '../../util/random';

export interface ShapePreset {
  id: string;
  name: string;
  build: () => ShapeDoc;
}

function base(points: Vec3[], over: Partial<ShapeDoc> = {}): ShapeDoc {
  return {
    points,
    closed: true,
    radius: 0.32,
    flatness: 0.45,
    roundness: 0.25,
    twist: 0,
    strands: 1,
    strandSpread: 1.3,
    strandTwist: 0,
    detail: null,
    ...over,
  };
}

function sample(n: number, f: (a: number) => Vec3): Vec3[] {
  return Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));
}

/** Rotates points around the x axis (tilt towards the viewer) and then around y. */
function tilt(points: Vec3[], ax: number, ay = 0): Vec3[] {
  const cx = Math.cos(ax), sx = Math.sin(ax);
  const cy = Math.cos(ay), sy = Math.sin(ay);
  return points.map(([x, y, z]) => {
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    return [x * cy + z1 * sy, y1, -x * sy + z1 * cy] as Vec3;
  });
}

export const SHAPE_PRESETS: ShapePreset[] = [
  {
    id: 'infinity',
    name: 'Unendlich',
    build: () =>
      base(
        tilt(
          sample(12, (a) => {
            const d = 1 + Math.sin(a) ** 2;
            // lemniscate of Bernoulli, lifted apart at the crossing
            return [(2.1 * Math.cos(a)) / d, (2.1 * Math.sin(a) * Math.cos(a)) / d, 0.42 * Math.sin(a)];
          }),
          -0.5,
          0.25,
        ),
        { radius: 0.36, flatness: 0.35, twist: 0.5 },
      ),
  },
  {
    id: 'infinity-bundle',
    name: 'Unendlich, gebündelt',
    build: () =>
      base(
        tilt(
          sample(12, (a) => {
            const d = 1 + Math.sin(a) ** 2;
            return [(2.2 * Math.cos(a)) / d, (2.2 * Math.sin(a) * Math.cos(a)) / d, 0.55 * Math.sin(a)];
          }),
          -0.45,
          0.2,
        ),
        { radius: 0.2, flatness: 0.55, strands: 3, strandSpread: 1.15, strandTwist: 1 / 3, twist: 1 },
      ),
  },
  {
    id: 'ring',
    name: 'Ring',
    build: () =>
      base(
        tilt(sample(8, (a) => [1.55 * Math.cos(a), 1.55 * Math.sin(a), 0.18 * Math.sin(2 * a)]), -0.9, 0.35),
        { radius: 0.42, flatness: 0.15, twist: 0 },
      ),
  },
  {
    id: 'moebius',
    name: 'Möbius',
    build: () =>
      base(
        tilt(sample(9, (a) => [1.5 * Math.cos(a), 1.35 * Math.sin(a), 0.25 * Math.cos(2 * a)]), -0.75, 0.5),
        { radius: 0.62, flatness: 0.72, roundness: 0.35, twist: 0.5 },
      ),
  },
  {
    id: 'multiring',
    name: 'Mehrfachring',
    build: () =>
      base(
        tilt(sample(8, (a) => [1.35 * Math.cos(a), 1.35 * Math.sin(a), 0.12 * Math.sin(3 * a)]), -0.85, 0.6),
        { radius: 0.24, flatness: 0.6, strands: 3, strandSpread: 1.45, strandTwist: 1 / 3, twist: 0.5 },
      ),
  },
  {
    id: 'wave',
    name: 'Welle',
    build: () =>
      base(
        [
          [-4.2, -0.4, 0.4],
          [-2.9, 0.3, 0],
          [-2.3, 1.15, -0.5],
          [-3.0, 1.6, -0.2],
          [-3.25, 0.85, 0.4],
          [-2.2, 0.0, 0.5],
          [-1.0, 0.2, 0],
          [-0.3, 1.5, -0.3],
          [0.6, 1.4, 0],
          [1.1, -0.2, 0.3],
          [2.2, -0.8, 0.1],
          [3.4, -0.1, -0.2],
          [4.6, 0.6, 0],
        ],
        { closed: false, radius: 0.3, flatness: 0.2, twist: 0 },
      ),
  },
  {
    id: 'knot',
    name: 'Torusknoten',
    build: () =>
      base(
        tilt(
          sample(18, (a) => {
            const r = 1.25 + 0.5 * Math.cos(3 * a);
            return [r * Math.cos(2 * a), r * Math.sin(2 * a), 0.5 * Math.sin(3 * a)];
          }),
          -0.6,
          0.3,
        ),
        { radius: 0.24, flatness: 0.3, twist: 1 },
      ),
  },
  {
    id: 'helix',
    name: 'Spirale',
    build: () =>
      base(
        Array.from({ length: 12 }, (_, i) => {
          const a = (i / 11) * Math.PI * 4.2;
          return [Math.cos(a) * 1.1, -2.3 + (i / 11) * 4.6, Math.sin(a) * 1.1] as Vec3;
        }),
        { closed: false, radius: 0.28, flatness: 0.55, twist: 1.5 },
      ),
  },
];

export function shapePreset(id: string): ShapeDoc {
  return (SHAPE_PRESETS.find((p) => p.id === id) ?? SHAPE_PRESETS[0]).build();
}

/** Organic variation of a shape: smooth random displacement and parameter jitter. */
export function randomizeShape(shape: ShapeDoc, seed: number): ShapeDoc {
  const rnd = mulberry32(seed);
  let size = 0;
  for (const p of shape.points) size = Math.max(size, Math.hypot(p[0], p[1], p[2]));
  const amp = size * 0.22;
  // low-frequency displacement: a few random sine waves evaluated along the control polygon
  const waves = Array.from({ length: 3 }, () => ({
    f: 1 + Math.floor(rnd() * 3),
    ph: rnd() * Math.PI * 2,
    dir: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5] as Vec3,
  }));
  const n = shape.points.length;
  const points = shape.points.map((p, i) => {
    const a = (i / n) * Math.PI * 2;
    const q: Vec3 = [...p];
    for (const w of waves) {
      const s = Math.sin(a * w.f + w.ph) * amp;
      q[0] += w.dir[0] * s;
      q[1] += w.dir[1] * s;
      q[2] += w.dir[2] * s;
    }
    return q;
  });
  const closed = shape.closed;
  const strands = rnd() < 0.3 ? 2 + Math.floor(rnd() * 2) : 1;
  return {
    ...shape,
    points,
    flatness: Math.min(0.85, Math.max(0, shape.flatness + (rnd() - 0.5) * 0.5)),
    roundness: Math.min(1, Math.max(0, shape.roundness + (rnd() - 0.5) * 0.4)),
    twist: closed ? Math.round((rnd() * 2.5) * 2) / 2 : rnd() * 2,
    radius: Math.max(0.12, shape.radius * (0.75 + rnd() * 0.5) * (strands > 1 ? 0.7 : 1)),
    strands,
    strandSpread: 1.1 + rnd() * 0.6,
    strandTwist: strands > 1 ? Math.round(rnd() * 2) / strands : 0,
    detail: null,
  };
}
