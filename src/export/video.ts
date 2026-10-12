import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat } from 'mediabunny';
import type { CameraDoc, ExportTargetDoc, SceneDoc } from '../model/types';
import { getEngine } from '../render/engineRef';
import { OfflineRenderer } from './OfflineRenderer';
import type { ExportProgress } from './jobs';

export type LoopKind = 'orbit' | 'lights' | 'flow' | 'breathe';

export const LOOP_LABEL: Record<LoopKind, string> = {
  orbit: 'Kamerafahrt',
  lights: 'Licht dreht',
  flow: 'Fließen',
  breathe: 'Atmen',
};

export interface VideoSettings {
  kind: LoopKind;
  seconds: number;
  fps: number;
  /** Fraction of the export format's resolution. */
  scale: number;
  quality: 'fast' | 'photo';
}

const VIDEO_GEOMETRY = { rings: 720, segments: 48, capRings: 8 };
const PHOTO_SAMPLES = 40;

/** Scene state at loop phase p ∈ [0, 1). Every animation is periodic, so the loop is seamless. */
export function frameAt(doc: SceneDoc, camera: CameraDoc, kind: LoopKind, p: number): { doc: SceneDoc; camera: CameraDoc } {
  const a = p * Math.PI * 2;
  switch (kind) {
    case 'orbit': {
      const [tx, , tz] = camera.target;
      const dx = camera.position[0] - tx;
      const dz = camera.position[2] - tz;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return { doc, camera: { ...camera, position: [tx + dx * c + dz * s, camera.position[1], tz - dx * s + dz * c] } };
    }
    case 'lights':
      return { doc: { ...doc, lighting: { ...doc.lighting, rotation: doc.lighting.rotation + p * 360 } }, camera };
    case 'flow': {
      const strands = Math.max(1, Math.round(doc.shape.strands));
      // a half turn maps a point-symmetric profile onto itself; strands advance by one slot
      return { doc: { ...doc, shape: { ...doc.shape, phase: p * Math.PI, strandPhase: (p * Math.PI * 2) / strands } }, camera };
    }
    case 'breathe':
      return { doc: { ...doc, shape: { ...doc.shape, radius: doc.shape.radius * (1 + 0.07 * Math.sin(a)) } }, camera };
  }
}

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
