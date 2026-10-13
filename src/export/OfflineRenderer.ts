import { NearestFilter, RGBAFormat, UnsignedByteType, Vector2, Vector4, WebGLRenderTarget, type RawShaderMaterial, type Texture } from 'three';
import type { Engine } from '../render/Engine';
import type { CameraDoc, SceneDoc } from '../model/types';
import { GlassMesh } from '../render/GlassMesh';
import { QUALITY_EXPORT, type SweepQuality } from '../geometry/sweep';
import { applyBackground, applyGlass, applyLighting, buildBackgroundLut, displayParams, outputMatrix } from '../render/uniforms';
import { basisFromDoc, tanHalfFov, type CameraBasis, type Rect } from '../render/view';
import { BloomChain } from '../render/Bloom';
import type { OutputSpace } from '../render/color';
import {
  CHECK_INTERVAL,
  countActive,
  GpuPacer,
  intersectRect,
  makeMaskRT,
  maskSize,
  PREVIEW_AA,
  projectedRect,
  type AdaptiveSettings,
} from '../render/adaptive';
import { DENOISE_APRON, Denoiser } from '../render/denoise';

/** Cost of a deterministic pass per pixel relative to a path sample (for progress estimates). */
const PREVIEW_COST = 0.05;

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
  /** Stop sampling blocks once they have converged (`samples` stays the upper bound). */
  adaptive?: AdaptiveSettings;
  /** Denoise the path traced glass, guided by the deterministic preview. */
  denoise?: boolean;
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

interface Region {
  /** Size of the surface (tile plus apron, or bloom source). */
  w: number;
  h: number;
  /** The pixels the region outputs, within the surface. */
  inner: Rect;
  /** The image frame relative to the surface (top-left origin). */
  frame: Rect;
  /** Part of the surface that can see the glass, or null. */
  glass: Rect | null;
}

interface Targets {
  preview: WebGLRenderTarget[];
  accum: WebGLRenderTarget[];
  mask: WebGLRenderTarget[];
}

/**
 * Renders a frame at arbitrary resolution, tile by tile, without blocking the UI or the system:
 * GPU work is split into short fenced bands (GpuPacer). Every tile gets a few anti-aliased passes
 * of the deterministic tracer (exact where no glass can be seen); only the part of the tile that
 * can see the glass is path traced, and blocks stop sampling once they have converged.
 */
export class OfflineRenderer {
  private engine: Engine;
  private mesh: GlassMesh | null = null;
  private meshShape: unknown = null;
  private exposure = 0;
  private toneMapping = 0;

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
    const { width: W, height: H } = opts;
    const tile = opts.tileSize ?? 1024;
    const basis = basisFromDoc(opts.camera);
    const tanHalf = tanHalfFov(opts.camera.focalLength);
    this.applyTarget(doc, W, H);
    const fx = doc.effects;
    const pu = e.pathMaterial.uniforms;
    pu.uLensRadius.value = fx.aperture * 0.06 * fx.focusDistance;
    pu.uFocusDist.value = fx.focusDistance;
    pu.uMaxBounces.value = 32;
    this.exposure = doc.lighting.exposure;
    this.toneMapping = doc.effects.toneMapping === 'agx' ? 0 : 1;
    const preview = !!opts.preview;
    const samples = preview ? 0 : opts.samples;
    const gl = e.renderer.getContext() as WebGL2RenderingContext;
    // short draws keep the system responsive; fences are grouped because each one idles the GPU
    const pacer = new GpuPacer(gl, { targetMs: 24, stepMs: 120, budget: 1, inFlight: 2, unthrottled: true });

    // with depth of field rays start anywhere on the lens: trace everything
    const glassIn = (w: number, h: number): Rect | null =>
      fx.aperture > 0
        ? { x: 0, y: 0, w, h }
        : projectedRect(this.mesh!.bounds(), { surfaceW: w, surfaceH: h, frame: { x: 0, y: 0, w, h }, tanHalfFov: tanHalf }, basis, 2);
    const glass = glassIn(W, H);

