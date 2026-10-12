import type { BackgroundDoc, LightDoc, LightingDoc } from '../types';

export interface StudioPreset {
  id: string;
  name: string;
  lighting: Omit<LightingDoc, 'studioId'>;
  background: BackgroundDoc;
}

let n = 0;
function light(p: Partial<LightDoc>): LightDoc {
  return {
    id: `l${++n}`,
    shape: 'rect',
    azimuth: 0,
    elevation: 0,
    distance: 8,
    width: 2,
    height: 6,
    rotation: 0,
    color: '#ffffff',
    intensity: 4,
    softness: 0.3,
    visibleToCamera: false,
    ...p,
  };
}

function solid(color: string, glassInfluence = 1): BackgroundDoc {
  return { type: 'solid', stops: [{ color, pos: 0 }, { color, pos: 1 }], angle: 90, center: [0.5, 0.5], radius: 0.9, glassInfluence };
}

export const STUDIO_PRESETS: StudioPreset[] = [
  {
    id: 'neon',
    name: 'Neon Violett',
    background: solid('#000000'),
    lighting: {
      exposure: 0,
      rotation: 0,
      dome: { top: '#1d1240', horizon: '#0a0620', bottom: '#000000', intensity: 1.2 },
      lights: [
        light({ shape: 'strip', azimuth: -60, elevation: 20, width: 5, height: 12, color: '#5a3cff', intensity: 3, softness: 0.9 }),
        light({ shape: 'strip', azimuth: 65, elevation: 5, width: 3, height: 11, color: '#ff3fb0', intensity: 3.5, softness: 0.8 }),
        light({ shape: 'rect', azimuth: 0, elevation: 70, width: 8, height: 4, color: '#a68cff', intensity: 1.5, softness: 0.9 }),
        light({ shape: 'strip', azimuth: 160, elevation: 20, width: 0.5, height: 9, color: '#ffffff', intensity: 4, softness: 0.4 }),
        light({ shape: 'strip', azimuth: -140, elevation: -10, width: 0.6, height: 8, color: '#62d2ff', intensity: 3, softness: 0.5 }),
        light({ shape: 'rect', azimuth: -20, elevation: 35, width: 0.25, height: 6, rotation: -30, color: '#ffffff', intensity: 6, softness: 0.3 }),
        light({ shape: 'strip', azimuth: -165, elevation: 30, width: 2.5, height: 10, rotation: 25, color: '#7a4dff', intensity: 2.5, softness: 0.8 }),
        light({ shape: 'strip', azimuth: 130, elevation: -25, width: 2, height: 9, rotation: -20, color: '#3a6bff', intensity: 2.5, softness: 0.8 }),
        light({ shape: 'strip', azimuth: 100, elevation: 40, width: 0.4, height: 8, rotation: 40, color: '#ff7ad9', intensity: 5, softness: 0.4 }),
      ],
    },
  },
  {
    id: 'black',
    name: 'Schwarzes Studio',
    background: solid('#000000'),
    lighting: {
      exposure: 0,
      rotation: 0,
      dome: { top: '#0a0a0c', horizon: '#020203', bottom: '#000000', intensity: 1 },
      lights: [
        light({ shape: 'strip', azimuth: -40, elevation: 40, width: 1.6, height: 12, intensity: 9, softness: 0.25, rotation: 20 }),
        light({ shape: 'strip', azimuth: 80, elevation: 8, width: 1.0, height: 11, intensity: 7, softness: 0.3 }),
        light({ shape: 'rect', azimuth: 180, elevation: 25, width: 8, height: 1.2, intensity: 6, softness: 0.3 }),
        light({ shape: 'rect', azimuth: 0, elevation: -65, width: 7, height: 3, color: '#8f9cff', intensity: 1.2, softness: 0.6 }),
        light({ shape: 'strip', azimuth: 125, elevation: -15, width: 0.45, height: 7, color: '#ff6ad5', intensity: 6, softness: 0.3 }),
        light({ shape: 'strip', azimuth: -120, elevation: -5, width: 0.45, height: 7, color: '#5fc8ff', intensity: 6, softness: 0.3 }),
      ],
    },
  },
  {
    id: 'white',
    name: 'Weißes Studio',
    background: solid('#f1f1f4', 1),
    lighting: {
      exposure: 0,
      rotation: 0,
      // dark, slightly blue studio around the white backdrop: gives the glass its contours
      dome: { top: '#4f5788', horizon: '#181c48', bottom: '#06071a', intensity: 1 },
      lights: [
        light({ shape: 'rect', azimuth: 10, elevation: 70, width: 5, height: 2, intensity: 4, softness: 0.7 }),
        light({ shape: 'strip', azimuth: -70, elevation: 10, width: 0.7, height: 10, intensity: 7, softness: 0.3 }),
        light({ shape: 'strip', azimuth: 75, elevation: 5, width: 0.6, height: 10, intensity: 7, softness: 0.3 }),
        light({ shape: 'rect', azimuth: -130, elevation: 0, width: 6, height: 14, color: '#000000', intensity: 0, softness: 0.4 }),
        light({ shape: 'rect', azimuth: 130, elevation: -5, width: 6, height: 14, color: '#000000', intensity: 0, softness: 0.4 }),
        light({ shape: 'strip', azimuth: -100, elevation: 20, width: 0.5, height: 7, color: '#4a5cff', intensity: 4, softness: 0.3 }),
        light({ shape: 'strip', azimuth: 105, elevation: -20, width: 0.5, height: 6, color: '#ff9a6a', intensity: 3, softness: 0.3 }),
      ],
    },
  },
  {
    id: 'prism',
    name: 'Prisma',
    background: solid('#0d0d12'),
    lighting: {
      exposure: 0.1,
      rotation: 0,
      dome: { top: '#16161c', horizon: '#060608', bottom: '#000000', intensity: 1 },
      lights: Array.from({ length: 9 }, (_, i) =>
        light({
          shape: 'strip',
          azimuth: -160 + i * 40,
          elevation: i % 2 ? 25 : -15,
          width: 0.35,
          height: 12,
          rotation: i * 23,
          intensity: 12,
          softness: 0.12,
        }),
      ),
    },
  },
  {
    id: 'sunset',
    name: 'Abendrot',
    background: {
      type: 'radial',
      stops: [
        { color: '#ffd2a1', pos: 0 },
        { color: '#e8607c', pos: 0.55 },
        { color: '#2d1745', pos: 1 },
      ],
      angle: 90,
      center: [0.5, 0.42],
      radius: 0.95,
      glassInfluence: 0.9,
    },
    lighting: {
      exposure: 0,
      rotation: 0,
      dome: { top: '#ffb38a', horizon: '#c2456a', bottom: '#1c0d2b', intensity: 1.5 },
      lights: [
        light({ shape: 'strip', azimuth: -60, elevation: 20, width: 1.4, height: 10, color: '#ffe0b8', intensity: 7, softness: 0.35 }),
        light({ shape: 'strip', azimuth: 75, elevation: 0, width: 1.0, height: 9, color: '#ff7aa8', intensity: 7, softness: 0.3 }),
        light({ shape: 'rect', azimuth: 0, elevation: 70, width: 7, height: 4, color: '#fff1e0', intensity: 4, softness: 0.6 }),
        light({ shape: 'rect', azimuth: 170, elevation: 10, width: 5, height: 8, color: '#000000', intensity: 0, softness: 0.5 }),
      ],
    },
  },
  {
    id: 'ice',
    name: 'Eis',
    background: {
      type: 'linear',
      stops: [
        { color: '#a9cdee', pos: 0 },
        { color: '#eef6ff', pos: 1 },
      ],
      angle: 90,
      center: [0.5, 0.5],
      radius: 0.9,
      glassInfluence: 1,
    },
    lighting: {
      exposure: 0,
      rotation: 0,
      dome: { top: '#6f8fb8', horizon: '#20385c', bottom: '#07101e', intensity: 1.2 },
      lights: [
        light({ shape: 'rect', azimuth: -20, elevation: 65, width: 8, height: 4, intensity: 6, softness: 0.6 }),
        light({ shape: 'strip', azimuth: -80, elevation: 5, width: 1.1, height: 10, color: '#dff0ff', intensity: 8, softness: 0.3 }),
        light({ shape: 'strip', azimuth: 85, elevation: 10, width: 0.8, height: 10, color: '#cfe6ff', intensity: 8, softness: 0.3 }),
        light({ shape: 'rect', azimuth: 150, elevation: 0, width: 3, height: 10, color: '#0e1a2a', intensity: 0, softness: 0.5 }),
        light({ shape: 'strip', azimuth: -150, elevation: -20, width: 0.5, height: 6, color: '#6aa8ff', intensity: 5, softness: 0.3 }),
      ],
    },
  },
];

export function studioPreset(id: string): StudioPreset {
  return STUDIO_PRESETS.find((s) => s.id === id) ?? STUDIO_PRESETS[0];
}

export function newLight(p: Partial<LightDoc> = {}): LightDoc {
  return light({ id: `l${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, ...p });
}
