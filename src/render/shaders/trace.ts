import { BVHShaderGLSL } from 'three-mesh-bvh';
import { environmentGLSL } from './environment';
import { PREVIEW_TAPS } from '../spectral';
import { BLOCK } from '../adaptive';

export const fullscreenVertex = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const opticsGLSL = /* glsl */ `
// eta = n_transmitted / n_incident
float fresnelDielectric( float cosI, float eta ) {
	float sinT2 = ( 1.0 - cosI * cosI ) / ( eta * eta );
	if ( sinT2 >= 1.0 ) return 1.0;
	float cosT = sqrt( 1.0 - sinT2 );
	float rs = ( cosI - eta * cosT ) / ( cosI + eta * cosT );
	float rp = ( eta * cosI - cosT ) / ( eta * cosI + cosT );
	return 0.5 * ( rs * rs + rp * rp );
}

// Reflectance of a thin film (n2, thickness d nm) between media n1 (incident) and n3, at lambda nm.
float thinFilmReflectance( float cosI, float n1, float n2, float n3, float d, float lambda ) {
	float sin1 = sqrt( max( 0.0, 1.0 - cosI * cosI ) );
	float sin2 = n1 / n2 * sin1;
	float sin3 = n1 / n3 * sin1;
	if ( sin2 >= 1.0 || sin3 >= 1.0 ) return 1.0;
	float cos2 = sqrt( 1.0 - sin2 * sin2 );
	float cos3 = sqrt( 1.0 - sin3 * sin3 );
	float r12s = ( n1 * cosI - n2 * cos2 ) / ( n1 * cosI + n2 * cos2 );
	float r12p = ( n2 * cosI - n1 * cos2 ) / ( n2 * cosI + n1 * cos2 );
	float r23s = ( n2 * cos2 - n3 * cos3 ) / ( n2 * cos2 + n3 * cos3 );
	float r23p = ( n3 * cos2 - n2 * cos3 ) / ( n3 * cos2 + n2 * cos3 );
	float c = cos( 12.566370614 * n2 * d * cos2 / lambda );
	float Rs = ( r12s * r12s + r23s * r23s + 2.0 * r12s * r23s * c ) / ( 1.0 + r12s * r12s * r23s * r23s + 2.0 * r12s * r23s * c );
	float Rp = ( r12p * r12p + r23p * r23p + 2.0 * r12p * r23p * c ) / ( 1.0 + r12p * r12p * r23p * r23p + 2.0 * r12p * r23p * c );
	return clamp( 0.5 * ( Rs + Rp ), 0.0, 1.0 );
}

float hash13( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}

float valueNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( mix( hash13( i ), hash13( i + vec3( 1, 0, 0 ) ), f.x ),
			mix( hash13( i + vec3( 0, 1, 0 ) ), hash13( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
		mix( mix( hash13( i + vec3( 0, 0, 1 ) ), hash13( i + vec3( 1, 0, 1 ) ), f.x ),
			mix( hash13( i + vec3( 0, 1, 1 ) ), hash13( i + vec3( 1, 1, 1 ) ), f.x ), f.y ),
		f.z );
}

uniform float uIridescence;
uniform vec2 uFilmThickness;   // nm range
uniform float uFilmIor;

float filmThickness( vec3 p ) {
	float n = valueNoise( p * 1.7 ) * 0.65 + valueNoise( p * 4.3 ) * 0.35;
	return mix( uFilmThickness.x, uFilmThickness.y, n );
}
`;

const commonUniforms = /* glsl */ `
uniform BVH bvh;
uniform sampler2D normalAttribute;

uniform vec2 uFrameOrigin;   // render target pixels
uniform vec2 uFrameSize;     // render target pixels
uniform vec3 uAbsorb;        // per unit length
uniform float uEps;
`;

const cameraGLSL = /* glsl */ `
vec3 cameraDir( vec2 pixel, out vec2 uv ) {
	uv = ( pixel - uFrameOrigin ) / uFrameSize;
	vec2 ndc = uv * 2.0 - 1.0;
	return normalize( uCamFwd + ndc.x * uTanHalfFov * uFrameAspect * uCamRight + ndc.y * uTanHalfFov * uCamUp );
}
`;

