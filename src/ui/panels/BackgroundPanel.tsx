import { useStore, updateDoc } from '../../model/store';
import { Button, ColorField, Section, Segmented, Slider } from '../controls';
import { IconPlus, IconTrash } from '../icons';
import type { BackgroundDoc } from '../../model/types';

const SWATCHES = ['#000000', '#0d0d12', '#1b1530', '#f1f1f4', '#ffffff', '#e9e2d8', '#0f2a3a', '#2d1745'];

export function BackgroundPanel() {
  const bg = useStore((s) => s.doc.background);
  const up = (patch: Partial<BackgroundDoc>, key?: string) => updateDoc('background', patch, key);
  const stops = [...bg.stops].sort((a, b) => a.pos - b.pos);
  const setStop = (i: number, patch: Partial<(typeof stops)[number]>) =>
    up({ stops: stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }, `bg-stop-${i}-${Object.keys(patch).join()}`);

  return (
    <>
      <Section title="Hintergrund">
        <Segmented
          value={bg.type}
          options={[
            { value: 'solid', label: 'Farbe' },
            { value: 'linear', label: 'Verlauf' },
            { value: 'radial', label: 'Kreisverlauf' },
          ]}
          onChange={(type) => up({ type, stops: type !== 'solid' && stops.length < 2 ? [...stops, { color: '#444444', pos: 1 }] : stops })}
        />
        {bg.type === 'solid' ? (
          <>
            <ColorField label="Farbe" value={stops[0].color} onChange={(color) => up({ stops: stops.map((s) => ({ ...s, color })) }, 'bg-solid')} />
            <div className="swatches">
              {SWATCHES.map((c) => (
                <button key={c} type="button" className="swatch" style={{ background: c }} title={c} onClick={() => up({ stops: stops.map((s) => ({ ...s, color: c })) })} />
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="gradient-preview" style={{ background: cssGradient(bg) }} />
            {stops.map((s, i) => (
              <div key={i} className="stop-row">
                <ColorField value={s.color} onChange={(color) => setStop(i, { color })} />
                <Slider label={`Position ${i + 1}`} value={s.pos} min={0} max={1} step={0.01} onChange={(pos) => setStop(i, { pos })} />
                {stops.length > 2 && (
                  <Button variant="ghost" title="Farbe entfernen" onClick={() => up({ stops: stops.filter((_, j) => j !== i) })}>
                    <IconTrash />
                  </Button>
                )}
              </div>
            ))}
            {stops.length < 4 && (
              <Button variant="ghost" onClick={() => up({ stops: [...stops, { color: stops[stops.length - 1].color, pos: 0.5 }] })}>
                <IconPlus /> Farbe hinzufügen
              </Button>
            )}
            {bg.type === 'linear' ? (
              <Slider label="Winkel" value={bg.angle} min={0} max={360} step={1} format={(v) => `${v}°`} onChange={(angle) => up({ angle })} />
            ) : (
              <>
                <Slider label="Mitte horizontal" value={bg.center[0]} min={0} max={1} step={0.01} onChange={(x) => up({ center: [x, bg.center[1]] })} />
                <Slider label="Mitte vertikal" value={bg.center[1]} min={0} max={1} step={0.01} onChange={(y) => up({ center: [bg.center[0], y] })} />
                <Slider label="Radius" value={bg.radius} min={0.1} max={2} step={0.01} onChange={(radius) => up({ radius })} />
              </>
            )}
          </>
        )}
      </Section>
      <Section title="Wirkung aufs Glas">
        <Slider label="Hintergrund im Glas" value={bg.glassInfluence} min={0} max={1} step={0.01} onChange={(glassInfluence) => up({ glassInfluence })} />
        <p className="hint">Wie stark das Glas den Hintergrund bricht. Bei 0 spiegelt es nur das Studio.</p>
      </Section>
    </>
  );
}

export function cssGradient(bg: BackgroundDoc): string {
  const stops = [...bg.stops].sort((a, b) => a.pos - b.pos).map((s) => `${s.color} ${Math.round(s.pos * 100)}%`);
  if (bg.type === 'solid') return bg.stops[0].color;
  if (bg.type === 'linear') return `linear-gradient(${90 - bg.angle}deg, ${stops.join(', ')})`;
  return `radial-gradient(circle at ${bg.center[0] * 100}% ${(1 - bg.center[1]) * 100}%, ${stops.join(', ')})`;
}
