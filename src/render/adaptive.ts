import { Box3, NearestFilter, RGBAFormat, UnsignedByteType, Vector3, WebGLRenderTarget } from 'three';
import { projectPoint, type CameraBasis, type FrameView, type Rect } from './view';
import { yieldTask } from '../util/yield';
import { toneGLSL } from './shaders/composite';

/** Rotated-grid sub-pixel offsets for the deterministic tracer. */
export const PREVIEW_AA: [number, number][] = [
  [0.125, 0.375],
  [-0.375, 0.125],
  [0.375, -0.125],
  [-0.125, -0.375],
  [0.25, 0.25],
  [-0.25, -0.25],
];

/** Edge length of the blocks the convergence mask decides on. */
export const BLOCK = 8;
/** Samples between convergence checks. */
export const CHECK_INTERVAL = 8;

export interface AdaptiveSettings {
  /** Samples every block receives before it may stop. */
  minSamples: number;
  /**
   * Estimated standard error of the displayed pixel (8-bit levels, after exposure and tone
   * mapping) below which a block counts as converged. The estimate assumes independent samples;
   * the stratified sequences converge faster, so it errs on the safe side.
   */
  tolerance: number;
}

// --- screen-space bounds of the glass --------------------------------------------------------------

/**
 * Pixel rectangle (top-left origin, integer, clamped to the surface) covering the projection of
 * `box`, padded by `pad` pixels. Pixels outside it cannot see the glass with a pinhole camera.
 * Returns the whole surface when the camera is inside or too close to the box, null when the box
 * lies completely outside the surface.
 */
export function projectedRect(box: Box3, view: FrameView, basis: CameraBasis, pad = 2): Rect | null {
  const full: Rect = { x: 0, y: 0, w: view.surfaceW, h: view.surfaceH };
  if (box.isEmpty()) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const p = new Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const q = projectPoint(view, basis, p);
    if (q.depth <= 1e-3) return full;
    x0 = Math.min(x0, q.x);
    y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x);
    y1 = Math.max(y1, q.y);
  }
  const l = Math.max(0, Math.floor(x0 - pad));
  const t = Math.max(0, Math.floor(y0 - pad));
  const r = Math.min(view.surfaceW, Math.ceil(x1 + pad));
  const b = Math.min(view.surfaceH, Math.ceil(y1 + pad));
  if (r <= l || b <= t) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}

// --- GPU pacing ----------------------------------------------------------------------------------

export interface PacerOptions {
  /** GPU time a single draw should take. Short draws let the system compositor interleave. */
  targetMs: number;
  /**
   * GPU time between fences (default: one fence per draw). Every fence costs a round trip that
   * leaves the GPU idle for a few milliseconds, so throughput-bound work groups several draws.
   */
  stepMs?: number;
  /** Fraction of wall-clock time the GPU may be busy with our work (1 = no pauses). */
  budget: number;
  /** Fenced steps kept in flight; 2 keeps the GPU fed while the CPU waits. */
  inFlight: number;
  /**
   * Keep going at full speed when the browser throttles timers (unfocused or background
   * windows) by polling with message tasks. For exports; the viewport may as well slow down.
   */
  unthrottled?: boolean;
}

interface InFlight {
  sync: WebGLSync;
  kind: string;
  pixels: number;
  placed: number;
}

/** Until when timers count as throttled (see GpuPacer.sleep). */
let throttledUntil = 0;

/**
 * Splits progressive GPU work into short, fenced bands and paces them: band heights adapt to a
 * GPU time target per draw (measured per kind of work, in ms per pixel), and a duty cycle keeps
 * the GPU partly idle so the rest of the system stays responsive.
 *
 * Without timer queries GPU time is only observable through fences, whose completion is noticed
 * with a latency of several milliseconds (timer granularity, batched status updates). With one
 * step in flight that latency is learned (the smallest wait seen) and subtracted; with two the
 * time between completions measures the GPU directly.
 */
export class GpuPacer {
  private gl: WebGL2RenderingContext;
  private opts: PacerOptions;
  private queue: InFlight[] = [];
  /** Pixels drawn since the last fence, and their kind of work (grouped steps). */
  private pending = 0;
  private pendingKind = '';
  /** Per kind of work: pixels per band, and the measured cost for sleeping until completion. */
  private kinds = new Map<string, { pixels: number; msPerPixel: number }>();
  private lastComplete = 0;
  /** Fence latency estimate (ms). */
  private latency = Infinity;

  constructor(gl: WebGL2RenderingContext, opts: PacerOptions) {
    this.gl = gl;
    this.opts = opts;
  }

  setBudget(budget: number): void {
    this.opts.budget = budget;
  }

  /** Rows of a surface `width` pixels wide that fit the per-draw time target. */
  rows(kind: string, width: number, maxRows: number): number {
    const k = this.kind(kind);
    return Math.max(1, Math.min(maxRows, Math.round(k.pixels / Math.max(width, 1))));
  }

  private kind(kind: string) {
    let k = this.kinds.get(kind);
    if (!k) {
      k = { pixels: 16384, msPerPixel: 0 };
      this.kinds.set(kind, k);
    }
    return k;
  }

  /**
   * Fences the work issued since the previous call and waits until the GPU may take more: until
   * fewer than `inFlight` steps are pending, plus the duty-cycle pause.
   */
  async step(kind: string, pixels: number, signal?: AbortSignal): Promise<void> {
    // measurements are per kind of work: a group never mixes them
    if (this.pending > 0 && kind !== this.pendingKind) this.fence();
    this.pending += pixels;
    this.pendingKind = kind;
    const k = this.kind(kind);
    const stepMs = this.opts.stepMs;
    if (stepMs && k.msPerPixel > 0 && this.pending * k.msPerPixel < stepMs) return;
    this.fence();
    while (this.queue.length >= this.opts.inFlight) {
      if (signal?.aborted) {
        this.drop();
        throw new DOMException('Abgebrochen', 'AbortError');
      }
      await this.waitOldest();
    }
  }

