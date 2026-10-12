import { describe, expect, it } from 'vitest';
import { crossingDepths, findCrossings, resample, strokeToCurve, type P2 } from '../src/geometry/freehand';
import { createDefaultDoc } from '../src/model/defaults';
import { decodeShare, encodeShare, fromJSON, toJSON } from '../src/model/serialize';
import { createDetail } from '../src/geometry/fields';
import { displayTransform, inverseDisplay, hexToSrgb } from '../src/render/color';
import { cauchy, iorAt, previewTaps, spectralNormalization, wavelengthToLinearSrgb } from '../src/render/spectral';
import { frameAt } from '../src/export/loops';
import type { Vec3 } from '../src/model/types';

function figureEight(n = 200, a = 200): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    const d = 1 + Math.sin(t) ** 2;
    return { x: 400 + (a * Math.cos(t)) / d, y: 300 + (a * Math.sin(t) * Math.cos(t)) / d };
  });
}

describe('freehand', () => {
  it('resamples to even spacing', () => {
    const r = resample(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      10,
    );
    expect(r.length).toBe(11);
    expect(r[5].x).toBeCloseTo(50);
  });

  it('finds the single crossing of a figure eight', () => {
    const pts = resample(figureEight(), 6);
    expect(findCrossings(pts, true).length).toBe(1);
  });

  it('lifts the two passes of a crossing to opposite sides', () => {
    const pts = resample(figureEight(), 6);
    const depths = crossingDepths(pts, true, 30, 20);
    const c = findCrossings(pts, true)[0];
    const da = depths[Math.round(c.a)];
    const db = depths[Math.round(c.b)];
    expect(Math.sign(da)).toBe(-Math.sign(db));
    expect(Math.abs(da - db)).toBeGreaterThan(45);
  });

  it('turns a closed stroke into a closed curve that clears itself', () => {
    const stroke = figureEight();
    stroke.push({ ...stroke[0] });
    const unproject = (x: number, y: number, depth: number): Vec3 => [x / 100, -y / 100, depth];
    const res = strokeToCurve(stroke, unproject, 100, 0.3);
    expect(res).not.toBeNull();
    expect(res!.closed).toBe(true);
    const zs = res!.points.map((p) => p[2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.6);
  });

  it('keeps open strokes open', () => {
    const stroke = Array.from({ length: 50 }, (_, i) => ({ x: i * 8, y: 200 + Math.sin(i / 5) * 40 }));
    const res = strokeToCurve(stroke, (x, y, d) => [x / 100, y / 100, d], 100, 0.3);
    expect(res?.closed).toBe(false);
  });
});

describe('serialization', () => {
  it('round-trips a document through a share link', () => {
    const doc = createDefaultDoc();
    const detail = createDetail();
    detail.radius[12] = 0.4;
    detail.offset[33] = -0.25;
    detail.twist[100] = 1.2;
    doc.shape = { ...doc.shape, detail };
    const link = encodeShare(doc);
    expect(link.length).toBeLessThan(6000);
    const back = decodeShare(link);
    expect(back.shape.points.length).toBe(doc.shape.points.length);
    expect(back.lighting.lights.length).toBe(doc.lighting.lights.length);
    expect(back.shape.detail!.radius[12]).toBeCloseTo(0.4, 3);
    expect(back.shape.detail!.offset[33]).toBeCloseTo(-0.25, 3);
    expect(back.shape.detail!.twist[100]).toBeCloseTo(1.2, 3);
    expect(back.exportTargets[1].camera).not.toBeNull();
  });

  it('rejects malformed or hostile data', () => {
    const bad = toJSON(createDefaultDoc()) as Record<string, unknown>;
    expect(() => fromJSON({ ...bad, version: 2 })).toThrow();
    expect(() => fromJSON({ ...bad, shape: { ...(bad.shape as object), points: Array(5000).fill([0, 0, 0]) } })).toThrow();
    expect(() => decodeShare('not-a-link')).toThrow();
  });
});

describe('colour', () => {
  const p = { exposure: 0, toneMapping: 'agx' as const, contrast: 0.15, saturation: 1.05 };

  it('inverse display transform reproduces picked background colours', () => {
    for (const hex of ['#000000', '#1b1530', '#f1f1f4', '#e8607c', '#a9cdee']) {
      for (const space of ['srgb', 'p3'] as const) {
        const L = inverseDisplay(hex, p, space);
        const shown = displayTransform(L, p, space);
        const target = hexToSrgb(hex);
        if (space === 'srgb') for (let i = 0; i < 3; i++) expect(Math.abs(shown[i] - target[i])).toBeLessThan(0.02);
      }
    }
  });

  it('spectral weights average to white', () => {
    const norm = spectralNormalization();
    const sum = [0, 0, 0];
    let n = 0;
    for (let l = 380; l <= 730; l += 0.5) {
      const c = wavelengthToLinearSrgb(l);
      for (let i = 0; i < 3; i++) sum[i] += c[i] / norm[i];
      n++;
    }
    for (let i = 0; i < 3; i++) expect(sum[i] / n).toBeCloseTo(1, 6);
  });

  it('preview taps sum to one per channel', () => {
    const taps = previewTaps();
    for (let c = 0; c < 3; c++) expect(taps.weights.reduce((a, w) => a + w[c], 0)).toBeCloseTo(1, 6);
  });

  it('dispersion keeps the base index at 587.6 nm and spreads blue above red', () => {
    const ab = cauchy(1.5, 0.5);
    expect(iorAt(ab, 587.6)).toBeCloseTo(1.5, 4);
    expect(iorAt(ab, 450)).toBeGreaterThan(iorAt(ab, 650));
    expect(cauchy(1.5, 0)[1]).toBe(0);
  });
});

describe('video loops', () => {
  it('every loop kind is seamless', () => {
    const doc = createDefaultDoc();
    for (const kind of ['orbit', 'lights', 'flow', 'breathe'] as const) {
      const a = frameAt(doc, doc.camera, kind, 0);
      const b = frameAt(doc, doc.camera, kind, 1);
      for (let i = 0; i < 3; i++) expect(b.camera.position[i]).toBeCloseTo(a.camera.position[i], 6);
      expect(b.doc.shape.radius).toBeCloseTo(a.doc.shape.radius, 6);
      expect(((b.doc.lighting.rotation - a.doc.lighting.rotation) % 360 + 360) % 360).toBeCloseTo(0, 6);
    }
  });
});
