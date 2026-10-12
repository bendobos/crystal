import type { Engine } from './Engine';

/** The single engine instance, for UI code that needs to pick, project or export. */
let current: Engine | null = null;
const listeners = new Set<(e: Engine | null) => void>();

export function setEngine(e: Engine | null): void {
  current = e;
  for (const l of listeners) l(e);
}

export function getEngine(): Engine | null {
  return current;
}

export function onEngine(fn: (e: Engine | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