const previewGLSL = /* glsl */ `
#define TAPS ${PREVIEW_TAPS}
uniform vec3 uIorRGB;            // n at red, green, blue reference wavelengths
uniform float uDispersionOn;
uniform vec3 uTapWeight[ TAPS ];
uniform vec2 uTapMix[ TAPS ];
uniform int uMaxBounces;

vec3 envDispersed( vec3 ro, vec3 rd, vec3 sR, vec3 sB ) {
	if ( uDispersionOn < 0.5 || dot( sR, sR ) + dot( sB, sB ) < 1e-10 ) return environment( ro, rd );
	vec3 c = vec3( 0.0 );
	for ( int k = 0; k < TAPS; k ++ ) {
		vec3 d = normalize( rd + sR * uTapMix[ k ].x + sB * uTapMix[ k ].y );
		c += uTapWeight[ k ] * environment( ro, d );
	}
	return c;
}

vec3 fresnelRGB( float cosI, bool entering, vec3 p ) {
	float n = uIorRGB.y;
	float F = fresnelDielectric( cosI, entering ? n : 1.0 / n );
	if ( uIridescence <= 0.0 ) return vec3( F );
	float d = filmThickness( p );
	float n1 = entering ? 1.0 : n;
	float n3 = entering ? n : 1.0;
	vec3 Ff = vec3(
		thinFilmReflectance( cosI, n1, uFilmIor, n3, d, 640.0 ),
		thinFilmReflectance( cosI, n1, uFilmIor, n3, d, 550.0 ),
		thinFilmReflectance( cosI, n1, uFilmIor, n3, d, 450.0 ) );
	return mix( vec3( F ), Ff, uIridescence );
}

// Deterministic, noise-free approximation: follows the dominant path (refraction, or reflection on
// total internal reflection) and adds the minor branch as a single environment lookup.
vec4 trace( vec3 ro, vec3 rd, vec2 uv ) {
	vec3 col = vec3( 0.0 );
	vec3 thr = vec3( 1.0 );
	vec3 sR = vec3( 0.0 );
	vec3 sB = vec3( 0.0 );
	int inside = 0;
	float alpha = 0.0;

	for ( int b = 0; b < 32; b ++ ) {
		if ( b >= uMaxBounces ) break;
		uvec4 faceIndices = uvec4( 0u );
		vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
		vec3 barycoord = vec3( 0.0 );
		float side = 1.0;
		float dist = 0.0;
		bool hit = bvhIntersectFirstHit( bvh, ro, rd, faceIndices, faceNormal, barycoord, side, dist );
		if ( ! hit ) {
			if ( b == 0 ) return vec4( primaryMiss( ro, rd, uv ), 0.0 );
			return vec4( col + thr * envDispersed( ro, rd, sR, sB ), alpha );
		}
		alpha = 1.0;
		vec3 p = ro + rd * dist;
		if ( inside > 0 ) thr *= exp( - uAbsorb * dist );
		bool front = side > 0.0;
		vec3 Ng = faceNormal;
		if ( front ) {
			inside ++;
			if ( inside > 1 ) { ro = p - Ng * uEps; continue; }
		} else {
			inside = max( inside - 1, 0 );
			if ( inside > 0 ) { ro = p - Ng * uEps; continue; }
		}
		vec3 Ns = normalize( textureSampleBarycoord( normalAttribute, barycoord, faceIndices.xyz ).xyz );
		if ( ! front ) Ns = - Ns;
		if ( dot( Ns, rd ) >= 0.0 ) Ns = Ng;

		float cosI = clamp( - dot( rd, Ns ), 0.0, 1.0 );
		float etaG = front ? 1.0 / uIorRGB.y : uIorRGB.y;
		vec3 refl = reflect( rd, Ns );
		vec3 refrG = refract( rd, Ns, etaG );

		if ( dot( refrG, refrG ) < 1e-8 ) {
			// total internal reflection: all light stays inside
			sR = reflect( rd + sR, Ns ) - refl;
			sB = reflect( rd + sB, Ns ) - refl;
			rd = refl;
			ro = p + Ng * uEps;
			inside = 1;
			continue;
		}

		vec3 F = fresnelRGB( cosI, front, p );
		vec3 dR = normalize( rd + sR );
		vec3 dB = normalize( rd + sB );
		vec3 rR = refract( dR, Ns, front ? 1.0 / uIorRGB.x : uIorRGB.x );
		vec3 rB = refract( dB, Ns, front ? 1.0 / uIorRGB.z : uIorRGB.z );

		if ( front ) {
			col += thr * F * environment( p + Ng * uEps, refl );
		} else {
			// partial internal reflection, approximated by the environment in that direction
			col += thr * F * environment( p, refl ) * 0.6;
		}
		thr *= 1.0 - F;
		sR = dot( rR, rR ) > 1e-8 ? rR - refrG : vec3( 0.0 );
		sB = dot( rB, rB ) > 1e-8 ? rB - refrG : vec3( 0.0 );
		rd = refrG;
		ro = p - Ng * uEps;
		if ( max( thr.r, max( thr.g, thr.b ) ) < 0.002 ) return vec4( col, alpha );
	}
	return vec4( col + thr * envDispersed( ro, rd, sR, sB ), alpha );
}

uniform sampler2D uPrev;
uniform int uSample;        // > 0: accumulate jittered passes (anti-aliasing for offline renders)
uniform vec2 uJitter;

out vec4 fragColor;
void main() {
	vec2 uv;
	vec3 rd = cameraDir( gl_FragCoord.xy + uJitter, uv );
	vec4 c = trace( uCamPos, rd, uv );
	if ( uSample > 0 ) c = mix( texelFetch( uPrev, ivec2( gl_FragCoord.xy ), 0 ), c, 1.0 / float( uSample + 1 ) );
	fragColor = c;
}
`;

