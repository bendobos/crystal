import { z } from 'zod';
import { strFromU8, strToU8, deflateSync, inflateSync } from 'fflate';
import { DETAIL_SIZE, type DetailFields, type SceneDoc } from './types';
import { createDefaultDoc } from './defaults';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const num = (min: number, max: number) => z.number().finite().min(min).max(max);
const vec3 = z.tuple([num(-1e4, 1e4), num(-1e4, 1e4), num(-1e4, 1e4)]);
const camera = z.object({ position: vec3, target: vec3, focalLength: num(5, 600) });

const schema = z.object({
  version: z.literal(1),
  name: z.string().max(120),
  shape: z.object({
    points: z.array(vec3).min(2).max(200),
    closed: z.boolean(),
    radius: num(0.01, 10),
    flatness: num(0, 1),
    roundness: num(0, 1),
    twist: num(-50, 50),
    strands: num(1, 5),
    strandSpread: num(0, 10),
    strandTwist: num(-50, 50),
    detail: z.string().max(8000).nullable(),
    taper: num(0, 1).optional(),
    blend: num(0, 2).optional(),
    branches: z
      .array(z.object({ t: num(0, 1), points: z.array(vec3).min(1).max(40), width: num(0.01, 5) }))
      .max(24)
      .optional(),
  }),
  glass: z.object({
    ior: num(1, 3),
    dispersion: num(0, 1),
    tint: hex,
    tintDensity: num(0, 1),
    iridescence: num(0, 1),
    iridescenceThickness: z.tuple([num(0, 3000), num(0, 3000)]),
  }),
  lighting: z.object({
    studioId: z.string().max(40),
    exposure: num(-10, 10),
    rotation: num(-720, 720),
    dome: z.object({ top: hex, horizon: hex, bottom: hex, intensity: num(0, 100) }),
    lights: z
      .array(
        z.object({
          id: z.string().max(40),
          shape: z.enum(['rect', 'strip', 'disc', 'ring']),
          azimuth: num(-720, 720),
          elevation: num(-90, 90),
          distance: num(0.5, 200),
          width: num(0.01, 100),
          height: num(0.01, 100),
          rotation: num(-720, 720),
          color: hex,
          intensity: num(0, 1000),
          softness: num(0, 1),
          visibleToCamera: z.boolean(),
        }),
      )
      .max(16),
  }),
  background: z.object({
    type: z.enum(['solid', 'linear', 'radial']),
    stops: z.array(z.object({ color: hex, pos: num(0, 1) })).min(1).max(4),
    angle: num(-720, 720),
    center: z.tuple([num(-2, 3), num(-2, 3)]),
    radius: num(0.01, 10),
    glassInfluence: num(0, 1),
  }),
  camera,
  effects: z.object({
    toneMapping: z.enum(['agx', 'neutral']),
    contrast: num(-1, 2),
    saturation: num(0, 3),
    aperture: num(0, 1),
    focusDistance: num(0.1, 1000),
    bloom: num(0, 2),
    bloomRadius: num(0.1, 5),
    vignette: num(0, 1),
    grain: num(0, 1),
  }),
  exportTargets: z
    .array(
      z.object({
        id: z.string().max(40),
        formatId: z.string().max(40),
        width: num(16, 16384).int(),
        height: num(16, 16384).int(),
        camera: camera.nullable(),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
  activeTargetId: z.string().max(40),
});

// detail fields are quantised to int16: plenty of precision for a brush-sculpted surface
const OFFSET_SCALE = 3000;
const RADIUS_SCALE = 8000;
const TWIST_SCALE = 2000;

function encodeDetail(d: DetailFields): string {
  const q = new Int16Array(DETAIL_SIZE * 5);
  const clamp = (v: number) => Math.max(-32767, Math.min(32767, Math.round(v)));
  for (let i = 0; i < DETAIL_SIZE * 3; i++) q[i] = clamp(d.offset[i] * OFFSET_SCALE);
  for (let i = 0; i < DETAIL_SIZE; i++) {
    q[DETAIL_SIZE * 3 + i] = clamp(d.radius[i] * RADIUS_SCALE);
    q[DETAIL_SIZE * 4 + i] = clamp(d.twist[i] * TWIST_SCALE);
  }
  return toBase64Url(deflateSync(new Uint8Array(q.buffer), { level: 9 }));
}

function decodeDetail(s: string): DetailFields | null {
  try {
    const bytes = inflateSync(fromBase64Url(s));
    if (bytes.byteLength !== DETAIL_SIZE * 5 * 2) return null;
    const q = new Int16Array(bytes.buffer, bytes.byteOffset, DETAIL_SIZE * 5);
    const d: DetailFields = { offset: new Float32Array(DETAIL_SIZE * 3), radius: new Float32Array(DETAIL_SIZE), twist: new Float32Array(DETAIL_SIZE) };
    for (let i = 0; i < DETAIL_SIZE * 3; i++) d.offset[i] = q[i] / OFFSET_SCALE;
    for (let i = 0; i < DETAIL_SIZE; i++) {
      d.radius[i] = q[DETAIL_SIZE * 3 + i] / RADIUS_SCALE;
      d.twist[i] = q[DETAIL_SIZE * 4 + i] / TWIST_SCALE;
    }
    return d;
  } catch {
    return null;
  }
}

function round(v: unknown): unknown {
  if (typeof v === 'number') return Math.round(v * 1e4) / 1e4;
  if (Array.isArray(v)) return v.map(round);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)]));
  return v;
}

/** JSON-safe representation of a scene document. */
export function toJSON(doc: SceneDoc): object {
  const { phase: _p, strandPhase: _s, ...shape } = doc.shape;
  void _p;
  void _s;
  return round({ ...doc, shape: { ...shape, detail: doc.shape.detail ? encodeDetail(doc.shape.detail) : null } }) as object;
}

/** Validates untrusted data (share links, stored projects) and returns a scene document. */
export function fromJSON(data: unknown): SceneDoc {
  const parsed = schema.parse(data);
  const doc: SceneDoc = {
    ...parsed,
    shape: { ...parsed.shape, strands: Math.round(parsed.shape.strands), detail: parsed.shape.detail ? decodeDetail(parsed.shape.detail) : null },
  };
  if (!doc.exportTargets.some((t) => t.id === doc.activeTargetId)) doc.activeTargetId = doc.exportTargets[0].id;
  return doc;
}

export function encodeShare(doc: SceneDoc): string {
  return toBase64Url(deflateSync(strToU8(JSON.stringify(toJSON(doc))), { level: 9 }));
}

export function decodeShare(s: string): SceneDoc {
  if (s.length > 60000) throw new Error('Link zu lang');
  const json = strFromU8(inflateSync(fromBase64Url(s)));
  return fromJSON(JSON.parse(json));
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function safeDefault(): SceneDoc {
  return createDefaultDoc();
}
