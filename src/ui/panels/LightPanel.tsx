import { useStore, updateDoc } from '../../model/store';
import { STUDIO_PRESETS, newLight } from '../../model/presets/studios';
import { applyStudio } from '../../model/actions';
import { Button, ColorField, Section, Segmented, Slider, Toggle } from '../controls';
import { IconPlus, IconTrash } from '../icons';
import type { LightDoc, LightShape } from '../../model/types';

const SHAPES: { value: LightShape; label: string }[] = [
  { value: 'rect', label: 'Fläche' },
  { value: 'strip', label: 'Streifen' },
  { value: 'disc', label: 'Kreis' },
  { value: 'ring', label: 'Ring' },
];

export function updateLight(id: string, patch: Partial<LightDoc>, coalesce?: string): void {
  useStore.getState().setDoc(
    (d) => ({ ...d, lighting: { ...d.lighting, lights: d.lighting.lights.map((l) => (l.id === id ? { ...l, ...patch } : l)) } }),
    { coalesce: coalesce ?? `light:${id}:${Object.keys(patch).join(',')}` },
  );
}

export function LightPanel() {
  const lighting = useStore((s) => s.doc.lighting);
  const selected = useStore((s) => s.selectedLight);
  const set = useStore((s) => s.set);
  const setDoc = useStore((s) => s.setDoc);
  const tool = useStore((s) => s.tool);
  const light = lighting.lights.find((l) => l.id === selected) ?? null;
  const up = (patch: Partial<typeof lighting>) => updateDoc('lighting', patch);

  return (
    <>
      <Section title="Studio">
        <div className="preset-grid">
          {STUDIO_PRESETS.map((p) => (
            <button key={p.id} type="button" className={`preset-chip ${lighting.studioId === p.id ? 'is-active' : ''}`} onClick={() => applyStudio(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <Slider label="Belichtung" value={lighting.exposure} min={-3} max={3} step={0.05} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} EV`} onChange={(exposure) => up({ exposure })} />
        <Slider label="Licht drehen" value={lighting.rotation} min={-180} max={180} step={1} format={(v) => `${v}°`} onChange={(rotation) => up({ rotation })} />
        <Slider label="Grundlicht" value={lighting.dome.intensity} min={0} max={5} step={0.05} onChange={(intensity) => up({ dome: { ...lighting.dome, intensity } })} />
        <div className="color-row">
          <ColorField value={lighting.dome.top} onChange={(top) => up({ dome: { ...lighting.dome, top } })} />
          <ColorField value={lighting.dome.horizon} onChange={(horizon) => up({ dome: { ...lighting.dome, horizon } })} />
          <ColorField value={lighting.dome.bottom} onChange={(bottom) => up({ dome: { ...lighting.dome, bottom } })} />
        </div>
        <p className="hint">Kuppel oben · Horizont · unten: das Umgebungslicht zwischen den Lichtquellen.</p>
      </Section>

      <Section
        title="Lichter"
        actions={
          <Button
            variant="ghost"
            title="Licht hinzufügen"
            onClick={() => {
              const l = newLight({ azimuth: Math.round(Math.random() * 360 - 180), elevation: 20, shape: 'strip', width: 1, height: 8 });
              setDoc((d) => ({ ...d, lighting: { ...d.lighting, lights: [...d.lighting.lights, l].slice(0, 16) } }));
              set({ selectedLight: l.id });
            }}
          >
            <IconPlus /> Neu
          </Button>
        }
      >
        <p className="hint">
          {tool === 'light'
            ? 'Aufs Glas tippen setzt das gewählte Licht so, dass sein Glanzlicht genau dort erscheint. Griffe ziehen verschiebt Lichter.'
            : 'Im Licht-Werkzeug lassen sich Lichter direkt im Bild verschieben und Glanzlichter per Tippen setzen.'}
        </p>
        <div className="light-list">
          {lighting.lights.map((l) => (
            <button key={l.id} type="button" className={`light-item ${l.id === selected ? 'is-active' : ''}`} onClick={() => set({ selectedLight: l.id === selected ? null : l.id })}>
              <span className="light-dot" style={{ background: l.intensity === 0 ? '#000' : l.color, boxShadow: l.intensity === 0 ? 'inset 0 0 0 1px #555' : undefined }} />
              <span>{SHAPES.find((s) => s.value === l.shape)?.label}</span>
              <span className="muted">{l.intensity === 0 ? 'Abschatter' : `${Math.round(l.azimuth)}° / ${Math.round(l.elevation)}°`}</span>
            </button>
          ))}
        </div>
      </Section>

      {light && (
        <Section
          title="Gewähltes Licht"
          actions={
            <Button
              variant="ghost"
              title="Licht löschen"
              onClick={() => {
                setDoc((d) => ({ ...d, lighting: { ...d.lighting, lights: d.lighting.lights.filter((x) => x.id !== light.id) } }));
                set({ selectedLight: null });
              }}
            >
              <IconTrash />
            </Button>
          }
        >
          <Segmented value={light.shape} options={SHAPES} onChange={(shape) => updateLight(light.id, { shape })} />
          <ColorField label="Farbe" value={light.color} onChange={(color) => updateLight(light.id, { color })} />
          <Slider label="Intensität" value={light.intensity} min={0} max={20} step={0.1} format={(v) => (v === 0 ? 'Abschatter' : v.toFixed(1))} onChange={(intensity) => updateLight(light.id, { intensity })} />
          <Slider label="Breite" value={light.width} min={0.1} max={14} step={0.05} onChange={(width) => updateLight(light.id, { width })} />
          <Slider label="Höhe" value={light.height} min={0.1} max={14} step={0.05} onChange={(height) => updateLight(light.id, { height })} />
          <Slider label="Weichheit" value={light.softness} min={0} max={1} step={0.01} onChange={(softness) => updateLight(light.id, { softness })} />
          <Slider label="Richtung" value={light.azimuth} min={-180} max={180} step={1} format={(v) => `${v}°`} onChange={(azimuth) => updateLight(light.id, { azimuth })} />
          <Slider label="Höhe über Horizont" value={light.elevation} min={-89} max={89} step={1} format={(v) => `${v}°`} onChange={(elevation) => updateLight(light.id, { elevation })} />
          <Slider label="Abstand" value={light.distance} min={3} max={20} step={0.1} onChange={(distance) => updateLight(light.id, { distance })} />
          <Slider label="Drehung" value={light.rotation} min={-180} max={180} step={1} format={(v) => `${v}°`} onChange={(rotation) => updateLight(light.id, { rotation })} />
          <Toggle label="Im Bild sichtbar" value={light.visibleToCamera} onChange={(visibleToCamera) => updateLight(light.id, { visibleToCamera })} />
        </Section>
      )}
    </>
  );
}
