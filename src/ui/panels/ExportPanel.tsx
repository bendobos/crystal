import { useStore } from '../../model/store';
import { FORMATS, formatById } from '../../export/formats';
import { exportTarget } from '../../model/defaults';
import { fitCamera } from '../../model/fit';
import { useExport } from '../../export/exportStore';
import { exportStills, QUALITY_LABEL, QUALITY_SAMPLES, type ExportQuality } from '../../export/jobs';
import { Button, Section, Segmented, Select, Toggle } from '../controls';
import { IconDownload, IconPlus, IconTrash, IconPhone, IconMonitor } from '../icons';
import type { ExportTargetDoc, SceneDoc } from '../../model/types';
import { VideoSection } from './VideoSection';

const FORMAT_OPTIONS = [
  ...FORMATS.map((f) => ({ value: f.id, label: `${f.name} · ${f.width}×${f.height}`, group: f.group })),
  { value: 'custom', label: 'Eigenes Format', group: 'Eigenes' },
];

export function startStillExport(targets: ExportTargetDoc[]): void {
  const doc = useStore.getState().doc;
  const { settings, set } = useExport.getState();
  const abort = new AbortController();
  set({ job: { kind: 'still', progress: { label: 'Vorbereiten…', fraction: 0, eta: null }, abort, files: null, error: null } });
  useStore.getState().set({ exporting: true });
  exportStills(doc, targets, settings, (progress) => {
    const job = useExport.getState().job;
    if (job) useExport.getState().set({ job: { ...job, progress } });
  }, abort.signal)
    .then((files) => {
      const job = useExport.getState().job;
      if (job) useExport.getState().set({ job: { ...job, files, progress: { label: 'Fertig', fraction: 1, eta: null } } });
    })
    .catch((err: Error) => {
      const job = useExport.getState().job;
      if (err.name === 'AbortError') useExport.getState().set({ job: null });
      else if (job) useExport.getState().set({ job: { ...job, error: err.message || String(err) } });
    })
    .finally(() => useStore.getState().set({ exporting: false }));
}

function updateTargets(fn: (targets: ExportTargetDoc[], d: SceneDoc) => ExportTargetDoc[]): void {
  useStore.getState().setDoc((d) => {
    const exportTargets = fn(d.exportTargets, d);
    const activeTargetId = exportTargets.some((t) => t.id === d.activeTargetId) ? d.activeTargetId : exportTargets[0]?.id;
    return { ...d, exportTargets, activeTargetId };
  });
}

