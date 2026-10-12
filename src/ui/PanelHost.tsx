import { useStore, type PanelId } from '../model/store';
import { FormPanel } from './panels/FormPanel';
import { GlassPanel } from './panels/GlassPanel';
import { LightPanel } from './panels/LightPanel';
import { BackgroundPanel } from './panels/BackgroundPanel';
import { CameraPanel } from './panels/CameraPanel';
import { ExportPanel } from './panels/ExportPanel';
import { IconClose } from './icons';

export const PANELS: { id: PanelId; label: string }[] = [
  { id: 'form', label: 'Form' },
  { id: 'glass', label: 'Glas' },
  { id: 'light', label: 'Licht' },
  { id: 'background', label: 'Hintergrund' },
  { id: 'camera', label: 'Kamera' },
  { id: 'export', label: 'Export' },
];

function PanelBody({ id }: { id: PanelId }) {
  switch (id) {
    case 'form':
      return <FormPanel />;
    case 'glass':
      return <GlassPanel />;
    case 'light':
      return <LightPanel />;
    case 'background':
      return <BackgroundPanel />;
    case 'camera':
      return <CameraPanel />;
    case 'export':
      return <ExportPanel />;
  }
}

export function PanelTabs() {
  const panel = useStore((s) => s.panel);
  const open = useStore((s) => s.panelOpen);
  const set = useStore((s) => s.set);
  return (
    <div className="panel-tabs" role="tablist">
      {PANELS.map((p) => (
        <button
          key={p.id}
          role="tab"
          type="button"
          aria-selected={open && panel === p.id}
          className={open && panel === p.id ? 'is-active' : ''}
          onClick={() => set(open && panel === p.id ? { panelOpen: false } : { panel: p.id, panelOpen: true })}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function SidePanel() {
  const panel = useStore((s) => s.panel);
  const open = useStore((s) => s.panelOpen);
  const set = useStore((s) => s.set);
  return (
    <aside className={`side-panel ${open ? 'is-open' : ''}`}>
      <div className="side-panel-head">
        <PanelTabs />
      </div>
      {open && (
        <div className="panel-scroll" key={panel}>
          <PanelBody id={panel} />
        </div>
      )}
      {open && (
        <button type="button" className="panel-collapse" title="Bedienfeld schließen" onClick={() => set({ panelOpen: false })}>
          <IconClose />
        </button>
      )}
    </aside>
  );
}

export function BottomSheet({ height }: { height: number }) {
  const panel = useStore((s) => s.panel);
  const open = useStore((s) => s.panelOpen);
  return (
    <div className={`bottom-sheet ${open ? 'is-open' : ''}`} style={{ height }}>
      <PanelTabs />
      {open && (
        <div className="panel-scroll" key={panel}>
          <PanelBody id={panel} />
        </div>
      )}
    </div>
  );
}
