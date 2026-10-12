import { useEffect, useState } from 'react';
import { deleteProject, listProjects, loadProject, saveProject, type ProjectMeta } from '../model/projects';
import { useStore } from '../model/store';
import { createDefaultDoc } from '../model/defaults';
import { getEngine } from '../render/engineRef';
import { Button } from './controls';
import { IconClose, IconPlus, IconTrash } from './icons';
import { uid } from '../util/random';

let currentProjectId: string | null = null;

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ProjectMeta[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const refresh = () => listProjects().then(setItems);
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    const urls: Record<string, string> = {};
    for (const p of items ?? []) if (p.thumb) urls[p.id] = URL.createObjectURL(p.thumb);
    setThumbs(urls);
    return () => Object.values(urls).forEach((u) => URL.revokeObjectURL(u));
  }, [items]);

  const save = async () => {
    const doc = useStore.getState().doc;
    const thumb = (await getEngine()?.snapshot(360)) ?? null;
    currentProjectId ??= uid('p');
    await saveProject(currentProjectId, doc, thumb);
    useStore.getState().set({ toast: 'Projekt gespeichert' });
    void refresh();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide" role="dialog">
        <div className="modal-head">
          <h2>Projekte</h2>
          <Button variant="ghost" title="Schließen" onClick={onClose}>
            <IconClose />
          </Button>
        </div>
        <div className="modal-actions start">
          <Button variant="primary" onClick={save}>
            Aktuelles Projekt speichern
          </Button>
          <Button
            onClick={() => {
              currentProjectId = null;
              useStore.getState().replaceDoc(createDefaultDoc());
              onClose();
            }}
          >
            <IconPlus /> Neues Projekt
          </Button>
        </div>
        <p className="hint">Projekte werden nur in diesem Browser gespeichert. Zum Weitergeben „Teilen“ verwenden.</p>
        <div className="project-grid">
          {items === null && <p className="muted">Lädt…</p>}
          {items?.length === 0 && <p className="muted">Noch keine gespeicherten Projekte.</p>}
          {items?.map((p) => (
            <div key={p.id} className="project-card">
              <button
                type="button"
                className="project-open"
                onClick={async () => {
                  const doc = await loadProject(p.id);
                  if (doc) {
                    currentProjectId = p.id;
                    useStore.getState().replaceDoc(doc);
                    onClose();
                  }
                }}
              >
                {thumbs[p.id] ? <img src={thumbs[p.id]} alt="" /> : <div className="thumb-empty" />}
                <span className="project-title">{p.name}</span>
                <span className="muted">{new Date(p.updated).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </button>
              <Button
                variant="ghost"
                title="Projekt löschen"
                onClick={async () => {
                  if (!confirm(`„${p.name}“ löschen?`)) return;
                  await deleteProject(p.id);
                  if (currentProjectId === p.id) currentProjectId = null;
                  void refresh();
                }}
              >
                <IconTrash />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