const pathGLSL = /* glsl */ `
uniform sampler2D uPrev;
uniform int uSample;
uniform uint uSeed;
uniform vec2 uCauchy;           // n(λ) = A + B / λ² (λ in µm)
uniform float uDispersion;      // > 0 when dispersion is enabled
uniform vec3 uSpecNorm;
uniform float uLensRadius;
uniform float uFocusDist;
uniform int uMaxBounces;

uint pcg( inout uint state ) {
	state = state * 747796405u + 2891336453u;
	uint word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
	return ( word >> 22u ) ^ word;
}

float rand( inout uint s ) {
	return float( pcg( s ) ) * ( 1.0 / 4294967296.0 );
}

// Cranley-Patterson rotated rank-1 sequence: stratified across samples of the same pixel
float seq( float offset, float alpha ) {
	return fract( offset + float( uSample ) * alpha );
}

float gauss( float x, float mu, float s1, float s2 ) {
	float t = ( x - mu ) / ( x < mu ? s1 : s2 );
	return exp( - 0.5 * t * t );
}

vec3 spectralWeight( float l ) {
	float x = 1.056 * gauss( l, 599.8, 37.9, 31.0 ) + 0.362 * gauss( l, 442.0, 16.0, 26.7 ) - 0.065 * gauss( l, 501.1, 20.4, 26.2 );
	float y = 0.821 * gauss( l, 568.8, 46.9, 40.5 ) + 0.286 * gauss( l, 530.9, 16.3, 31.1 );
	float z = 1.217 * gauss( l, 437.0, 11.8, 36.0 ) + 0.681 * gauss( l, 459.0, 26.0, 13.8 );
	vec3 rgb = vec3(
		3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
		- 0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
		0.0556434 * x - 0.2040259 * y + 1.0572252 * z );
	return rgb / uSpecNorm;
}

vec2 concentricDisk( vec2 u ) {
	vec2 o = 2.0 * u - 1.0;
	if ( o.x == 0.0 && o.y == 0.0 ) return vec2( 0.0 );
	float r, th;
	if ( abs( o.x ) > abs( o.y ) ) { r = o.x; th = 0.785398163 * ( o.y / o.x ); }
	else { r = o.y; th = 1.570796327 - 0.785398163 * ( o.x / o.y ); }
	return r * vec2( cos( th ), sin( th ) );
}

uniform float uBranchMix;

// stratified choice for the first branch decisions (they dominate the variance)
float branchRand( int b, vec4 offs, inout uint rng ) {
	if ( b == 0 ) return seq( offs.x, 0.2360679775 );
	if ( b == 1 ) return seq( offs.y, 0.6457513111 );
	if ( b == 2 ) return seq( offs.z, 0.3166247904 );
	if ( b == 3 ) return seq( offs.w, 0.8284271247 );
	return rand( rng );
}

vec4 trace( vec3 ro, vec3 rd, vec2 uv, float lambda, vec4 offs, inout uint rng ) {
	float n = uCauchy.x + uCauchy.y / ( lambda * lambda * 1e-6 );
	bool spectral = false;
	vec3 thr = vec3( 1.0 );
	int inside = 0;
	float alpha = 0.0;
	vec3 w = spectralWeight( lambda );

	for ( int b = 0; b < 64; b ++ ) {
		if ( b >= uMaxBounces ) break;
		uvec4 faceIndices = uvec4( 0u );
		vec3 faceNormal = vec3( 0.0, 0.0, 1.0 );
		vec3 barycoord = vec3( 0.0 );
		float side = 1.0;
		float dist = 0.0;
		bool hit = bvhIntersectFirstHit( bvh, ro, rd, faceIndices, faceNormal, barycoord, side, dist );
		if ( ! hit ) {
			vec3 L = b == 0 ? primaryMiss( ro, rd, uv ) : environment( ro, rd );
			return vec4( thr * L * ( spectral ? w : vec3( 1.0 ) ), alpha );
		}
		alpha = 1.0;
		vec3 p = ro + rd * dist;
		if ( inside > 0 ) thr *= exp( - uAbsorb * dist );
		bool front = side > 0.0;
		vec3 Ng = faceNormal;
		if ( front ) {
			inside ++;
			if ( inside > 1 ) { ro = p - Ng * uEps; continue; }
		} else {
			inside = max( inside - 1, 0 );
			if ( inside > 0 ) { ro = p - Ng * uEps; continue; }
		}
		vec3 Ns = normalize( textureSampleBarycoord( normalAttribute, barycoord, faceIndices.xyz ).xyz );
		if ( ! front ) Ns = - Ns;
		if ( dot( Ns, rd ) >= 0.0 ) Ns = Ng;

		float cosI = clamp( - dot( rd, Ns ), 0.0, 1.0 );
		float eta = front ? n : 1.0 / n;
		float F = fresnelDielectric( cosI, eta );
		if ( uIridescence > 0.0 && F < 1.0 ) {
			float Ff = thinFilmReflectance( cosI, front ? 1.0 : n, uFilmIor, front ? n : 1.0, filmThickness( p ), lambda );
			F = mix( F, Ff, uIridescence );
			spectral = true;
		}
		vec3 t = refract( rd, Ns, 1.0 / eta );
		bool tir = F >= 1.0 || dot( t, t ) < 1e-8;
		// pick reflection more often than F alone would (bright reflections are rare but strong),
		// compensating with the branch weight
		float pr = tir ? 1.0 : mix( F, 0.5, uBranchMix );
		if ( branchRand( b, offs, rng ) < pr ) {
			if ( ! tir ) thr *= F / pr;
			rd = reflect( rd, Ns );
			ro = p + Ng * uEps;
			inside = front ? 0 : 1;
		} else {
			thr *= ( 1.0 - F ) / ( 1.0 - pr );
			rd = t;
			ro = p - Ng * uEps;
			if ( uDispersion > 0.0 ) spectral = true;
		}
	}
	return vec4( thr * environment( ro, rd ) * ( spectral ? w : vec3( 1.0 ) ), alpha );
}

uniform sampler2D uActive;      // convergence mask, one texel per block
uniform int uUseMask;

out vec4 fragColor;
void main() {
	ivec2 ip = ivec2( gl_FragCoord.xy );
	if ( uUseMask == 1 && texelFetch( uActive, ip / ${BLOCK}, 0 ).r < 0.5 ) {
		fragColor = texelFetch( uPrev, ip, 0 );
		return;
	}
	uint rng = uint( ip.x ) * 1973u + uint( ip.y ) * 9277u + uSeed * 26699u + uint( uSample ) * 1597334677u;
	rng = rng | 1u;
	pcg( rng );
	// per-pixel rotations of the stratified sequences
	float o1 = rand( rng );
	float o2 = rand( rng );
	float o3 = rand( rng );
	float o4 = rand( rng );
	float o5 = rand( rng );

	vec2 jitter = vec2( seq( o1, 0.7548776662 ), seq( o2, 0.5698402910 ) );
	vec2 uv;
	vec3 rd = cameraDir( floor( gl_FragCoord.xy ) + jitter, uv );
	vec3 ro = uCamPos;
	if ( uLensRadius > 0.0 ) {
		vec3 focus = uCamPos + rd * ( uFocusDist / dot( rd, uCamFwd ) );
		vec2 disk = concentricDisk( vec2( seq( o3, 0.4142135624 ), seq( o4, 0.7320508076 ) ) ) * uLensRadius;
		ro = uCamPos + uCamRight * disk.x + uCamUp * disk.y;
		rd = normalize( focus - ro );
	}
	float lambda = mix( 380.0, 730.0, seq( o5, 0.6180339887 ) );
	vec4 offs = vec4( rand( rng ), rand( rng ), rand( rng ), rand( rng ) );
	vec4 s = trace( ro, rd, uv, lambda, offs, rng );
	// clamp extreme outliers so single samples cannot dominate the average
	s.rgb = clamp( s.rgb, vec3( - 64.0 ), vec3( 64.0 ) );
	// alpha carries the second moment of the sample mean (rgb average) for the convergence test
	float m = ( s.r + s.g + s.b ) / 3.0;
	s.a = m * m;
	vec4 prev = texelFetch( uPrev, ip, 0 );
	fragColor = uSample == 0 ? s : mix( prev, s, 1.0 / float( uSample + 1 ) );
}
`;

function header(): string {
  return /* glsl */ `
precision highp float;
precision highp int;
precision highp isampler2D;
precision highp usampler2D;
#define BVH_STACK_DEPTH 32
${BVHShaderGLSL.common_functions}
${BVHShaderGLSL.bvh_struct_definitions}
${BVHShaderGLSL.bvh_ray_functions}
`;
}

export function buildTraceShader(mode: 'preview' | 'path'): string {
  return [
    header(),
    commonUniforms,
    environmentGLSL,
    opticsGLSL,
    cameraGLSL,
    mode === 'preview' ? previewGLSL : pathGLSL,
  ].join('\n');
}
