import { useStore } from '../model/store';

export function StatusPill() {
  const status = useStore((s) => s.status);
  if (!status) return null;
  const pct = Math.min(1, status.progress);
  const label =
    status.mode === 'preview'
      ? 'Live-Vorschau'
      : status.mode === 'sharp'
        ? 'Wird geschärft'
        : status.mode === 'refine'
          ? `Verfeinert · ${Math.round(pct * 100)} %`
          : 'Fertig verfeinert';
  return (
    <div className={`status-pill mode-${status.mode}`} title={`${Math.round(status.fps)} fps · Vorschau ×${status.previewScale.toFixed(2)} · ${status.samples} Samples · Stufe ${status.tier}`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="5.5" className="ring-bg" />
        <circle cx="7" cy="7" r="5.5" className="ring" strokeDasharray={`${pct * 34.6} 34.6`} transform="rotate(-90 7 7)" />
      </svg>
      {label}
    </div>
  );
}
