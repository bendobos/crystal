import { Vector3 } from 'three';
import type { DetailFields, ShapeDoc } from '../model/types';
import { DETAIL_SIZE } from '../model/types';
import { cloneDetail, createDetail, forEachInBrush, smoothField } from '../geometry/fields';
import type { SweepResult } from '../geometry/sweep';
import type { BrushSettings } from '../model/store';

/**
 * One brush stroke on the glass. Works on the dense detail fields so edits stay local, while the
 * control points keep defining the overall form.
 */
export class BrushStroke {
  private readonly settings: BrushSettings;
  private readonly sweep: SweepResult;
  private readonly startDetail: DetailFields;
  private readonly detail: DetailFields;
  private readonly closed: boolean;
  private readonly radiusT: number;
  private t0: number;
  private lastTime: number;

  constructor(shape: ShapeDoc, sweep: SweepResult, settings: BrushSettings, t0: number) {
    this.settings = settings;
    this.sweep = sweep;
    this.closed = sweep.closed;
    this.startDetail = shape.detail ? cloneDetail(shape.detail) : createDetail();
    this.detail = cloneDetail(this.startDetail);
    this.radiusT = Math.max(0.01, settings.size / Math.max(sweep.curveLength, 1e-3));
    this.t0 = t0;
    this.lastTime = performance.now();
  }

  /** Frame vectors (base curve) at field sample i. */
  private frameAt(i: number): { n: Vector3; b: Vector3; t: Vector3 } {
    const N = this.sweep.rings;
    const tParam = this.closed ? i / DETAIL_SIZE : i / (DETAIL_SIZE - 1);
    const r = Math.min(N - 1, Math.round(tParam * (this.closed ? N : N - 1)) % N);
    const f = this.sweep.baseFrames;
    return {
      n: new Vector3(f.normal[r * 3], f.normal[r * 3 + 1], f.normal[r * 3 + 2]),
      b: new Vector3(f.binormal[r * 3], f.binormal[r * 3 + 1], f.binormal[r * 3 + 2]),
      t: new Vector3(f.tangent[r * 3], f.tangent[r * 3 + 1], f.tangent[r * 3 + 2]),
    };
  }

  /** Pull: total world-space displacement since the stroke started. */
  pull(displacement: Vector3): DetailFields {
    const d = this.detail;
    d.offset.set(this.startDetail.offset);
    forEachInBrush(this.t0, this.radiusT, this.closed, (i, w) => {
      const fr = this.frameAt(i);
      d.offset[i * 3] += displacement.dot(fr.n) * w;
      d.offset[i * 3 + 1] += displacement.dot(fr.b) * w;
      d.offset[i * 3 + 2] += displacement.dot(fr.t) * w * 0.5;
    });
    return d;
  }

  /** Twist: horizontal screen distance since the stroke started, in pixels. */
  twist(dxPx: number): DetailFields {
    const d = this.detail;
    d.twist.set(this.startDetail.twist);
    const amount = (dxPx / 120) * this.settings.strength * 2;
    forEachInBrush(this.t0, this.radiusT, this.closed, (i, w) => {
      d.twist[i] += amount * w;
    });
    return d;
  }

  /** Inflate/pinch/smooth: continuous while held; t follows the cursor. */
  hold(t: number | null): DetailFields {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    if (t !== null) this.t0 = t;
    const d = this.detail;
    const mode = this.settings.mode;
    if (mode === 'inflate' || mode === 'pinch') {
      const rate = (mode === 'inflate' ? 1 : -1) * this.settings.strength * 1.4 * dt;
      forEachInBrush(this.t0, this.radiusT, this.closed, (i, w) => {
        d.radius[i] = Math.min(1.3, Math.max(-1.8, d.radius[i] + rate * w));
      });
    } else if (mode === 'smooth') {
      const amount = Math.min(1, this.settings.strength * dt * 12);
      smoothField(d.radius, 1, this.closed, this.t0, this.radiusT, amount);
      smoothField(d.twist, 1, this.closed, this.t0, this.radiusT, amount);
      smoothField(d.offset, 3, this.closed, this.t0, this.radiusT, amount);
    }
    return d;
  }

  result(): DetailFields {
    return this.detail;
  }
}
