import { openDB, type IDBPDatabase } from 'idb';
import type { SceneDoc } from './types';
import { fromJSON, toJSON } from './serialize';

export interface ProjectMeta {
  id: string;
  name: string;
  updated: number;
  thumb: Blob | null;
}

interface ProjectRecord extends ProjectMeta {
  doc: object;
}

const DB_NAME = 'crystal';
const AUTOSAVE = '__autosave__';
let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore('projects', { keyPath: 'id' });
    },
  });
  return dbPromise;
}

export async function listProjects(): Promise<ProjectMeta[]> {
  try {
    const all = (await (await db()).getAll('projects')) as ProjectRecord[];
    return all
      .filter((p) => p.id !== AUTOSAVE)
      .map(({ id, name, updated, thumb }) => ({ id, name, updated, thumb }))
      .sort((a, b) => b.updated - a.updated);
  } catch {
    return [];
  }
}

export async function saveProject(id: string, doc: SceneDoc, thumb: Blob | null): Promise<void> {
  const rec: ProjectRecord = { id, name: doc.name || 'Unbenannt', updated: Date.now(), thumb, doc: toJSON(doc) };
  await (await db()).put('projects', rec);
}

export async function loadProject(id: string): Promise<SceneDoc | null> {
  const rec = (await (await db()).get('projects', id)) as ProjectRecord | undefined;
  return rec ? fromJSON(rec.doc) : null;
}

export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete('projects', id);
}

export async function autosave(doc: SceneDoc): Promise<void> {
  try {
    await saveProject(AUTOSAVE, doc, null);
  } catch {
    // storage may be unavailable (private browsing); autosave is best-effort
  }
}

export async function loadAutosave(): Promise<SceneDoc | null> {
  try {
    return await loadProject(AUTOSAVE);
  } catch {
    return null;
  }
}
