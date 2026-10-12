/**
 * Final image: preview/refined blend, bloom, exposure, tone mapping, grading, vignette, grain and
 * output encoding. The colour math must match displayTransform() in render/color.ts.
 */
export const compositeFragment = /* glsl */ `
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPreview;
uniform sampler2D uAccum;
uniform sampler2D uBloom;
uniform vec4 uBloomTransform;   // bloom texture covers the frame; maps vUv into it
uniform float uMixAccum;
uniform float uBloomStrength;
uniform float uExposure;        // linear multiplier
uniform int uToneMapping;       // 0 agx, 1 neutral
uniform float uContrast;
uniform float uSaturation;
uniform mat3 uOutFrom2020;
uniform float uVignette;
uniform float uGrain;
uniform vec2 uFrameOrigin;      // output pixels
uniform vec2 uFrameSize;        // output pixels
uniform float uFrameAspect;
uniform uint uNoiseSeed;

const mat3 SRGB_TO_REC2020 = mat3(
	vec3( 0.6274, 0.0691, 0.0164 ),
	vec3( 0.3293, 0.9195, 0.0880 ),
	vec3( 0.0433, 0.0113, 0.8956 ) );

vec3 agxContrast( vec3 x ) {
	vec3 x2 = x * x;
	vec3 x4 = x2 * x2;
	return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// three.js AgX (MIT) without the final gamut conversion: returns linear Rec.2020
vec3 agx( vec3 color ) {
	const mat3 inset = mat3(
		vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
		vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
		vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
	const mat3 outset = mat3(
		vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
		vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
		vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
	const float minEv = - 12.47393;
	const float maxEv = 4.026069;
	color = inset * ( SRGB_TO_REC2020 * color );
	color = clamp( ( log2( max( color, 1e-10 ) ) - minEv ) / ( maxEv - minEv ), 0.0, 1.0 );
	color = agxContrast( color );
	color = outset * color;
	return pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
}

vec3 neutral( vec3 color ) {
	const float startCompression = 0.8 - 0.04;
	const float desaturation = 0.15;
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak >= startCompression ) {
		float d = 1.0 - startCompression;
		float newPeak = 1.0 - d * d / ( peak + d - startCompression );
		color *= newPeak / peak;
		float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
		color = mix( color, vec3( newPeak ), g );
	}
	return SRGB_TO_REC2020 * color;
}

float srgbOetf( float c ) {
	return c <= 0.0031308 ? c * 12.92 : 1.055 * pow( c, 1.0 / 2.4 ) - 0.055;
}

uint hashU( uint x ) {
	x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
	return x;
}

float hashPixel( ivec2 p, uint salt ) {
	return float( hashU( uint( p.x ) * 73856093u ^ uint( p.y ) * 19349663u ^ salt ) ) * ( 1.0 / 4294967296.0 );
}

void main() {
	vec3 pre = texture( uPreview, vUv ).rgb;
	vec3 acc = texture( uAccum, vUv ).rgb;
	vec3 hdr = mix( pre, acc, uMixAccum );
	hdr += texture( uBloom, vUv * uBloomTransform.xy + uBloomTransform.zw ).rgb * uBloomStrength;

	vec3 x = hdr * uExposure;
	vec3 v = uToneMapping == 0 ? agx( x ) : neutral( x );
	float l = dot( v, vec3( 0.2627, 0.6780, 0.0593 ) );
	v = l + ( v - l ) * uSaturation;
	vec3 e = pow( clamp( v, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
	e = clamp( e + uContrast * ( e * e * ( 3.0 - 2.0 * e ) - e ), 0.0, 1.0 );
	v = pow( e, vec3( 2.2 ) );
	vec3 o = clamp( uOutFrom2020 * v, 0.0, 1.0 );

	vec2 fuv = ( gl_FragCoord.xy - uFrameOrigin ) / uFrameSize;
	if ( uVignette > 0.0 ) {
		vec2 q = ( fuv - 0.5 ) * vec2( uFrameAspect, 1.0 ) / max( uFrameAspect, 1.0 );
		float r = length( q ) * 1.414;
		o *= 1.0 - uVignette * smoothstep( 0.35, 1.25, r );
	}

	vec3 enc = vec3( srgbOetf( o.r ), srgbOetf( o.g ), srgbOetf( o.b ) );
	ivec2 ip = ivec2( gl_FragCoord.xy - uFrameOrigin );
	if ( uGrain > 0.0 ) {
		float g = hashPixel( ip, uNoiseSeed ) + hashPixel( ip, uNoiseSeed ^ 0x9e3779b9u ) - 1.0;
		float lum = dot( enc, vec3( 0.333 ) );
		enc += g * uGrain * 0.12 * ( 0.35 + 0.65 * ( 1.0 - abs( lum * 2.0 - 1.0 ) ) );
	}
	// triangular dither against banding in 8-bit output
	float d = hashPixel( ip, 0x68e31da4u ) + hashPixel( ip, 0xb5297a4du ) - 1.0;
	enc += d / 255.0;
	fragColor = vec4( clamp( enc, 0.0, 1.0 ), 1.0 );
}
`;

