import type { CameraDoc, SceneDoc } from '../model/types';

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
