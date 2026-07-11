/**
 * FLUID (流体) — GLSL sources for the Stam stable-fluids pipeline.
 *
 * Every pass renders the shared fullscreen triangle (FS_TRIANGLE_VS,
 * `in vec2 vUv` in [0,1]²) and targets GLSL ES 3.00.
 *
 * Conventions:
 *  - velocity: RG16F ping-pong, units = velocity-grid texels / second
 *  - dye:      RGBA16F ping-pong, linear-light HDR color
 *  - all float textures use NEAREST; every smooth sample is a manual bilerp
 *    (linear filtering of float textures is not guaranteed)
 *  - splat / pulse positions are in "q-space": device px / min(w, h),
 *    so x ∈ [0, aspectX], y ∈ [0, aspectY] and min(aspectX, aspectY) = 1;
 *    radii are fractions of the short screen side.
 */

export const MAX_SPLATS = 16;

const BILERP = `
vec4 bilerp(sampler2D t, vec2 uv, vec2 texel) {
  vec2 st = uv / texel - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec4 a = texture(t, (i + vec2(0.5, 0.5)) * texel);
  vec4 b = texture(t, (i + vec2(1.5, 0.5)) * texel);
  vec4 c = texture(t, (i + vec2(0.5, 1.5)) * texel);
  vec4 d = texture(t, (i + vec2(1.5, 1.5)) * texel);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/**
 * Semi-Lagrangian advection with manual bilinear taps + dissipation.
 * `self = true` is the velocity-by-itself variant: the trace start lands
 * exactly on a texel center, so the bilerp degenerates to one NEAREST tap.
 */
export function makeAdvectFS(self: boolean): string {
  return `#version 300 es
precision highp float;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uVelTexel;   // 1 / velocity grid size
uniform vec2 uSrcTexel;   // 1 / source grid size
uniform float uDt;
uniform float uDissipation;
in vec2 vUv;
out vec4 outColor;
${BILERP}
void main() {
  vec2 vel = ${self ? 'texture(uVelocity, vUv).xy' : 'bilerp(uVelocity, vUv, uVelTexel).xy'};
  vec2 coord = vUv - uDt * vel * uVelTexel;
  outColor = uDissipation * bilerp(uSource, coord, uSrcTexel);
}
`;
}

/**
 * Batched gaussian splats, drawn with additive blending (ONE, ONE) straight
 * into the 16F target. Used for velocity forces (uVal.xy) and dye (uVal.rgb).
 */
export const SPLAT_FS = `#version 300 es
precision highp float;
#define MAX_SPLATS ${MAX_SPLATS}
uniform vec2 uAspect;                 // (w/min, h/min)
uniform int uCount;
uniform vec4 uPosRad[MAX_SPLATS];     // xy = pos (q-space), z = radius (q)
uniform vec4 uVal[MAX_SPLATS];        // value added at the gaussian center
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 q = vUv * uAspect;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uCount) break;
    vec2 d = q - uPosRad[i].xy;
    float rr = uPosRad[i].z * uPosRad[i].z;
    float d2 = dot(d, d);
    if (d2 < 9.0 * rr) sum += uVal[i] * exp(-d2 / rr); // >3σ contributes nothing
  }
  outColor = sum;
}
`;

/** Curl (scalar vorticity) of the velocity field. */
export const CURL_FS = `#version 300 es
precision highp float;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}
`;

/** Vorticity confinement — sharpens filaments instead of letting them blur. */
export const VORTICITY_FS = `#version 300 es
precision highp float;
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform vec2 uTexel;
uniform float uStrength;
uniform float uDt;
in vec2 vUv;
out vec4 outColor;
void main() {
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uStrength * C;
  force.y *= -1.0;
  vec2 velocity = texture(uVelocity, vUv).xy + force * uDt;
  outColor = vec4(clamp(velocity, vec2(-2000.0), vec2(2000.0)), 0.0, 1.0);
}
`;

/** Divergence with reflected (no-through) boundary velocities. */
export const DIVERGENCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vUv.x - uTexel.x < 0.0) { L = -C.x; }
  if (vUv.x + uTexel.x > 1.0) { R = -C.x; }
  if (vUv.y - uTexel.y < 0.0) { B = -C.y; }
  if (vUv.y + uTexel.y > 1.0) { T = -C.y; }
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}
`;

/** Scale a field by a constant — pressure warm start (p *= 0.8). */
export const CLEAR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uValue;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = uValue * texture(uTex, vUv); }
`;

/** One Jacobi pressure iteration. */
export const PRESSURE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float divergence = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}
`;

/** Subtract the pressure gradient → (approximately) divergence-free velocity. */
export const GRADIENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 outColor;
void main() {
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(velocity, 0.0, 1.0);
}
`;

/**
 * Pulse shockwave: an expanding gaussian ring, additively blended.
 * uMode 0 → radial velocity impulse; uMode 1 → dye ring.
 */
export const PULSE_FS = `#version 300 es
precision highp float;
uniform vec2 uAspect;
uniform vec2 uCenter;    // q-space
uniform float uRadius;   // ring radius, q units
uniform float uWidth;    // ring thickness, q units
uniform float uVelAmp;   // velocity-grid texels/s at the ring crest
uniform vec3 uColor;
uniform float uDyeAmp;
uniform float uMode;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 q = vUv * uAspect;
  vec2 d = q - uCenter;
  float len = length(d) + 1e-5;
  float x = (len - uRadius) / uWidth;
  float g = exp(-x * x);
  if (uMode < 0.5) {
    outColor = vec4((d / len) * (uVelAmp * g), 0.0, 0.0);
  } else {
    outColor = vec4(uColor * (uDyeAmp * g), 0.0);
  }
}
`;

/**
 * Present the dye field in HDR linear light (into the post composer's scene
 * target, allocated at exactly dye resolution so one NEAREST tap is exact —
 * the post composer upsamples with LINEAR). Soft low-end suppression keeps
 * stray haze from greying the voids while filament cores stay hot for bloom.
 */
export const RENDER_FS = `#version 300 es
precision highp float;
uniform sampler2D uDye;
uniform vec3 uBg;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 dye = max(texture(uDye, vUv).rgb, 0.0);
  float l = max(dye.r, max(dye.g, dye.b));
  float shape = 0.5 + 0.85 * smoothstep(0.01, 0.7, l);
  outColor = vec4(uBg + dye * shape, 1.0);
}
`;
