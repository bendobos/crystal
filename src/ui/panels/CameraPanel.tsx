import { Vector3 } from 'three';
import { useStore, updateDoc } from '../../model/store';
import { fitView, activeTarget } from '../../model/actions';
import { Button, Section, Segmented, Slider } from '../controls';
import { IconFit } from '../icons';
import { getEngine } from '../../render/engineRef';
import { storeTier, type QualityTier } from '../../render/quality';

export function CameraPanel() {
  const doc = useStore((s) => s.doc);
  const status = useStore((s) => s.status);
  const setDoc = useStore((s) => s.setDoc);
  const fx = doc.effects;
  const target = activeTarget(doc);
  const cam = target?.camera ?? doc.camera;
  const upFx = (patch: Partial<typeof fx>) => updateDoc('effects', patch);
  const setFocal = (focalLength: number) =>
    setDoc(
      (d) => {
        const t = activeTarget(d);
        if (t?.camera) return { ...d, exportTargets: d.exportTargets.map((x) => (x.id === t.id ? { ...x, camera: { ...x.camera!, focalLength } } : x)) };
        return { ...d, camera: { ...d.camera, focalLength } };
      },
      { coalesce: 'focal' },
    );

  return (
    <>
      <Section
        title="Kamera"
        actions={
          <Button variant="ghost" onClick={fitView} title="Objekt einpassen">
            <IconFit /> Einpassen
          </Button>
        }
      >
        <Slider label="Brennweite" value={cam.focalLength} min={18} max={200} step={1} format={(v) => `${v} mm`} onChange={setFocal} />
        <p className="hint">Ziehen dreht die Kamera, Scrollen/Pinch zoomt, rechte Maustaste bzw. zwei Finger verschieben.</p>
      </Section>
      <Section title="Tiefenunschärfe">
        <Slider label="Blende" value={fx.aperture} min={0} max={1} step={0.01} format={(v) => (v === 0 ? 'aus' : v.toFixed(2))} onChange={(aperture) => upFx({ aperture })} />
        <Slider label="Fokus-Abstand" value={fx.focusDistance} min={1} max={60} step={0.1} disabled={fx.aperture === 0} onChange={(focusDistance) => upFx({ focusDistance })} />
        <Button
          disabled={fx.aperture === 0}
          onClick={() => {
            const e = getEngine();
            if (!e) return;
            const p = e.controls.getPosition(new Vector3());
            const t = e.controls.getTarget(new Vector3());
            upFx({ focusDistance: Math.round(p.distanceTo(t) * 10) / 10 });
          }}
        >
          Auf Objektmitte fokussieren
        </Button>
        <p className="hint">Tiefenunschärfe erscheint in der verfeinerten Ansicht. Im Kamera-Werkzeug fokussiert ein Doppeltipp aufs Glas.</p>
      </Section>
      <Section title="Bildlook">
        <Segmented
          label="Tonemapping"
          value={fx.toneMapping}
          options={[
            { value: 'agx', label: 'Filmisch (AgX)' },
            { value: 'neutral', label: 'Neutral' },
          ]}
          onChange={(toneMapping) => upFx({ toneMapping })}
        />
        <Slider label="Kontrast" value={fx.contrast} min={-0.5} max={1} step={0.01} onChange={(contrast) => upFx({ contrast })} />
        <Slider label="Sättigung" value={fx.saturation} min={0} max={2} step={0.01} onChange={(saturation) => upFx({ saturation })} />
        <Slider label="Leuchten (Bloom)" value={fx.bloom} min={0} max={1} step={0.01} onChange={(bloom) => upFx({ bloom })} />
        <Slider label="Bloom-Radius" value={fx.bloomRadius} min={0.3} max={3} step={0.01} disabled={fx.bloom === 0} onChange={(bloomRadius) => upFx({ bloomRadius })} />
        <Slider label="Vignette" value={fx.vignette} min={0} max={1} step={0.01} onChange={(vignette) => upFx({ vignette })} />
        <Slider label="Filmkorn" value={fx.grain} min={0} max={1} step={0.01} onChange={(grain) => upFx({ grain })} />
      </Section>
      <Section title="Vorschau-Qualität">
        <Segmented<QualityTier>
          value={status?.tier ?? 'medium'}
          options={[
            { value: 'low', label: 'Sparsam' },
            { value: 'medium', label: 'Ausgewogen' },
            { value: 'high', label: 'Maximal' },
          ]}
          onChange={(tier) => {
            storeTier(tier);
            getEngine()?.setQuality(tier);
          }}
        />
        <p className="hint">Betrifft nur die Ansicht. Exporte werden immer in voller Qualität gerendert.</p>
      </Section>
    </>
  );
}