/** Bright-pass + downsample, and blur passes for bloom. */
export const bloomDownFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform sampler2D uSrc2;
uniform float uMix2;
uniform vec2 uTexel;
uniform float uThreshold;
uniform int uBright;
vec3 fetch( vec2 uv ) {
	vec3 c = uMix2 >= 0.0 ? mix( texture( uSrc, uv ).rgb, texture( uSrc2, uv ).rgb, uMix2 ) : texture( uSrc, uv ).rgb;
	if ( uBright == 1 ) {
		float l = max( c.r, max( c.g, c.b ) );
		c *= smoothstep( uThreshold, uThreshold * 2.0 + 0.5, l );
	}
	return c;
}
void main() {
	// 13-tap downsample (Jimenez 2014)
	vec2 t = uTexel;
	vec3 a = fetch( vUv + t * vec2( - 2, 2 ) );
	vec3 b = fetch( vUv + t * vec2( 0, 2 ) );
	vec3 c = fetch( vUv + t * vec2( 2, 2 ) );
	vec3 d = fetch( vUv + t * vec2( - 2, 0 ) );
	vec3 e = fetch( vUv );
	vec3 f = fetch( vUv + t * vec2( 2, 0 ) );
	vec3 g = fetch( vUv + t * vec2( - 2, - 2 ) );
	vec3 h = fetch( vUv + t * vec2( 0, - 2 ) );
	vec3 i = fetch( vUv + t * vec2( 2, - 2 ) );
	vec3 j = fetch( vUv + t * vec2( - 1, 1 ) );
	vec3 k = fetch( vUv + t * vec2( 1, 1 ) );
	vec3 l = fetch( vUv + t * vec2( - 1, - 1 ) );
	vec3 m = fetch( vUv + t * vec2( 1, - 1 ) );
	vec3 col = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
	fragColor = vec4( col, 1.0 );
}
`;

export const bloomUpFragment = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;      // lower mip (blurred)
uniform sampler2D uBase;     // current mip
uniform vec2 uTexel;
uniform float uRadius;
void main() {
	vec2 t = uTexel * uRadius;
	vec3 s = texture( uSrc, vUv + vec2( - t.x, t.y ) ).rgb + 2.0 * texture( uSrc, vUv + vec2( 0, t.y ) ).rgb + texture( uSrc, vUv + t ).rgb
		+ 2.0 * texture( uSrc, vUv + vec2( - t.x, 0 ) ).rgb + 4.0 * texture( uSrc, vUv ).rgb + 2.0 * texture( uSrc, vUv + vec2( t.x, 0 ) ).rgb
		+ texture( uSrc, vUv - t ).rgb + 2.0 * texture( uSrc, vUv + vec2( 0, - t.y ) ).rgb + texture( uSrc, vUv + vec2( t.x, - t.y ) ).rgb;
	fragColor = vec4( texture( uBase, vUv ).rgb + s / 16.0, 1.0 );
}
`;
