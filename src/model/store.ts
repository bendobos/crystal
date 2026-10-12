import { create } from 'zustand';
import type { SceneDoc } from './types';
import { createDefaultDoc } from './defaults';
import type { RenderStatus } from '../render/Engine';

export type Tool = 'camera' | 'points' | 'brush' | 'draw' | 'light';
export type BrushMode = 'pull' | 'inflate' | 'pinch' | 'twist' | 'smooth';
export type PanelId = 'form' | 'glass' | 'light' | 'background' | 'camera' | 'export';

export interface BrushSettings {
  mode: BrushMode;
  /** Brush radius in world units. */
  size: number;
  strength: number;
}

interface HistoryOptions {
  /** false: don't record; string: merge with the previous change of the same key. */
  history?: boolean;
  coalesce?: string;
}

interface AppState {
  doc: SceneDoc;
  past: SceneDoc[];
  future: SceneDoc[];
  tool: Tool;
  brush: BrushSettings;
  panel: PanelId;
  panelOpen: boolean;
  selectedLight: string | null;
  selectedPoint: number | null;
  status: RenderStatus | null;
  /** Bumped whenever the engine's camera or frame changes, for overlays. */
  viewVersion: number;
  exporting: boolean;
  toast: string | null;

  setDoc(fn: (d: SceneDoc) => SceneDoc, opts?: HistoryOptions): void;
  replaceDoc(doc: SceneDoc): void;
  begin(): void;
  end(): void;
  undo(): void;
  redo(): void;
  set(p: Partial<Pick<AppState, 'tool' | 'brush' | 'panel' | 'panelOpen' | 'selectedLight' | 'selectedPoint' | 'status' | 'exporting' | 'toast'>>): void;
  bumpView(): void;
}

const MAX_HISTORY = 80;
let lastCoalesce: { key: string; time: number } | null = null;
let txSnapshot: SceneDoc | null = null;

export const useStore = create<AppState>((set, get) => ({
  doc: createDefaultDoc(),
  past: [],
  future: [],
  tool: 'camera',
  brush: { mode: 'pull', size: 0.9, strength: 0.6 },
  panel: 'form',
  panelOpen: true,
  selectedLight: null,
  selectedPoint: null,
  status: null,
  viewVersion: 0,
  exporting: false,
  toast: null,

  setDoc(fn, opts = {}) {
    const prev = get().doc;
    const next = fn(prev);
    if (next === prev) return;
    const record = opts.history !== false && txSnapshot === null;
    if (!record) {
      set({ doc: next });
      return;
    }
    const now = performance.now();
    if (opts.coalesce && lastCoalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.time < 1200) {
      lastCoalesce.time = now;
      set({ doc: next, future: [] });
      return;
    }
    lastCoalesce = opts.coalesce ? { key: opts.coalesce, time: now } : null;
    set({ doc: next, past: [...get().past.slice(-MAX_HISTORY + 1), prev], future: [] });
  },

  replaceDoc(doc) {
    lastCoalesce = null;
    set({ doc, past: [...get().past.slice(-MAX_HISTORY + 1), get().doc], future: [] });
  },

  begin() {
    if (txSnapshot === null) txSnapshot = get().doc;
  },

  end() {
    const snap = txSnapshot;
    txSnapshot = null;
    lastCoalesce = null;
    if (snap && snap !== get().doc) set({ past: [...get().past.slice(-MAX_HISTORY + 1), snap], future: [] });
  },

  undo() {
    const { past, doc, future } = get();
    if (!past.length) return;
    lastCoalesce = null;
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future] });
  },

  redo() {
    const { past, doc, future } = get();
    if (!future.length) return;
    lastCoalesce = null;
    set({ doc: future[0], past: [...past, doc], future: future.slice(1) });
  },

  set(p) {
    set(p);
  },

  bumpView() {
    set({ viewVersion: get().viewVersion + 1 });
  },
}));

/** Convenience updater for nested doc sections. */
export function updateDoc<K extends keyof SceneDoc>(key: K, patch: Partial<SceneDoc[K]>, coalesce?: string): void {
  useStore.getState().setDoc((d) => ({ ...d, [key]: { ...(d[key] as object), ...patch } }), { coalesce: coalesce ?? `${String(key)}:${Object.keys(patch).join(',')}` });
}