  private fence(): void {
    const gl = this.gl;
    const pixels = this.pending;
    const kind = this.pendingKind;
    this.pending = 0;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) return;
    this.queue.push({ sync, kind, pixels, placed: performance.now() });
  }

  /** Waits for everything issued so far. */
  async drain(): Promise<void> {
    if (this.pending > 0) this.fence();
    while (this.queue.length) await this.waitOldest();
  }

  /** Forgets pending fences (the work still completes on the GPU). */
  drop(): void {
    for (const f of this.queue) this.gl.deleteSync(f.sync);
    this.queue = [];
    this.pending = 0;
  }

  private async sleep(ms: number): Promise<void> {
    const now = performance.now();
    const hidden = typeof document !== 'undefined' && document.hidden;
    // hidden or unfocused pages clamp timers to as little as once per second; message tasks are
    // not throttled
    if (this.opts.unthrottled && (hidden || now < throttledUntil)) return yieldTask();
    await new Promise((r) => setTimeout(r, Math.max(0, ms)));
    const late = performance.now() - now - ms;
    if (late > 50) throttledUntil = performance.now() + 2000;
  }

  private async waitOldest(): Promise<void> {
    const gl = this.gl;
    const f = this.queue[0];
    // sleep through most of the expected time (bounded: the estimate includes the sleep itself
    // and one-off costs such as shader compilation), then poll at timer granularity
    const expected = Math.min(f.pixels * this.kind(f.kind).msPerPixel, this.opts.stepMs ?? this.opts.targetMs) * 0.75;
    const start = Math.max(f.placed, this.lastComplete);
    let first = true;
    for (;;) {
      const r = gl.clientWaitSync(f.sync, 0, 0);
      if (r !== gl.TIMEOUT_EXPIRED) break;
      const remaining = start + expected - performance.now();
      await this.sleep(first && remaining > 2 ? remaining : 1);
      first = false;
    }
    gl.deleteSync(f.sync);
    this.queue.shift();
    const now = performance.now();
    const ms = Math.max(0.05, now - Math.max(f.placed, this.lastComplete));
    this.lastComplete = now;
    let gpu = ms;
    if (this.opts.inFlight === 1) {
      this.latency = Math.min(this.latency * 1.02, ms);
      gpu = Math.max(ms - this.latency, ms * 0.1);
    }
    if (f.pixels > 0) {
      const k = this.kind(f.kind);
      const perPixel = gpu / f.pixels;
      k.msPerPixel = k.msPerPixel === 0 ? perPixel : k.msPerPixel * 0.6 + perPixel * 0.4;
      // a band cut short by the end of the surface says little about larger ones
      const ideal = this.opts.targetMs / k.msPerPixel;
      if (f.pixels >= k.pixels * 0.9 || ideal < k.pixels) {
        k.pixels = Math.max(256, Math.min(1 << 24, k.pixels * 2, Math.max(k.pixels * 0.25, ideal)));
      }
    }
    const pause = gpu * (1 / Math.max(0.05, this.opts.budget) - 1);
    if (pause > 0.5 && this.queue.length === 0) await this.sleep(pause);
  }
}

// --- convergence mask ----------------------------------------------------------------------------

/**
 * One fragment per block: decides from the accumulated mean (rgb) and second moment (alpha) of
 * the block and its one-pixel border whether it needs more samples, measuring the error as it
 * shows after tone mapping. Converged blocks stay converged, so every pixel's average stays a
 * plain mean over the samples it received.
 */
export const convergenceFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uAccum;
uniform sampler2D uMaskPrev;
uniform float uSamples;
uniform float uTol;            // 8-bit levels
uniform float uExposure;
uniform int uToneMapping;
out vec4 fragColor;
${toneGLSL}
float display( float x ) {
	vec3 c = vec3( max( x, 0.0 ) * uExposure );
	vec3 v = uToneMapping == 0 ? agx( c ) : neutral( c );
	return srgbOetf( clamp( dot( v, vec3( 0.2627, 0.6780, 0.0593 ) ), 0.0, 1.0 ) );
}
void main() {
	ivec2 b = ivec2( gl_FragCoord.xy );
	if ( texelFetch( uMaskPrev, b, 0 ).r < 0.5 ) { fragColor = vec4( 0.0 ); return; }
	ivec2 size = textureSize( uAccum, 0 );
	ivec2 lo = max( b * ${BLOCK} - 1, ivec2( 0 ) );
	ivec2 hi = min( b * ${BLOCK} + ${BLOCK + 1}, size );
	float worst = 0.0;
	for ( int y = lo.y; y < hi.y; y ++ ) {
		for ( int x = lo.x; x < hi.x; x ++ ) {
			vec4 c = texelFetch( uAccum, ivec2( x, y ), 0 );
			float m = ( c.r + c.g + c.b ) / 3.0;
			float s = sqrt( max( c.a - m * m, 0.0 ) / uSamples );
			worst = max( worst, display( m + s ) - display( m - s ) );
		}
	}
	fragColor = vec4( worst * 0.5 * 255.0 > uTol ? 1.0 : 0.0 );
}
`;

export function makeMaskRT(w: number, h: number): WebGLRenderTarget {
  return new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: UnsignedByteType,
    format: RGBAFormat,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

export function maskSize(w: number, h: number): [number, number] {
  return [Math.ceil(w / BLOCK), Math.ceil(h / BLOCK)];
}

/** Number of active blocks in RGBA8 mask pixels. */
export function countActive(px: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
  return n;
}
