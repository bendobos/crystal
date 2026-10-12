import { useStore, updateDoc } from '../../model/store';
import { SHAPE_PRESETS } from '../../model/presets/shapes';
import { applyShapePreset, randomize } from '../../model/actions';
import { Button, Section, Segmented, Slider, Toggle } from '../controls';
import { IconDice } from '../icons';
import { isDetailEmpty } from '../../geometry/fields';
import type { BrushMode } from '../../model/store';

const BRUSH_MODES: { value: BrushMode; label: string; title: string }[] = [
  { value: 'pull', label: 'Ziehen', title: 'Röhre verbiegen' },
  { value: 'inflate', label: 'Blasen', title: 'Gedrückt halten zum Aufblasen' },
  { value: 'pinch', label: 'Kneifen', title: 'Dünner machen' },
  { value: 'twist', label: 'Drehen', title: 'Horizontal ziehen zum Verdrehen' },
  { value: 'smooth', label: 'Glätten', title: 'Unebenheiten ausgleichen' },
];

export function BrushSettingsSection() {
  const brush = useStore((s) => s.brush);
  const set = useStore((s) => s.set);
  return (
    <Section title="Glasbläser-Pinsel">
      <Segmented value={brush.mode} options={BRUSH_MODES} onChange={(mode) => set({ brush: { ...brush, mode } })} />
      <Slider label="Pinselgröße" value={brush.size} min={0.2} max={3} step={0.05} onChange={(size) => set({ brush: { ...brush, size } })} />
      <Slider label="Stärke" value={brush.strength} min={0.05} max={1} step={0.05} onChange={(strength) => set({ brush: { ...brush, strength } })} />
      <p className="hint">Direkt auf dem Glas ziehen. Zwei Finger bzw. rechte Maustaste bewegen die Kamera.</p>
    </Section>
  );
}

export function FormPanel() {
  const shape = useStore((s) => s.doc.shape);
  const tool = useStore((s) => s.tool);
  const setDoc = useStore((s) => s.setDoc);
  const closed = shape.closed && shape.points.length >= 3;
  const up = (patch: Partial<typeof shape>, key?: string) => updateDoc('shape', patch, key);

  return (
    <>
      <Section
        title="Vorlagen"
        actions={
          <Button variant="ghost" onClick={randomize} title="Zufällige Variante">
            <IconDice /> Würfeln
          </Button>
        }
      >
        <div className="preset-grid">
          {SHAPE_PRESETS.map((p) => (
            <button key={p.id} type="button" className="preset-chip" onClick={() => applyShapePreset(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
      </Section>

      {tool === 'brush' && <BrushSettingsSection />}

      <Section title="Röhre">
        <Slider label="Dicke" value={shape.radius} min={0.05} max={1.2} step={0.01} onChange={(radius) => up({ radius })} />
        <Slider label="Abflachung" value={shape.flatness} min={0} max={0.95} step={0.01} onChange={(flatness) => up({ flatness })} />
        <Slider label="Kanten" value={shape.roundness} min={0} max={1} step={0.01} format={(v) => (v < 0.15 ? 'rund' : v > 0.75 ? 'kantig' : 'weich')} onChange={(roundness) => up({ roundness })} />
        <Slider
          label="Verdrehung"
          value={shape.twist}
          min={0}
          max={4}
          step={closed ? 0.5 : 0.01}
          marks={closed ? [0.5, 1, 1.5, 2, 2.5, 3, 3.5] : undefined}
          format={(v) => `${(closed ? Math.round(v * 2) / 2 : v).toFixed(closed ? 1 : 2)} U.`}
          onChange={(twist) => up({ twist })}
        />
        <Toggle label="Geschlossene Form" value={shape.closed} onChange={(c) => up({ closed: c })} />
      </Section>

      <Section title="Stränge">
        <Slider label="Anzahl" value={shape.strands} min={1} max={5} step={1} onChange={(strands) => up({ strands })} />
        <Slider label="Abstand" value={shape.strandSpread} min={0.6} max={3} step={0.01} disabled={shape.strands < 2} onChange={(strandSpread) => up({ strandSpread })} />
        <Slider
          label="Umeinander winden"
          value={shape.strandTwist}
          min={0}
          max={3}
          step={closed && shape.strands > 1 ? 1 / shape.strands : 0.01}
          disabled={shape.strands < 2}
          format={(v) => `${v.toFixed(2)} U.`}
          onChange={(strandTwist) => up({ strandTwist })}
        />
      </Section>

      {!isDetailEmpty(shape.detail) && (
        <Section title="Feinform">
          <p className="hint">Mit dem Pinsel geformte Details folgen der Grundform.</p>
          <Button onClick={() => setDoc((d) => ({ ...d, shape: { ...d.shape, detail: null } }))}>Feinform zurücksetzen</Button>
        </Section>
      )}
    </>
  );
}
