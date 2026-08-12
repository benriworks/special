/**
 * HANABI — GLSL sources.
 *
 * Particle state lives in one MRT ping-pong pair of RGBA32F textures:
 *   pos: xy = position (q-space: min(w,h) = 1), z = age, w = life (0 = dead)
 *   vel: xy = velocity (q/s), z = per-particle seed,
 *        w = meta pack:  brightQ*1000 + type*100 + colA*10 + colB
 *            (brightQ = brightness / 0.6 quantized 0..15; all ints ≤ 15977,
 *             exact in float32)
 *
 * One fragment pass updates BOTH textures (no particle-particle coupling, so
 * MRT halves the texel work vs. split pos/vel passes). Spawning is CPU-driven:
 * up to MAX_EVENTS ranged events per step; a fragment whose particle index
 * falls inside an event's [start, start+count) window (mod pool) re-initializes
 * itself from the event descriptor instead of integrating.
 */

/** Max spawn events flushed to the GPU per sim step. */
export const MAX_EVENTS = 16;

// Particle types (shared TS/GLSL).
export const T_TAIL = 1;   // rocket tail segment (head flares + shed sparks)
export const T_PEONY = 2;  // 牡丹 — uniform projected-sphere burst
export const T_CHRYS = 3;  // 菊 — streaked radial burst, long trails
export const T_WILLOW = 4; // 柳 — long-falling drooping gold
export const T_RING = 5;   // 環 — tilted disc
export const T_SENKO = 6;  // 線香花火 — pointer sparkler crackle

