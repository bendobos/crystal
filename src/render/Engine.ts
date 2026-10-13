import {
  Clock,
  Color,
  DataTexture,
  FloatType,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  PerspectiveCamera,
  RawShaderMaterial,
  RGBAFormat,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
  type IUniform,
  type Texture,
  Box3,
  Matrix4,
  Quaternion,
  Raycaster,
  Sphere,
  Spherical,
  Vector3 as V3,
} from 'three';
import CameraControls from 'camera-controls';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { CameraDoc, ExportTargetDoc, SceneDoc } from '../model/types';
import { GlassMesh, type SurfaceHit } from './GlassMesh';
import { QUALITY_INTERACTIVE } from '../geometry/sweep';
import { buildTraceShader, fullscreenVertex } from './shaders/trace';
import { bloomDownFragment, bloomUpFragment, compositeFragment } from './shaders/composite';
import {
  applyBackground,
  applyGlass,
  applyLighting,
  buildBackgroundLut,
  createEnvironmentUniforms,
  createMaterialUniforms,
  displayParams,
  outputMatrix,
} from './uniforms';
import type { OutputSpace } from './color';
import {
  basisFromCamera,
  fitFrame,
  projectionFor,
  rayDirection,
  tanHalfFov,
  type CameraBasis,
  type FrameView,
  type Rect,
} from './view';
import { BloomChain } from './Bloom';
import { detectTier, TIER_SETTINGS, type QualityTier, type TierSettings } from './quality';
import {
  CHECK_INTERVAL,
  convergenceFragment,
  countActive,
  GpuPacer,
  intersectRect,
  makeMaskRT,
  maskSize,
  PREVIEW_AA,
  projectedRect,
} from './adaptive';

