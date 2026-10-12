import type { SceneDoc, ShapeDoc } from './types';
import { useStore } from './store';
import { randomizeShape, shapePreset } from './presets/shapes';
import { studioPreset } from './presets/studios';
import { fitCamera } from './fit';
import { getEngine } from '../render/engineRef';

export function activeTarget(d: SceneDoc) {
  return d.exportTargets.find((t) => t.id === d.activeTargetId) ?? d.exportTargets[0];
}

function withFittedCamera(d: SceneDoc, shape: ShapeDoc): SceneDoc {
  const t = activeTarget(d);
  const aspect = t ? t.width / t.height : 1;
  return {
    ...d,
    shape,
    camera: fitCamera(d.camera, shape, aspect),
    exportTargets: d.exportTargets.map((x) => (x.camera ? { ...x, camera: fitCamera(x.camera, shape, x.width / x.height) } : x)),
  };
}

export function applyShapePreset(id: string): void {
  useStore.getState().setDoc((d) => withFittedCamera(d, shapePreset(id)));
}

export function randomize(): void {
  const seed = Math.floor(Math.random() * 2 ** 31);
  useStore.getState().setDoc((d) => withFittedCamera(d, randomizeShape(d.shape, seed)));
}

export function fitView(): void {
  useStore.getState().setDoc((d) => {
    const t = activeTarget(d);
    if (t?.camera) {
      return { ...d, exportTargets: d.exportTargets.map((x) => (x.id === t.id ? { ...x, camera: fitCamera(x.camera!, d.shape, x.width / x.height) } : x)) };
    }
    return { ...d, camera: fitCamera(d.camera, d.shape, t ? t.width / t.height : 1) };
  });
  getEngine()?.invalidate();
}

export function applyStudio(id: string, withBackground = true): void {
  const s = studioPreset(id);
  useStore.getState().setDoc((d) => ({
    ...d,
    lighting: { studioId: id, ...structuredClone(s.lighting), rotation: d.lighting.rotation },
    background: withBackground ? structuredClone(s.background) : d.background,
  }));
}

export { fitCamera };
