import { useStore } from '../model/store';
import { getEngine } from '../render/engineRef';
import { formatById } from '../export/formats';
import { useExport } from '../export/exportStore';

/** Dims everything outside the active export frame and previews device chrome on top of it. */
export function FrameOverlay() {
  useStore((s) => s.viewVersion);
  const doc = useStore((s) => s.doc);
  const deviceOverlay = useExport((s) => s.deviceOverlay);
  const e = getEngine();
  if (!e) return null;
  const f = e.frameRect();
  const target = doc.exportTargets.find((t) => t.id === doc.activeTargetId) ?? doc.exportTargets[0];
  const fmt = formatById(target.formatId);
  const portrait = target.height > target.width;
  const k = f.h / 1000; // overlay sizes relative to frame height
  return (
    <div className="frame-overlay" aria-hidden>
      <div className="frame-mask" style={{ left: f.x, top: f.y, width: f.w, height: f.h }} />
      <div className="frame-label" style={{ left: f.x, top: f.y + f.h + 6 }}>
        {fmt?.name ?? 'Eigenes Format'} · {target.width}×{target.height}
        {target.camera ? ' · eigener Ausschnitt' : ''}
      </div>
      {deviceOverlay && portrait && (
        <div className="device device-phone" style={{ left: f.x, top: f.y, width: f.w, height: f.h, ['--k' as string]: k }}>
          <div className="island" />
          <div className="lock-date">Montag, 12. Oktober</div>
          <div className="lock-time">9:41</div>
          <div className="home-bar" />
        </div>
      )}
      {deviceOverlay && !portrait && (
        <div className="device device-desktop" style={{ left: f.x, top: f.y, width: f.w, height: f.h, ['--k' as string]: k }}>
          <div className="menubar">
            <span></span>
            <span className="menubar-app">Finder</span>
            <span>Ablage</span>
            <span>Bearbeiten</span>
            <span className="menubar-right">Mo 12. Okt. 9:41</span>
          </div>
          <div className="dock">
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
