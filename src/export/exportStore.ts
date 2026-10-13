import { create } from 'zustand';
import type { ExportProgress, StillSettings } from './jobs';

export interface ExportJob {
  kind: 'still' | 'video';
  progress: ExportProgress;
  abort: AbortController;
  files: { name: string; blob: Blob }[] | null;
  error: string | null;
}

interface ExportState {
  settings: StillSettings;
  deviceOverlay: boolean;
  job: ExportJob | null;
  set(p: Partial<Omit<ExportState, 'set'>>): void;
}

function defaultSpace(): 'srgb' | 'p3' {
  try {
    return window.matchMedia?.('(color-gamut: p3)').matches ? 'p3' : 'srgb';
  } catch {
    return 'srgb';
  }
}

export const useExport = create<ExportState>((set) => ({
  settings: { quality: 'high', format: 'png', space: defaultSpace(), denoise: false },
  deviceOverlay: true,
  job: null,
  set: (p) => set(p),
}));
