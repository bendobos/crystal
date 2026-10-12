import { useStore, updateDoc } from '../../model/store';
import { ColorField, Section, Slider } from '../controls';

const IOR_PRESETS = [
  { name: 'Wasser', ior: 1.33 },
  { name: 'Glas', ior: 1.5 },
  { name: 'Kristall', ior: 1.62 },
  { name: 'Saphir', ior: 1.77 },
  { name: 'Diamant', ior: 2.42 },
];

export function GlassPanel() {
  const glass = useStore((s) => s.doc.glass);
  const up = (patch: Partial<typeof glass>) => updateDoc('glass', patch);
  return (
    <>
      <Section title="Material">
        <div className="preset-grid">
          {IOR_PRESETS.map((p) => (
            <button key={p.name} type="button" className={`preset-chip ${Math.abs(glass.ior - p.ior) < 0.005 ? 'is-active' : ''}`} onClick={() => up({ ior: p.ior })}>
              {p.name}
            </button>
          ))}
        </div>
        <Slider label="Brechungsindex" value={glass.ior} min={1.1} max={2.6} step={0.01} onChange={(ior) => up({ ior })} />
        <Slider label="Regenbogen (Dispersion)" value={glass.dispersion} min={0} max={1} step={0.01} onChange={(dispersion) => up({ dispersion })} />
      </Section>
      <Section title="Tönung">
        <ColorField label="Farbe" value={glass.tint} onChange={(tint) => up({ tint })} />
        <Slider label="Dichte" value={glass.tintDensity} min={0} max={1} step={0.01} onChange={(tintDensity) => up({ tintDensity })} />
        <p className="hint">Dicke Stellen färben sich stärker, wie bei echtem Glas.</p>
      </Section>
      <Section title="Schillern">
        <Slider label="Dünnschicht-Interferenz" value={glass.iridescence} min={0} max={1} step={0.01} onChange={(iridescence) => up({ iridescence })} />
        <Slider
          label="Schichtdicke min"
          value={glass.iridescenceThickness[0]}
          min={50}
          max={1200}
          step={10}
          disabled={glass.iridescence <= 0}
          format={(v) => `${v} nm`}
          onChange={(v) => up({ iridescenceThickness: [v, Math.max(v, glass.iridescenceThickness[1])] })}
        />
        <Slider
          label="Schichtdicke max"
          value={glass.iridescenceThickness[1]}
          min={50}
          max={1200}
          step={10}
          disabled={glass.iridescence <= 0}
          format={(v) => `${v} nm`}
          onChange={(v) => up({ iridescenceThickness: [Math.min(v, glass.iridescenceThickness[0]), v] })}
        />
      </Section>
    </>
  );
}
