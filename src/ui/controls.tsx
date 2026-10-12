import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HexColorPicker } from 'react-colorful';
import { useStore } from '../model/store';

export function Section({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      {(title || actions) && (
        <header className="section-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="section-actions">{actions}</div>}
        </header>
      )}
      <div className="section-body">{children}</div>
    </section>
  );
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  /** Snap points shown as ticks (e.g. half turns). */
  marks?: number[];
  disabled?: boolean;
}

/** Slider that records a single undo step per drag. */
export function Slider({ label, value, min, max, step = 0.01, onChange, format, marks, disabled }: SliderProps) {
  const begin = useStore((s) => s.begin);
  const end = useStore((s) => s.end);
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={`slider ${disabled ? 'is-disabled' : ''}`}>
      <span className="slider-top">
        <span className="slider-label">{label}</span>
        <span className="slider-value">{format ? format(value) : fmt(value, step)}</span>
      </span>
      <span className="slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          style={{ ['--pct' as string]: `${Math.min(100, Math.max(0, pct))}%` }}
          onPointerDown={begin}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyUp={end}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {marks && (
          <span className="slider-marks" aria-hidden>
            {marks.map((m) => (
              <i key={m} style={{ left: `${((m - min) / (max - min)) * 100}%` }} />
            ))}
          </span>
        )}
      </span>
    </label>
  );
}

function fmt(v: number, step: number): string {
  const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return v.toFixed(d);
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="field">
      {label && <span className="field-label">{label}</span>}
      <div className="segmented" role="radiogroup">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            title={o.title}
            className={o.value === value ? 'is-active' : ''}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

export function ColorField({ label, value, onChange }: { label?: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLDivElement>(null);
  const begin = useStore((s) => s.begin);
  const end = useStore((s) => s.end);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        end();
      }
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open, end]);
  return (
    <div className="color-field" ref={ref}>
      <button
        type="button"
        className="color-swatch-btn"
        onClick={() => {
          if (!open) begin();
          else end();
          setOpen(!open);
        }}
      >
        <span className="color-swatch" style={{ background: value }} />
        {label && <span className="color-label">{label}</span>}
        <span className="color-hex">{value.toUpperCase()}</span>
      </button>
      {open && (
        <div className="color-pop">
          <HexColorPicker color={value} onChange={onChange} />
          <input
            className="text-input"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value.toLowerCase());
            }}
          />
        </div>
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  title,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" className={`btn btn-${variant} ${className}`} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      {children}
    </button>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string; group?: string }[];
  onChange: (v: T) => void;
}) {
  const groups = Array.from(new Set(options.map((o) => o.group ?? '')));
  return (
    <label className="field">
      {label && <span className="field-label">{label}</span>}
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {groups.map((g) =>
          g ? (
            <optgroup key={g} label={g}>
              {options
                .filter((o) => o.group === g)
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ) : (
            options
              .filter((o) => !o.group)
              .map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
          ),
        )}
      </select>
    </label>
  );
}
