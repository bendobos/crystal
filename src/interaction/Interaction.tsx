import { useEffect, useMemo, useState } from 'react';
import { Vector3 } from 'three';
import CameraControls from 'camera-controls';
import { useStore } from '../model/store';
import { getEngine } from '../render/engineRef';
import { projectPoint, rayDirection } from '../render/view';
import { ArcSpline } from '../geometry/spline';
import { strokeToCurve, type P2 } from '../geometry/freehand';
import { BrushStroke } from './brush';
import type { LightDoc, Vec3 } from '../model/types';
import { newLight } from '../model/presets/studios';
import { updateLight } from '../ui/panels/LightPanel';

/**
 * Direct manipulation on the object: control point handles, glass-blower brush, freehand drawing
 * and the light sphere. One finger / left mouse drives the tool; empty-space drags and two-finger
 * gestures stay with the camera.
 */
export function Interaction({ host }: { host: React.RefObject<HTMLDivElement | null> }) {
  const tool = useStore((s) => s.tool);
  useStore((s) => s.viewVersion);
  const doc = useStore((s) => s.doc);
  const brush = useStore((s) => s.brush);
  const selectedPoint = useStore((s) => s.selectedPoint);
  const selectedLight = useStore((s) => s.selectedLight);
  const [cursor, setCursor] = useState<{ x: number; y: number; r: number } | null>(null);
  const [stroke, setStroke] = useState<P2[] | null>(null);
  const engine = getEngine();
  const view = engine?.view() ?? null;

  // --- canvas gestures --------------------------------------------------------------------
  useEffect(() => {
    const el = host.current;
    const e = getEngine();
    if (!el || !e) return;
    const pointers = new Set<number>();
    let active: null | {
      id: number;
      kind: 'brush' | 'draw';
      start: P2;
      startHit?: { point: Vector3; depth: number };
      stroke?: BrushStroke;
      pts?: P2[];
      raf?: number;
      last?: P2;
    } = null;

    const local = (ev: PointerEvent): P2 => {
      const r = el.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const capture = (on: boolean) => {
      // hand single-pointer drags to the tool instead of the orbit controls
      const A = CameraControls.ACTION;
      e.controls.mouseButtons.left = on ? A.NONE : A.ROTATE;
      e.controls.touches.one = on ? A.NONE : A.TOUCH_ROTATE;
    };
    const finish = (commit: boolean) => {
      if (!active) return;
      if (active.raf) cancelAnimationFrame(active.raf);
      const st = useStore.getState();
      if (active.kind === 'draw' && commit && active.pts && active.pts.length > 2) {
        applyStroke(active.pts);
      }
      if (active.kind === 'brush') st.end();
      active = null;
      setStroke(null);
      capture(false);
      e.setInteracting(false);
    };

    const onDown = (ev: PointerEvent) => {
      pointers.add(ev.pointerId);
      const st = useStore.getState();
      if (pointers.size > 1) {
        // second finger: the camera takes over
        finish(active?.kind === 'draw' ? false : true);
        return;
      }
      if (ev.button !== 0 || (ev.target as Element).closest?.('[data-handle]')) return;
      const p = local(ev);
      if (st.tool === 'draw') {
        capture(true);
        active = { id: ev.pointerId, kind: 'draw', start: p, pts: [p] };
        setStroke([p]);
        e.setInteracting(true);
        return;
      }
      if (st.tool === 'brush') {
        const hit = e.pick(p.x, p.y);
        if (!hit || !e.glass.sweep) return;
        capture(true);
        st.begin();
        const shape = st.doc.shape;
        const s = new BrushStroke(shape, e.glass.sweep, st.brush, hit.t);
        const { basis } = e.view();
        const depth = hit.point.clone().sub(basis.position).dot(basis.forward);
        active = { id: ev.pointerId, kind: 'brush', start: p, startHit: { point: hit.point, depth }, stroke: s, last: p };
        e.setInteracting(true);
        if (st.brush.mode !== 'pull' && st.brush.mode !== 'twist') {
          // continuous effect while held
          const tick = () => {
            if (!active?.stroke) return;
            const last = active.last ?? p;
            const h = e.pick(last.x, last.y);
            const detail = active.stroke.hold(h ? h.t : null);
            useStore.getState().setDoc((d) => ({ ...d, shape: { ...d.shape, detail } }), { history: false });
            active.raf = requestAnimationFrame(tick);
          };
          active.raf = requestAnimationFrame(tick);
        }
        return;
      }
      if (st.tool === 'light') {
        // tap on glass: place the selected light's highlight there (on pointerup if it was a tap)
        const hit = e.pick(p.x, p.y);
        if (!hit) return;
        capture(true);
        const startT = performance.now();
        const up = (u: PointerEvent) => {
          window.removeEventListener('pointerup', up);
          capture(false);
          const q = local(u);
          if (performance.now() - startT < 500 && Math.hypot(q.x - p.x, q.y - p.y) < 8) placeHighlight(p.x, p.y);
        };
        window.addEventListener('pointerup', up);
        return;
      }
    };

    const onMove = (ev: PointerEvent) => {
      const p = local(ev);
      const st = useStore.getState();
      if (st.tool === 'brush' && ev.pointerType !== 'touch') {
        const h = e.pick(p.x, p.y);
        if (h) {
          const { view: v, basis } = e.view();
          const depth = h.point.clone().sub(basis.position).dot(basis.forward);
          const r = (st.brush.size / (2 * depth * v.tanHalfFov)) * v.frame.h;
          setCursor({ x: p.x, y: p.y, r });
        } else setCursor(null);
      }
      if (!active || ev.pointerId !== active.id) return;
      if (active.kind === 'draw') {
        active.pts!.push(p);
        setStroke([...active.pts!]);
        return;
      }
      if (active.kind === 'brush' && active.stroke && active.startHit) {
        active.last = p;
        const mode = st.brush.mode;
        if (mode === 'pull') {
          const { view: v, basis } = e.view();
          const k = (2 * active.startHit.depth * v.tanHalfFov) / v.frame.h;
          const disp = new Vector3()
            .addScaledVector(basis.right, (p.x - active.start.x) * k)
            .addScaledVector(basis.up, -(p.y - active.start.y) * k);
          const detail = active.stroke.pull(disp);
          st.setDoc((d) => ({ ...d, shape: { ...d.shape, detail } }), { history: false });
        } else if (mode === 'twist') {
          const detail = active.stroke.twist(p.x - active.start.x);
          st.setDoc((d) => ({ ...d, shape: { ...d.shape, detail } }), { history: false });
        }
      }
    };

    const onUp = (ev: PointerEvent) => {
      pointers.delete(ev.pointerId);
      if (active && ev.pointerId === active.id) finish(true);
    };

    const onLeave = () => setCursor(null);

    const onDouble = (ev: MouseEvent) => {
      const st = useStore.getState();
      const r = el.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (st.tool === 'points') insertPoint(x, y);
      else if (st.tool === 'camera' && st.doc.effects.aperture > 0) {
        const hit = e.pick(x, y);
        if (hit) {
          const { basis } = e.view();
          const depth = hit.point.clone().sub(basis.position).dot(basis.forward);
          st.setDoc((d) => ({ ...d, effects: { ...d.effects, focusDistance: Math.round(depth * 100) / 100 } }));
          st.set({ toast: `Fokus auf ${depth.toFixed(1)} gesetzt` });
        }
      }
    };

    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('dblclick', onDouble);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('dblclick', onDouble);
      finish(false);
    };
  }, [host, engine]);

  useEffect(() => {
    if (tool !== 'brush') setCursor(null);
  }, [tool]);

  // --- overlays -------------------------------------------------------------------------------
  const pointsOverlay = useMemo(() => {
    if (tool !== 'points' || !view || !engine?.glass.sweep) return null;
    const c = engine.glass.sweep.centers;
    const n = c.length / 3;
    const line: string[] = [];
    for (let i = 0; i < n; i += 2) {
      const p = projectPoint(view.view, view.basis, new Vector3(c[i * 3], c[i * 3 + 1], c[i * 3 + 2]));
      if (p.depth > 0) line.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    if (doc.shape.closed && line.length) line.push(line[0]);
    const handles = doc.shape.points.map((pt, i) => ({ i, ...projectPoint(view.view, view.basis, new Vector3(...pt)) }));
    const centerDepth = projectPoint(view.view, view.basis, new Vector3(...engine.glass.sweep.center)).depth;
    return { line: line.join(' '), handles, centerDepth };
  }, [tool, view, doc.shape, engine]);

  return (
    <svg className="interaction-layer" width="100%" height="100%">
      {pointsOverlay && (
        <>
          <polyline points={pointsOverlay.line} className="curve-line" />
          {pointsOverlay.handles.map((h) =>
            h.depth > 0 ? (
              <PointHandle key={h.i} index={h.i} x={h.x} y={h.y} behind={h.depth > pointsOverlay.centerDepth} selected={selectedPoint === h.i} />
            ) : null,
          )}
        </>
      )}
      {tool === 'light' && view && <LightSphere selected={selectedLight} lights={doc.lighting.lights} rotation={doc.lighting.rotation} />}
      {cursor && tool === 'brush' && (
        <g className="brush-cursor">
          <circle cx={cursor.x} cy={cursor.y} r={cursor.r} />
          <circle cx={cursor.x} cy={cursor.y} r={2} className="dot" />
          <text x={cursor.x + cursor.r + 6} y={cursor.y + 4}>
            {brushLabel(brush.mode)}
          </text>
        </g>
      )}
      {stroke && stroke.length > 1 && <polyline className="draw-stroke" points={stroke.map((p) => `${p.x},${p.y}`).join(' ')} />}
    </svg>
  );
}

function brushLabel(m: string): string {
  return { pull: 'Ziehen', inflate: 'Aufblasen', pinch: 'Kneifen', twist: 'Drehen', smooth: 'Glätten' }[m] ?? m;
}

// --- control points -------------------------------------------------------------------------------

function PointHandle({ index, x, y, behind, selected }: { index: number; x: number; y: number; behind: boolean; selected: boolean }) {
  const onDown = (ev: React.PointerEvent<SVGGElement>) => {
    ev.stopPropagation();
    ev.preventDefault();
    const e = getEngine();
    if (!e) return;
    const st = useStore.getState();
    st.set({ selectedPoint: index });
    st.begin();
    e.setInteracting(true);
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const start = { x: ev.clientX, y: ev.clientY };
    const startPt = new Vector3(...st.doc.shape.points[index]);
    const { view: v, basis } = e.view();
    const depth = startPt.clone().sub(basis.position).dot(basis.forward);
    const k = (2 * depth * v.tanHalfFov) / v.frame.h;
    let moved = false;
    const long = window.setTimeout(() => {
      if (!moved) deletePoint(index);
    }, 650);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - start.x;
      const dy = m.clientY - start.y;
      if (Math.hypot(dx, dy) > 4) moved = true;
      const p = startPt.clone();
      if (m.shiftKey || m.altKey) p.addScaledVector(basis.forward, dy * k * 2).addScaledVector(basis.right, dx * k);
      else p.addScaledVector(basis.right, dx * k).addScaledVector(basis.up, -dy * k);
      useStore.getState().setDoc(
        (d) => ({ ...d, shape: { ...d.shape, points: d.shape.points.map((q, i) => (i === index ? ([p.x, p.y, p.z] as Vec3) : q)) } }),
        { history: false },
      );
    };
    const up = () => {
      window.clearTimeout(long);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      useStore.getState().end();
      e.setInteracting(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <g data-handle className={`point-handle ${behind ? 'is-behind' : ''} ${selected ? 'is-selected' : ''}`} onPointerDown={onDown}>
      <circle cx={x} cy={y} r={18} className="hit" />
      <circle cx={x} cy={y} r={selected ? 7.5 : 6} className="dot" />
    </g>
  );
}

function deletePoint(index: number): void {
  const st = useStore.getState();
  const min = st.doc.shape.closed ? 4 : 3;
  if (st.doc.shape.points.length <= min) {
    st.set({ toast: 'Mindestens ' + min + ' Punkte nötig' });
    return;
  }
  st.setDoc((d) => ({ ...d, shape: { ...d.shape, points: d.shape.points.filter((_, i) => i !== index), detail: null } }));
  st.set({ selectedPoint: null, toast: 'Punkt gelöscht' });
}

export function deleteSelectedPoint(): void {
  const i = useStore.getState().selectedPoint;
  if (i !== null) deletePoint(i);
}

function insertPoint(x: number, y: number): void {
  const e = getEngine();
  if (!e) return;
  const hit = e.pick(x, y);
  if (!hit) return;
  const st = useStore.getState();
  const shape = st.doc.shape;
  const spline = new ArcSpline(shape.points, shape.closed);
  const u = spline.paramAt(hit.t);
  const seg = Math.min(Math.floor(u), shape.points.length - (shape.closed ? 1 : 2));
  const p: Vec3 = [0, 0, 0];
  spline.pointAt(hit.t, p);
  const points = [...shape.points];
  points.splice(seg + 1, 0, p);
  // detail fields are parameterised along the curve and survive point edits
  st.setDoc((d) => ({ ...d, shape: { ...d.shape, points } }));
  st.set({ selectedPoint: seg + 1, toast: 'Punkt eingefügt' });
}

// --- freehand ---------------------------------------------------------------------------------------

function applyStroke(pts: P2[]): void {
  const e = getEngine();
  if (!e) return;
  const st = useStore.getState();
  const { view: v, basis } = e.view();
  const target = e.controls.getTarget(new Vector3());
  const planeDepth = target.clone().sub(basis.position).dot(basis.forward);
  const pxPerUnit = v.frame.h / (2 * planeDepth * v.tanHalfFov);
  const unproject = (x: number, y: number, depth: number): Vec3 => {
    const dir = rayDirection(v, basis, x, y);
    const t = planeDepth / dir.dot(basis.forward);
    const p = basis.position.clone().addScaledVector(dir, t).addScaledVector(basis.forward, depth);
    return [p.x, p.y, p.z];
  };
  const res = strokeToCurve(pts, unproject, pxPerUnit, st.doc.shape.radius);
  if (!res) {
    st.set({ toast: 'Strich zu kurz' });
    return;
  }
  st.setDoc((d) => ({ ...d, shape: { ...d.shape, points: res.points, closed: res.closed, detail: null } }));
  st.set({ toast: res.closed ? 'Geschlossene Form erzeugt' : 'Offene Form erzeugt' });
}

// --- lights ---------------------------------------------------------------------------------------

function lightDir(l: LightDoc, rotation: number): Vector3 {
  const az = ((l.azimuth + rotation) * Math.PI) / 180;
  const el = (l.elevation * Math.PI) / 180;
  return new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

function dirToAngles(o: Vector3, rotation: number): { azimuth: number; elevation: number } {
  let az = (Math.atan2(o.x, o.z) * 180) / Math.PI - rotation;
  az = ((((az + 180) % 360) + 360) % 360) - 180;
  return { azimuth: Math.round(az * 10) / 10, elevation: Math.round(((Math.asin(Math.max(-1, Math.min(1, o.y))) * 180) / Math.PI) * 10) / 10 };
}

/** Places a light so its mirror reflection appears at the given screen point. */
function placeHighlight(x: number, y: number): void {
  const e = getEngine();
  if (!e) return;
  const hit = e.pick(x, y);
  if (!hit) return;
  const st = useStore.getState();
  const { view: v, basis } = e.view();
  const dir = rayDirection(v, basis, x, y);
  const n = hit.normal.clone();
  if (n.dot(dir) > 0) n.negate();
  const r = dir.clone().reflect(n).normalize();
  const rot = st.doc.lighting.rotation;
  let light = st.doc.lighting.lights.find((l) => l.id === st.selectedLight) ?? null;
  const dist = light?.distance ?? 8;
  // intersect hit + r·s with the sphere |p| = dist around the rig centre
  const p0 = hit.point;
  const b = p0.dot(r);
  const c = p0.lengthSq() - dist * dist;
  const s = -b + Math.sqrt(Math.max(0, b * b - c));
  const pos = p0.clone().addScaledVector(r, s).normalize();
  const angles = dirToAngles(pos, rot);
  if (light) {
    updateLight(light.id, angles);
  } else {
    light = newLight({ ...angles, shape: 'strip', width: 0.8, height: 6, intensity: 6 });
    const l = light;
    st.setDoc((d) => ({ ...d, lighting: { ...d.lighting, lights: [...d.lighting.lights, l].slice(0, 16) } }));
    st.set({ selectedLight: l.id });
  }
  st.set({ toast: 'Glanzlicht gesetzt' });
}

function LightSphere({ lights, rotation, selected }: { lights: LightDoc[]; rotation: number; selected: string | null }) {
  const e = getEngine();
  if (!e) return null;
  const { view: v, basis } = e.view();
  const c = projectPoint(v, basis, new Vector3(0, 0, 0));
  const R = Math.min(v.frame.w, v.frame.h) * 0.42;
  const toScreen = (o: Vector3) => ({ x: c.x + o.dot(basis.right) * R, y: c.y - o.dot(basis.up) * R, front: o.dot(basis.forward) < 0 });

  const onDown = (l: LightDoc) => (ev: React.PointerEvent<SVGGElement>) => {
    ev.stopPropagation();
    ev.preventDefault();
    const st = useStore.getState();
    st.set({ selectedLight: l.id });
    st.begin();
    e.setInteracting(true);
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    const front = lightDir(l, rotation).dot(basis.forward) < 0;
    const host = (ev.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const move = (m: PointerEvent) => {
      let x = (m.clientX - host.left - c.x) / R;
      let y = -(m.clientY - host.top - c.y) / R;
      let r = Math.hypot(x, y);
      let hemiFront = front;
      if (r > 1) {
        // dragging past the rim continues onto the other hemisphere
        const r2 = Math.max(0, 2 - r);
        x = (x / r) * r2;
        y = (y / r) * r2;
        r = r2;
        hemiFront = !front;
      }
      const z = Math.sqrt(Math.max(0, 1 - r * r)) * (hemiFront ? -1 : 1);
      const o = new Vector3().addScaledVector(basis.right, x).addScaledVector(basis.up, y).addScaledVector(basis.forward, z).normalize();
      updateLight(l.id, dirToAngles(o, rotation), `light-drag-${l.id}`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      useStore.getState().end();
      e.setInteracting(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <g className="light-sphere">
      <circle cx={c.x} cy={c.y} r={R} className="rim" />
      <ellipse cx={c.x} cy={c.y} rx={R} ry={R * 0.28} className="equator" />
      {lights.map((l) => {
        const s = toScreen(lightDir(l, rotation));
        const flag = l.intensity === 0;
        return (
          <g key={l.id} data-handle className={`light-handle ${s.front ? 'is-front' : 'is-back'} ${selected === l.id ? 'is-selected' : ''}`} onPointerDown={onDown(l)}>
            <circle cx={s.x} cy={s.y} r={20} className="hit" />
            <circle cx={s.x} cy={s.y} r={selected === l.id ? 10 : 8} className="dot" style={{ fill: flag ? '#000' : l.color, stroke: flag ? '#888' : undefined }} />
          </g>
        );
      })}
    </g>
  );
}
