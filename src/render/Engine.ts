import {
  Clock,
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
import { yieldTask } from '../util/yield';
import { detectTier, TIER_SETTINGS, type QualityTier, type TierSettings } from './quality';

CameraControls.install({
  THREE: { Vector2, Vector3: V3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

export interface RenderStatus {
  mode: 'preview' | 'refine' | 'done' | 'paused';
  samples: number;
  target: number;
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
  private previewRT: WebGLRenderTarget;
  private accumA: WebGLRenderTarget;
  private accumB: WebGLRenderTarget;
  readonly bloom = new BloomChain();
  private bloomTex: Texture | null = null;
  private lut: DataTexture | null = null;
  private raf = 0;
  private clock = new Clock();
  private needsPreview = true;
  private samples = 0;
  /** Rows of the refinement target traced per frame (adapted to keep frames short). */
  private rowsPerFrame = 64;
  private rowCursor = 0;
  private lastBandRows = 0;
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
      uniforms: { ...shared, uMaxBounces: { value: this.settings.previewBounces } },
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
        uSrc2: { value: null },
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

    this.previewRT = this.makeRT(1, 1, HalfFloatType, LinearFilter);
    this.accumA = this.makeRT(1, 1, this.floatType, NearestFilter);
    this.accumB = this.makeRT(1, 1, this.floatType, NearestFilter);

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

  /** Camera that fits the object into the frame, keeping the viewing direction. */
  fitCamera(margin = 1.12): CameraDoc | null {
    const s = this.glass.sweep;
    const cam = this.activeCamera();
    if (!s || !cam) return null;
    const t = this.tanHalf();
    const aspect = this.frameAspect();
    const half = Math.atan(t * Math.min(1, aspect));
    const dist = (s.boundingRadius * margin) / Math.sin(half);
    const target = new Vector3(...s.center);
    const dir = new Vector3(...cam.position).sub(new Vector3(...cam.target)).normalize();
    const pos = target.clone().addScaledVector(dir, dist);
    return { position: [pos.x, pos.y, pos.z], target: [target.x, target.y, target.z], focalLength: cam.focalLength };
  }

  sceneScale(): number {
    return this.glass.sweep?.boundingRadius ?? 2;
  }

  invalidate(): void {
    this.needsPreview = true;
    this.samples = 0;
    this.rowCursor = 0;
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

  /** Measures GPU time per pass (ms per megapixel), forcing completion with a pixel read. */
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
    const rows = this.rowsPerFrame;
    this.rowsPerFrame = 1e6;
    const prev = time(() => this.renderPreview());
    const path = time(() => {
      this.rowCursor = 0;
      this.renderSampleBand();
    });
    this.rowsPerFrame = rows;
    this.suspended = wasSuspended;
    this.invalidate();
    const mp = (rt: WebGLRenderTarget) => (rt.width * rt.height) / 1e6;
    return { previewMsPerMP: prev / mp(this.previewRT), pathMsPerMP: path / mp(this.accumA) };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    window.removeEventListener('pointerup', this.onAnyPointerUp, true);
    window.removeEventListener('pointercancel', this.onAnyPointerUp, true);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.glass.dispose();
    for (const rt of [this.previewRT, this.accumA, this.accumB]) rt.dispose();
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
    const refine = Math.min(1, Math.sqrt(this.settings.maxRefinePixels / (w * h)));
    const rw = Math.max(1, Math.round(w * refine));
    const rh = Math.max(1, Math.round(h * refine));
    this.accumA.setSize(rw, rh);
    this.accumB.setSize(rw, rh);
    this.bloom.setSize(rw, rh);
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
    } else if (!busy && idle > SETTLE_MS) {
      if (this.glass.degraded) this.glass.rebuild();
      if (this.samples < this.settings.targetSamples) {
        this.statusMode = 'refine';
        this.startPump();
      } else this.statusMode = 'done';
    }
    if (rendered || this.compositeOnly) {
      this.compositeOnly = false;
      this.renderBloom();
      this.composite();
    }
    if (frameDt > 0 && frameDt < 500) this.frameEma = this.frameEma * 0.9 + frameDt * 0.1;
    this.emitStatus(now);

    const more = this.needsPreview || busy || idle <= SETTLE_MS + 20;
    if (more) this.requestRender();
    if (!busy && idle <= SETTLE_MS) {
      // start refining when the settle time is over even if animation frames are throttled
      clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(this.settle, SETTLE_MS - idle + 5);
    }
  };

  private settleTimer = 0;
  private settle = (): void => {
    if (this.disposed || this.suspended || this.needsPreview || this.interacting || this.controlsActive) return;
    if (performance.now() - this.lastChange < SETTLE_MS) return;
    if (this.glass.degraded) this.glass.rebuild();
    if (this.samples < this.settings.targetSamples) {
      this.statusMode = 'refine';
      this.startPump();
    }
  };

  // --- progressive refinement pump -------------------------------------------------------------
  // Runs outside requestAnimationFrame: each band is issued only once the previous one finished
  // on the GPU (fence), which keeps the GPU queue short and the UI responsive.

  private pumping = false;

  private startPump(): void {
    if (this.pumping) return;
    this.pumping = true;
    void yieldTask().then(this.pump);
  }

  private pump = (): void => {
    if (this.disposed || this.suspended || this.needsPreview || this.interacting || this.controlsActive || !this.doc) {
      this.pumping = false;
      return;
    }
    if (this.samples >= this.settings.targetSamples) {
      this.pumping = false;
      this.statusMode = 'done';
      this.requestRender(true);
      return;
    }
    if (!this.fenceDone()) {
      // poll quickly while the band is young, then back off to spare the CPU
      if (performance.now() - this.fenceStart < 40) void yieldTask().then(this.pump);
      else setTimeout(this.pump, 1);
      return;
    }
    const completed = this.renderSampleBand();
    this.placeFence();
    if (completed) this.requestRender(true);
    void yieldTask().then(this.pump);
  };

  private adaptPreview(frameDt: number): void {
    if (frameDt <= 0 || frameDt > 250) return;
    const target = this.settings.previewFrameMs;
    if (frameDt > target * 1.2) this.previewScale *= 0.92;
    else if (frameDt < target * 0.75) this.previewScale *= 1.04;
    this.previewScale = Math.min(this.settings.previewScaleMax, Math.max(this.settings.previewScaleMin, this.previewScale));
  }

  private fence: WebGLSync | null = null;
  private fenceStart = 0;
  private fenceRows = 0;

  private placeFence(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.fenceStart = performance.now();
    this.fenceRows = this.lastBandRows;
  }

  /** True when no band is in flight; adapts the band height to ~12 ms of GPU time. */
  private fenceDone(): boolean {
    if (!this.fence) return true;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const r = gl.clientWaitSync(this.fence, 0, 0);
    if (r === gl.TIMEOUT_EXPIRED) return false;
    gl.deleteSync(this.fence);
    this.fence = null;
    const ms = performance.now() - this.fenceStart;
    if (this.fenceRows > 0 && ms > 0) {
      const target = 10;
      const ideal = (this.fenceRows * target) / ms;
      const next = this.rowsPerFrame * 0.6 + ideal * 0.4;
      this.rowsPerFrame = Math.max(4, Math.min(this.accumB.height, Math.round(next)));
    }
    return true;
  }

  private renderPreview(): void {
    // preview resolution is relative to CSS pixels: high-DPR screens upscale the live preview
    const k = Math.min(this.previewScale, this.dpr);
    const w = Math.max(1, Math.round(this.cssW * k));
    const h = Math.max(1, Math.round(this.cssH * k));
    if (this.previewRT.width !== w || this.previewRT.height !== h) this.previewRT.setSize(w, h);
    this.setFrameUniforms(this.previewMaterial.uniforms, w, h, this.scaledFrame(w));
    this.quad.material = this.previewMaterial;
    this.renderer.setRenderTarget(this.previewRT);
    this.quad.render(this.renderer);
  }

  private renderSampleBand(): boolean {
    const read = this.accumA;
    const write = this.accumB;
    const w = write.width;
    const h = write.height;
    const u = this.pathMaterial.uniforms;
    this.setFrameUniforms(u, w, h, this.scaledFrame(w));
    u.uPrev.value = read.texture;
    u.uSample.value = this.samples;
    u.uSeed.value = 1;
    const fx = this.doc!.effects;
    u.uLensRadius.value = fx.aperture * 0.06 * fx.focusDistance;
    u.uFocusDist.value = fx.focusDistance;
    const y0 = this.rowCursor;
    const rows = Math.min(this.rowsPerFrame, h - y0);
    this.lastBandRows = rows;
    write.scissor.set(0, y0, w, rows);
    write.scissorTest = rows < h;
    this.quad.material = this.pathMaterial;
    this.renderer.setRenderTarget(write);
    this.quad.render(this.renderer);
    write.scissorTest = false;
    this.rowCursor += rows;
    if (this.rowCursor >= h) {
      this.rowCursor = 0;
      this.accumA = write;
      this.accumB = read;
      this.samples++;
      return true;
    }
    return false;
  }

  private mixAccum(): number {
    const s = this.samples;
    if (s < 2) return 0;
    const x = Math.min(1, (s - 2) / 10);
    return x * x * (3 - 2 * x);
  }

  private renderBloom(): void {
    const fx = this.doc?.effects;
    if (!fx || fx.bloom <= 0 || !this.bloom.available) {
      this.bloomTex = null;
      return;
    }
    this.bloomTex = this.bloom.render(
      this.renderer,
      this.quad,
      this.bloomDown,
      this.bloomUp,
      { a: this.previewRT.texture, b: this.accumA.texture, mix: this.mixAccum() },
      this.bloomThreshold(),
      fx.bloomRadius,
    );
  }

  bloomThreshold(): number {
    return 0.9 / Math.pow(2, this.doc?.lighting.exposure ?? 0);
  }

  private composite(): void {
    const c = this.compositeMaterial.uniforms;
    c.uPreview.value = this.previewRT.texture;
    c.uAccum.value = this.accumA.texture;
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

  private emitStatus(now: number): void {
    if (!this.events.onStatus) return;
    if (now - this.lastStatus < 120 && this.statusMode === 'refine') return;
    this.lastStatus = now;
    this.events.onStatus({
      mode: this.statusMode,
      samples: this.samples,
      target: this.settings.targetSamples,
      previewScale: this.previewScale,
      fps: 1000 / this.frameEma,
      tier: this.tier,
    });
  }

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
