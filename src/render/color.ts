/**
 * Colour helpers shared by the renderer and the UI. The display transform here mirrors the GLSL
 * in shaders/composite.ts exactly, so background colours can be inverted to the HDR radiance that
 * displays as exactly the colour the user picked.
 */

export type RGB = [number, number, number];
export type OutputSpace = 'srgb' | 'p3';
export type Mat3 = [RGB, RGB, RGB]; // column-major, like GLSL mat3(c0, c1, c2)

export function hexToSrgb(hex: string): RGB {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function srgbToHex(c: RGB): string {
  const to = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0');
  return `#${to(c[0])}${to(c[1])}${to(c[2])}`;
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export function hexToLinear(hex: string): RGB {
  const s = hexToSrgb(hex);
  return [srgbToLinear(s[0]), srgbToLinear(s[1]), srgbToLinear(s[2])];
}

export function mul(m: Mat3, v: RGB): RGB {
  return [
    m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
    m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
    m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
  ];
}

function mulMat(a: Mat3, b: Mat3): Mat3 {
  return [mul(a, b[0]), mul(a, b[1]), mul(a, b[2])];
}

function invert(m: Mat3): Mat3 {
  const [a, b, c] = [m[0][0], m[1][0], m[2][0]];
  const [d, e, f] = [m[0][1], m[1][1], m[2][1]];
  const [g, h, i] = [m[0][2], m[1][2], m[2][2]];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    [A, -(b * i - c * h), b * f - c * e],
    [B, a * i - c * g, -(a * f - c * d)],
    [C, -(a * h - b * g), a * e - b * d],
  ].map((row) => row.map((x) => x / det));
  // inv is row-major; convert to column-major
  return [
    [inv[0][0], inv[1][0], inv[2][0]],
    [inv[0][1], inv[1][1], inv[2][1]],
    [inv[0][2], inv[1][2], inv[2][2]],
  ];
}

function rowsToCols(r: number[][]): Mat3 {
  return [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ];
}

// Primaries → CIE XYZ (D65)
const SRGB_TO_XYZ = rowsToCols([
  [0.4123908, 0.3575843, 0.1804808],
  [0.212639, 0.7151687, 0.0721923],
  [0.0193308, 0.1191948, 0.9505322],
]);
const P3_TO_XYZ = rowsToCols([
  [0.4865709, 0.2656677, 0.1982173],
  [0.2289746, 0.6917385, 0.0792869],
  [0.0, 0.0451134, 1.0439444],
]);
const REC2020_TO_XYZ = rowsToCols([
  [0.636958, 0.1446169, 0.168881],
  [0.2627002, 0.6779981, 0.0593017],
  [0.0, 0.0280727, 1.0609851],
]);

export const XYZ_TO_SRGB = invert(SRGB_TO_XYZ);
export const SRGB_TO_REC2020: Mat3 = mulMat(invert(REC2020_TO_XYZ), SRGB_TO_XYZ);
export const REC2020_TO_SRGB: Mat3 = invert(SRGB_TO_REC2020);
export const REC2020_TO_P3: Mat3 = mulMat(invert(P3_TO_XYZ), REC2020_TO_XYZ);
export const SRGB_TO_P3: Mat3 = mulMat(invert(P3_TO_XYZ), SRGB_TO_XYZ);

export function outFromRec2020(space: OutputSpace): Mat3 {
  return space === 'p3' ? REC2020_TO_P3 : REC2020_TO_SRGB;
}

// --- tone mapping (identical to composite.ts) ---------------------------------------------------

// three.js AgX (MIT), matrices in GLSL column order
const AGX_SRGB_TO_REC2020: Mat3 = [
  [0.6274, 0.0691, 0.0164],
  [0.3293, 0.9195, 0.088],
  [0.0433, 0.0113, 0.8956],
];
const AGX_INSET: Mat3 = [
  [0.856627153315983, 0.137318972929847, 0.11189821299995],
  [0.0951212405381588, 0.761241990602591, 0.0767994186031903],
  [0.0482516061458583, 0.101439036467562, 0.811302368396859],
];
const AGX_OUTSET: Mat3 = [
  [1.1271005818144368, -0.1413297634984383, -0.14132976349843826],
  [-0.11060664309660323, 1.157823702216272, -0.11060664309660294],
  [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405],
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

function agxContrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** AgX: linear sRGB in, linear Rec.2020 display out (before output gamut conversion). */
function agx(c: RGB): RGB {
  let v = mul(AGX_INSET, mul(AGX_SRGB_TO_REC2020, c));
  v = v.map((x) => {
    const l = Math.log2(Math.max(x, 1e-10));
    const n = Math.min(Math.max((l - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0), 1);
    return agxContrast(n);
  }) as RGB;
  v = mul(AGX_OUTSET, v);
  return v.map((x) => Math.pow(Math.max(0, x), 2.2)) as RGB;
}

/** Khronos PBR Neutral: linear sRGB in, linear Rec.2020 out. */
function neutral(c: RGB): RGB {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  let col: RGB = [...c];
  const x = Math.min(col[0], col[1], col[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  col = col.map((v) => v - offset) as RGB;
  const peak = Math.max(col[0], col[1], col[2]);
  if (peak >= startCompression) {
    const d = 1 - startCompression;
    const newPeak = 1 - (d * d) / (peak + d - startCompression);
    col = col.map((v) => (v * newPeak) / peak) as RGB;
    const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
    col = col.map((v) => v + (newPeak - v) * g) as RGB;
  }
  return mul(SRGB_TO_REC2020, col);
}

export interface DisplayParams {
  exposure: number;
  toneMapping: 'agx' | 'neutral';
  contrast: number;
  saturation: number;
}

const LUMA_2020: RGB = [0.2627, 0.678, 0.0593];

/** Linear sRGB radiance → display-encoded colour in the output space (no spatial effects). */
export function displayTransform(c: RGB, p: DisplayParams, space: OutputSpace): RGB {
  const k = Math.pow(2, p.exposure);
  const x: RGB = [c[0] * k, c[1] * k, c[2] * k];
  let v = p.toneMapping === 'agx' ? agx(x) : neutral(x);
  // grade in linear Rec.2020 display space
  const l = v[0] * LUMA_2020[0] + v[1] * LUMA_2020[1] + v[2] * LUMA_2020[2];
  v = v.map((ch) => l + (ch - l) * p.saturation) as RGB;
  v = v.map((ch) => {
    const e = Math.pow(Math.min(Math.max(ch, 0), 1), 1 / 2.2);
    const s = e * e * (3 - 2 * e);
    return Math.pow(Math.min(Math.max(e + p.contrast * (s - e), 0), 1), 2.2);
  }) as RGB;
  const o = mul(outFromRec2020(space), v);
  return o.map((ch) => linearToSrgb(Math.min(Math.max(ch, 0), 1))) as RGB;
}

/**
 * Finds linear sRGB radiance whose display transform is the given sRGB hex colour.
 * Colours brighter than the tone mapper can reach are clamped to the brightest reachable value.
 */
export function inverseDisplay(hex: string, p: DisplayParams, space: OutputSpace): RGB {
  return inverseDisplaySrgb(hexToSrgb(hex), p, space);
}

export function inverseDisplaySrgb(srgb: RGB, p: DisplayParams, space: OutputSpace): RGB {
  let target: RGB = srgb;
  if (space === 'p3') {
    const lin: RGB = [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
    target = mul(SRGB_TO_P3, lin).map((v) => linearToSrgb(Math.min(Math.max(v, 0), 1))) as RGB;
  }
  const k = Math.pow(2, p.exposure);
  let L: RGB = [srgbToLinear(srgb[0]) / k, srgbToLinear(srgb[1]) / k, srgbToLinear(srgb[2]) / k];
  const maxL = 80 / k;
  for (let it = 0; it < 40; it++) {
    const d = displayTransform(L, p, space);
    let err = 0;
    L = L.map((v, i) => {
      const t = srgbToLinear(target[i]);
      const cur = srgbToLinear(d[i]);
      err = Math.max(err, Math.abs(t - cur));
      if (t <= 1e-5) return v * 0.5;
      const ratio = cur > 1e-6 ? t / cur : 4;
      // damped multiplicative update; tone curves are monotone so this converges
      return Math.min(Math.max(v * Math.pow(ratio, 0.8), 1e-7), maxL);
    }) as RGB;
    if (err < 2e-4) break;
  }
  return L;
}
