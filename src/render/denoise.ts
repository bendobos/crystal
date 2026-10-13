import { GLSL3, NearestFilter, RawShaderMaterial, RGBAFormat, Vector4, WebGLRenderTarget, type FloatType, type HalfFloatType, type Texture, type WebGLRenderer } from 'three';
import type { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { fullscreenVertex } from './shaders/trace';

/**
 * Denoiser for the path traced glass: an edge-avoiding à-trous wavelet filter (5×5 B3 spline,
 * doubling step, as in SVGF). Averaging stops at edges of the deterministic preview of the same
 * frame (noise-free, so its edges are reliable) and at differences in the path traced image that
 * exceed the propagated noise, so real detail such as dispersion fringes survives.
 *
 * The preview only steers the weights and never enters the result: filtering the difference to the
 * preview instead measured as accurate but let the preview's own artefacts (seams where its
 * approximation switches paths) show through as fine lines.
 */

export const DENOISE_ITERATIONS = 5;
/** Pixels on each side a region needs beyond the pixels it outputs, for seamless tiles. */
export const DENOISE_APRON = 2 * ((1 << DENOISE_ITERATIONS) - 1) + 2;

const guideGLSL = /* glsl */ `
uniform sampler2D uGuide;
uniform vec4 uGuideRect;   // part of the guide (guide pixels, GL origin) the surface covers
vec3 guideAt( ivec2 p, ivec2 size ) {
	vec2 g = uGuideRect.xy + ( vec2( p ) + 0.5 ) * uGuideRect.zw / vec2( size );
	return texture( uGuide, g / vec2( textureSize( uGuide, 0 ) ) ).rgb;
}
vec3 feature( vec3 c ) {
	return log( vec3( 0.002 ) + max( c, 0.0 ) );
}
`;

/** Image and the variance of its pixel mean. */
const initFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uAccum;   // rgb mean, a = mean of s² (s = rgb average per sample)
uniform float uSamples;
out vec4 fragColor;
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	vec4 a = texelFetch( uAccum, p, 0 );
	float m = ( a.r + a.g + a.b ) / 3.0;
	fragColor = vec4( a.rgb, max( a.a - m * m, 0.0 ) / max( uSamples, 1.0 ) );
}
`;

const atrousFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uSrc;     // rgb radiance, a = variance
uniform int uStep;
uniform float uSigmaGuide;
uniform float uSigmaNoise;
uniform float uChroma;      // weight of colour (vs. brightness) differences
${guideGLSL}
out vec4 fragColor;
const float K[ 3 ] = float[ 3 ]( 0.375, 0.25, 0.0625 );
void main() {
	ivec2 p = ivec2( gl_FragCoord.xy );
	ivec2 size = textureSize( uSrc, 0 );
	vec4 c = texelFetch( uSrc, p, 0 );
	vec3 gp = feature( guideAt( p, size ) );
	vec3 sum = vec3( 0.0 );
	float var = 0.0;
	float wsum = 0.0;
	for ( int y = - 2; y <= 2; y ++ ) {
		for ( int x = - 2; x <= 2; x ++ ) {
			ivec2 q = p + ivec2( x, y ) * uStep;
			if ( any( lessThan( q, ivec2( 0 ) ) ) || any( greaterThanEqual( q, size ) ) ) continue;
			vec4 s = texelFetch( uSrc, q, 0 );
			vec3 dg = feature( guideAt( q, size ) ) - gp;
			vec3 dr = s.rgb - c.rgb;
			float dm = ( dr.r + dr.g + dr.b ) / 3.0;
			float dl = dm * dm + uChroma * dot( dr - dm, dr - dm );
			float w = K[ abs( x ) ] * K[ abs( y ) ]
				* exp( - dot( dg, dg ) / ( 2.0 * uSigmaGuide * uSigmaGuide ) )
				* exp( - dl / ( uSigmaNoise * uSigmaNoise * ( c.a + s.a ) + 1e-8 ) );
			sum += w * s.rgb;
			var += w * w * s.a;
			wsum += w;
		}
	}
	fragColor = vec4( sum / wsum, var / ( wsum * wsum ) );
}
`;

