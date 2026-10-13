import type { ExportTargetDoc, SceneDoc } from '../model/types';
import { getEngine } from '../render/engineRef';
import { OfflineRenderer } from './OfflineRenderer';
import { deliverFiles, encodeImage, type ImageFormat } from './encode';
import { formatById } from './formats';
import type { OutputSpace } from '../render/color';
import type { AdaptiveSettings } from '../render/adaptive';

export type ExportQuality = 'draft' | 'high' | 'max';

/** Upper bound of path samples per pixel; converged blocks stop earlier (QUALITY_ADAPTIVE). */
export const QUALITY_SAMPLES: Record<ExportQuality, number> = { draft: 48, high: 192, max: 640 };
/**
 * Samples with the denoiser: chosen so the error against a reference matches (or beats) the
 * undenoised setting of the same quality.
 */
export const QUALITY_SAMPLES_DENOISED: Record<ExportQuality, number> = { draft: 24, high: 80, max: 320 };
export const QUALITY_ADAPTIVE: Record<ExportQuality, AdaptiveSettings> = {
  draft: { minSamples: 16, tolerance: 2 },
  high: { minSamples: 32, tolerance: 1 },
  max: { minSamples: 64, tolerance: 0.5 },
};
export const QUALITY_LABEL: Record<ExportQuality, string> = { draft: 'Entwurf', high: 'Hoch', max: 'Maximal' };

export interface StillSettings {
  quality: ExportQuality;
  format: ImageFormat;
  space: OutputSpace;
  /** Denoise the path traced glass and render about half the samples. */
  denoise: boolean;
}

export interface ExportProgress {
  label: string;
  fraction: number;
  /** Seconds remaining, once it can be estimated. */
  eta: number | null;
}

function fileName(doc: SceneDoc, t: ExportTargetDoc, format: ImageFormat): string {
  const base = (doc.name || 'crystal').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'crystal';
  return `${base}-${t.formatId}-${t.width}x${t.height}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

/** Renders the given export targets and hands the files to the user. */
export async function exportStills(
  doc: SceneDoc,
  targets: ExportTargetDoc[],
  settings: StillSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ name: string; blob: Blob }[]> {
  const engine = getEngine();
  if (!engine) throw new Error('Renderer nicht bereit');
  const tile = window.matchMedia?.('(pointer: coarse)').matches ? 768 : 1024;
  const samples = (settings.denoise ? QUALITY_SAMPLES_DENOISED : QUALITY_SAMPLES)[settings.quality];
  const totalPixels = targets.reduce((a, t) => a + t.width * t.height, 0);
  let donePixels = 0;
  const t0 = performance.now();
  const files: { name: string; blob: Blob }[] = [];
  engine.suspend();
  const off = new OfflineRenderer(engine);
  // keep the screen on during long renders where supported
  let wake: { release(): Promise<void> } | null = null;
  try {
    wake = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null;
  } catch {
    wake = null;
  }
  try {
    onProgress({ label: 'Geometrie in Exportqualität vorbereiten…', fraction: 0, eta: null });
    await new Promise((r) => setTimeout(r, 30));
    off.prepare(doc, settings.space);
    for (const t of targets) {
      const name = formatById(t.formatId)?.name ?? `${t.width}×${t.height}`;
      const pixels = t.width * t.height;
      const img = await off.render(doc, {
        width: t.width,
        height: t.height,
        camera: t.camera ?? doc.camera,
        samples,
        adaptive: QUALITY_ADAPTIVE[settings.quality],
        denoise: settings.denoise,
        space: settings.space,
        tileSize: tile,
        signal,
        onProgress: (f) => {
          const overall = (donePixels + f * pixels) / totalPixels;
          const elapsed = (performance.now() - t0) / 1000;
          onProgress({
            label: `${name} wird gerendert`,
            fraction: overall,
            eta: overall > 0.03 ? (elapsed / overall) * (1 - overall) : null,
          });
        },
      });
      donePixels += pixels;
      onProgress({ label: `${name} wird gespeichert…`, fraction: donePixels / totalPixels, eta: null });
      files.push({ name: fileName(doc, t, settings.format), blob: await encodeImage(img, settings.format) });
    }
  } finally {
    off.restore();
    engine.resume();
    void wake?.release().catch(() => undefined);
  }
  return files;
}

export function zipNameFor(doc: SceneDoc): string {
  return `${(doc.name || 'crystal').replace(/\s+/g, '-')}-wallpaper.zip`;
}

export { deliverFiles };