export function ExportPanel() {
  const doc = useStore((s) => s.doc);
  const setDoc = useStore((s) => s.setDoc);
  const settings = useExport((s) => s.settings);
  const deviceOverlay = useExport((s) => s.deviceOverlay);
  const setExport = useExport((s) => s.set);
  const exporting = useStore((s) => s.exporting);
  const active = doc.exportTargets.find((t) => t.id === doc.activeTargetId) ?? doc.exportTargets[0];
  const enabled = doc.exportTargets.filter((t) => t.enabled);
  const megapixels = enabled.reduce((a, t) => a + (t.width * t.height) / 1e6, 0);

  return (
    <>
      <Section
        title="Formate"
        actions={
          <Button
            variant="ghost"
            title="Format hinzufügen"
            onClick={() => {
              const t = exportTarget('uhd-4k', `t${Date.now().toString(36)}`);
              // new formats start with their own, fitted framing
              const d = useStore.getState().doc;
              t.camera = fitCamera(structuredClone(d.camera), d.shape, t.width / t.height, 1.15);
              updateTargets((ts) => [...ts, t]);
              setDoc((d) => ({ ...d, activeTargetId: t.id }), { history: false });
            }}
          >
            <IconPlus /> Format
          </Button>
        }
      >
        <p className="hint">Das aktive Format bestimmt den Rahmen im Bild. Mit „Eigener Ausschnitt“ hat ein Format eine eigene Kamera.</p>
        <div className="target-list">
          {doc.exportTargets.map((t) => {
            const isActive = t.id === active?.id;
            const portrait = t.height > t.width;
            return (
              <div key={t.id} className={`target ${isActive ? 'is-active' : ''}`}>
                <button type="button" className="target-main" onClick={() => setDoc((d) => ({ ...d, activeTargetId: t.id }), { history: false })}>
                  {portrait ? <IconPhone /> : <IconMonitor />}
                  <span className="target-name">{formatById(t.formatId)?.name ?? 'Eigenes Format'}</span>
                  <span className="muted">
                    {t.width}×{t.height}
                  </span>
                </button>
                {isActive && (
                  <div className="target-edit">
                    <Select
                      value={formatById(t.formatId) ? t.formatId : 'custom'}
                      options={FORMAT_OPTIONS}
                      onChange={(id) => {
                        const f = formatById(id);
                        updateTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, formatId: id, width: f?.width ?? x.width, height: f?.height ?? x.height } : x)));
                      }}
                    />
                    {!formatById(t.formatId) && (
                      <div className="size-row">
                        <NumberInput value={t.width} onChange={(width) => updateTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, width } : x)))} />
                        <span>×</span>
                        <NumberInput value={t.height} onChange={(height) => updateTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, height } : x)))} />
                      </div>
                    )}
                    <Toggle
                      label="Eigener Ausschnitt"
                      value={!!t.camera}
                      onChange={(own) => updateTargets((ts, d) => ts.map((x) => (x.id === t.id ? { ...x, camera: own ? structuredClone(d.camera) : null } : x)))}
                    />
                    <Toggle label="Im Format-Set" value={t.enabled} onChange={(on) => updateTargets((ts) => ts.map((x) => (x.id === t.id ? { ...x, enabled: on } : x)))} />
                    {doc.exportTargets.length > 1 && (
                      <Button variant="ghost" onClick={() => updateTargets((ts) => ts.filter((x) => x.id !== t.id))}>
                        <IconTrash /> Entfernen
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <Toggle label="Geräte-Einblendung (Uhr, Menüleiste)" value={deviceOverlay} onChange={(v) => setExport({ deviceOverlay: v })} />
      </Section>

      <Section title="Bild exportieren">
        <Segmented<ExportQuality>
          label="Qualität"
          value={settings.quality}
          options={(['draft', 'high', 'max'] as const).map((q) => ({ value: q, label: QUALITY_LABEL[q], title: `${QUALITY_SAMPLES[q]} Samples pro Pixel` }))}
          onChange={(quality) => setExport({ settings: { ...settings, quality } })}
        />
        <Segmented
          label="Dateiformat"
          value={settings.format}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
          ]}
          onChange={(format) => setExport({ settings: { ...settings, format } })}
        />
        <Segmented
          label="Farbraum"
          value={settings.space}
          options={[
            { value: 'p3', label: 'Display P3', title: 'Größerer Farbraum: kräftigere Regenbogenfarben auf Apple-Geräten' },
            { value: 'srgb', label: 'sRGB', title: 'Maximale Kompatibilität' },
          ]}
          onChange={(space) => setExport({ settings: { ...settings, space } })}
        />
        <div className="button-stack">
          <Button variant="primary" disabled={exporting || !active} onClick={() => active && startStillExport([active])}>
            <IconDownload /> {active ? `${formatById(active.formatId)?.name ?? 'Format'} exportieren` : 'Exportieren'}
          </Button>
          <Button disabled={exporting || enabled.length < 2} onClick={() => startStillExport(enabled)}>
            Format-Set exportieren ({enabled.length} · {megapixels.toFixed(0)} MP)
          </Button>
        </div>
      </Section>

      <VideoSection />
    </>
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      className="text-input"
      type="number"
      min={64}
      max={12000}
      value={value}
      onChange={(e) => {
        const v = Math.round(Number(e.target.value));
        if (v >= 64 && v <= 12000) onChange(v);
      }}
    />
  );
}
