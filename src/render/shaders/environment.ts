/** Studio environment: analytic light cards, a gradient dome and the background projection. */
export const MAX_LIGHTS = 16;

export const environmentGLSL = /* glsl */ `
#define MAX_LIGHTS ${MAX_LIGHTS}

uniform int uLightCount;
uniform vec3 uLightPos[MAX_LIGHTS];
uniform vec3 uLightU[MAX_LIGHTS];      // right axis divided by half width
uniform vec3 uLightV[MAX_LIGHTS];      // up axis divided by half height
uniform vec3 uLightN[MAX_LIGHTS];      // emitting side normal (towards the object)
uniform vec4 uLightColor[MAX_LIGHTS];  // radiance, w = visible to camera
uniform vec2 uLightShape[MAX_LIGHTS];  // x = shape id, y = softness

uniform vec3 uDomeTop;
uniform vec3 uDomeHorizon;
uniform vec3 uDomeBottom;

uniform sampler2D uBgLut;   // HDR gradient, 256 x 1
uniform int uBgType;        // 0 solid, 1 linear, 2 radial
uniform vec4 uBgParams;     // linear: dir.xy, extent; radial: centre.xy, radius
uniform float uGlassInfluence;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform float uTanHalfFov;
uniform float uFrameAspect;

float lightMask( vec2 uv, vec2 sh ) {
	float soft = max( sh.y, 0.002 );
	if ( sh.x < 0.5 ) {
		vec2 a = abs( uv );
		return ( 1.0 - smoothstep( 1.0 - soft, 1.0, a.x ) ) * ( 1.0 - smoothstep( 1.0 - soft, 1.0, a.y ) );
	} else if ( sh.x < 1.5 ) {
		return 1.0 - smoothstep( 1.0 - soft, 1.0, length( uv ) );
	} else if ( sh.x < 2.5 ) {
		float d = abs( length( uv ) - 0.8 ) / 0.2;
		return 1.0 - smoothstep( 1.0 - soft, 1.0, d );
	}
	// gradient strip: soft along its width, fading along its length
	vec2 a = abs( uv );
	float m = ( 1.0 - smoothstep( 1.0 - soft, 1.0, a.x ) ) * ( 1.0 - smoothstep( 0.92, 1.0, a.y ) );
	return m * mix( 1.0, 0.12, smoothstep( -1.0, 1.0, uv.y ) );
}

// Emission seen along a ray and the fraction of the background not covered by cards.
void lightsAlong( vec3 ro, vec3 rd, bool primary, out vec3 emit, out float transmit ) {
	emit = vec3( 0.0 );
	transmit = 1.0;
	for ( int i = 0; i < MAX_LIGHTS; i ++ ) {
		if ( i >= uLightCount ) break;
		if ( primary && uLightColor[ i ].w < 0.5 ) continue;
		vec3 n = uLightN[ i ];
		float denom = dot( rd, n );
		if ( abs( denom ) < 1e-6 ) continue;
		float t = dot( uLightPos[ i ] - ro, n ) / denom;
		if ( t <= 0.0 ) continue;
		vec3 q = ro + rd * t - uLightPos[ i ];
		vec2 uv = vec2( dot( q, uLightU[ i ] ), dot( q, uLightV[ i ] ) );
		float m = lightMask( uv, uLightShape[ i ] );
		if ( m <= 0.0 ) continue;
		if ( denom < 0.0 ) emit += transmit * uLightColor[ i ].rgb * m;
		transmit *= 1.0 - m;
	}
}

vec3 dome( vec3 d ) {
	float y = clamp( d.y, - 1.0, 1.0 );
	return y >= 0.0
		? mix( uDomeHorizon, uDomeTop, sqrt( y ) )
		: mix( uDomeHorizon, uDomeBottom, sqrt( - y ) );
}

float gradientCoord( vec2 uv ) {
	if ( uBgType == 0 ) return 0.0;
	vec2 p = ( uv - 0.5 ) * vec2( uFrameAspect, 1.0 );
	if ( uBgType == 1 ) return clamp( 0.5 + dot( p, uBgParams.xy ) / uBgParams.z, 0.0, 1.0 );
	vec2 c = ( uBgParams.xy - 0.5 ) * vec2( uFrameAspect, 1.0 );
	return clamp( length( p - c ) / uBgParams.z, 0.0, 1.0 );
}

vec3 backgroundAt( vec2 uv ) {
	return texture( uBgLut, vec2( gradientCoord( uv ) * ( 255.0 / 256.0 ) + 0.5 / 256.0, 0.5 ) ).rgb;
}

// The background as seen through the glass: a finite backdrop behind the object that covers the
// frame plus a margin, like seamless paper in a studio. Rays bent past its edge see the studio,
// which gives glass its dark contour lines.
vec3 backdropDir( vec3 d ) {
	float f = dot( d, uCamFwd );
	if ( f <= 0.02 ) return dome( d );
	vec2 ndc = vec2( dot( d, uCamRight ) / uFrameAspect, dot( d, uCamUp ) ) / ( f * uTanHalfFov );
	float edge = max( abs( ndc.x ) * min( uFrameAspect, 1.0 ), abs( ndc.y ) * min( 1.0 / uFrameAspect, 1.0 ) );
	float cover = 1.0 - smoothstep( 1.1, 1.35, edge );
	return mix( dome( d ), backgroundAt( ndc * 0.5 + 0.5 ), cover );
}

vec3 environment( vec3 ro, vec3 rd ) {
	vec3 e;
	float tr;
	lightsAlong( ro, rd, false, e, tr );
	vec3 bg = mix( dome( rd ), backdropDir( rd ), uGlassInfluence );
	return e + tr * bg;
}

vec3 primaryMiss( vec3 ro, vec3 rd, vec2 uv ) {
	vec3 e;
	float tr;
	lightsAlong( ro, rd, true, e, tr );
	return e + tr * backgroundAt( uv );
}
`;
