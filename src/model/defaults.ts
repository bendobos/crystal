import type { CameraDoc, EffectsDoc, ExportTargetDoc, GlassDoc, SceneDoc } from './types';
import { shapePreset } from './presets/shapes';
import { studioPreset } from './presets/studios';
import { formatById } from '../export/formats';
import { fitCamera } from './fit';

export const DEFAULT_GLASS: GlassDoc = {
  ior: 1.5,
  dispersion: 0.35,
  tint: '#ffffff',
  tintDensity: 0,
  iridescence: 0,
  iridescenceThickness: [250, 650],
};

export const DEFAULT_EFFECTS: EffectsDoc = {
  toneMapping: 'agx',
  contrast: 0.15,
  saturation: 1.05,
  aperture: 0,
  focusDistance: 12,
  bloom: 0.08,
  bloomRadius: 1,
  vignette: 0.12,
  grain: 0.08,
};

export const DEFAULT_CAMERA: CameraDoc = {
  position: [0, 0.4, 12],
  target: [0, 0, 0],
  focalLength: 70,
};

export function exportTarget(formatId: string, id = formatId): ExportTargetDoc {
  const f = formatById(formatId) ?? { width: 1920, height: 1080 };
  return { id, formatId, width: f.width, height: f.height, camera: null, enabled: true };
}

export function createDefaultDoc(): SceneDoc {
  const studio = studioPreset('neon');
  const shape = shapePreset('infinity');
  const targets = [exportTarget('iphone-pro'), exportTarget('mac-5k')];
  // the desktop format gets its own framing so the object fills the landscape frame too
  targets[1].camera = fitCamera(structuredClone(DEFAULT_CAMERA), shape, targets[1].width / targets[1].height, 1.15);
  return {
    version: 1,
    name: 'Unbenannt',
    shape,
    glass: { ...DEFAULT_GLASS },
    lighting: { studioId: studio.id, ...structuredClone(studio.lighting) },
    background: structuredClone(studio.background),
    camera: fitCamera(structuredClone(DEFAULT_CAMERA), shape, targets[0].width / targets[0].height, 1.02),
    effects: { ...DEFAULT_EFFECTS },
    exportTargets: targets,
    activeTargetId: targets[0].id,
  };
}
