import { DataTexture, DataUtils, HalfFloatType, LinearFilter, Matrix3, RGBAFormat, Vector2, Vector3, Vector4, ClampToEdgeWrapping, type IUniform } from 'three';
import type { BackgroundDoc, EffectsDoc, GlassDoc, LightingDoc, Vec3 } from '../model/types';
import { hexToLinear, hexToSrgb, inverseDisplaySrgb, outFromRec2020, type DisplayParams, type OutputSpace, type RGB } from './color';
import { cauchy, iorAt, LAMBDA_B, LAMBDA_G, LAMBDA_R, previewTaps, spectralNormalization, PREVIEW_TAPS } from './spectral';
import { MAX_LIGHTS } from './shaders/environment';

type Uniforms = Record<string, IUniform>;

const LIGHT_SHAPE_ID = { rect: 0, disc: 1, ring: 2, strip: 3 } as const;

export function createEnvironmentUniforms(): Uniforms {
  return {
    uLightCount: { value: 0 },
    uLightPos: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3()) },
    uLightU: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3()) },
    uLightV: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3()) },
    uLightN: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector3()) },
    uLightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector4()) },
    uLightShape: { value: Array.from({ length: MAX_LIGHTS }, () => new Vector2()) },
    uDomeTop: { value: new Vector3() },
    uDomeHorizon: { value: new Vector3() },
    uDomeBottom: { value: new Vector3() },
    uBgLut: { value: null },
    uBgType: { value: 0 },
    uBgParams: { value: new Vector4(0, 1, 1, 0) },
    uGlassInfluence: { value: 1 },
    uCamPos: { value: new Vector3() },
    uCamRight: { value: new Vector3(1, 0, 0) },
    uCamUp: { value: new Vector3(0, 1, 0) },
    uCamFwd: { value: new Vector3(0, 0, -1) },
    uTanHalfFov: { value: 0.2 },
    uFrameAspect: { value: 1 },
  };
}

export function createMaterialUniforms(): Uniforms {
  const taps = previewTaps();
  const norm = spectralNormalization();
  return {
    uAbsorb: { value: new Vector3() },
    uEps: { value: 2e-4 },
    uIridescence: { value: 0 },
    uFilmThickness: { value: new Vector2(250, 650) },
    uFilmIor: { value: 1.33 },
    uIorRGB: { value: new Vector3(1.5, 1.5, 1.5) },
    uDispersionOn: { value: 0 },
    uTapWeight: { value: taps.weights.map((w) => new Vector3(...w)) },
    uTapMix: { value: taps.mix.map((m) => new Vector2(...m)) },
    uCauchy: { value: new Vector2(1.5, 0) },
    uDispersion: { value: 0 },
    uSpecNorm: { value: new Vector3(...norm) },
  };
}

export { PREVIEW_TAPS };

