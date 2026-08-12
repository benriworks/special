/**
 * HEARTH — 暖炉. GLSL sources.
 *
 * Two flame-body engines share one composite:
 *  (a) SIM — RGBA16F ping-pong heat/velocity field (vx, vy, heat, –), texel
 *      units like fluid: semi-Lagrangian self-advection + buoyancy +
 *      analytic curl-noise turbulence + height cooling. Heat / stir / bellows
 *      / kindling are injected as batched gaussian splats (fluid idiom).
 *      Runs on hardware GL — the most honest flame motion.
 *  (b) FBM — fully procedural: an emitter "bed profile" (CPU-flickered
 *      gaussians) shaped by a height envelope, domain-warped by rising value
 *      noise (licks) and carved by a faster second octave (tongue separation
 *      + detached wisps). This is the software-GL preset; stirs/bellows/wind
 *      bend the noise domain directly.
 *
 * The composite draws, in q-space (device px / min(w,h), y up):
 * firebox wall + arch + floor spill → banked coal bed (Worley cells breathing
 * individually) → log silhouettes (capsule SDFs, bark striations, pulsing
 * crack veins) → the flame body mapped dark→bright through the theme palette
 * → pop flash. Heat shimmer pre-distorts the sampling coordinate above the
 * fire. Sparks are a separate MRT particle pool drawn as velocity-elongated
 * gl.LINES additively into the HDR scene after the composite.
 */

/** Max gaussian splats per injection flush (sim path). */
export const MAX_SPLATS = 16;
/** Max spark spawn events flushed to the GPU per sim step. */
export const MAX_SEVENTS = 8;

// Spark spawn kinds (shared TS/GLSL).
export const SK_COAL = 0;     // ember drifting up from the coal bed
export const SK_STROKE = 1;   // poker stroke — kicked along the drag segment
export const SK_POP = 2;      // pop burst — radial, up-biased
export const SK_FOUNTAIN = 3; // kindling toss / bellows rush — strong updraft

/** Sin-free hashes + value noise (SwiftShader pays dearly for sin()). */
const NOISE = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), w.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), w.x), w.y);
}
float fbm2(vec2 p) { return 0.64 * vnoise(p) + 0.36 * vnoise(p * 2.17 + 11.3); }
`;

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
 * Sim path (a): one field update step. RGBA16F = (vx, vy, heat, –), velocity
 * in field texels/s. Self-advection lands on a texel center (single NEAREST
 * tap), source re-sampled with manual bilerp. Forces: buoyancy ∝ heat,
 * divergence-free curl of a scrolling value-noise potential (strong where hot,
 * faint in cold air), audio wind gust. Heat cools faster with height.
 */
export const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform vec2 uAspect;    // q-space extents
uniform float uDt;
uniform float uT;
uniform float uBase;     // hearth baseline y (q)
uniform float uSimMin;   // field texels per q unit
uniform float uWindG;    // gust, q/s
uniform float uBuoy;     // q/s^2 per unit heat
uniform float uTurb;     // curl swirl amplitude, q/s
in vec2 vUv;
out vec4 outColor;
${NOISE}
${BILERP}
void main() {
  vec2 vel0 = texture(uField, vUv).xy;
  vec4 s = bilerp(uField, vUv - uDt * vel0 * uTexel, uTexel);
  vec2 q = vUv * uAspect;
  // curl of a rising noise potential — cheap incompressible turbulence
  float e = 0.07;
  vec2 np = vec2(q.x * 2.6, q.y * 1.9 - uT * 1.1);
  float nT = vnoise(np + vec2(0.0, e * 1.9));
  float nB = vnoise(np - vec2(0.0, e * 1.9));
  float nR = vnoise(np + vec2(e * 2.6, 0.0));
  float nL = vnoise(np - vec2(e * 2.6, 0.0));
  vec2 curl = vec2(nT - nB, nL - nR) / (2.0 * e);
  float heat = max(s.z, 0.0);
  vec2 v = s.xy;
  float sw = clamp(heat * 1.6, 0.12, 1.0); // hot column churns, cold air barely
  v += (vec2(uWindG, uBuoy * min(heat, 1.5)) + curl * (uTurb * sw)) * (uDt * uSimMin);
  v *= exp(-2.3 * uDt);
  heat *= exp(-uDt * (1.15 + 2.6 * max(0.0, q.y - uBase - 0.12)));
  outColor = vec4(v, min(heat, 1.5), 0.0);
}
`;

