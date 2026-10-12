import { useEffect, useRef, useState } from 'react';
import { Viewport } from './Viewport';
import { useStore } from '../model/store';
import { TopBar } from './TopBar';
import { Toolbar, ToolHint, TOOLS } from './Toolbar';
import { BottomSheet, SidePanel } from './PanelHost';
import { FrameOverlay } from './FrameOverlay';
import { ExportDialog } from './ExportDialog';
import { ProjectsDialog } from './ProjectsDialog';
import { Toast } from './Toast';
import { StatusPill } from './StatusPill';
import { Interaction, deleteSelectedPoint } from '../interaction/Interaction';
import { frameAreaFor, useLayout } from './layout';
import { getEngine, onEngine } from '../render/engineRef';
import { decodeShare, encodeShare } from '../model/serialize';
import { autosave, loadAutosave } from '../model/projects';

export function App() {
  const layout = useLayout();
  const panelOpen = useStore((s) => s.panelOpen);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetHeight = layout.mobile ? (panelOpen ? Math.round(layout.height * 0.46) : 52) : 0;
  const toolbarH = layout.mobile ? 64 : 0;

  // keep the format frame inside the area not covered by UI
  useEffect(() => {
    const apply = () => getEngine()?.setFrameArea(frameAreaFor(layout, panelOpen, sheetHeight + toolbarH));
    apply();
    return onEngine(apply);
  }, [layout, panelOpen, sheetHeight, toolbarH]);

  // initial document: share link > autosave > default
  useEffect(() => {
    const hash = location.hash.match(/[#&]s=([^&]+)/);
    if (hash) {
      try {
        useStore.getState().replaceDoc(decodeShare(hash[1]));
        useStore.setState({ past: [] });
        history.replaceState(null, '', location.pathname + location.search);
        useStore.getState().set({ toast: 'Geteilte Szene geladen' });
        return;
      } catch {
        useStore.getState().set({ toast: 'Link konnte nicht gelesen werden' });
      }
    }
    void loadAutosave().then((doc) => {
      if (doc && useStore.getState().past.length === 0) {
        useStore.setState({ doc });
      }
    });
  }, []);

  // autosave, debounced
  useEffect(() => {
    let t = 0;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.doc === prev.doc) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => void autosave(useStore.getState().doc), 1500);
    });
    return () => {
      unsub();
      window.clearTimeout(t);
    };
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      const st = useStore.getState();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
      } else if (!mod && (e.key === 'Delete' || e.key === 'Backspace') && st.tool === 'points') {
        deleteSelectedPoint();
      } else if (!mod) {
        const t = TOOLS.find((x) => x.key === e.key);
        if (t) st.set({ tool: t.id });
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const share = async () => {
    const url = `${location.origin}${location.pathname}#s=${encodeShare(useStore.getState().doc)}`;
    const st = useStore.getState();
    try {
      if (layout.mobile && navigator.share) {
        await navigator.share({ title: st.doc.name || 'Crystal', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      st.set({ toast: 'Link kopiert – er enthält die komplette Szene' });
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') {
        window.prompt('Link zum Kopieren:', url);
      }
    }
  };

  return (
    <div className={`app ${layout.mobile ? 'is-mobile' : 'is-desktop'}`} style={{ ['--sheet' as string]: `${sheetHeight}px` }}>
      <div className="stage" ref={hostRef}>
        <Viewport />
        <FrameOverlay />
        <Interaction host={hostRef} />
      </div>
      <TopBar compact={layout.mobile} onProjects={() => setProjectsOpen(true)} onShare={share} />
      {layout.mobile ? (
        <div className="mobile-dock">
          <Toolbar vertical={false} />
          <BottomSheet height={sheetHeight} />
        </div>
      ) : (
        <>
          <Toolbar vertical />
          <SidePanel />
        </>
      )}
      <ToolHint />
      <StatusPill />
      <Toast />
      <ExportDialog />
      {projectsOpen && <ProjectsDialog onClose={() => setProjectsOpen(false)} />}
    </div>
  );
}