const HASH = `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

/**
 * Update pass (MRT). Uniform layout per event:
 *   uSpawnA: start, count, type, seed
 *   uSpawnB: cx, cy, p0, p1     (TAIL: p0p1 = prev head; RING: p0 = speed,
 *            p1 = tilt; SENKO: p0 = intensity, p1 = spread; bursts: p0 = speed)
 *   uSpawnC: colA, colB, sparkleProb, brightScale
 */
export const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform float uWind;
uniform float uSideF;
uniform float uCountF;
uniform int uNumSpawns;
uniform vec4 uSpawnA[${MAX_EVENTS}];
uniform vec4 uSpawnB[${MAX_EVENTS}];
uniform vec4 uSpawnC[${MAX_EVENTS}];
layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

const float TWO_PI = 6.283185307179586;
${HASH}
float packMeta(float bright, float type, float colA, float colB) {
  float bq = clamp(floor(bright / 0.6 + 0.5), 0.0, 15.0);
  return bq * 1000.0 + type * 100.0 + colA * 10.0 + colB;
}

void spawn(int e, float rel, out vec4 P, out vec4 V) {
  vec4 A = uSpawnA[e];
  vec4 B = uSpawnB[e];
  vec4 C = uSpawnC[e];
  float type = A.z;
  float cnt = max(A.y, 1.0);
  float u = (rel + 0.5) / cnt;
  float s0 = fract(A.w + rel * 0.61803398875);
  float h1 = hash11(s0 * 127.13 + 0.71);
  float h2 = hash11(s0 * 311.77 + 3.31);
  float h3 = hash11(s0 * 613.51 + 7.97);
  float h4 = hash11(s0 * 911.27 + 1.13);
  vec2 pos = B.xy;
  vec2 vel = vec2(0.0);
  float life = 1.0;
  float bright = 1.0;
  float colA = C.x;
  float colB = C.y;

  if (type < 1.5) {
    // ROCKET TAIL — B.zw = head position last step, B.xy = head now.
    if (h4 > 0.70) {
      // head flares spread along the recent path, carrying the head's velocity
      // ((cur−prev)/dt) so draw-time elongation bridges inter-frame gaps even
      // at low fps → a continuous ascending streak with a hot tip
      pos = mix(B.zw, B.xy, 0.55 + 0.45 * h1) + (vec2(h2, h3) - 0.5) * 0.004;
      vel = (B.xy - B.zw) / max(uDt, 1e-3) * (0.70 + 0.25 * h2);
      life = 0.05 + 0.10 * h3;
      bright = 3.4;
    } else {
      // gold sparks shed along the flight segment, falling away
      pos = mix(B.zw, B.xy, u) + (vec2(h1, h2) - 0.5) * 0.008;
      float a = h1 * TWO_PI;
      vel = vec2(cos(a), sin(a)) * (0.015 + 0.055 * h2);
      life = 0.22 + 0.60 * h3;
      bright = 0.55;
    }
  } else if (type < 4.5) {
    // PEONY / CHRYSANTHEMUM / WILLOW — direction sampled on a 3D sphere and
    // projected to 2D: the |v| distribution densifies toward the rim exactly
    // like a real shell photographed from the ground.
    float z = h1 * 2.0 - 1.0;
    float a = h2 * TWO_PI;
    vec2 dir = vec2(cos(a), sin(a)) * sqrt(max(0.0, 1.0 - z * z));
    if (type < 2.5) {
      vel = dir * B.z * (0.90 + 0.18 * h3);
      life = 1.10 + 0.80 * h4;
      bright = 1.05;
    } else if (type < 3.5) {
      vel = dir * B.z * (0.92 + 0.16 * h3);
      life = 1.55 + 0.95 * h4;
      bright = 0.95;
    } else {
      vel = dir * B.z * (0.80 + 0.35 * h3);
      life = 2.90 + 1.90 * h4;
      bright = 0.80;
    }
    // first ~2% = the burst core: near-still, brief, ferociously bright (the
    // "pop" that blooms white through the tonemapper)
    if (u < 0.02) { vel *= 0.05; life = 0.15 + 0.12 * h4; bright = 8.5; }
  } else if (type < 5.5) {
    // RING — disc with random tilt (B.w = minor-axis scale) + orientation.
    float a = u * TWO_PI + (h1 - 0.5) * 0.10;
    vec2 dir = vec2(cos(a), sin(a) * max(0.30, B.w));
    float ra = A.w * TWO_PI;
    dir = mat2(cos(ra), -sin(ra), sin(ra), cos(ra)) * dir;
    vel = dir * B.z * (0.95 + 0.10 * h3);
    life = 1.10 + 0.70 * h4;
    bright = 1.10;
    if (h2 < 0.03) { vel *= 0.05; life = 0.2; bright = 7.0; }
  } else {
    // SENKO — pointer sparkler, seeded continuously along the pointer's
    // inter-frame segment (B.zw = previous point): mostly slow drifting
    // sparks, a few fast crackle branches (h2^3 biases speed low), a good
    // share of long-lived falling embers, and a hot core at the tip.
    float charge = clamp((C.w - 1.0) * 2.0, 0.0, 1.0);
    pos = mix(B.zw, B.xy, u) + (vec2(h3, h4) - 0.5) * (0.012 + 0.02 * charge);
    float a = h1 * TWO_PI;
    vel = vec2(cos(a), sin(a)) * ((0.03 + 0.30 * h2 * h2 * h2) * (1.0 + 0.5 * charge));
    life = 0.50 + 2.00 * h3 * h3;
    bright = 1.35;
    float h5 = hash11(s0 * 419.23 + 5.41);
    if (h5 > 0.93) { life = 0.10 + 0.12 * h4; bright = 1.8; vel *= 2.6; }
    else if (h5 < 0.28) { life = 2.6 + 1.3 * h4; bright = 0.75; vel *= 0.55; }
    if (u > 0.92) { pos = B.xy + (vec2(h3, h4) - 0.5) * 0.006; vel *= 0.3; life = 0.05 + 0.08 * h4; bright = 2.8; }
  }

  // accent-colored sparkle stars (strobing highlights) for shell types
  float h6 = hash11(s0 * 733.19 + 9.02);
  if (h6 < C.z && type > 1.5) { colA = 6.0; colB = 6.0; }

  P = vec4(pos, 0.0, life);
  V = vec4(vel, s0, packMeta(bright * C.w, type, colA, colB));
}

void main() {
  vec2 fc = floor(gl_FragCoord.xy);
  float pid = fc.y * uSideF + fc.x;

  // ranged reassignment — the last matching event wins
  int hit = -1;
  float rel = 0.0;
  for (int i = 0; i < ${MAX_EVENTS}; i++) {
    if (i >= uNumSpawns) break;
    float r = pid - uSpawnA[i].x;
    if (r < 0.0) r += uCountF;
    if (r < uSpawnA[i].y) { hit = i; rel = r; }
  }
  if (hit >= 0) { spawn(hit, rel, outPos, outVel); return; }

  vec4 P = texelFetch(uPos, ivec2(fc), 0);
  vec4 V = texelFetch(uVel, ivec2(fc), 0);
  float age = P.z;
  float life = P.w;
  if (life <= 0.0 || age >= life) {
    // dead — park in the reservoir until an event reassigns this texel
    outPos = vec4(P.xy, 1.0, 0.0);
    outVel = vec4(0.0, 0.0, V.z, V.w);
    return;
  }
  float typeF = floor(mod(V.w, 1000.0) / 100.0);
  // per-type ballistics: willow droops (high gravity, low drag → slow terminal
  // fall), senko falls briskly, burst stars decelerate hard then drift
  float drag = typeF < 1.5 ? 2.6 : typeF < 2.5 ? 2.55 : typeF < 3.5 ? 1.85
             : typeF < 4.5 ? 1.5 : typeF < 5.5 ? 2.7 : 1.7;
  float grav = typeF < 1.5 ? 0.10 : typeF < 2.5 ? 0.115 : typeF < 3.5 ? 0.105
             : typeF < 4.5 ? 0.185 : typeF < 5.5 ? 0.10 : 0.16;
  float hw = hash11(V.z * 53.71 + 2.19);
  vec2 acc = vec2(uWind * (0.4 + 0.9 * hw), -grav);
  vec2 v = (V.xy + acc * uDt) * exp(-drag * uDt);
  outPos = vec4(P.xy + v * uDt, age + uDt, life);
  outVel = vec4(v, V.z, V.w);
}
`;

