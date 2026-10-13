import type { WebGLRenderer } from 'three';
import type { AdaptiveSettings } from './adaptive';

export type QualityTier = 'low' | 'medium' | 'high';

export interface TierSettings {
  /** Device pixel ratio cap for the canvas. */
  maxDpr: number;
  /** Live preview resolution while interacting, relative to device pixels (adaptive). */
  previewScaleMin: number;
  previewScaleMax: number;
  previewBounces: number;
  /** Target frame time for the adaptive preview resolution. */
  previewFrameMs: number;
  /** Pixel budget for path tracing the glass region in the viewport. */
  maxRefinePixels: number;
  /** Upper bound of path samples in the viewport; most blocks stop earlier (see `refine`). */
  targetSamples: number;
  refine: AdaptiveSettings;
  /** Share of GPU time the background refinement may use, so the system stays responsive. */
  gpuBudget: number;
}

export const TIER_SETTINGS: Record<QualityTier, TierSettings> = {
  low: {
    maxDpr: 2,
    previewScaleMin: 0.2,
    previewScaleMax: 0.5,
    previewBounces: 6,
    previewFrameMs: 33,
    maxRefinePixels: 0.5e6,
    targetSamples: 64,
    refine: { minSamples: 24, tolerance: 3 },
    gpuBudget: 0.5,
  },
  medium: {
    maxDpr: 2,
    previewScaleMin: 0.25,
    previewScaleMax: 0.6,
    previewBounces: 8,
    previewFrameMs: 28,
    maxRefinePixels: 1.2e6,
    targetSamples: 128,
    refine: { minSamples: 32, tolerance: 2 },
    gpuBudget: 0.5,
  },
  high: {
    maxDpr: 2,
    previewScaleMin: 0.3,
    previewScaleMax: 0.75,
    previewBounces: 10,
    previewFrameMs: 22,
    maxRefinePixels: 3e6,
    targetSamples: 256,
    refine: { minSamples: 32, tolerance: 1.5 },
    gpuBudget: 0.6,
  },
};

const STORAGE_KEY = 'crystal.quality';

export function storedTier(): QualityTier | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : null;
  } catch {
    return null;
  }
}

export function storeTier(tier: QualityTier | null): void {
  try {
    if (tier) localStorage.setItem(STORAGE_KEY, tier);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode): the tier simply isn't remembered
  }
}

/** Initial quality guess; the adaptive preview resolution fine-tunes from there. */
export function detectTier(renderer: WebGLRenderer): QualityTier {
  const stored = storedTier();
  if (stored) return stored;
  const gl = renderer.getContext();
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  let gpu = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    gpu = '';
  }
  const g = gpu.toLowerCase();
  if (/apple m\d|nvidia|geforce|rtx|radeon rx|radeon pro/.test(g)) return 'high';
  if (coarse) return /apple gpu/.test(g) ? 'medium' : 'low';
  if (/intel|mali|adreno|powervr/.test(g)) return 'medium';
  return 'high';
}
