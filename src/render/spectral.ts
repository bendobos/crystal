import { XYZ_TO_SRGB, mul, type RGB } from './color';

export const LAMBDA_MIN = 380;
export const LAMBDA_MAX = 730;
/** Wavelengths (nm) used by the live preview: green carries the path, red/blue define the spread. */
export const LAMBDA_G = 550;
export const LAMBDA_R = 640;
export const LAMBDA_B = 450;
/** Number of wavelength taps the preview uses when a dispersed ray escapes. */
export const PREVIEW_TAPS = 7;

function g(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}

/** CIE 1931 colour matching functions, multi-lobe fit by Wyman, Sloan & Shirley (2013). */
export function cieXYZ(l: number): RGB {
  const x = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}

export function wavelengthToLinearSrgb(l: number): RGB {
  return mul(XYZ_TO_SRGB, cieXYZ(l));
}

/**
 * Per-channel normalisation so that averaging the weight over uniformly sampled wavelengths
 * yields exactly (1, 1, 1): without dispersion white stays white.
 */
export function spectralNormalization(): RGB {
  const sum: RGB = [0, 0, 0];
  let n = 0;
  for (let l = LAMBDA_MIN; l <= LAMBDA_MAX; l += 0.5) {
    const c = wavelengthToLinearSrgb(l);
    sum[0] += c[0];
    sum[1] += c[1];
    sum[2] += c[2];
    n++;
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** Cauchy coefficients A, B (λ in µm) for refractive index n_d and a dispersion strength 0..1. */
export function cauchy(ior: number, dispersion: number): [number, number] {
  // Abbe number from ~infinity (no dispersion) down to 6 (far beyond real glass, for the look)
  const strength = Math.max(0, Math.min(1, dispersion));
  if (strength <= 0) return [ior, 0];
  const abbe = 6 / strength;
  // n_F - n_C = B (1/0.4861² - 1/0.6563²)
  const B = (ior - 1) / (abbe * (1 / (0.4861 * 0.4861) - 1 / (0.6563 * 0.6563)));
  const A = ior - B / (0.5876 * 0.5876);
  return [A, B];
}

export function iorAt(ab: [number, number], lambdaNm: number): number {
  const l = lambdaNm / 1000;
  return ab[0] + ab[1] / (l * l);
}

export interface PreviewTaps {
  /** Weight per tap (sums to 1 per channel). */
  weights: RGB[];
  /** Interpolation factors (red spread, blue spread) per tap. */
  mix: [number, number][];
}

/** Weights and spread factors for the preview's rainbow taps between LAMBDA_B and LAMBDA_R. */
export function previewTaps(): PreviewTaps {
  const weights: RGB[] = [];
  const mix: [number, number][] = [];
  const inv = (l: number) => 1 / (l * l);
  const sum: RGB = [0, 0, 0];
  for (let k = 0; k < PREVIEW_TAPS; k++) {
    // spread taps over a slightly wider band than R/B so fringes fade out smoothly
    const l = 430 + (k / (PREVIEW_TAPS - 1)) * (660 - 430);
    // integrate the colour over the tap's band for smoother weights
    const c: RGB = [0, 0, 0];
    const band = (660 - 430) / (PREVIEW_TAPS - 1);
    for (let s = -0.5; s <= 0.5; s += 0.05) {
      const w = wavelengthToLinearSrgb(l + s * band);
      c[0] += w[0];
      c[1] += w[1];
      c[2] += w[2];
    }
    weights.push(c);
    sum[0] += c[0];
    sum[1] += c[1];
    sum[2] += c[2];
    if (l >= LAMBDA_G) mix.push([(inv(l) - inv(LAMBDA_G)) / (inv(LAMBDA_R) - inv(LAMBDA_G)), 0]);
    else mix.push([0, (inv(l) - inv(LAMBDA_G)) / (inv(LAMBDA_B) - inv(LAMBDA_G))]);
  }
  for (const w of weights) {
    w[0] /= sum[0];
    w[1] /= sum[1];
    w[2] /= sum[2];
  }
  return { weights, mix };
}