    const tilesX = Math.ceil(W / tile);
    const tilesY = Math.ceil(H / tile);
    // the denoiser reads neighbours: tiles trace a margin around the pixels they output
    const apron = opts.denoise && !preview ? DENOISE_APRON : 0;
    const regions: Region[] = [];
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x0 = tx * tile;
        const y0 = ty * tile;
        const tw = Math.min(tile, W - x0);
        const th = Math.min(tile, H - y0);
        const ex = Math.max(0, x0 - apron);
        const ey = Math.max(0, y0 - apron);
        const ew = Math.min(W, x0 + tw + apron) - ex;
        const eh = Math.min(H, y0 + th + apron) - ey;
        const g = glass && intersectRect(glass, { x: ex, y: ey, w: ew, h: eh });
        // the frame extends beyond the surface: surface pixel (0,0) is image pixel (ex, ey)
        regions.push({
          w: ew,
          h: eh,
          inner: { x: x0 - ex, y: y0 - ey, w: tw, h: th },
          frame: { x: -ex, y: -ey, w: W, h: H },
          glass: g && { x: g.x - ex, y: g.y - ey, w: g.w, h: g.h },
        });
      }
    }
    let bloomRegion: Region | null = null;
    const bloomSamples = preview ? 0 : 24;
    if (fx.bloom > 0) {
      const bh = Math.min(720, H);
      const bw = Math.max(1, Math.round((bh * W) / H));
      bloomRegion = { w: bw, h: bh, inner: { x: 0, y: 0, w: bw, h: bh }, frame: { x: 0, y: 0, w: bw, h: bh }, glass: glassIn(bw, bh) };
    }

    const cost = (r: Region, n: number) => r.w * r.h * PREVIEW_AA.length * PREVIEW_COST + (r.glass ? r.glass.w * r.glass.h * n : 0);
    const totalWork = regions.reduce((a, r) => a + cost(r, samples), 0) + (bloomRegion ? cost(bloomRegion, bloomSamples) : 0);
    let done = 0;
    let lastProgress = 0;
    const work = (units: number) => {
      done += units;
      const now = performance.now();
      if (now - lastProgress > 100) {
        lastProgress = now;
        opts.onProgress?.(Math.min(1, done / totalWork));
      }
    };

    const denoiser = opts.denoise && !preview ? new Denoiser(e.floatType) : null;
    const t: Targets = {
      preview: [this.floatRT(tile, tile), this.floatRT(tile, tile)],
      accum: [this.floatRT(1, 1), this.floatRT(1, 1)],
      mask: [makeMaskRT(1, 1), makeMaskRT(1, 1)],
    };
    const ldr = new WebGLRenderTarget(tile, tile, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    });
    const px = new Uint8Array(tile * tile * 4);
    const bloom = new BloomChain();
    let bloomSrc: Targets | null = null;
    const ctx = { basis, tanHalf, pacer, signal: opts.signal, adaptive: opts.adaptive, work };

    try {
      // bloom from a low-resolution render of the whole frame
      let bloomTex: Texture | null = null;
      if (bloomRegion) {
        const r = bloomRegion;
        bloomSrc = {
          preview: [this.floatRT(r.w, r.h), this.floatRT(r.w, r.h)],
          accum: [this.floatRT(1, 1), this.floatRT(1, 1)],
          mask: [makeMaskRT(1, 1), makeMaskRT(1, 1)],
        };
        const traced = (await this.traceRegion(r, bloomSamples, bloomSrc, ctx)) > 0;
        const g = traced ? r.glass! : null;
        bloom.setSize(r.w * 2, r.h * 2);
        bloomTex = bloom.render(
          e.renderer,
          e.quad,
          e.bloomDown,
          e.bloomUp,
          {
            a: bloomSrc.preview[0].texture,
            b: g ? bloomSrc.accum[0].texture : null,
            bRect: g ? [g.x / r.w, (r.h - g.y - g.h) / r.h, g.w / r.w, g.h / r.h] : undefined,
            mix: 1,
          },
          e.bloomThreshold(),
          fx.bloomRadius,
        );
      }

      const out = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        const x0 = (i % tilesX) * tile;
        const y0 = Math.floor(i / tilesX) * tile;
        const { w: tw, h: th } = r.inner;
        const traced = await this.traceRegion(r, samples, t, ctx);
        const g = r.glass ?? { x: 0, y: 0, w: 1, h: 1 };
        let accum: Texture = t.accum[0].texture;
        if (traced > 0 && denoiser) {
          // guide: the preview pixels under the glass part (GL origin)
          accum = denoiser.run(e.renderer, e.quad, accum, traced, t.preview[0].texture, [g.x, r.h - g.y - g.h, g.w, g.h]);
        }
        // composite the pixels the tile outputs
        const c = e.compositeMaterial.uniforms;
        c.uPreview.value = t.preview[0].texture;
        const ox = r.inner.x;
        const oy = r.h - r.inner.y - th; // GL origin
        (c.uPreviewTransform.value as Vector4).set(tw / r.w, th / r.h, ox / r.w, oy / r.h);
        (c.uPreviewMax.value as Vector2).set(1, 1);
        c.uAccum.value = accum;
        (c.uAccumRect.value as Vector4).set(g.x - ox, r.h - (g.y + g.h) - oy, g.w, g.h);
        c.uMixAccum.value = traced > 0 ? 1 : 0;
        c.uBloom.value = bloomTex ?? e.blackTexture;
        // GL uv: tile covers [x0, x0+tw] × [H-y0-th, H-y0] of the frame
        (c.uBloomTransform.value as Vector4).set(tw / W, th / H, x0 / W, (H - y0 - th) / H);
        c.uOutFrom2020.value = outputMatrix(opts.space);
        (c.uFrameOrigin.value as Vector2).set(-x0, th + y0 - H);
        (c.uFrameSize.value as Vector2).set(W, H);
        c.uFrameAspect.value = W / H;
        ldr.setSize(tw, th);
        e.quad.material = e.compositeMaterial;
        e.renderer.setRenderTarget(ldr);
        e.quad.render(e.renderer);
        await pacer.drain();
        e.renderer.readRenderTargetPixels(ldr, 0, 0, tw, th, px);
        for (let row = 0; row < th; row++) {
          const src = (th - 1 - row) * tw * 4;
          const dst = ((y0 + row) * W + x0) * 4;
          out.set(px.subarray(src, src + tw * 4), dst);
        }
      }
      opts.onProgress?.(1);
      return { width: W, height: H, data: out, space: opts.space };
    } finally {
      pacer.drop();
      const rts = [...t.preview, ...t.accum, ...t.mask, ldr];
      if (bloomSrc) rts.push(...bloomSrc.preview, ...bloomSrc.accum, ...bloomSrc.mask);
      for (const rt of rts) rt.dispose();
      bloom.dispose();
      denoiser?.dispose();
      pu.uMaxBounces.value = 24;
      pu.uUseMask.value = 0;
      e.renderer.setRenderTarget(null);
    }
  }

  /**
   * Renders a region: anti-aliased deterministic passes over all of it into `t.preview[0]`, then
   * path tracing over its glass part into `t.accum[0]`. Returns the samples traced (0: none).
   */
  private async traceRegion(
    r: Region,
    samples: number,
    t: Targets,
    ctx: {
      basis: CameraBasis;
      tanHalf: number;
      pacer: GpuPacer;
      signal?: AbortSignal;
      adaptive?: AdaptiveSettings;
      work: (units: number) => void;
    },
  ): Promise<number> {
    const e = this.engine;
    const { basis, tanHalf, pacer, signal, adaptive, work } = ctx;
    for (const rt of t.preview) rt.setSize(r.w, r.h);
    const pv = e.previewMaterial.uniforms;
    const bounces = pv.uMaxBounces.value;
    pv.uMaxBounces.value = 14;
    for (let s = 0; s < PREVIEW_AA.length; s++) {
      e.setFrameUniforms(pv, r.w, r.h, r.frame, basis, tanHalf);
      const j = PREVIEW_AA[s];
      (pv.uJitter.value as Vector2).set(j[0], j[1]);
      pv.uSample.value = s;
      pv.uPrev.value = t.preview[0].texture;
      await this.bands(t.preview[1], 'preview', pacer, signal, (n) => work(n * PREVIEW_COST), e.previewMaterial);
      t.preview.reverse();
    }
    pv.uMaxBounces.value = bounces;
    pv.uSample.value = 0;
    (pv.uJitter.value as Vector2).set(0, 0);

    const g = r.glass;
    if (!g || samples <= 0) return 0;
    for (const rt of t.accum) rt.setSize(g.w, g.h);
    const [mw, mh] = maskSize(g.w, g.h);
    for (const rt of t.mask) rt.setSize(mw, mh);
    e.clearTarget(t.mask[0], 1);
    const maskPx = new Uint8Array(mw * mh * 4);
    const frame: Rect = { x: r.frame.x - g.x, y: r.frame.y - g.y, w: r.frame.w, h: r.frame.h };
    const pu = e.pathMaterial.uniforms;
    const px = g.w * g.h;
    let traced = 0;
    for (let s = 0; s < samples; s++) {
      e.setFrameUniforms(pu, g.w, g.h, frame, basis, tanHalf);
      pu.uPrev.value = t.accum[0].texture;
      pu.uSample.value = s;
      pu.uSeed.value = 7;
      pu.uActive.value = t.mask[0].texture;
      pu.uUseMask.value = adaptive ? 1 : 0;
      await this.bands(t.accum[1], 'path', pacer, signal, work, e.pathMaterial);
      t.accum.reverse();
      const n = s + 1;
      traced = n;
      if (adaptive && n >= adaptive.minSamples && n % CHECK_INTERVAL === 0 && n < samples) {
        const u = e.convergenceMaterial.uniforms;
        u.uAccum.value = t.accum[0].texture;
        u.uMaskPrev.value = t.mask[0].texture;
        u.uSamples.value = n;
        u.uTol.value = adaptive.tolerance;
        u.uExposure.value = Math.pow(2, this.exposure);
        u.uToneMapping.value = this.toneMapping;
        e.quad.material = e.convergenceMaterial;
        e.renderer.setRenderTarget(t.mask[1]);
        e.quad.render(e.renderer);
        t.mask.reverse();
        await pacer.drain();
        e.renderer.readRenderTargetPixels(t.mask[0], 0, 0, mw, mh, maskPx);
        if (countActive(maskPx) === 0) {
          work(px * (samples - n));
          break;
        }
      }
    }
    pu.uUseMask.value = 0;
    return traced;
  }

  /** Draws `material` over `target` in paced row bands. */
  private async bands(
    target: WebGLRenderTarget,
    kind: string,
    pacer: GpuPacer,
    signal: AbortSignal | undefined,
    work: (pixels: number) => void,
    material: RawShaderMaterial,
  ): Promise<void> {
    const e = this.engine;
    const { width: w, height: h } = target;
    for (let y0 = 0; y0 < h; ) {
      if (signal?.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      const rows = Math.min(pacer.rows(kind, w, h - y0), h - y0);
      target.scissor.set(0, y0, w, rows);
      target.scissorTest = rows < h;
      e.quad.material = material;
      e.renderer.setRenderTarget(target);
      e.quad.render(e.renderer);
      target.scissorTest = false;
      y0 += rows;
      await pacer.step(kind, w * rows, signal);
      work(w * rows);
    }
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
}