CameraControls.install({
  THREE: { Vector2, Vector3: V3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

export interface RenderStatus {
  mode: 'preview' | 'sharp' | 'refine' | 'done' | 'paused';
  samples: number;
  target: number;
  /** Refinement progress 0..1 (converged blocks stop early). */
  progress: number;
  previewScale: number;
  fps: number;
  tier: QualityTier;
}

export interface EngineEvents {
  onStatus?: (s: RenderStatus) => void;
  /** Camera or frame changed (for overlays). */
  onView?: () => void;
  /** Camera came to rest after user interaction. */
  onCameraEnd?: (cam: CameraDoc) => void;
}

const SETTLE_MS = 160;
/** Path samples before the refined image starts to replace the sharp preview, and when it has. */
const MIX_START = 16;
const MIX_END = 32;
/** Bounces of the deterministic tracer for the settled (sharp) preview. */
const SHARP_BOUNCES = 12;
/** Minimum time between composites while refining. */
const REFINE_COMPOSITE_MS = 150;
const FALLBACK_CAMERA: CameraDoc = { position: [0, 0, 12], target: [0, 0, 0], focalLength: 70 };

export type Uniforms = Record<string, IUniform>;

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly glass = new GlassMesh();
  readonly camera = new PerspectiveCamera(30, 1, 0.05, 500);
  readonly controls: CameraControls;
  readonly quad = new FullScreenQuad();
  readonly env = createEnvironmentUniforms();
  readonly mat = createMaterialUniforms();
  readonly previewMaterial: RawShaderMaterial;
  readonly pathMaterial: RawShaderMaterial;
  readonly compositeMaterial: RawShaderMaterial;
  readonly bloomDown: RawShaderMaterial;
  readonly bloomUp: RawShaderMaterial;
  readonly convergenceMaterial: RawShaderMaterial;
  readonly floatType: typeof FloatType | typeof HalfFloatType;
  readonly displaySpace: OutputSpace;
  readonly blackTexture: DataTexture;

  doc: SceneDoc | null = null;
  tier: QualityTier;
  settings: TierSettings;
  /** Render paused, e.g. while an export uses the GPU. */
  suspended = false;

  private events: EngineEvents;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private frameCss: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private frameArea: Rect | null = null;
  /**
   * Preview targets at native canvas resolution. The live preview uses the lower-left part of
   * previewA; the settled preview accumulates jittered passes in both (ping-pong).
   */
  private previewA: WebGLRenderTarget;
  private previewB: WebGLRenderTarget;
  /** The preview shown: target and the part of it in use. */
  private shown: { rt: WebGLRenderTarget; w: number; h: number };
  /** Completed anti-aliasing passes of the settled preview, and the next row of the current one. */
  private sharpPass = 0;
  private sharpCursor = 0;
  /** Path tracing accumulators, covering only `refineRect` (native canvas pixels, top-left origin). */
  private accumA: WebGLRenderTarget;
  private accumB: WebGLRenderTarget;
  private maskA: WebGLRenderTarget;
  private maskB: WebGLRenderTarget;
  private maskPixels = new Uint8Array(4);
  private refineState: 'none' | 'running' | 'done' = 'none';
  private refineRect: Rect | null = null;
  private refineFrame: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private totalBlocks = 0;
  private activeBlocks = 0;
  private maskPending = false;
  private lastRefineComposite = 0;
  private pacer: GpuPacer;
  readonly bloom = new BloomChain();
  private bloomTex: Texture | null = null;
  private lut: DataTexture | null = null;
  private raf = 0;
  private clock = new Clock();
  private needsPreview = true;
  private samples = 0;
  private rowCursor = 0;
  private lastChange = 0;
  private lastFrame = 0;
  private frameEma = 16;
  private previewScale: number;
  private interacting = false;
  private controlsActive = false;
  private applyingCamera = false;
  private lastStatus = 0;
  private statusMode: RenderStatus['mode'] = 'preview';
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private pendingShape = false;

  constructor(canvas: HTMLCanvasElement, events: EngineEvents = {}) {
    this.canvas = canvas;
    this.events = events;
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.autoClear = false;
    const gl = this.renderer.getContext() as WebGL2RenderingContext & { drawingBufferColorSpace?: string };
    let space: OutputSpace = 'srgb';
    if ('drawingBufferColorSpace' in gl && window.matchMedia?.('(color-gamut: p3)').matches) {
      try {
        gl.drawingBufferColorSpace = 'display-p3';
        space = gl.drawingBufferColorSpace === 'display-p3' ? 'p3' : 'srgb';
      } catch {
        space = 'srgb';
      }
    }
    this.displaySpace = space;
    this.floatType = this.renderer.extensions.has('EXT_color_buffer_float') ? FloatType : HalfFloatType;

    this.tier = detectTier(this.renderer);
    this.settings = TIER_SETTINGS[this.tier];
    this.previewScale = this.settings.previewScaleMax;

    this.blackTexture = new DataTexture(new Float32Array(4), 1, 1, RGBAFormat, FloatType);
    this.blackTexture.needsUpdate = true;

    const shared = {
      ...this.env,
      ...this.mat,
      bvh: { value: this.glass.struct },
      normalAttribute: { value: this.glass.normalTex },
      uFrameOrigin: { value: new Vector2() },
      uFrameSize: { value: new Vector2(1, 1) },
    };
    this.previewMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: buildTraceShader('preview'),
      uniforms: {
        ...shared,
        uMaxBounces: { value: this.settings.previewBounces },
        uPrev: { value: null },
        uSample: { value: 0 },
        uJitter: { value: new Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.pathMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: buildTraceShader('path'),
      uniforms: {
        ...shared,
        uPrev: { value: null },
        uSample: { value: 0 },
        uSeed: { value: 1 },
        uLensRadius: { value: 0 },
        uFocusDist: { value: 10 },
        uMaxBounces: { value: 24 },
        uBranchMix: { value: 0.35 },
        uActive: { value: null },
        uUseMask: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: compositeFragment,
      uniforms: {
        uPreview: { value: null },
        uAccum: { value: null },
        uBloom: { value: this.blackTexture },
        uBloomTransform: { value: new Vector4(1, 1, 0, 0) },
        uPreviewTransform: { value: new Vector4(1, 1, 0, 0) },
        uPreviewMax: { value: new Vector2(1, 1) },
        uAccumRect: { value: new Vector4(0, 0, 1, 1) },
        uMixAccum: { value: 0 },
        uBloomStrength: { value: 0 },
        uExposure: { value: 1 },
        uToneMapping: { value: 0 },
        uContrast: { value: 0 },
        uSaturation: { value: 1 },
        uOutFrom2020: { value: outputMatrix(space) },
        uVignette: { value: 0 },
        uGrain: { value: 0 },
        uFrameOrigin: { value: new Vector2() },
        uFrameSize: { value: new Vector2(1, 1) },
        uFrameAspect: { value: 1 },
        uNoiseSeed: { value: 7 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.bloomDown = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: bloomDownFragment,
      uniforms: {
        uSrc: { value: null },
        uSrcScale: { value: new Vector2(1, 1) },
        uSrc2: { value: null },
        uSrc2Rect: { value: new Vector4(0, 0, 1, 1) },
        uMix2: { value: -1 },
        uTexel: { value: new Vector2() },
        uThreshold: { value: 1 },
        uBright: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.bloomUp = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: bloomUpFragment,
      uniforms: { uSrc: { value: null }, uBase: { value: null }, uTexel: { value: new Vector2() }, uRadius: { value: 1 } },
      depthTest: false,
      depthWrite: false,
    });

    this.convergenceMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: fullscreenVertex,
      fragmentShader: convergenceFragment,
      uniforms: {
        uAccum: { value: null },
        uMaskPrev: { value: null },
        uSamples: { value: 1 },
        uTol: { value: 1 },
        uExposure: { value: 1 },
        uToneMapping: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.previewA = this.makeRT(1, 1, HalfFloatType, LinearFilter);
    this.previewB = this.makeRT(1, 1, HalfFloatType, LinearFilter);
    this.shown = { rt: this.previewA, w: 1, h: 1 };
    this.accumA = this.makeRT(1, 1, this.floatType, NearestFilter);
    this.accumB = this.makeRT(1, 1, this.floatType, NearestFilter);
    this.maskA = makeMaskRT(1, 1);
    this.maskB = makeMaskRT(1, 1);
    this.pacer = new GpuPacer(gl as WebGL2RenderingContext, { targetMs: 8, budget: this.settings.gpuBudget, inFlight: 1 });

    this.controls = new CameraControls(this.camera, canvas);
    this.controls.smoothTime = 0.12;
    this.controls.draggingSmoothTime = 0.05;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 80;
    this.controls.dollySpeed = 0.6;
    this.controls.azimuthRotateSpeed = 0.8;
    this.controls.polarRotateSpeed = 0.8;
    this.controls.addEventListener('controlstart', () => {
      this.controlsActive = true;
      this.invalidate();
    });
    this.controls.addEventListener('controlend', () => {
      this.controlsActive = false;
      this.requestRender();
    });
    this.controls.addEventListener('rest', () => this.reportCamera());
    this.controls.addEventListener('update', () => {
      if (!this.applyingCamera) this.invalidate();
      this.events.onView?.();
    });

    // safety net: a gesture can end without camera-controls seeing it (captured pointers,
    // cancelled touches); never let a stale "camera active" state block refinement
    window.addEventListener('pointerup', this.onAnyPointerUp, true);
    window.addEventListener('pointercancel', this.onAnyPointerUp, true);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
  }

  // --- public API ---------------------------------------------------------------------------

  setEvents(events: EngineEvents): void {
    this.events = events;
  }

  setDoc(doc: SceneDoc): void {
    const prev = this.doc;
    this.doc = doc;
    let invalidate = false;
    if (!prev || prev.shape !== doc.shape) {
      this.pendingShape = true;
      invalidate = true;
    }
    if (!prev || prev.glass !== doc.glass || prev.shape.radius !== doc.shape.radius) {
      applyGlass(this.mat, doc.glass, this.sceneScale());
      invalidate = true;
    }
    if (!prev || prev.lighting !== doc.lighting) {
      applyLighting(this.env, doc.lighting, [0, 0, 0]);
      invalidate = true;
    }
    const target = this.activeTarget();
    const prevTarget = prev ? prev.exportTargets.find((t) => t.id === prev.activeTargetId) : null;
    if (
      !prev ||
      prev.background !== doc.background ||
      prev.lighting.exposure !== doc.lighting.exposure ||
      prev.effects.toneMapping !== doc.effects.toneMapping ||
      prev.effects.contrast !== doc.effects.contrast ||
      prev.effects.saturation !== doc.effects.saturation ||
      prevTarget?.width !== target?.width ||
      prevTarget?.height !== target?.height
    ) {
      this.lut = buildBackgroundLut(doc.background, displayParams(doc.lighting, doc.effects), this.displaySpace, this.lut ?? undefined);
      this.env.uBgLut.value = this.lut;
      applyBackground(this.env, doc.background, this.frameAspect());
      invalidate = true;
    }
    if (!prev || prev.effects !== doc.effects) {
      this.applyEffects();
      // effects that only affect compositing don't need new samples
      if (prev && (prev.effects.aperture !== doc.effects.aperture || prev.effects.focusDistance !== doc.effects.focusDistance)) {
        invalidate = true;
      } else this.requestRender(true);
    }
    // camera: apply unless the change came from our own controls
    const cam = this.activeCamera();
    const prevCam = prev ? (prevTarget?.camera ?? prev.camera) : null;
    if (!prev || cam !== prevCam || prevTarget?.id !== target?.id) {
      if (!this.cameraMatches(cam)) this.applyCamera(cam, false);
      invalidate = true;
    }
    if (!prev || prevTarget?.width !== target?.width || prevTarget?.height !== target?.height) {
      this.updateFrame();
      invalidate = true;
    }
    if (invalidate) this.invalidate();
  }

  /** The visible area the frame should be fitted into (CSS px relative to the canvas). */
  setFrameArea(area: Rect | null): void {
    this.frameArea = area;
    this.updateFrame();
    this.invalidate();
  }

  setInteracting(on: boolean): void {
    if (this.interacting === on) return;
    this.interacting = on;
    this.invalidate();
  }

  /**
   * Camera bindings. Tools grab single-pointer gestures that start on the glass (see
   * Interaction.tsx); everything else orbits. With a tool active two fingers orbit and zoom.
   */
  setTool(cameraTool: boolean): void {
    const A = CameraControls.ACTION;
    this.controls.mouseButtons.left = A.ROTATE;
    this.controls.mouseButtons.right = A.TRUCK;
    this.controls.mouseButtons.middle = A.DOLLY;
    this.controls.mouseButtons.wheel = A.DOLLY;
    this.controls.touches.one = A.TOUCH_ROTATE;
    this.controls.touches.two = cameraTool ? A.TOUCH_DOLLY_TRUCK : A.TOUCH_DOLLY_ROTATE;
    this.controls.touches.three = A.TOUCH_TRUCK;
  }

  setQuality(tier: QualityTier): void {
    this.tier = tier;
    this.settings = TIER_SETTINGS[tier];
    this.previewScale = Math.min(this.previewScale, this.settings.previewScaleMax);
    this.previewMaterial.uniforms.uMaxBounces.value = this.settings.previewBounces;
    this.pacer.setBudget(this.settings.gpuBudget);
    this.resize();
    this.invalidate();
  }

  frameRect(): Rect {
    return { ...this.frameCss };
  }

  /** View description in CSS pixels for overlays and picking. */
  view(): { view: FrameView; basis: CameraBasis } {
    this.syncProjection();
    return {
      view: { surfaceW: this.cssW, surfaceH: this.cssH, frame: this.frameCss, tanHalfFov: this.tanHalf() },
      basis: basisFromCamera(this.camera),
    };
  }

  /** Ray from a CSS pixel position on the canvas. */
  rayAt(x: number, y: number): { origin: Vector3; direction: Vector3 } {
    const { view, basis } = this.view();
    return { origin: basis.position.clone(), direction: rayDirection(view, basis, x, y) };
  }

  pick(x: number, y: number): SurfaceHit | null {
    const r = this.rayAt(x, y);
    return this.glass.raycast(r.origin, r.direction);
  }

  currentCamera(): CameraDoc {
    const p = this.controls.getPosition(new Vector3());
    const t = this.controls.getTarget(new Vector3());
    return { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z], focalLength: this.activeCamera()?.focalLength ?? 70 };
  }

  sceneScale(): number {
    return this.glass.sweep?.boundingRadius ?? 2;
  }

  invalidate(): void {
    this.needsPreview = true;
    this.samples = 0;
    this.rowCursor = 0;
    this.sharpPass = 0;
    this.sharpCursor = 0;
    this.refineState = 'none';
    this.maskPending = false;
    this.lastChange = performance.now();
    this.requestRender();
  }

  requestRender(compositeOnly = false): void {
    if (compositeOnly) this.compositeOnly = true;
    if (!this.raf && !this.disposed && !this.suspended) this.raf = requestAnimationFrame(this.frame);
  }

  /** Resumes interactive rendering and re-applies all scene state (after exports). */
  resume(): void {
    this.suspended = false;
    const d = this.doc;
    this.doc = null;
    if (d) this.setDoc(d);
    this.resize();
    this.invalidate();
  }

  suspend(): void {
    this.suspended = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Small JPEG of the current view (for project thumbnails). */
  snapshot(maxWidth = 360): Promise<Blob | null> {
    // the drawing buffer is only valid right after compositing, within the same task
    this.composite();
    const f = this.scaledFrame(this.canvas.width);
    const scale = Math.min(1, maxWidth / f.w);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(f.w * scale));
    c.height = Math.max(1, Math.round(f.h * scale));
    c.getContext('2d')?.drawImage(this.canvas, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
  }

  /**
   * Measures GPU time per pass (ms per megapixel), forcing completion with a pixel read: the
   * settled preview at native resolution and path tracing over the glass region.
   */
  benchmark(passes = 4): { previewMsPerMP: number; pathMsPerMP: number } {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => {
      this.composite();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    };
    const time = (fn: () => void) => {
      sync();
      const t = performance.now();
      for (let i = 0; i < passes; i++) fn();
      sync();
      return (performance.now() - t) / passes;
    };
    const wasSuspended = this.suspended;
    this.suspended = true;
    const prev = time(() => {
      this.sharpPass = 0;
      this.sharpCursor = 0;
      this.renderSharpRows(this.canvas.height);
    });
    this.beginRefine();
    const path = this.refineRect
      ? time(() => {
          this.rowCursor = 0;
          this.renderPathRows(this.accumB.height);
        })
      : NaN;
    this.suspended = wasSuspended;
    this.invalidate();
    const mp = (w: number, h: number) => (w * h) / 1e6;
    return {
      previewMsPerMP: prev / mp(this.canvas.width, this.canvas.height),
      pathMsPerMP: path / mp(this.accumA.width, this.accumA.height),
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    window.removeEventListener('pointerup', this.onAnyPointerUp, true);
    window.removeEventListener('pointercancel', this.onAnyPointerUp, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.glass.dispose();
    clearTimeout(this.settleTimer);
    this.pacer.drop();
    for (const rt of [this.previewA, this.previewB, this.accumA, this.accumB, this.maskA, this.maskB]) rt.dispose();
    this.convergenceMaterial.dispose();
    this.bloom.dispose();
    this.renderer.dispose();
  }

  // --- internals ----------------------------------------------------------------------------

  private compositeOnly = false;

  activeTarget(): ExportTargetDoc | null {
    const d = this.doc;
    if (!d) return null;
    return d.exportTargets.find((t) => t.id === d.activeTargetId) ?? d.exportTargets[0] ?? null;
  }

  activeCamera(): CameraDoc {
    const t = this.activeTarget();
    return t?.camera ?? this.doc?.camera ?? FALLBACK_CAMERA;
  }

  frameAspect(): number {
    const t = this.activeTarget();
    return t ? t.width / t.height : this.cssW / this.cssH;
  }

  tanHalf(): number {
    return tanHalfFov(this.activeCamera()?.focalLength ?? 70);
  }

  private makeRT(w: number, h: number, type: typeof FloatType | typeof HalfFloatType, filter: typeof LinearFilter | typeof NearestFilter) {
    return new WebGLRenderTarget(w, h, {
      type,
      format: RGBAFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  private cameraMatches(cam: CameraDoc): boolean {
    const p = this.controls.getPosition(new Vector3());
    const t = this.controls.getTarget(new Vector3());
    const eps = 1e-4;
    return (
      Math.abs(p.x - cam.position[0]) < eps &&
      Math.abs(p.y - cam.position[1]) < eps &&
      Math.abs(p.z - cam.position[2]) < eps &&
      Math.abs(t.x - cam.target[0]) < eps &&
      Math.abs(t.y - cam.target[1]) < eps &&
      Math.abs(t.z - cam.target[2]) < eps
    );
  }

  applyCamera(cam: CameraDoc, smooth: boolean): void {
    this.applyingCamera = !smooth;
    void this.controls.setLookAt(...cam.position, ...cam.target, smooth);
    this.controls.update(0);
    this.applyingCamera = false;
    this.syncProjection();
    this.events.onView?.();
  }

  private reportCamera(): void {
    if (!this.doc) return;
    const cur = this.currentCamera();
    if (!this.cameraMatches(this.activeCamera())) this.events.onCameraEnd?.(cur);
  }

  private updateFrame(): void {
    const area = this.frameArea ?? { x: 0, y: 0, w: this.cssW, h: this.cssH };
    const margin = Math.min(28, Math.max(10, Math.min(area.w, area.h) * 0.04));
    this.frameCss = fitFrame(area, this.frameAspect(), margin);
    this.syncProjection();
    this.events.onView?.();
  }

  private syncProjection(): void {
    const view: FrameView = { surfaceW: this.cssW, surfaceH: this.cssH, frame: this.frameCss, tanHalfFov: this.tanHalf() };
    // camera-controls reads fov/aspect for dolly and truck speed; keep them consistent
    const tanCanvas = this.tanHalf() * (this.cssH / Math.max(this.frameCss.h, 1));
    this.camera.fov = (2 * Math.atan(tanCanvas) * 180) / Math.PI;
    this.camera.aspect = this.cssW / this.cssH;
    projectionFor(view, this.camera.near, this.camera.far, this.camera.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, this.settings.maxDpr);
    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr && this.canvas.width > 1) return;
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.renderer.setSize(Math.round(cssW * dpr), Math.round(cssH * dpr), false);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    this.previewA.setSize(w, h);
    this.previewB.setSize(w, h);
    // bloom spread is relative to the image: a megapixel is plenty
    const b = Math.min(1, Math.sqrt(1e6 / (w * h)));
    this.bloom.setSize(Math.max(1, Math.round(w * b)), Math.max(1, Math.round(h * b)));
    this.updateFrame();
    this.invalidate();
  }

  private applyEffects(): void {
    const d = this.doc;
    if (!d) return;
    const fx = d.effects;
    const c = this.compositeMaterial.uniforms;
    c.uExposure.value = Math.pow(2, d.lighting.exposure);
    c.uToneMapping.value = fx.toneMapping === 'agx' ? 0 : 1;
    c.uContrast.value = fx.contrast;
    c.uSaturation.value = fx.saturation;
    c.uVignette.value = fx.vignette;
    c.uGrain.value = fx.grain;
    c.uBloomStrength.value = fx.bloom;
  }

  /** Writes camera and frame uniforms for a render surface of the given size. */
  setFrameUniforms(target: Uniforms, _surfaceW: number, surfaceH: number, frame: Rect, basis?: CameraBasis, tanHalf?: number): void {
    const b = basis ?? basisFromCamera(this.camera);
    (this.env.uCamPos.value as Vector3).copy(b.position);
    (this.env.uCamRight.value as Vector3).copy(b.right);
    (this.env.uCamUp.value as Vector3).copy(b.up);
    (this.env.uCamFwd.value as Vector3).copy(b.forward);
    this.env.uTanHalfFov.value = tanHalf ?? this.tanHalf();
    this.env.uFrameAspect.value = frame.w / frame.h;
    // GL coordinates: origin at the bottom left
    (target.uFrameOrigin.value as Vector2).set(frame.x, surfaceH - (frame.y + frame.h));
    (target.uFrameSize.value as Vector2).set(frame.w, frame.h);
  }

  private scaledFrame(w: number): Rect {
    const s = w / this.cssW;
    return { x: this.frameCss.x * s, y: this.frameCss.y * s, w: this.frameCss.w * s, h: this.frameCss.h * s };
  }

  private updateGeometry(): void {
    if (!this.doc) return;
    const t0 = performance.now();
    this.glass.update(this.doc.shape, QUALITY_INTERACTIVE, true);
    applyGlass(this.mat, this.doc.glass, this.sceneScale());
    this.pendingShape = false;
    this.geometryMs = performance.now() - t0;
  }

  geometryMs = 0;

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed || this.suspended || !this.doc) return;
    const dt = this.clock.getDelta();
    this.controls.update(dt);
    this.syncProjection();
    if (this.pendingShape) this.updateGeometry();

    const idle = now - this.lastChange;
    const busy = this.interacting || this.controlsActive;
    let rendered = false;
    const frameDt = now - this.lastFrame;
    this.lastFrame = now;

    if (this.needsPreview) {
      this.adaptPreview(frameDt);
      this.renderPreview();
      this.needsPreview = false;
      rendered = true;
      this.statusMode = 'preview';
    } else if (!busy && idle > SETTLE_MS) this.settle();
    if (rendered || this.compositeOnly) {
      this.compositeOnly = false;
      this.renderBloom();
      this.composite();
    }
    if (frameDt > 0 && frameDt < 500) this.frameEma = this.frameEma * 0.9 + frameDt * 0.1;
    this.emitStatus(now);

    const more = this.needsPreview || busy || idle <= SETTLE_MS + 20;
    if (more) this.requestRender();
    if (!busy && idle <= SETTLE_MS) this.scheduleSettle();
  };

  private settleTimer = 0;

  /** Start refining when the settle time is over, even if animation frames are throttled. */
  private scheduleSettle(): void {
    clearTimeout(this.settleTimer);
    const idle = performance.now() - this.lastChange;
    this.settleTimer = window.setTimeout(this.settle, Math.max(0, SETTLE_MS - idle) + 5);
  }

  private settle = (): void => {
    if (!this.canPump()) return;
    if (this.glass.degraded) this.glass.rebuild();
    if (!this.refined()) this.startPump();
  };

  // --- progressive refinement pump -------------------------------------------------------------
  // Runs outside requestAnimationFrame in short, fenced bands (GpuPacer): first a few jittered
  // passes of the deterministic tracer at native resolution (sharp, noise-free), then path
  // tracing over the glass region until its blocks converge. The pacer leaves the GPU idle part
  // of the time so that the rest of the system stays responsive.

  private pumping = false;

  private canPump(): boolean {
    return !(
      this.disposed ||
      this.suspended ||
      this.needsPreview ||
      this.interacting ||
      this.controlsActive ||
      !this.doc ||
      document.hidden ||
      performance.now() - this.lastChange < SETTLE_MS
    );
  }

  private refined(): boolean {
    return this.sharpPass >= PREVIEW_AA.length && this.refineState === 'done';
  }

  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    try {
      while (this.canPump()) {
        const work = this.pumpStep();
        if (!work) break;
        await this.pacer.step(work.kind, work.pixels);
      }
    } finally {
      this.pumping = false;
    }
    // stopped by a pending change or a gesture: those reschedule; this covers everything else
    if (!this.disposed && !this.refined()) this.scheduleSettle();
    this.emitStatus(performance.now());
  }

  /** Issues the next band of work; null when the view is fully refined. */
  private pumpStep(): { kind: string; pixels: number } | null {
    if (this.sharpPass < PREVIEW_AA.length) {
      this.statusMode = 'sharp';
      const w = this.canvas.width;
      const rows = this.pacer.rows('preview', w, this.canvas.height - this.sharpCursor);
      this.renderSharpRows(rows);
      return { kind: 'preview', pixels: w * rows };
    }
    if (this.refineState === 'none') this.beginRefine();
    if (this.maskPending) this.readMask();
    if (this.refineState === 'running' && (this.samples >= this.settings.targetSamples || this.activeBlocks === 0)) {
      this.refineState = 'done';
    }
    if (this.refineState === 'done') {
      this.statusMode = 'done';
      this.requestRender(true);
      return null;
    }
    this.statusMode = 'refine';
    const w = this.accumB.width;
    const rows = this.pacer.rows('path', w, this.accumB.height - this.rowCursor);
    this.renderPathRows(rows);
    return { kind: 'path', pixels: w * rows };
  }

  private adaptPreview(frameDt: number): void {
    if (frameDt <= 0 || frameDt > 250) return;
    const target = this.settings.previewFrameMs;
    if (frameDt > target * 1.2) this.previewScale *= 0.92;
    else if (frameDt < target * 0.75) this.previewScale *= 1.04;
    this.previewScale = Math.min(this.settings.previewScaleMax, Math.max(this.settings.previewScaleMin, this.previewScale));
  }

  /** Live preview: one pass at the adaptive resolution into the lower-left part of previewA. */
  private renderPreview(): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const k = this.previewScale * this.dpr;
    const w = Math.max(1, Math.min(W, Math.round(this.cssW * k)));
    const h = Math.max(1, Math.min(H, Math.round(this.cssH * k)));
    const u = this.previewMaterial.uniforms;
    this.setFrameUniforms(u, w, h, this.scaledFrame(w));
    u.uSample.value = 0;
    u.uPrev.value = this.previewB.texture;
    this.previewA.viewport.set(0, 0, w, h);
    this.quad.material = this.previewMaterial;
    this.renderer.setRenderTarget(this.previewA);
    this.quad.render(this.renderer);
    this.previewA.viewport.set(0, 0, W, H);
    this.shown = { rt: this.previewA, w, h };
  }

  /** Rows of the current anti-aliasing pass of the settled preview (native resolution). */
  private renderSharpRows(rows: number): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    // even passes write B, odd passes A; the live preview in A is no longer shown by then
    const write = this.sharpPass % 2 === 0 ? this.previewB : this.previewA;
    const read = write === this.previewA ? this.previewB : this.previewA;
    const u = this.previewMaterial.uniforms;
    this.setFrameUniforms(u, W, H, this.scaledFrame(W));
    const j = PREVIEW_AA[this.sharpPass];
    (u.uJitter.value as Vector2).set(j[0], j[1]);
    u.uSample.value = this.sharpPass;
    u.uPrev.value = read.texture;
    u.uMaxBounces.value = Math.max(SHARP_BOUNCES, this.settings.previewBounces);
    const y0 = this.sharpCursor;
    const n = Math.min(rows, H - y0);
    write.viewport.set(0, 0, W, H);
    write.scissor.set(0, y0, W, n);
    write.scissorTest = true;
    this.quad.material = this.previewMaterial;
    this.renderer.setRenderTarget(write);
    this.quad.render(this.renderer);
    write.scissorTest = false;
    u.uSample.value = 0;
    (u.uJitter.value as Vector2).set(0, 0);
    u.uMaxBounces.value = this.settings.previewBounces;
    this.sharpCursor += n;
    if (this.sharpCursor >= H) {
      this.sharpCursor = 0;
      this.sharpPass++;
      this.shown = { rt: write, w: W, h: H };
      this.requestRender(true);
    }
  }

  /**
   * Sets up path tracing for the current view: the region that can see the glass (projected
   * bounds within the frame; the whole frame with depth of field), its accumulators and mask.
   */
  private beginRefine(): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const frame = this.scaledFrame(W);
    const frameInt: Rect = { x: Math.floor(frame.x), y: Math.floor(frame.y), w: Math.ceil(frame.w), h: Math.ceil(frame.h) };
    const surface: Rect = { x: 0, y: 0, w: W, h: H };
    let rect: Rect | null;
    if ((this.doc?.effects.aperture ?? 0) > 0) rect = frameInt;
    else {
      const view: FrameView = { surfaceW: W, surfaceH: H, frame, tanHalfFov: this.tanHalf() };
      rect = projectedRect(this.glass.bounds(), view, basisFromCamera(this.camera), 3);
      rect = rect && intersectRect(rect, frameInt);
    }
    rect = rect && intersectRect(rect, surface);
    this.refineRect = rect;
    this.samples = 0;
    this.rowCursor = 0;
    this.maskPending = false;
    if (!rect) {
      this.refineState = 'done';
      this.activeBlocks = this.totalBlocks = 0;
      return;
    }
    const scale = Math.min(1, Math.sqrt(this.settings.maxRefinePixels / (rect.w * rect.h)));
    const aw = Math.max(1, Math.round(rect.w * scale));
    const ah = Math.max(1, Math.round(rect.h * scale));
    const sx = aw / rect.w;
    const sy = ah / rect.h;
    this.refineFrame = { x: (frame.x - rect.x) * sx, y: (frame.y - rect.y) * sy, w: frame.w * sx, h: frame.h * sy };
    for (const rt of [this.accumA, this.accumB]) if (rt.width !== aw || rt.height !== ah) rt.setSize(aw, ah);
    const [mw, mh] = maskSize(aw, ah);
    for (const rt of [this.maskA, this.maskB]) if (rt.width !== mw || rt.height !== mh) rt.setSize(mw, mh);
    if (this.maskPixels.length !== mw * mh * 4) this.maskPixels = new Uint8Array(mw * mh * 4);
    this.clearTarget(this.maskA, 1);
    this.totalBlocks = this.activeBlocks = mw * mh;
    this.refineState = 'running';
  }

  clearTarget(rt: WebGLRenderTarget, value: number): void {
    const prev = this.renderer.getClearColor(new Color());
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(new Color(value, value, value), value);
    this.renderer.setRenderTarget(rt);
    this.renderer.clear(true, false, false);
    this.renderer.setClearColor(prev, alpha);
  }

  /** Rows of the current path tracing sample over the glass region. */
  private renderPathRows(rows: number): void {
    const read = this.accumA;
    const write = this.accumB;
    const w = write.width;
    const h = write.height;
    const u = this.pathMaterial.uniforms;
    this.setFrameUniforms(u, w, h, this.refineFrame);
    u.uPrev.value = read.texture;
    u.uSample.value = this.samples;
    u.uSeed.value = 1;
    u.uActive.value = this.maskA.texture;
    u.uUseMask.value = 1;
    const fx = this.doc!.effects;
    u.uLensRadius.value = fx.aperture * 0.06 * fx.focusDistance;
    u.uFocusDist.value = fx.focusDistance;
    const y0 = this.rowCursor;
    const n = Math.min(rows, h - y0);
    write.scissor.set(0, y0, w, n);
    write.scissorTest = n < h;
    this.quad.material = this.pathMaterial;
    this.renderer.setRenderTarget(write);
    this.quad.render(this.renderer);
    write.scissorTest = false;
    u.uUseMask.value = 0;
    this.rowCursor += n;
    if (this.rowCursor < h) return;
    this.rowCursor = 0;
    this.accumA = write;
    this.accumB = read;
    this.samples++;
    const { minSamples, tolerance } = this.settings.refine;
    if (this.samples >= minSamples && this.samples % CHECK_INTERVAL === 0) this.updateMask(tolerance);
    const now = performance.now();
    if (this.samples >= MIX_START && now - this.lastRefineComposite > REFINE_COMPOSITE_MS) {
      this.lastRefineComposite = now;
      this.requestRender(true);
    }
  }

  /** Convergence check; the result is read back once the GPU is done with it (readMask). */
  private updateMask(tolerance: number): void {
    const u = this.convergenceMaterial.uniforms;
    u.uAccum.value = this.accumA.texture;
    u.uMaskPrev.value = this.maskA.texture;
    u.uSamples.value = this.samples;
    u.uTol.value = tolerance;
    const c = this.compositeMaterial.uniforms;
    u.uExposure.value = c.uExposure.value;
    u.uToneMapping.value = c.uToneMapping.value;
    this.quad.material = this.convergenceMaterial;
    this.renderer.setRenderTarget(this.maskB);
    this.quad.render(this.renderer);
    const t = this.maskA;
    this.maskA = this.maskB;
    this.maskB = t;
    this.maskPending = true;
  }

  private readMask(): void {
    this.maskPending = false;
    const m = this.maskA;
    this.renderer.readRenderTargetPixels(m, 0, 0, m.width, m.height, this.maskPixels);
    this.activeBlocks = countActive(this.maskPixels);
  }

  private mixAccum(): number {
    if (!this.refineRect) return 0;
    if (this.refineState === 'done' && this.samples > 0) return 1;
    const x = Math.min(1, Math.max(0, (this.samples - MIX_START) / (MIX_END - MIX_START)));
    return x * x * (3 - 2 * x);
  }

  /** Accumulator rect for compositing: GL origin, native canvas pixels. */
  private accumRectGL(): [number, number, number, number] {
    const r = this.refineRect ?? { x: 0, y: 0, w: 1, h: 1 };
    return [r.x, this.canvas.height - (r.y + r.h), r.w, r.h];
  }

  private renderBloom(): void {
    const fx = this.doc?.effects;
    if (!fx || fx.bloom <= 0 || !this.bloom.available) {
      this.bloomTex = null;
      return;
    }
    const s = this.shown;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const [rx, ry, rw, rh] = this.accumRectGL();
    const mix = this.mixAccum();
    this.bloomTex = this.bloom.render(
      this.renderer,
      this.quad,
      this.bloomDown,
      this.bloomUp,
      {
        a: s.rt.texture,
        aScale: [s.w / s.rt.width, s.h / s.rt.height],
        b: mix > 0 ? this.accumA.texture : null,
        bRect: [rx / W, ry / H, rw / W, rh / H],
        mix,
      },
      this.bloomThreshold(),
      fx.bloomRadius,
    );
  }

  bloomThreshold(): number {
    return 0.9 / Math.pow(2, this.doc?.lighting.exposure ?? 0);
  }

  private composite(): void {
    const c = this.compositeMaterial.uniforms;
    const s = this.shown;
    c.uPreview.value = s.rt.texture;
    const pw = s.rt.width;
    const ph = s.rt.height;
    (c.uPreviewTransform.value as Vector4).set(s.w / pw, s.h / ph, 0, 0);
    (c.uPreviewMax.value as Vector2).set((s.w - 0.5) / pw, (s.h - 0.5) / ph);
    c.uAccum.value = this.accumA.texture;
    (c.uAccumRect.value as Vector4).set(...this.accumRectGL());
    c.uMixAccum.value = this.mixAccum();
    c.uBloom.value = this.bloomTex ?? this.blackTexture;
    (c.uBloomTransform.value as Vector4).set(1, 1, 0, 0);
    c.uOutFrom2020.value = outputMatrix(this.displaySpace);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const f = this.scaledFrame(w);
    (c.uFrameOrigin.value as Vector2).set(f.x, h - (f.y + f.h));
    (c.uFrameSize.value as Vector2).set(f.w, f.h);
    c.uFrameAspect.value = f.w / f.h;
    this.quad.material = this.compositeMaterial;
    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);
  }

  private progress(): number {
    if (this.statusMode === 'done') return 1;
    if (this.statusMode !== 'refine') return 0;
    const bySamples = Math.min(1, this.samples / this.settings.targetSamples);
    const remaining = this.totalBlocks > 0 ? this.activeBlocks / this.totalBlocks : 1;
    return 1 - remaining * (1 - bySamples);
  }

  private emitStatus(now: number): void {
    if (!this.events.onStatus) return;
    if (now - this.lastStatus < 120 && this.statusMode === 'refine') return;
    this.lastStatus = now;
    this.events.onStatus({
      mode: this.statusMode,
      samples: this.samples,
      target: this.settings.targetSamples,
      progress: this.progress(),
      previewScale: this.previewScale,
      fps: 1000 / this.frameEma,
      tier: this.tier,
    });
  }

  private onVisibility = (): void => {
    if (document.hidden) return;
    this.requestRender();
    this.scheduleSettle();
  };

  private onAnyPointerUp = (e: PointerEvent): void => {
    if (e.buttons === 0 && this.controlsActive) {
      setTimeout(() => {
        this.controlsActive = false;
        this.requestRender();
      }, 0);
    }
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault();
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  };

  private onContextRestored = (): void => {
    if (this.doc) {
      this.pendingShape = true;
      this.lut = buildBackgroundLut(this.doc.background, displayParams(this.doc.lighting, this.doc.effects), this.displaySpace);
      this.env.uBgLut.value = this.lut;
    }
    this.invalidate();
  };
}
