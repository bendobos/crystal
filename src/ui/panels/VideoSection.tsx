import { useState } from 'react';
import { useStore } from '../../model/store';
import { useExport } from '../../export/exportStore';
import { exportVideo, LOOP_LABEL, type LoopKind, type VideoSettings } from '../../export/video';
import { Button, Section, Segmented, Slider } from '../controls';
import { IconVideo } from '../icons';

export function VideoSection() {
  const [settings, setSettings] = useState<VideoSettings>({ kind: 'lights', seconds: 6, fps: 30, scale: 0.5, quality: 'fast' });
  const exporting = useStore((s) => s.exporting);
  const doc = useStore((s) => s.doc);
  const target = doc.exportTargets.find((t) => t.id === doc.activeTargetId) ?? doc.exportTargets[0];
  const up = (p: Partial<VideoSettings>) => setSettings((s) => ({ ...s, ...p }));
  const w = Math.round((target.width * settings.scale) / 2) * 2;
  const h = Math.round((target.height * settings.scale) / 2) * 2;

  const start = () => {
    const abort = new AbortController();
    const { set } = useExport.getState();
    set({ job: { kind: 'video', progress: { label: 'Vorbereiten…', fraction: 0, eta: null }, abort, files: null, error: null } });
    useStore.getState().set({ exporting: true });
    exportVideo(doc, target, settings, (progress) => {
      const job = useExport.getState().job;
      if (job) set({ job: { ...job, progress } });
    }, abort.signal)
      .then((file) => {
        const job = useExport.getState().job;
        if (job) set({ job: { ...job, files: [file], progress: { label: 'Fertig', fraction: 1, eta: null } } });
      })
      .catch((err: Error) => {
        const job = useExport.getState().job;
        if (err.name === 'AbortError') set({ job: null });
        else if (job) set({ job: { ...job, error: err.message || String(err) } });
      })
      .finally(() => useStore.getState().set({ exporting: false }));
  };

  return (
    <Section title="Video-Loop">
      <Segmented<LoopKind>
        value={settings.kind}
        options={(Object.keys(LOOP_LABEL) as LoopKind[]).map((k) => ({ value: k, label: LOOP_LABEL[k] }))}
        onChange={(kind) => up({ kind })}
      />
      <Slider label="Dauer" value={settings.seconds} min={3} max={15} step={1} format={(v) => `${v} s`} onChange={(seconds) => up({ seconds })} />
      <Segmented
        label="Bildrate"
        value={String(settings.fps)}
        options={[
          { value: '24', label: '24' },
          { value: '30', label: '30' },
          { value: '60', label: '60' },
        ]}
        onChange={(v) => up({ fps: Number(v) })}
      />
      <Segmented
        label="Auflösung"
        value={String(settings.scale)}
        options={[
          { value: '0.5', label: '50 %' },
          { value: '0.75', label: '75 %' },
          { value: '1', label: '100 %' },
        ]}
        onChange={(v) => up({ scale: Number(v) })}
      />
      <Segmented
        label="Qualität"
        value={settings.quality}
        options={[
          { value: 'fast', label: 'Schnell', title: 'Live-Renderer: rauschfrei, Sekunden pro Bild' },
          { value: 'photo', label: 'Fotorealistisch', title: 'Pathtracer: deutlich langsamer' },
        ]}
        onChange={(quality) => up({ quality })}
      />
      <p className="hint">
        {w}×{h}, {Math.round(settings.seconds * settings.fps)} Bilder. Nahtlose Schleife: das letzte Bild geht exakt ins erste über.
      </p>
      <Button disabled={exporting} onClick={start}>
        <IconVideo /> Video rendern
      </Button>
    </Section>
  );
}