/**
 * Batched gaussian splats, additively blended into the RGBA16F field
 * (fluid idiom). uVal = (vx, vy, heat, 0) in field texels/s + heat units.
 */
export const SPLAT_FS = `#version 300 es
precision highp float;
#define MAX_SPLATS ${MAX_SPLATS}
uniform vec2 uAspect;
uniform int uCount;
uniform vec4 uPosRad[MAX_SPLATS]; // xy = pos (q), z = radius (q)
uniform vec4 uVal[MAX_SPLATS];
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
    if (d2 < 9.0 * rr) sum += uVal[i] * exp(-d2 / rr);
  }
  outColor = sum;
}
`;

/**
 * The composite. `useSim` picks the flame-heat source; everything else —
 * coloring, logs, coals, shimmer, spill — is shared between (a) and (b).
 */
export function makeCompositeFS(useSim: boolean): string {
  // Flame body — sim variant: field heat modulated by a fast rising noise
  // octave for sub-grid tongue detail (motion/bending comes from the sim).
  const FLAME_SIM = `
float flameHeat(vec2 q) {
  float hs = bilerp(uHeat, vec2(q.x, q.y + uBase) / uAspect, uHeatTexel).z;
  if (hs < 0.01) return 0.0;
  float yy = q.y - FLAME_BASE;
  // sub-grid tongue detail: the same fast rising ridge noise as (b); motion
  // and bending come from the advected field itself
  vec2 p2 = vec2(q.x * 7.0 + 9.7, q.y * 3.6 - uT * 2.7);
  float n2 = fbm2(p2);
  float heat = clamp(hs * (0.30 + 1.0 * n2), 0.0, 1.0) * smoothstep(0.02, 0.2, hs);
  heat *= smoothstep(-0.1, 0.02, yy);
  // temperature: the field is hottest where dense — reuse it for the ramp
  return heat * (0.4 + 0.8 * min(hs, 1.0)) * uGlow;
}
`;

  // Flame body — procedural variant: bed profile × height envelope, licked by
  // warped rising noise, carved by a faster octave. Stirs bend the domain
  // (poker), bellows raise the local bed, gusts shear everything downwind.
  const FLAME_FBM = `
float bedAt(float x) {
  float b = 0.0;
  for (int i = 0; i < 5; i++) {
    float dx = (x - uEmit[i].x) / uEmit[i].y;
    b += uEmit[i].z * exp(-dx * dx);
  }
  float bx = (x - uBellows.x) / (0.16 * uBedHalf * 2.4);
  b += uBellows.z * 1.25 * exp(-bx * bx);
  return b;
}
float flameHeat(vec2 q) {
  float yy = q.y - FLAME_BASE;
  if (yy < -0.045 || yy > 0.95) return 0.0;
  if (abs(q.x - uCx) > uBedHalf + 0.30) return 0.0;
  // poker stirs: column influence — soft in y so strokes above the fire fan it
  vec2 off = vec2(0.0);
  float stirB = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 d = q - uStir[i].xy;
    float g = exp(-d.x * d.x * 55.0 - max(0.0, -d.y) * max(0.0, -d.y) * 40.0
                  - max(0.0, d.y) * max(0.0, d.y) * 7.0);
    off += uStir[i].zw * g;
    stirB += length(uStir[i].zw) * g;
  }
  // body sway (slow, tall octaves) → warped x = which tongue owns this pixel
  float n1 = fbm2(vec2(q.x * 4.2, q.y * 1.9 - uT * 1.45));
  float xw = q.x + (n1 - 0.5) * (0.12 + 0.45 * yy) + off.x * 0.8
           + uWindG * (0.30 + 0.5 * yy) * yy;
  float b = min(bedAt(xw), 1.35);
  if (b < 0.03) return 0.0;
  float H = (0.18 + 0.46 * b) * uFlameH * (1.0 + off.y * 0.9);
  float env = 1.0 - yy / max(H, 0.03);       // 1 at the bed → 0 at the tip
  if (env < -0.35) return 0.0;
  // tongue ridge: fast rising noise (~9Hz micro-flicker from the scroll rate).
  // Noise must EXCEED the height fraction for flame to survive → textured
  // base, licks separating mid-height, detached wisps past the tip.
  vec2 p2 = vec2(xw * 7.0 + 9.7, q.y * 3.6 - uT * 2.7);
  float n2 = uDetail > 0.5 ? fbm2(p2) : vnoise(p2);
  float cut = 1.0 - env;
  float heat = clamp(n2 * 1.2 + 0.2 - cut * 1.15, 0.0, 1.0);
  heat *= 0.62 + 0.38 * n2;                  // never flat, even in the body
  heat *= smoothstep(-0.045, 0.06, yy);      // roots fade in at the bed
  heat *= smoothstep(-0.35, -0.02, env);     // wisps taper out
  heat *= min(1.0, b * 1.6);
  heat *= 1.0 + stirB * 0.8 + uKindle * 0.45;
  // temperature: white-hot near the bed core, cooling toward tips and edges
  return heat * (0.30 + 0.75 * clamp(env, 0.0, 1.0)) * uGlow;
}
`;

  return `#version 300 es
precision highp float;
uniform vec2 uAspect;
uniform float uT;
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform float uLum;      // ~100ms-lagged fire luminance (light spill follows)
uniform float uFlameH;   // global flame height scale (bank×intensity×audio)
uniform float uGlow;     // flame brightness scale
uniform float uKindle;   // pulse kindling envelope 0..1
uniform float uWindG;    // audio blow gust, signed
uniform float uShim;     // heat-shimmer strength param
uniform float uDetail;   // 1 = full octaves, 0 = lean (perf governor)
uniform float uBase;     // hearth baseline y (q) — composite works above it
uniform float uCx;       // fire bed center x (q)
uniform float uBedHalf;  // fire bed half width (q)
uniform vec4 uEmit[5];   // x, halfwidth, flicker, –
uniform vec4 uLogA[3];   // capsule endpoints ax, ay, bx, by (settle baked in)
uniform vec4 uLogB[3];   // radius, seed, settleGlow, –
uniform vec4 uEmbers[6]; // kindled coal spots: x, y, strength, –
uniform vec4 uStir[8];   // x, y, velx·env, vely·env  (poker strokes)
uniform vec4 uPop;       // x, y, flash, coalFlare
uniform vec4 uBellows;   // x, y, strength, –
${useSim ? 'uniform sampler2D uHeat;\nuniform vec2 uHeatTexel;' : ''}
in vec2 vUv;
out vec4 outColor;

const float FLAME_BASE = 0.10;
${NOISE}
${useSim ? BILERP : ''}
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
/** Temperature → color: palette dark→bright with an HDR-hot core. */
vec3 fireCol(float h) {
  float t = clamp(h, 0.0, 1.0);
  return pal(pow(t, 0.88)) * (0.08 + 2.6 * t * t);
}
${useSim ? FLAME_SIM : FLAME_FBM}

void main() {
  vec2 q = vUv * uAspect;
  q.y -= uBase; // hearth space: y = 0 is the hearth floor line

  // ---- heat shimmer: refract the whole scene above the fire --------------
  float sa = uShim * (0.006 + 0.012 * uLum) * smoothstep(0.24, 0.8, q.y);
  if (sa > 0.0004) {
    float s1 = vnoise(vec2(q.x * 5.2, q.y * 3.1 - uT * 2.2));
    float s2 = uDetail > 0.5 ? vnoise(vec2(q.x * 9.9 + 3.7, q.y * 6.3 - uT * 3.6)) : 0.5;
    q += vec2((s1 - 0.5) + (s2 - 0.5) * 0.7, (s2 - 0.5) * 0.5) * sa;
  }

  // ---- firebox wall, arch, floor spill -----------------------------------
  float stone = vnoise(vec2(q.x * 3.4, q.y * 3.0));
  vec3 col = uBg * (0.42 + 0.40 * stone);
  vec2 wd = vec2((q.x - uCx) * 1.05, (q.y - 0.18) * 1.35);
  float wl = exp(-dot(wd, wd) * 2.8);
  col += pal(0.42) * (wl * uLum * (0.09 + 0.09 * stone));      // firelight on the wall
  vec2 ad = vec2(q.x - uCx, q.y) / vec2(uBedHalf + 0.36, 1.45);
  float aD = length(ad);
  col *= 1.0 - 0.4 * smoothstep(0.92, 1.5, aD);                // beyond the arch: dark
  float rim = (aD - 1.0) / 0.05;
  // faint warm arch rim, strongest low (side pillars), dissolving overhead
  col += pal(0.5) * (exp(-rim * rim) * (0.010 + 0.035 * uLum) * smoothstep(1.15, 0.35, q.y));
  // hearth floor: everything below the baseline, warm spill fading downward
  float fl = smoothstep(0.055, 0.0, q.y);
  col = mix(col, uBg * 0.9, fl * 0.4);
  col += pal(0.58) * (fl * uLum * 0.12 * (0.5 + 0.5 * stone) * exp(min(q.y, 0.0) * 5.0));

  float bedMask = smoothstep(uBedHalf + 0.10, uBedHalf - 0.14, abs(q.x - uCx));

  // ---- banked coal bed: a contiguous glowing mass fractured into Worley
  // cells whose cores breathe individually; dark ash seams between ----------
  if (q.y < 0.16 && q.y > -0.2 && bedMask > 0.003) {
    // irregular coal pieces: jittered cells + per-cell size/brightness spread
    vec2 cp = vec2(q.x * 19.0, q.y * 34.0 + vnoise(q * 9.0) * 1.4);
    vec2 ci = floor(cp);
    vec2 cf = fract(cp);
    float d1 = 8.0;
    vec2 id = ci;
    for (int oy = -1; oy <= 1; oy++)
    for (int ox = -1; ox <= 1; ox++) {
      vec2 g = vec2(float(ox), float(oy));
      vec2 r = g + hash22(ci + g) - cf;
      float d = dot(r, r);
      if (d < d1) { d1 = d; id = ci + g; }
    }
    d1 = sqrt(d1);
    float h1 = hash12(id);
    float h2 = hash12(id + 7.7);
    // slow per-cell breathing (~0.1–0.4Hz); brightness spread — some pieces
    // ash-dark, some fierce; a floor keeps the bed a connected glowing mass
    float ph = uT * (0.7 + 1.7 * h1) + h2 * 6.2831853;
    float glow = (0.30 + 0.70 * (0.5 + 0.5 * sin(ph))) * (0.35 + 0.9 * h1);
    glow *= 0.92 + 0.08 * sin(uT * 7.0 + h1 * 40.0);
    float depth = exp(-max(0.0, q.y - 0.02) * 8.0);
    float emb = 0.0;
    for (int i = 0; i < 6; i++) {
      vec2 ed = q - uEmbers[i].xy;
      emb += uEmbers[i].z * exp(-dot(ed, ed) * 700.0);
    }
    vec2 pd0 = q - uPop.xy;
    float base = (0.30 + 0.75 * glow) * depth * bedMask * (0.55 + 0.6 * uLum);
    base += emb * 1.5 + uPop.w * exp(-dot(pd0, pd0) * 260.0) + uKindle * 0.5 * bedMask;
    float body = 0.25 + 0.75 * smoothstep(0.85, 0.30, d1); // core vs. ash seam
    float zone = bedMask * smoothstep(0.15, 0.06, q.y) * smoothstep(-0.17, -0.04, q.y);
    col = mix(col, uBg * 0.55, zone * 0.9);                // dark ash ground
    col += fireCol(min(1.05, base * body)) * zone;
  }

  // ---- logs: capsule silhouettes, bark striations, pulsing crack veins ---
  float logM = 0.0;
  if (q.y < 0.34) {
    for (int i = 0; i < 3; i++) {
      vec2 a = uLogA[i].xy;
      vec2 ba = uLogA[i].zw - a;
      vec2 pa = q - a;
      float tt = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      float d = length(pa - ba * tt) - uLogB[i].x;
      float mask = smoothstep(0.006, -0.005, d);
      if (mask > 0.003) {
        float seed = uLogB[i].y;
        float along = tt * 7.0 + seed * 3.1;
        float across = d * 55.0;
        float bark = vnoise(vec2(along * 2.6, across * 0.9 + seed));
        vec3 lc = mix(uBg * 0.5, pal(0.09), 0.45 + 0.4 * bark) * (0.55 + 0.45 * bark);
        lc += pal(0.48) * (uLum * 0.16 * (0.4 + 0.6 * bark) * exp(-q.y * 3.5)); // underlit
        // crack veins: sparse ridged lines along the grain, patch-masked so
        // only stretches of the log glow; breathing slowly, flaring on
        // settle events and with the overall fire
        float vn = vnoise(vec2(along * 3.3, across * 0.35 + seed * 9.0));
        float ridge = 1.0 - abs(2.0 * vn - 1.0);
        float veinPatch = smoothstep(0.38, 0.75, vnoise(vec2(along * 0.9 + seed * 5.0, seed * 13.0)));
        float crack = smoothstep(0.88, 0.99, ridge) * veinPatch;
        float cp2 = 0.55 + 0.45 * sin(uT * (0.6 + 0.5 * seed) + seed * 17.0 + tt * 11.0);
        float ch = crack * cp2 * (0.45 + 0.9 * uLum) * (1.0 + uLogB[i].z * 2.2 + uKindle * 0.8);
        lc += fireCol(min(1.0, 0.42 + 0.6 * ch)) * ch * 0.85;
        col = mix(col, lc, mask);
        logM = max(logM, mask);
      }
    }
  }

  // ---- the flames — logs partially occlude them (tongues rise behind and
  // between the wood; a thinner veil still licks across the front) ---------
  float heat = flameHeat(q) * (1.0 - logM * 0.62);
  col = col * (1.0 - min(0.55, heat * 0.45)) + fireCol(heat);

  // ---- pop flash (one-frame-ish spark burst light) -----------------------
  vec2 pd = q - uPop.xy;
  col += pal(0.95) * (uPop.z * 2.2 * exp(-dot(pd, pd) * 150.0));

  outColor = vec4(col, 1.0);
}
`;
}

