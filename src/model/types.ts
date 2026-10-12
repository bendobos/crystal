/**
 * The scene document: everything needed to reproduce a render. Pure data, no three.js,
 * so it can be serialized into projects and share links.
 */

export type Vec3 = [number, number, number];

/** Number of samples in the dense "fine shape" fields along the curve. */
export const DETAIL_SIZE = 256;

export interface DetailFields {
  /** Offset of the tube centre in the local frame (normal, binormal, tangent), 3 per sample. */
  offset: Float32Array;
  /** Log-scale radius factor per sample (0 = unchanged). */
  radius: Float32Array;
  /** Additional twist per sample in radians. */
  twist: Float32Array;
}

export interface ShapeDoc {
  points: Vec3[];
  closed: boolean;
  /** Base tube radius in world units. */
  radius: number;
  /** 0 = round, approaching 1 = flat band. */
  flatness: number;
  /** 0 = ellipse, 1 = rounded rectangle (superellipse exponent). */
  roundness: number;
  /** Total twist of the profile along the curve in turns (closed curves snap to half turns). */
  twist: number;
  strands: number;
  /** Distance of the strands from the curve, in multiples of the radius. */
  strandSpread: number;
  /** Turns the strands wind around each other (closed curves snap to 1/strands). */
  strandTwist: number;
  detail: DetailFields | null;
  /** Animation offsets (not edited directly): profile rotation and strand rotation in radians. */
  phase?: number;
  strandPhase?: number;
}

export interface GlassDoc {
  /** Index of refraction at 587.6 nm. */
  ior: number;
  /** 0 = no dispersion, 1 = strongly exaggerated rainbow. */
  dispersion: number;
  /** Tint colour (hex sRGB) and density; thicker glass absorbs more. */
  tint: string;
  tintDensity: number;
  /** Thin-film iridescence strength 0..1. */
  iridescence: number;
  /** Film thickness range in nanometres. */
  iridescenceThickness: [number, number];
}

export type LightShape = 'rect' | 'strip' | 'disc' | 'ring';

export interface LightDoc {
  id: string;
  shape: LightShape;
  /** Placement on a sphere around the object, in degrees. */
  azimuth: number;
  elevation: number;
  distance: number;
  /** Size in world units. */
  width: number;
  height: number;
  /** Roll of the light around its own axis in degrees. */
  rotation: number;
  color: string;
  /** Radiance multiplier. 0 turns the light into a black card (flag). */
  intensity: number;
  /** Edge softness 0..1. */
  softness: number;
  visibleToCamera: boolean;
}

export interface DomeDoc {
  top: string;
  horizon: string;
  bottom: string;
  intensity: number;
}

export interface LightingDoc {
  studioId: string;
  exposure: number;
  /** Rotation of the whole light rig around the vertical axis in degrees. */
  rotation: number;
  dome: DomeDoc;
  lights: LightDoc[];
}

export interface GradientStop {
  color: string;
  pos: number;
}

export interface BackgroundDoc {
  type: 'solid' | 'linear' | 'radial';
  stops: GradientStop[];
  /** Linear gradient angle in degrees (0 = left to right, 90 = bottom to top). */
  angle: number;
  /** Radial gradient centre in frame UV and radius relative to frame height. */
  center: [number, number];
  radius: number;
  /** How strongly the glass refracts the background instead of the studio dome. */
  glassInfluence: number;
}

export interface CameraDoc {
  position: Vec3;
  target: Vec3;
  /** Focal length in mm (full-frame equivalent, 24 mm sensor height). */
  focalLength: number;
}

export type ToneMapper = 'agx' | 'neutral';

export interface EffectsDoc {
  toneMapping: ToneMapper;
  contrast: number;
  saturation: number;
  /** f-number style aperture; 0 = everything sharp. */
  aperture: number;
  /** Focus distance in world units. */
  focusDistance: number;
  bloom: number;
  bloomRadius: number;
  vignette: number;
  grain: number;
}

export interface ExportTargetDoc {
  id: string;
  formatId: string;
  width: number;
  height: number;
  /** Own framing for this format; null = follows the main camera. */
  camera: CameraDoc | null;
  enabled: boolean;
}

export interface SceneDoc {
  version: 1;
  name: string;
  shape: ShapeDoc;
  glass: GlassDoc;
  lighting: LightingDoc;
  background: BackgroundDoc;
  camera: CameraDoc;
  effects: EffectsDoc;
  exportTargets: ExportTargetDoc[];
  activeTargetId: string;
}
