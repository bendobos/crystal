import { useEffect, useRef } from 'react';
import { useExport } from '../export/exportStore';
import { deliverFiles } from '../export/encode';
import { useStore } from '../model/store';
import { Button } from './controls';
import { IconDownload, IconShare } from './icons';

function formatEta(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return 'Restzeit wird geschätzt…';
  if (s < 60) return `noch ca. ${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  return `noch ca. ${m} min ${Math.round(s - m * 60)} s`;
}

export function ExportDialog() {
  const job = useExport((s) => s.job);
  const set = useExport((s) => s.set);
  const name = useStore((s) => s.doc.name);
  const delivered = useRef<unknown>(null);
  const coarse = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;

  // desktop: download right away; touch devices need a fresh tap for the share sheet
  useEffect(() => {
    if (job?.files && !coarse && delivered.current !== job.files) {
      delivered.current = job.files;
      void deliverFiles(job.files, `${(name || 'crystal').replace(/\s+/g, '-')}-wallpaper.zip`);
    }
  }, [job?.files, coarse, name]);

  if (!job) return null;
  const pct = Math.round(job.progress.fraction * 100);
  const done = !!job.files;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-live="polite">
        <h2>{job.error ? 'Export fehlgeschlagen' : done ? 'Export fertig' : job.kind === 'video' ? 'Video wird gerendert' : 'Wallpaper wird gerendert'}</h2>
        {job.error ? (
          <p className="error-text">{job.error}</p>
        ) : (
          <>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-meta">
              <span>{job.progress.label}</span>
              <span>{done ? `${job.files!.length} Datei${job.files!.length > 1 ? 'en' : ''}` : `${pct} % · ${formatEta(job.progress.eta)}`}</span>
            </div>
            {!done && <p className="hint">Bitte die App geöffnet lassen. Im Hintergrund drosselt der Browser das Rendern.</p>}
          </>
        )}
        <div className="modal-actions">
          {done && (
            <Button variant="primary" onClick={() => void deliverFiles(job.files!, `${(name || 'crystal').replace(/\s+/g, '-')}-wallpaper.zip`)}>
              {coarse ? <IconShare /> : <IconDownload />} {coarse ? 'Sichern / Teilen' : 'Erneut herunterladen'}
            </Button>
          )}
          {!done && !job.error ? (
            <Button variant="danger" onClick={() => job.abort.abort()}>
              Abbrechen
            </Button>
          ) : (
            <Button onClick={() => set({ job: null })}>Schließen</Button>
          )}
        </div>
      </div>
    </div>
  );
}