/**
 * Spark pool update (MRT, hanabi idiom).
 *   pos: xy = position (q), z = age, w = life (0 = dead)
 *   vel: xy = velocity (q/s), z = seed, w = brightness
 * Ranged spawn events re-initialize a contiguous index window per step.
 */
export const SPARK_UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform float uSideF;
uniform float uCountF;
uniform float uWindG;
uniform int uNumSpawns;
uniform vec4 uSpA[${MAX_SEVENTS}]; // start, count, kind, seed
uniform vec4 uSpB[${MAX_SEVENTS}]; // kind-specific (see spawn())
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

void spawn(int e, float rel, out vec4 P, out vec4 V) {
  vec4 A = uSpA[e];
  vec4 B = uSpB[e];
  float u = (rel + 0.5) / max(A.y, 1.0);
  float s0 = fract(A.w + rel * 0.61803398875);
  float h1 = hash11(s0 * 127.1 + 0.7);
  float h2 = hash11(s0 * 311.7 + 3.3);
  float h3 = hash11(s0 * 613.5 + 8.0);
  float h4 = hash11(s0 * 911.2 + 1.1);
  vec2 pos;
  vec2 vel;
  float life;
  float bright;
  if (A.z < 0.5) {
    // COAL — B = (x, y, spread, upBias): a single ember lifting off the bed
    pos = vec2(B.x + (h1 - 0.5) * B.z, B.y + (h2 - 0.5) * 0.035);
    vel = vec2((h3 - 0.5) * 0.10, 0.05 + (0.22 + 0.30 * B.w) * h4 * h4);
    life = 0.9 + 1.9 * h2;
    bright = 0.55 + 0.75 * h3;
  } else if (A.z < 1.5) {
    // STROKE — B = (x, y, prevX, prevY): kicked along the poker segment
    pos = mix(B.zw, B.xy, u) + (vec2(h1, h2) - 0.5) * 0.02;
    vec2 dir = B.xy - B.zw;
    float dl = max(length(dir), 1e-4);
    vel = dir / dl * (0.15 + 0.50 * h3) + vec2((h1 - 0.5) * 0.22, 0.16 + 0.28 * h2);
    life = 0.6 + 1.1 * h4;
    bright = 0.95 + 0.85 * h3;
  } else if (A.z < 2.5) {
    // POP — B = (x, y, speed, –): radial burst, biased upward
    float a = h1 * 6.2831853;
    pos = B.xy + (vec2(h2, h3) - 0.5) * 0.015;
    vel = vec2(cos(a), abs(sin(a)) * 0.9 + 0.30) * (B.z * (0.35 + 0.85 * h4));
    life = 0.5 + 1.2 * h2;
    bright = 1.1 + 1.0 * h3;
  } else {
    // FOUNTAIN — B = (cx, y, halfw, upSpeed): kindling toss / bellows rush
    float x = B.x + (h1 * 2.0 - 1.0) * B.z * (0.35 + 0.65 * h4);
    pos = vec2(x, B.y + h2 * 0.06);
    vel = vec2((h3 - 0.5) * 0.30, B.w * (0.5 + 0.8 * h4));
    life = 0.8 + 1.5 * h2;
    bright = 0.95 + 0.85 * h3;
  }
  P = vec4(pos, 0.0, life);
  V = vec4(vel, s0, bright);
}

