import { NearestFilter, RGBAFormat, UnsignedByteType, Vector2, Vector4, WebGLRenderTarget, type Texture } from 'three';
import type { Engine } from '../render/Engine';
import type { CameraDoc, SceneDoc } from '../model/types';
import { GlassMesh } from '../render/GlassMesh';
import { QUALITY_EXPORT, type SweepQuality } from '../geometry/sweep';
import { applyBackground, applyGlass, applyLighting, buildBackgroundLut, displayParams, outputMatrix } from '../render/uniforms';
import { basisFromDoc, tanHalfFov, type CameraBasis, type Rect } from '../render/view';
import { BloomChain } from '../render/Bloom';
import type { OutputSpace } from '../render/color';
import { yieldTask } from '../util/yield';

/** Rotated-grid sub-pixel offsets for the deterministic tracer. */
const PREVIEW_AA: [number, number][] = [
  [0.125, 0.375],
  [-0.375, 0.125],
  [0.375, -0.125],
  [-0.125, -0.375],
  [0.25, 0.25],
  [-0.25, -0.25],
];

export interface OfflineOptions {
  width: number;
  height: number;
  camera: CameraDoc;
  samples: number;
  space: OutputSpace;
  /** Tile edge length in pixels. */
  tileSize?: number;
  /** Use the deterministic live tracer instead of path tracing (fast, noise-free). */
  preview?: boolean;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface RenderedImage {
  width: number;
  height: number;
  /** RGBA8, top row first, display-encoded in `space`. */
  data: Uint8ClampedArray;
  space: OutputSpace;
}

/**
 * Renders a frame at arbitrary resolution with the path tracer, tile by tile, without blocking the
 * UI: each GPU pass is fenced and the next one is issued only after it has finished.
 */
export class OfflineRenderer {
  private engine: Engine;
  private mesh: GlassMesh | null = null;
  private meshShape: unknown = null;

  constructor(engine: Engine) {
    this.engine = engine;
  }

  /** Prepares geometry and uniforms for `doc`. Call before render(); restore() afterwards. */
  prepare(doc: SceneDoc, space: OutputSpace, quality: SweepQuality = QUALITY_EXPORT, refit = false): void {
    const e = this.engine;
    if (this.meshShape !== doc.shape || !this.mesh) {
      if (refit && this.mesh) {
        // animation frames: same topology, refitting is much faster than a rebuild
        this.mesh.update(doc.shape, quality, true);
      } else {
        this.mesh?.dispose();
        this.mesh = new GlassMesh();
        this.mesh.update(doc.shape, quality, false);
        this.mesh.rebuild();
      }
      this.meshShape = doc.shape;
    }
    for (const m of [e.pathMaterial, e.previewMaterial]) {
      m.uniforms.bvh.value = this.mesh.struct;
      m.uniforms.normalAttribute.value = this.mesh.normalTex;
    }
    applyGlass(e.mat, doc.glass, this.mesh.sweep?.boundingRadius ?? 2);
    applyLighting(e.env, doc.lighting, [0, 0, 0]);
    e.env.uBgLut.value = buildBackgroundLut(doc.background, displayParams(doc.lighting, doc.effects), space);
  }

  /** Re-applies the per-frame state that depends on the target (frame aspect for gradients). */
  private applyTarget(doc: SceneDoc, width: number, height: number): void {
    applyBackground(this.engine.env, doc.background, width / height);
  }

  restore(): void {
    const e = this.engine;
    for (const m of [e.pathMaterial, e.previewMaterial]) {
      m.uniforms.bvh.value = e.glass.struct;
      m.uniforms.normalAttribute.value = e.glass.normalTex;
    }
    this.mesh?.dispose();
    this.mesh = null;
    this.meshShape = null;
  }

