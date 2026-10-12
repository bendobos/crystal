import { HalfFloatType, LinearFilter, RGBAFormat, Vector2, WebGLRenderTarget, type RawShaderMaterial, type Texture, type WebGLRenderer } from 'three';
import type { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

export interface BloomSource {
  a: Texture;
  /** Optional second texture blended in with `mix` (preview ↔ refined). */
  b: Texture | null;
  mix: number;
}

/** Mip-chain bloom (13-tap downsample, tent upsample). The spread is relative to the image size. */
export class BloomChain {
  private mips: WebGLRenderTarget[] = [];
  private spare: WebGLRenderTarget[] = [];
  private w = 0;
  private h = 0;

  setSize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.dispose();
    this.w = w;
    this.h = h;
    let bw = Math.max(1, Math.floor(w / 2));
    let bh = Math.max(1, Math.floor(h / 2));
    for (let i = 0; i < 6 && bw >= 4 && bh >= 4; i++) {
      this.mips.push(makeRT(bw, bh));
      this.spare.push(makeRT(bw, bh));
      bw = Math.floor(bw / 2);
      bh = Math.floor(bh / 2);
    }
  }

  get available(): boolean {
    return this.mips.length > 0;
  }

  render(
    renderer: WebGLRenderer,
    quad: FullScreenQuad,
    down: RawShaderMaterial,
    up: RawShaderMaterial,
    src: BloomSource,
    threshold: number,
    radius: number,
  ): Texture {
    const d = down.uniforms;
    d.uThreshold.value = threshold;
    let prev: Texture = src.a;
    for (let i = 0; i < this.mips.length; i++) {
      const rt = this.mips[i];
      d.uSrc.value = prev;
      d.uSrc2.value = i === 0 && src.b ? src.b : prev;
      d.uMix2.value = i === 0 && src.b ? src.mix : -1;
      d.uBright.value = i === 0 ? 1 : 0;
      const pw = i === 0 ? rt.width * 2 : this.mips[i - 1].width;
      const ph = i === 0 ? rt.height * 2 : this.mips[i - 1].height;
      (d.uTexel.value as Vector2).set(1 / pw, 1 / ph);
      quad.material = down;
      renderer.setRenderTarget(rt);
      quad.render(renderer);
      prev = rt.texture;
    }
    const u = up.uniforms;
    u.uRadius.value = radius;
    let lower = this.mips[this.mips.length - 1];
    for (let i = this.mips.length - 2; i >= 0; i--) {
      const base = this.mips[i];
      const out = this.spare[i];
      u.uSrc.value = lower.texture;
      u.uBase.value = base.texture;
      (u.uTexel.value as Vector2).set(1 / lower.width, 1 / lower.height);
      quad.material = up;
      renderer.setRenderTarget(out);
      quad.render(renderer);
      lower = out;
    }
    return lower.texture;
  }

  dispose(): void {
    for (const rt of [...this.mips, ...this.spare]) rt.dispose();
    this.mips = [];
    this.spare = [];
    this.w = 0;
    this.h = 0;
  }
}

function makeRT(w: number, h: number): WebGLRenderTarget {
  return new WebGLRenderTarget(w, h, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}