void main() {
  vec2 fc = floor(gl_FragCoord.xy);
  float pid = fc.y * uSideF + fc.x;
  int hit = -1;
  float rel = 0.0;
  for (int i = 0; i < ${MAX_SEVENTS}; i++) {
    if (i >= uNumSpawns) break;
    float r = pid - uSpA[i].x;
    if (r < 0.0) r += uCountF;
    if (r < uSpA[i].y) { hit = i; rel = r; }
  }
  if (hit >= 0) { spawn(hit, rel, outPos, outVel); return; }

  vec4 P = texelFetch(uPos, ivec2(fc), 0);
  vec4 V = texelFetch(uVel, ivec2(fc), 0);
  if (P.w <= 0.0 || P.z >= P.w) {
    outPos = vec4(P.xy, 1.0, 0.0); // dead — reservoir
    outVel = vec4(0.0, 0.0, V.z, V.w);
    return;
  }
  float h = hash11(V.z * 53.7 + 2.2);
  vec2 v = V.xy;
  v.y += (0.28 + 0.5 * h) * uDt;                                  // chimney draft
  v.x += sin(P.z * (5.0 + 8.0 * h) + V.z * 37.0) * 0.24 * uDt;    // turbulent wiggle
  v.x += uWindG * 1.7 * uDt;                                      // blow gust scatter
  v *= exp(-1.15 * uDt);
  outPos = vec4(P.xy + v * uDt, P.z + uDt, P.w);
  outVel = vec4(v, V.z, V.w);
}
`;

/**
 * Spark draw: gl.LINES, velocity-elongated. Brighten-then-die: fast ramp-in,
 * strobing twinkle, long fade; color cools hot→dim along the flight.
 */
export const SPARK_DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform int uSide;
uniform int uStride;
uniform int uCount;
uniform vec2 uQ2C;      // 2 / aspect (q → clip)
uniform float uT;
uniform float uBright;
uniform float uStretch; // seconds of velocity elongation
uniform float uMinLen;  // min dash length, q
uniform vec3 uHot;
uniform vec3 uCool;
out vec3 vColor;
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  int pid = (gl_VertexID >> 1) * uStride;
  int end = gl_VertexID & 1;
  if (pid >= uCount) { gl_Position = vec4(0.0, 0.0, 3.0, 1.0); vColor = vec3(0.0); return; }
  ivec2 tc = ivec2(pid % uSide, pid / uSide);
  vec4 P = texelFetch(uPos, tc, 0);
  if (P.w <= 0.0 || P.z >= P.w) { gl_Position = vec4(0.0, 0.0, 3.0, 1.0); vColor = vec3(0.0); return; }
  vec4 V = texelFetch(uVel, tc, 0);
  float ageF = P.z / P.w;
  float h1 = hash11(V.z * 57.3 + 0.2);
  float h2 = hash11(V.z * 171.1 + 3.8);
  float strobe = 0.35 + 0.65 * (0.5 + 0.5 * sin(uT * (11.0 + 15.0 * h1) + h2 * 6.2831853));
  float b = V.w * smoothstep(0.0, 0.09, ageF) * (1.0 - smoothstep(0.5, 1.0, ageF)) * strobe;
  vec3 col = mix(uHot, uCool, smoothstep(0.10, 0.85, ageF));
  vec2 d = V.xy * uStretch;
  float dl = length(d);
  vec2 dir = dl > 1e-5 ? d / dl : vec2(0.0, 1.0);
  dl = max(dl, uMinLen);
  vec2 p = P.xy - dir * (dl * float(end));
  gl_Position = vec4(p * uQ2C - 1.0, 0.0, 1.0);
  vColor = col * (b * uBright * (end == 1 ? 0.32 : 1.0));
}
`;

export const SPARK_DRAW_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }
`;