  async render(doc: SceneDoc, opts: OfflineOptions): Promise<RenderedImage> {
    const e = this.engine;
    const { width: W, height: H, samples } = opts;
    const tile = opts.tileSize ?? 768;
    const basis = basisFromDoc(opts.camera);
    const tanHalf = tanHalfFov(opts.camera.focalLength);
    this.applyTarget(doc, W, H);
    const fx = doc.effects;
    const pu = e.pathMaterial.uniforms;
    pu.uLensRadius.value = fx.aperture * 0.06 * fx.focusDistance;
    pu.uFocusDist.value = fx.focusDistance;
    pu.uMaxBounces.value = 32;

    const tilesX = Math.ceil(W / tile);
    const tilesY = Math.ceil(H / tile);
    const preview = !!opts.preview;
    // the live tracer is deterministic: a few jittered passes are enough for clean edges
    const passes = preview ? PREVIEW_AA.length : samples;
    const bloomPasses = fx.bloom > 0 ? (preview ? 1 : 24) : 0;
    const totalWork = tilesX * tilesY * passes + bloomPasses;
    let done = 0;
    const progress = () => opts.onProgress?.(Math.min(1, done / totalWork));

    // bloom from a low-resolution pass of the whole frame
    let bloomTex: Texture | null = null;
    const bloom = new BloomChain();
    let bloomSrc: WebGLRenderTarget[] = [];
    if (fx.bloom > 0) {
      const bh = Math.min(720, H);
      const bw = Math.max(1, Math.round((bh * W) / H));
      bloomSrc = [this.floatRT(bw, bh), this.floatRT(bw, bh)];
      const frame: Rect = { x: 0, y: 0, w: bw, h: bh };
      for (let s = 0; s < bloomPasses; s++) {
        if (preview) await this.previewPass(bloomSrc, 0, bw, bh, frame, basis, tanHalf, opts.signal);
        else await this.pathPass(bloomSrc, s, bw, bh, frame, basis, tanHalf, opts.signal);
        done++;
        progress();
      }
      bloom.setSize(bw * 2, bh * 2);
      bloomTex = bloom.render(e.renderer, e.quad, e.bloomDown, e.bloomUp, { a: bloomSrc[0].texture, b: null, mix: 0 }, e.bloomThreshold(), fx.bloomRadius);
    }

    const out = new Uint8ClampedArray(W * H * 4);
    const accum = [this.floatRT(tile, tile), this.floatRT(tile, tile)];
    const ldr = new WebGLRenderTarget(tile, tile, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const px = new Uint8Array(tile * tile * 4);
    const gl = e.renderer.getContext();

    try {
      for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
          const x0 = tx * tile;
          const y0 = ty * tile;
          const tw = Math.min(tile, W - x0);
          const th = Math.min(tile, H - y0);
          for (const rt of accum) rt.setSize(tw, th);
          ldr.setSize(tw, th);
          // the frame extends beyond the tile: tile pixel (0,0) is image pixel (x0, y0)
          const frame: Rect = { x: -x0, y: -y0, w: W, h: H };
          for (let s = 0; s < passes; s++) {
            if (preview) await this.previewPass(accum, s, tw, th, frame, basis, tanHalf, opts.signal);
            else await this.pathPass(accum, s, tw, th, frame, basis, tanHalf, opts.signal);
            done++;
            if (s % 4 === 0) progress();
          }
          // composite the tile
          const c = e.compositeMaterial.uniforms;
          c.uPreview.value = accum[0].texture;
          c.uAccum.value = accum[0].texture;
          c.uMixAccum.value = 1;
          c.uBloom.value = bloomTex ?? e.blackTexture;
          // GL uv: tile covers [x0, x0+tw] × [H-y0-th, H-y0] of the frame
          (c.uBloomTransform.value as Vector4).set(tw / W, th / H, x0 / W, (H - y0 - th) / H);
          c.uOutFrom2020.value = outputMatrix(opts.space);
          (c.uFrameOrigin.value as Vector2).set(-x0, th + y0 - H);
          (c.uFrameSize.value as Vector2).set(W, H);
          c.uFrameAspect.value = W / H;
          e.quad.material = e.compositeMaterial;
          e.renderer.setRenderTarget(ldr);
          e.quad.render(e.renderer);
          e.renderer.readRenderTargetPixels(ldr, 0, 0, tw, th, px);
          for (let r = 0; r < th; r++) {
            const src = (th - 1 - r) * tw * 4;
            const dst = ((y0 + r) * W + x0) * 4;
            out.set(px.subarray(src, src + tw * 4), dst);
          }
          void gl;
          progress();
        }
      }
    } finally {
      for (const rt of [...accum, ldr, ...bloomSrc]) rt.dispose();
      bloom.dispose();
      pu.uMaxBounces.value = 24;
      e.renderer.setRenderTarget(null);
    }
    return { width: W, height: H, data: out, space: opts.space };
  }

  private floatRT(w: number, h: number): WebGLRenderTarget {
    return new WebGLRenderTarget(w, h, {
      type: this.engine.floatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
  }

  private async previewPass(
    rts: WebGLRenderTarget[],
    sample: number,
    w: number,
    h: number,
    frame: Rect,
    basis: CameraBasis,
    tanHalf: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    const e = this.engine;
    const u = e.previewMaterial.uniforms;
    const bounces = u.uMaxBounces.value;
    u.uMaxBounces.value = 14;
    e.setFrameUniforms(u, w, h, frame, basis, tanHalf);
    const j = PREVIEW_AA[sample % PREVIEW_AA.length];
    (u.uJitter.value as Vector2).set(j[0], j[1]);
    u.uSample.value = sample;
    u.uPrev.value = rts[0].texture;
    e.quad.material = e.previewMaterial;
    e.renderer.setRenderTarget(rts[1]);
    e.quad.render(e.renderer);
    const t = rts[0];
    rts[0] = rts[1];
    rts[1] = t;
    u.uMaxBounces.value = bounces;
    u.uSample.value = 0;
    (u.uJitter.value as Vector2).set(0, 0);
    await gpuIdle(e.renderer.getContext() as WebGL2RenderingContext);
  }

  /** One path-tracing sample over a surface; ping-pongs `rts` so rts[0] holds the result. */
  private async pathPass(
    rts: WebGLRenderTarget[],
    sample: number,
    w: number,
    h: number,
    frame: Rect,
    basis: CameraBasis,
    tanHalf: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    const e = this.engine;
    const u = e.pathMaterial.uniforms;
    e.setFrameUniforms(u, w, h, frame, basis, tanHalf);
    u.uPrev.value = rts[0].texture;
    u.uSample.value = sample;
    u.uSeed.value = 7;
    e.quad.material = e.pathMaterial;
    e.renderer.setRenderTarget(rts[1]);
    e.quad.render(e.renderer);
    const t = rts[0];
    rts[0] = rts[1];
    rts[1] = t;
    await gpuIdle(e.renderer.getContext() as WebGL2RenderingContext);
  }
}

/** Resolves once the GPU has finished all submitted work, polling a fence without blocking. */
export async function gpuIdle(gl: WebGL2RenderingContext): Promise<void> {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  if (!sync) return;
  const start = performance.now();
  for (;;) {
    const r = gl.clientWaitSync(sync, 0, 0);
    if (r === gl.ALREADY_SIGNALED || r === gl.CONDITION_SATISFIED || r === gl.WAIT_FAILED) break;
    // poll via message tasks first (no timer clamping), then back off to timers
    if (performance.now() - start < 250) await yieldTask();
    else await new Promise((res) => setTimeout(res, 2));
  }
  gl.deleteSync(sync);
}