const finalFragment = /* glsl */ `
precision highp float;
precision highp int;
uniform sampler2D uSrc;
out vec4 fragColor;
void main() {
	fragColor = vec4( texelFetch( uSrc, ivec2( gl_FragCoord.xy ), 0 ).rgb, 0.0 );
}
`;

export interface DenoiseParams {
  /** Width of the guide edge stop, in natural-log units of radiance. */
  sigmaGuide: number;
  /** Differences beyond this many standard deviations of noise count as detail. */
  sigmaNoise: number;
  /** Weight of colour differences in the residual (dispersion fringes are mostly colour). */
  chroma: number;
  /** À-trous passes; the filter radius doubles with each. */
  iterations: number;
}

// tuned against 1536-sample references (display-space RMSE)
export const DENOISE_DEFAULTS: DenoiseParams = { sigmaGuide: 0.35, sigmaNoise: 3, chroma: 0.3, iterations: DENOISE_ITERATIONS };

function material(fragmentShader: string, uniforms: RawShaderMaterial['uniforms']): RawShaderMaterial {
  return new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: fullscreenVertex,
    fragmentShader,
    uniforms: { uGuide: { value: null }, uGuideRect: { value: new Vector4() }, ...uniforms },
    depthTest: false,
    depthWrite: false,
  });
}

export class Denoiser {
  readonly params: DenoiseParams = { ...DENOISE_DEFAULTS };
  private init = material(initFragment, { uAccum: { value: null }, uSamples: { value: 1 } });
  private atrous = material(atrousFragment, {
    uSrc: { value: null },
    uStep: { value: 1 },
    uSigmaGuide: { value: 0.35 },
    uSigmaNoise: { value: 3 },
    uChroma: { value: 0.3 },
  });
  private final = material(finalFragment, { uSrc: { value: null } });
  private rts: WebGLRenderTarget[];

  constructor(type: typeof FloatType | typeof HalfFloatType) {
    const make = () =>
      new WebGLRenderTarget(1, 1, {
        type,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
    this.rts = [make(), make()];
  }

  /**
   * Denoises `accum` (mean rgb, second moment in alpha, `samples` per pixel). `guideRect` is the
   * part of `guide` (its pixels, GL origin) that the accumulator covers. Returns a texture of the
   * same size with the denoised radiance; valid until the next call.
   */
  run(renderer: WebGLRenderer, quad: FullScreenQuad, accum: Texture, samples: number, guide: Texture, guideRect: [number, number, number, number]): Texture {
    const { width: w, height: h } = accum.image as { width: number; height: number };
    for (const rt of this.rts) if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    for (const m of [this.init, this.atrous, this.final]) {
      m.uniforms.uGuide.value = guide;
      (m.uniforms.uGuideRect.value as Vector4).set(...guideRect);
    }
    const pass = (m: RawShaderMaterial, target: WebGLRenderTarget) => {
      quad.material = m;
      renderer.setRenderTarget(target);
      quad.render(renderer);
    };
    this.init.uniforms.uAccum.value = accum;
    this.init.uniforms.uSamples.value = samples;
    pass(this.init, this.rts[0]);
    const a = this.atrous.uniforms;
    a.uSigmaGuide.value = this.params.sigmaGuide;
    a.uSigmaNoise.value = this.params.sigmaNoise;
    a.uChroma.value = this.params.chroma;
    for (let i = 0; i < Math.min(this.params.iterations, DENOISE_ITERATIONS); i++) {
      a.uSrc.value = this.rts[0].texture;
      a.uStep.value = 1 << i;
      pass(this.atrous, this.rts[1]);
      this.rts.reverse();
    }
    this.final.uniforms.uSrc.value = this.rts[0].texture;
    pass(this.final, this.rts[1]);
    return this.rts[1].texture;
  }

  dispose(): void {
    for (const rt of this.rts) rt.dispose();
    for (const m of [this.init, this.atrous, this.final]) m.dispose();
  }
}

