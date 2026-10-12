import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } from 'mediabunny';
import type { ExportTargetDoc, SceneDoc } from '../model/types';
import { frameAt, type VideoSettings } from './loops';

export type { LoopKind, VideoSettings } from './loops';
import { getEngine } from '../render/engineRef';
import { OfflineRenderer } from './OfflineRenderer';
import type { ExportProgress } from './jobs';

const VIDEO_GEOMETRY = { rings: 720, segments: 48, capRings: 8 };
const PHOTO_SAMPLES = 40;

export async function exportVideo(
  doc: SceneDoc,
  target: ExportTargetDoc,
  settings: VideoSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ name: string; blob: Blob }> {
  const engine = getEngine();
  if (!engine) throw new Error('Renderer nicht bereit');
  if (typeof VideoEncoder === 'undefined') throw new Error('Dieser Browser unterstützt keine Video-Kodierung (WebCodecs).');
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
  const w = even(target.width * settings.scale);
  const h = even(target.height * settings.scale);
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: w, height: h, frameRate: settings.fps });
  if (!codec) throw new Error(`Video in ${w}×${h} kann auf diesem Gerät nicht kodiert werden. Bitte eine kleinere Auflösung wählen.`);
  const webm = codec === 'vp9' || codec === 'av1';
  const output = new Output({ format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: settings.fps });
  await output.start();

  const frames = Math.max(2, Math.round(settings.seconds * settings.fps));
  const baseCamera = target.camera ?? doc.camera;
  const off = new OfflineRenderer(engine);
  engine.suspend();
  const t0 = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      const f = frameAt(doc, baseCamera, settings.kind, i / frames);
      off.prepare(f.doc, 'srgb', VIDEO_GEOMETRY, true);
      const img = await off.render(f.doc, {
        width: w,
        height: h,
        camera: f.camera,
        samples: PHOTO_SAMPLES,
        preview: settings.quality === 'fast',
        space: 'srgb',
        tileSize: 1024,
        signal,
        onProgress: (x) => {
          const overall = (i + x) / frames;
          const elapsed = (performance.now() - t0) / 1000;
          onProgress({ label: `Bild ${i + 1} von ${frames}`, fraction: overall, eta: overall > 0.02 ? (elapsed / overall) * (1 - overall) : null });
        },
      });
      ctx.putImageData(new ImageData(img.data as unknown as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      await source.add(i / settings.fps, 1 / settings.fps);
    }
    onProgress({ label: 'Video wird abgeschlossen…', fraction: 1, eta: null });
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    off.restore();
    engine.resume();
  }
  const buffer = (output.target as BufferTarget).buffer!;
  const base = (doc.name || 'crystal').replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'crystal';
  return {
    name: `${base}-${settings.kind}-${w}x${h}.${webm ? 'webm' : 'mp4'}`,
    blob: new Blob([buffer], { type: webm ? 'video/webm' : 'video/mp4' }),
  };
}