/**
 * Draw pass — gl.LINES, two vertices per particle: head at pos, tail at
 * pos - v̂·max(|v|·stretch, minLen). Velocity elongation bridges inter-frame
 * gaps for fast stars (continuous streaks) and the min length keeps near-still
 * embers visible as tiny dashes. Additive into the RGBA16F trail buffer.
 */
export const DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform int uSide;
uniform int uStride;
uniform int uCount;
uniform vec2 uQ2C;       // 2 / aspect  (q-space → clip)
uniform float uTime;
uniform float uBright;
uniform float uStretch;  // seconds of velocity elongation
uniform float uMinLen;   // minimum dash length, q units
uniform vec3 uColors[8]; // 0..5 palette, 6 accent, 7 white-hot top
out vec3 vColor;
${HASH}
void main() {
  int pid = (gl_VertexID >> 1) * uStride;
  int end = gl_VertexID & 1;
  if (pid >= uCount) { gl_Position = vec4(0.0, 0.0, 3.0, 1.0); vColor = vec3(0.0); return; }
  ivec2 tc = ivec2(pid % uSide, pid / uSide);
  vec4 P = texelFetch(uPos, tc, 0);
  float age = P.z;
  float life = P.w;
  if (life <= 0.0 || age >= life) { gl_Position = vec4(0.0, 0.0, 3.0, 1.0); vColor = vec3(0.0); return; }
  vec4 V = texelFetch(uVel, tc, 0);

  float meta = V.w;
  float bq = floor(meta / 1000.0);
  float rem = meta - bq * 1000.0;
  float typeF = floor(rem / 100.0);
  rem -= typeF * 100.0;
  float colA = floor(rem / 10.0);
  float colB = rem - colA * 10.0;
  float seed = V.z;
  float h1 = hash11(seed * 57.31 + 0.17);
  float h2 = hash11(seed * 171.13 + 3.77);
  float ageF = age / life;

  // chrysanthemum stars shift colA→colB along their life (tip color change);
  // other types pick one of the two per star
  bool chrys = typeF > 2.5 && typeF < 3.5;
  float cmix = chrys ? smoothstep(0.15, 0.75, ageF) : step(0.5, h1);
  vec3 col = mix(uColors[int(colA)], uColors[int(colB)], cmix);

  float bright = bq * 0.6;
  col = mix(col, uColors[7], smoothstep(2.4, 5.5, bright)); // hot cores whiten

  // end-of-life strobing twinkle; accent sparkle stars strobe from birth
  float isAccent = (colA > 5.5 && colA < 6.5) ? 1.0 : 0.0;
  float twAmt = clamp(smoothstep(0.40, 0.85, ageF) * 0.85 + isAccent * 0.55, 0.0, 1.0);
  float strobe = 0.25 + 0.75 * (0.5 + 0.5 * sin(uTime * (15.0 + 27.0 * h1) + h2 * 6.2831853));
  float tw = mix(1.0, strobe, twAmt);

  float fadeOut = 1.0 - smoothstep(0.60, 1.0, ageF);
  float b = bright * (0.72 + 0.56 * h2) * tw * fadeOut * uBright;

  // per-type stretch: chrysanthemum streaks hardest, senko stays granular
  float sk = typeF < 1.5 ? 1.35 : typeF < 2.5 ? 0.95 : typeF < 3.5 ? 1.70
           : typeF < 4.5 ? 1.35 : typeF < 5.5 ? 0.95 : 0.90;
  vec2 d = V.xy * (uStretch * sk);
  float dl = length(d);
  vec2 dir = dl > 1e-5 ? d / dl : vec2(cos(h1 * 6.2831853), sin(h1 * 6.2831853));
  dl = max(dl, uMinLen);
  vec2 p = P.xy - dir * (dl * float(end));
  gl_Position = vec4(p * uQ2C - 1.0, 0.0, 1.0);
  vColor = col * (b * (end == 1 ? 0.30 : 1.0));
}
`;

export const DRAW_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }
`;

export const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uFade;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * uFade;
  outColor = vec4(max(c - 0.0006, 0.0), 1.0); // epsilon kills permanent ghosts
}
`;

/**
 * Present: night-sky vertical gradient (deep dark zenith, faint horizon haze)
 * + trail buffer + atmosphere flash (a big burst briefly lights the whole sky,
 * strongest up where the shell broke).
 */
export const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTrail;
uniform vec3 uBg;
uniform vec3 uFlashCol;
uniform float uFlash;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 bg = uBg * (1.18 - 0.55 * vUv.y);
  bg += uBg * 0.35 * pow(max(0.0, 1.0 - vUv.y), 6.0);
  vec3 c = bg + texture(uTrail, vUv).rgb;
  c += uFlashCol * (uFlash * (0.35 + 0.50 * vUv.y));
  outColor = vec4(c, 1.0);
}
`;
