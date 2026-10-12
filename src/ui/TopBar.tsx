import { useStore } from '../model/store';
import { Button } from './controls';
import { IconDownload, IconFolder, IconRedo, IconShare, IconUndo } from './icons';

export function TopBar({ onProjects, onShare, compact }: { onProjects: () => void; onShare: () => void; compact: boolean }) {
  const name = useStore((s) => s.doc.name);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setDoc = useStore((s) => s.setDoc);
  const set = useStore((s) => s.set);
  return (
    <header className="top-bar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        {!compact && <span className="brand-name">Crystal</span>}
        <input
          className="project-name"
          value={name}
          aria-label="Projektname"
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }), { coalesce: 'name' })}
        />
      </div>
      <div className="top-actions">
        <Button variant="ghost" title="Rückgängig (⌘Z)" disabled={!canUndo} onClick={undo}>
          <IconUndo />
        </Button>
        <Button variant="ghost" title="Wiederholen (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
          <IconRedo />
        </Button>
        <Button variant="ghost" title="Projekte" onClick={onProjects}>
          <IconFolder />
          {!compact && <span>Projekte</span>}
        </Button>
        <Button variant="ghost" title="Link teilen" onClick={onShare}>
          <IconShare />
          {!compact && <span>Teilen</span>}
        </Button>
        <Button variant="primary" title="Exportieren" onClick={() => set({ panel: 'export', panelOpen: true })}>
          <IconDownload />
          {!compact && <span>Export</span>}
        </Button>
      </div>
    </header>
  );
}