/** Light card placement around the object centre. */
export function lightBasis(
  azimuthDeg: number,
  elevationDeg: number,
  distance: number,
  rollDeg: number,
  center: Vec3,
): { pos: Vector3; right: Vector3; up: Vector3; normal: Vector3 } {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const o = new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
  const pos = new Vector3(...center).addScaledVector(o, distance);
  const worldUp = Math.abs(o.y) > 0.98 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(worldUp, o).normalize();
  const up = new Vector3().crossVectors(o, right).normalize();
  const r = (rollDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const right2 = right.clone().multiplyScalar(c).addScaledVector(up, s);
  const up2 = right.clone().multiplyScalar(-s).addScaledVector(up, c);
  return { pos, right: right2, up: up2, normal: o.clone().negate() };
}

export function applyLighting(u: Uniforms, lighting: LightingDoc, center: Vec3): void {
  const lights = lighting.lights.slice(0, MAX_LIGHTS);
  u.uLightCount.value = lights.length;
  lights.forEach((l, i) => {
    const b = lightBasis(l.azimuth + lighting.rotation, l.elevation, l.distance, l.rotation, center);
    (u.uLightPos.value[i] as Vector3).copy(b.pos);
    (u.uLightU.value[i] as Vector3).copy(b.right).multiplyScalar(2 / Math.max(l.width, 1e-3));
    (u.uLightV.value[i] as Vector3).copy(b.up).multiplyScalar(2 / Math.max(l.height, 1e-3));
    (u.uLightN.value[i] as Vector3).copy(b.normal);
    const c = hexToLinear(l.color);
    (u.uLightColor.value[i] as Vector4).set(c[0] * l.intensity, c[1] * l.intensity, c[2] * l.intensity, l.visibleToCamera ? 1 : 0);
    (u.uLightShape.value[i] as Vector2).set(LIGHT_SHAPE_ID[l.shape], Math.max(0.002, l.softness));
  });
  const d = lighting.dome;
  const k = d.intensity;
  (u.uDomeTop.value as Vector3).set(...(hexToLinear(d.top).map((x) => x * k) as RGB));
  (u.uDomeHorizon.value as Vector3).set(...(hexToLinear(d.horizon).map((x) => x * k) as RGB));
  (u.uDomeBottom.value as Vector3).set(...(hexToLinear(d.bottom).map((x) => x * k) as RGB));
}

export function displayParams(lighting: LightingDoc, fx: EffectsDoc): DisplayParams {
  return { exposure: lighting.exposure, toneMapping: fx.toneMapping, contrast: fx.contrast, saturation: fx.saturation };
}

const LUT_SIZE = 256;

/** HDR gradient LUT whose tone-mapped result reproduces the chosen background colours exactly. */
export function buildBackgroundLut(bg: BackgroundDoc, params: DisplayParams, space: OutputSpace, tex?: DataTexture): DataTexture {
  const stops = [...bg.stops].sort((a, b) => a.pos - b.pos);
  const data = new Uint16Array(LUT_SIZE * 4);
  const cache = new Map<string, RGB>();
  for (let i = 0; i < LUT_SIZE; i++) {
    const u = i / (LUT_SIZE - 1);
    let srgb: RGB;
    if (bg.type === 'solid' || stops.length === 1) srgb = hexToSrgb(stops[0]?.color ?? '#000000');
    else {
      let j = 0;
      while (j < stops.length - 2 && u > stops[j + 1].pos) j++;
      const a = stops[j];
      const b = stops[j + 1];
      const f = b.pos > a.pos ? Math.min(Math.max((u - a.pos) / (b.pos - a.pos), 0), 1) : 0;
      const ca = hexToSrgb(a.color);
      const cb = hexToSrgb(b.color);
      // smooth interpolation in display space reads as an even gradient
      const s = f * f * (3 - 2 * f) * 0.35 + f * 0.65;
      srgb = [ca[0] + (cb[0] - ca[0]) * s, ca[1] + (cb[1] - ca[1]) * s, ca[2] + (cb[2] - ca[2]) * s];
    }
    const key = srgb.map((x) => Math.round(x * 1023)).join(',');
    let L = cache.get(key);
    if (!L) {
      L = inverseDisplaySrgb(srgb, params, space);
      cache.set(key, L);
    }
    data[i * 4] = DataUtils.toHalfFloat(L[0]);
    data[i * 4 + 1] = DataUtils.toHalfFloat(L[1]);
    data[i * 4 + 2] = DataUtils.toHalfFloat(L[2]);
    data[i * 4 + 3] = DataUtils.toHalfFloat(1);
  }
  const t = tex ?? new DataTexture(data, LUT_SIZE, 1, RGBAFormat, HalfFloatType);
  if (tex) t.image.data = data;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.wrapS = ClampToEdgeWrapping;
  t.wrapT = ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function applyBackground(u: Uniforms, bg: BackgroundDoc, frameAspect: number): void {
  u.uBgType.value = bg.type === 'solid' ? 0 : bg.type === 'linear' ? 1 : 2;
  u.uGlassInfluence.value = bg.glassInfluence;
  if (bg.type === 'linear') {
    const a = (bg.angle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // extent so that the gradient spans the frame corner to corner
    const ext = Math.abs(dx) * frameAspect + Math.abs(dy);
    (u.uBgParams.value as Vector4).set(dx, dy, ext, 0);
  } else {
    (u.uBgParams.value as Vector4).set(bg.center[0], bg.center[1], Math.max(0.05, bg.radius), 0);
  }
}

export function applyGlass(u: Uniforms, glass: GlassDoc, sceneScale: number): void {
  const ab = cauchy(glass.ior, glass.dispersion);
  (u.uIorRGB.value as Vector3).set(iorAt(ab, LAMBDA_R), iorAt(ab, LAMBDA_G), iorAt(ab, LAMBDA_B));
  (u.uCauchy.value as Vector2).set(ab[0], ab[1]);
  u.uDispersionOn.value = glass.dispersion > 0.001 ? 1 : 0;
  u.uDispersion.value = glass.dispersion > 0.001 ? glass.dispersion : 0;
  const tint = hexToLinear(glass.tint);
  // density is per object size so the look survives scaling
  const k = (glass.tintDensity * 2.5) / Math.max(sceneScale, 1e-3);
  (u.uAbsorb.value as Vector3).set(...(tint.map((c) => -Math.log(Math.max(c, 0.002)) * k) as RGB));
  u.uIridescence.value = glass.iridescence;
  (u.uFilmThickness.value as Vector2).set(glass.iridescenceThickness[0], glass.iridescenceThickness[1]);
  u.uEps.value = 2e-4 * Math.max(1, sceneScale);
}

export function outputMatrix(space: OutputSpace): Matrix3 {
  const m = outFromRec2020(space);
  // Matrix3.set takes row-major arguments; m is column-major
  return new Matrix3().set(m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]);
}
