import { useStore, type Tool } from '../model/store';
import { IconBrush, IconDraw, IconLight, IconOrbit, IconPoints } from './icons';

export const TOOLS: { id: Tool; label: string; icon: React.ReactNode; hint: string; key: string }[] = [
  { id: 'camera', label: 'Kamera', icon: <IconOrbit />, hint: 'Ansicht drehen, zoomen und verschieben', key: '1' },
  { id: 'points', label: 'Punkte', icon: <IconPoints />, hint: 'Kontrollpunkte ziehen · Doppelklick fügt ein · lang drücken löscht', key: '2' },
  { id: 'brush', label: 'Pinsel', icon: <IconBrush />, hint: 'Glas ziehen, aufblasen, kneifen, drehen', key: '3' },
  { id: 'draw', label: 'Zeichnen', icon: <IconDraw />, hint: 'Linie zeichnen – daraus wird eine Glasröhre', key: '4' },
  { id: 'light', label: 'Licht', icon: <IconLight />, hint: 'Lichter auf der Kugel verschieben · aufs Glas tippen setzt ein Glanzlicht', key: '5' },
];

export function Toolbar({ vertical }: { vertical: boolean }) {
  const tool = useStore((s) => s.tool);
  const set = useStore((s) => s.set);
  return (
    <nav className={`toolbar ${vertical ? 'is-vertical' : 'is-horizontal'}`} aria-label="Werkzeuge">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tool-btn ${tool === t.id ? 'is-active' : ''}`}
          title={`${t.label} (${t.key}) – ${t.hint}`}
          aria-pressed={tool === t.id}
          onClick={() => {
            const patch: Parameters<typeof set>[0] = { tool: t.id };
            if (t.id === 'brush') patch.panel = 'form';
            if (t.id === 'light') patch.panel = 'light';
            set(patch);
          }}
        >
          {t.icon}
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function ToolHint() {
  const tool = useStore((s) => s.tool);
  const t = TOOLS.find((x) => x.id === tool);
  if (!t || tool === 'camera') return null;
  return <div className="tool-hint">{t.hint}</div>;
}
