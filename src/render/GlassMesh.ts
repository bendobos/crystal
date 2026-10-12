import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { CENTER, FloatVertexAttributeTexture, MeshBVH, MeshBVHUniformStruct, SAH } from 'three-mesh-bvh';
import type { ShapeDoc } from '../model/types';
import { sweepShape, type SweepQuality, type SweepResult } from '../geometry/sweep';

export interface SurfaceHit {
  point: Vector3;
  normal: Vector3;
  /** Curve parameter at the hit. */
  t: number;
  strand: number;
  distance: number;
}

/**
 * Owns the swept glass geometry, its BVH and the GPU textures the tracer reads. Updates with
 * unchanged topology only refit the BVH (fast, used while dragging); topology changes rebuild it.
 */
export class GlassMesh {
  readonly struct = new MeshBVHUniformStruct();
  readonly normalTex = new FloatVertexAttributeTexture();
  sweep: SweepResult | null = null;
  geometry: BufferGeometry | null = null;
  bvh: MeshBVH | null = null;
  /** True when the current BVH was refitted and would benefit from a full SAH rebuild. */
  degraded = false;
  version = 0;

  update(shape: ShapeDoc, quality: SweepQuality, allowRefit: boolean): void {
    const prevKey = this.sweep?.topologyKey;
    const sweep = sweepShape(shape, quality, allowRefit ? this.sweep : null);
    const sameTopology = allowRefit && !!this.bvh && sweep.topologyKey === prevKey && sweep.positions === this.sweep?.positions;
    this.sweep = sweep;
    if (sameTopology && this.geometry && this.bvh) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.normal.needsUpdate = true;
      this.bvh.refit();
      this.degraded = true;
    } else {
      this.build(sweep, CENTER);
      this.degraded = true;
    }
    this.upload();
  }

  /** Full-quality BVH rebuild for the current geometry (call when interaction settles). */
  rebuild(): void {
    if (!this.sweep) return;
    this.build(this.sweep, SAH);
    this.degraded = false;
    this.upload();
  }

  private build(sweep: SweepResult, strategy: typeof CENTER | typeof SAH): void {
    this.geometry?.dispose();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(sweep.positions, 3));
    g.setAttribute('normal', new BufferAttribute(sweep.normals, 3));
    // the BVH reorders the index in place, so give it a copy of the canonical one
    g.setIndex(new BufferAttribute(sweep.index.slice(), 1));
    this.geometry = g;
    // small leaves measured fastest for GPU traversal (leaf 4: ~55 ms/MP vs 86 ms/MP at leaf 10)
    this.bvh = new MeshBVH(g, { strategy, maxLeafSize: 4, maxDepth: 30 });
  }

  private upload(): void {
    if (!this.bvh || !this.geometry) return;
    this.struct.updateFrom(this.bvh);
    this.normalTex.updateFrom(this.geometry.attributes.normal as BufferAttribute);
    this.version++;
  }

  raycast(origin: Vector3, direction: Vector3): SurfaceHit | null {
    if (!this.bvh || !this.geometry || !this.sweep) return null;
    const hit = this.bvh.raycastFirst(new Ray(origin, direction), DoubleSide);
    if (!hit || !hit.face) return null;
    const pos = this.geometry.attributes.position as BufferAttribute;
    const { a, b, c } = hit.face;
    const pa = new Vector3().fromBufferAttribute(pos, a);
    const pb = new Vector3().fromBufferAttribute(pos, b);
    const pc = new Vector3().fromBufferAttribute(pos, c);
    const bary = barycentric(hit.point, pa, pb, pc);
    const tp = this.sweep.tparam;
    let t = tp[a] * bary.x + tp[b] * bary.y + tp[c] * bary.z;
    // closed curves wrap: avoid averaging across the seam
    if (this.sweep.closed) {
      const vals = [tp[a], tp[b], tp[c]];
      if (Math.max(...vals) - Math.min(...vals) > 0.5) {
        const w = vals.map((v) => (v < 0.5 ? v + 1 : v));
        t = (w[0] * bary.x + w[1] * bary.y + w[2] * bary.z) % 1;
      }
    }
    const nrm = this.geometry.attributes.normal as BufferAttribute;
    const normal = new Vector3()
      .addScaledVector(new Vector3().fromBufferAttribute(nrm, a), bary.x)
      .addScaledVector(new Vector3().fromBufferAttribute(nrm, b), bary.y)
      .addScaledVector(new Vector3().fromBufferAttribute(nrm, c), bary.z)
      .normalize();
    return { point: hit.point.clone(), normal, t, strand: this.sweep.strand[a], distance: hit.distance };
  }

  dispose(): void {
    this.geometry?.dispose();
    this.struct.dispose();
    this.normalTex.dispose();
  }
}

function barycentric(p: Vector3, a: Vector3, b: Vector3, c: Vector3): Vector3 {
  const v0 = new Vector3().subVectors(b, a);
  const v1 = new Vector3().subVectors(c, a);
  const v2 = new Vector3().subVectors(p, a);
  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01 || 1;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return new Vector3(1 - v - w, v, w);
}
