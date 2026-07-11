/**
 * FLOCK — 群れ. GPU stochastic-neighborhood boids murmuration.
 *
 * Simulation: position + velocity ping-pong (RGBA32F, one texel per boid,
 * updated in a single MRT pass). Every boid samples SAMPLES hash-jittered
 * random flockmates per frame — statistically indistinguishable from an
 * exact O(n²) neighborhood — for separation / alignment / cohesion, plus a
 * density-regulated cohesion term that keeps 5–15 sub-flocks alive and
 * continuously merging/splitting instead of collapsing into one blob.
 *
 * Fear lives in vel.z: predators (pressed pointer / touches, an invisible
 * idle ghost-predator, the pulse shockwave) inject it and neighbors catch it
 * within alignment range, so panic visibly propagates through the flock as
 * an accent-colored wave. Boids render as velocity-aligned streak triangles
 * (one non-instanced draw; tiny instances crawl under SwiftShader) into a
 * fading RGBA16F trail buffer (ribbons), then again at full HDR brightness
 * on top, composed through the shared post pipeline.
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, UniformSetter, compileProgram, drawFullscreen, makeTexture,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';
import type { Theme } from '../../engine/types';

// ---------------------------------------------------------------------------
// Tuning constants (world space: height = 1, width = aspect)
// ---------------------------------------------------------------------------

const PREWARM_STEPS = 110;   // sim steps before frame 1 → structured flocks mid-flight
const PREWARM_TRAIL = 30;    // last N prewarm steps also paint the trail buffer
const PULSE_LIFE = 2.1;      // seconds the shockwave stays active
const GHOST_FEAR_CAP = 0.55; // idle waves stay softer than user-driven panic

// ---------------------------------------------------------------------------
// Simulation shader (MRT: pos + vel)
// ---------------------------------------------------------------------------

const UPDATE_FS = (samples: number) => `#version 300 es
precision highp float;
precision highp int;

#define SAMPLES ${samples}

uniform highp sampler2D uPos;   // xy pos, z seed, w smoothed density
uniform highp sampler2D uVel;   // xy vel, z fear, w spare
uniform int uSide;
uniform int uCount;
uniform float uAspect;          // world width (height = 1)
uniform float uScale;           // sqrt(aspect): keeps flock scale screen-invariant
uniform float uDt;
uniform float uTime;
uniform float uSeed;            // per-step jitter for the stochastic neighborhood
uniform float uRSep;            // separation radius (~1.7x mean boid spacing)
uniform float uRCoh;            // cohesion radius (includes uScale and param)
uniform float uExpect;          // expected samples inside uRCoh at uniform density
uniform float uCohGain;         // 結束 param
uniform float uFearGain;        // 恐れ param
uniform vec4 uPred[4];          // xy world, z: 0 beacon / 1 predator, w weight (0 = off)
uniform vec4 uGhost[3];         // xy world, z strength, w fear cap
uniform vec4 uPulse;            // xy world, z age, w active

layout(location = 0) out vec4 oPos;
layout(location = 1) out vec4 oVel;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  int self = tc.y * uSide + tc.x;
  vec4 P = texelFetch(uPos, tc, 0);
  vec4 V = texelFetch(uVel, tc, 0);
  vec2 pos = P.xy;
  float seed = P.z;
  vec2 vel = V.xy;
  float fear = V.z;

  // paranoia: resurrect any boid that went NaN
  if (isnan(pos.x) || isnan(pos.y) || isnan(vel.x) || isnan(vel.y)) {
    pos = vec2(hash12(vec2(float(self), 3.7)) * uAspect, hash12(vec2(float(self), 9.2)));
    vel = vec2(0.2, 0.0);
    fear = 0.0;
  }

  float spd = length(vel) + 1e-5;
  vec2 fwd = vel / spd;

  float rAli = 0.07 * uScale;

  // --- stochastic neighborhood -------------------------------------------
  vec2 sep = vec2(0.0);
  vec2 ali = vec2(0.0);
  vec2 cohSum = vec2(0.0);
  float nAli = 0.0;
  float nCoh = 0.0;
  float nDens = 0.0;
  float nbrFear = 0.0;

  for (int s = 0; s < SAMPLES; s++) {
    float r = hash12(vec2(float(self) * 0.3731 + uSeed, float(s) * 17.132 + uSeed * 1.618));
    int j = min(int(r * float(uCount)), uCount - 1);
    if (j == self) continue;
    ivec2 jc = ivec2(j % uSide, j / uSide);
    vec2 pj = texelFetch(uPos, jc, 0).xy;
    vec2 d = pj - pos;
    float dist = length(d) + 1e-5;
    if (dist < uRSep) sep -= (d / dist) * (1.0 - dist / uRSep);
    if (dist < uRCoh) {
      nDens += 1.0;    // density counts everything in range (better statistics)
      // forward view cone for alignment/cohesion (birds ignore what's behind);
      // the anisotropy is what folds a uniform gas into travelling streams
      if (dot(fwd, d) >= -0.4 * dist) { cohSum += pj; nCoh += 1.0; }
    }
    if (dist < rAli && dot(fwd, d) >= -0.4 * dist) {
      vec4 vj = texelFetch(uVel, jc, 0);
      float fj = vj.z;
      float w = 1.0 + fj * 8.0;                       // panicked neighbors dominate heading
      ali += (vj.xy / (length(vj.xy) + 1e-5)) * w;
      nAli += w;
      nbrFear = max(nbrFear, fj * (1.0 - 0.55 * dist / rAli)); // fear contagion
    }
  }

  // smoothed local density (1.0 == uniform average)
  float dens = mix(P.w, nDens / max(uExpect, 0.4), 0.08);

  // preferred flock size: crowded cores stop cohering and push apart, lonely
  // boids seek company — this keeps many sub-flocks alive & merging/splitting.
  float crowd = smoothstep(1.35, 2.9, dens);
  float lonely = smoothstep(0.55, 0.15, dens);
  float cohW = uCohGain * (1.0 - 0.9 * crowd) * (1.0 + 1.2 * lonely);

  // per-boid preferred speed: fast and slow birds shear big carpets apart,
  // so a merged mega-flock always tears back into sub-flocks
  float pref = 0.8 + 0.5 * seed;

  vec2 acc = vec2(0.0);
  acc += sep * 4.5 * (1.0 + 1.1 * crowd + 1.2 * min(fear, 1.0));
  if (nAli > 0.0) {
    vec2 avgDir = ali / (length(ali) + 1e-5);
    acc += (avgDir * spd - vel) * 4.5;   // direction matching, speed stays personal
  }
  if (nCoh > 0.0) {
    acc += (cohSum / nCoh - pos) / uRCoh * 1.4 * cohW;
  }
  acc += fwd * (0.26 * pref - spd) * 0.8; // cruise toward personal speed

  // per-boid rotating wander (zero-mean: no global herding bias)
  float wa = uTime * (0.45 + seed * 0.8) + seed * 43.0;
  acc += vec2(cos(wa), sin(wa)) * 0.18;

  // gentle roost pull: the murmuration orbits mid-screen instead of
  // permanently hugging the walls after scares (also = fast regroup)
  acc += (vec2(uAspect * 0.5, 0.5) - pos) * 0.24;

  // soft-bounce world bounds (aspect-correct)
  float m = min(0.13, uAspect * 0.28);
  vec2 push = max(vec2(0.0), (vec2(m) - pos) / m)
            - max(vec2(0.0), (pos - vec2(uAspect - m, 1.0 - m)) / m);
  acc += push * abs(push) * 5.5;

  // pointers: beacons attract softly, pressed = predator (flee + fear spike)
  for (int k = 0; k < 4; k++) {
    vec4 pr = uPred[k];
    if (pr.w <= 0.001) continue;
    vec2 d = pos - pr.xy;
    float dist = length(d) + 1e-4;
    vec2 dir = d / dist;
    if (pr.z > 0.5) {
      float R = 0.24 * uScale;
      float g = exp(-dist * dist / (R * R)) * pr.w;
      acc += dir * g * 4.5 * uFearGain;
      fear = max(fear, min(1.25, g * 1.7 * uFearGain));
    } else {
      float R = 0.5 * uScale;
      float g = exp(-dist * dist / (R * R)) * pr.w;
      acc += -dir * g * 0.85;
      acc += vec2(-dir.y, dir.x) * g * 0.35;   // gentle orbit → beacon swirl
    }
  }

  // invisible wandering ghost-predators: the idle murmuration drivers; their
  // staggered lunges also keep carving any merged mass back into sub-flocks
  for (int k = 0; k < 3; k++) {
    vec4 gh = uGhost[k];
    if (gh.z <= 0.001) continue;
    vec2 d = pos - gh.xy;
    float dist = length(d) + 1e-4;
    float R = 0.30 * uScale;
    float g = exp(-dist * dist / (R * R)) * gh.z;
    acc += (d / dist) * g * 3.0;
    fear = max(fear, min(gh.w, g * 1.1));
  }

  // pulse: center shockwave — an expanding ring of outward push + fear
  if (uPulse.w > 0.5) {
    float age = uPulse.z;
    float R = 0.06 + age * 1.35;
    vec2 d = pos - uPulse.xy;
    float dist = length(d);
    float band = 0.09 + age * 0.07;
    float g = exp(-pow((dist - R) / band, 2.0)) * exp(-age * 1.4);
    vec2 dir = dist > 1e-3 ? d / dist : vec2(1.0, 0.0);
    acc += dir * g * 11.0;
    fear = max(fear, min(1.25, g * 1.5));
  }

  // fear: contagion pickup, exponential relaxation, acceleration burst.
  // The 0.82 hop factor keeps a panic wave LOCAL — it dies out after
  // ~0.3-0.4 world units instead of igniting the whole sky.
  fear = max(fear * exp(-uDt * 2.4), nbrFear * 0.82);
  acc += fwd * fear * 1.5;

  // integrate with min/max speed clamps — everything always flies
  vel += acc * uDt;
  float ns = length(vel) + 1e-6;
  float vMax = 0.34 * pref * (1.0 + 1.0 * min(fear, 1.25));
  vel *= clamp(ns, 0.16 * pref, vMax) / ns;
  pos += vel * uDt;

  // hard containment at the very edge (soft bounds do the real steering)
  if (pos.x < 0.003) { pos.x = 0.003; vel.x = abs(vel.x); }
  if (pos.x > uAspect - 0.003) { pos.x = uAspect - 0.003; vel.x = -abs(vel.x); }
  if (pos.y < 0.003) { pos.y = 0.003; vel.y = abs(vel.y); }
  if (pos.y > 0.997) { pos.y = 0.997; vel.y = -abs(vel.y); }

  oPos = vec4(pos, seed, dens);
  oVel = vec4(vel, fear, V.w);
}
`;

// ---------------------------------------------------------------------------
// Boid streaks (elongated along velocity; 3 verts per boid, single draw)
// ---------------------------------------------------------------------------

const BOID_VS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPos;
uniform highp sampler2D uVel;
uniform int uSide;
uniform float uAspect;
uniform float uScale;
uniform float uTime;
uniform float uGain;
uniform float uStreak;   // >1 in the trail pass → continuous ribbons
uniform float uWide;     // width multiplier (trail buffer is low-res)
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uAccent;
out vec3 vColor;
out float vAlong;

vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(x);
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], x - float(i));
}

void main() {
  // non-instanced: 3 consecutive vertices per boid (instancing with tiny
  // instances is pathologically slow under SwiftShader)
  int bi = gl_VertexID / 3;
  int corner = gl_VertexID - bi * 3;
  ivec2 tc = ivec2(bi % uSide, bi / uSide);
  vec4 P = texelFetch(uPos, tc, 0);
  vec4 V = texelFetch(uVel, tc, 0);
  float spd = length(V.xy) + 1e-5;
  vec2 dir = V.xy / spd;
  vec2 prp = vec2(-dir.y, dir.x);
  float fear = min(V.z, 1.25);
  float dens = P.w;

  float sz = 0.75 + 0.25 * uScale;
  float len = (0.0075 + 0.040 * spd) * (1.0 + 0.55 * fear) * sz * uStreak;
  float wid = 0.0026 * (1.0 - 0.25 * fear) * sz * uWide;

  vec2 local = corner == 0 ? vec2(0.62 * len, 0.0)
             : corner == 1 ? vec2(-0.38 * len, wid)
             : vec2(-0.38 * len, -wid);
  vAlong = corner == 0 ? 1.0 : 0.0;

  vec2 wp = P.xy + dir * local.x + prp * local.y;
  gl_Position = vec4(vec2(wp.x / uAspect, wp.y) * 2.0 - 1.0, 0.0, 1.0);

  // color: heading angle (cyclic, slowly rotating) + local density + a touch of
  // per-boid identity, mapped through the UPPER palette range only — otherwise a
  // collectively-heading flock can all land on the darkest palette entry and the
  // whole sky blacks out. Fear flashes toward the theme accent.
  float hue = 0.5 - 0.5 * cos(atan(dir.y, dir.x) - uTime * 0.11);
  float pt = 0.34 + 0.48 * hue + 0.12 * clamp(dens * 0.35, 0.0, 1.0) + 0.1 * (P.z - 0.5);
  vec3 col = pal(pt);
  col = mix(col, uAccent * 1.15, 0.55 * fear);
  // density-compensated brightness: soften additive stacking in packed cores
  // without dimming the whole sky when the population clusters up (sqrt, capped)
  float bright = (0.34 + 0.35 * smoothstep(0.3, 2.2, dens) + 0.32 * fear)
               * inversesqrt(clamp(dens, 1.0, 6.0));
  vColor = col * bright * uGain;
}
`;

const BOID_FS = `#version 300 es
precision highp float;
in vec3 vColor;
in float vAlong;
out vec4 outColor;
void main() { outColor = vec4(vColor * (0.35 + 0.65 * vAlong), 1.0); }
`;

// ---------------------------------------------------------------------------
// Trail fade / present passes
// ---------------------------------------------------------------------------

const TRAIL_FADE_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uTex;
uniform vec2 uTexel;
uniform float uFade;
in vec2 vUv;
out vec4 outColor;
void main() {
  // slight cross-blur diffuses the ribbons as they fade
  vec3 c = texture(uTex, vUv).rgb * 0.60
         + texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb * 0.10
         + texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb * 0.10
         + texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb * 0.10
         + texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb * 0.10;
  outColor = vec4(c * uFade, 1.0);
}
`;

const PRESENT_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uTrail;
uniform vec3 uBg;
uniform vec3 uGlow;
uniform float uTime;
in vec2 vUv;
out vec4 outColor;
void main() {
  // faint drifting aurora shimmer so the empty sky is never dead flat
  float sh = sin(vUv.x * 13.0 + uTime * 0.41) * sin(vUv.y * 11.0 - uTime * 0.31);
  vec3 col = uBg + uGlow * (0.012 + 0.009 * sh) + texture(uTrail, vUv).rgb;
  outColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

class FlockMode implements Mode {
  readonly id = 'flock';
  readonly name = { ja: '群れ', en: 'Flock' };
  readonly params: ParamDef[] = [
    { key: 'cohesion', label: { ja: '結束', en: 'Cohesion' }, type: 'range', min: 0.5, max: 1.8, step: 0.05, default: 1 },
    { key: 'fear', label: { ja: '恐れ', en: 'Fear' }, type: 'range', min: 0.2, max: 2.5, step: 0.05, default: 1.2 },
    { key: 'trail', label: { ja: '軌跡', en: 'Trails' }, type: 'range', min: 0.85, max: 0.965, step: 0.005, default: 0.91 },
  ];

  // params
  private pCoh = 1;
  private pFear = 1.2;
  private pTrail = 0.91;

  // sim dimensions
  private side = 128;
  private count = 128 * 128;
  private samples = 32;
  private aspect = 1;
  private scale = 1;
  private renderScale = 0.9;
  private perfScale = 1;       // internal-resolution governor (software GL etc.)
  private dtEma = 1 / 60;      // real (unclamped) frame time
  private lastNow = 0;
  private lastScaleDrop = 0;

  // GL resources
  private gl: WebGL2RenderingContext | null = null;
  private updateProg: WebGLProgram | null = null;
  private boidProg: WebGLProgram | null = null;
  private fadeProg: WebGLProgram | null = null;
  private presentProg: WebGLProgram | null = null;
  private uUpdate: UniformSetter | null = null;
  private uBoid: UniformSetter | null = null;
  private uFade: UniformSetter | null = null;
  private uPresent: UniformSetter | null = null;
  private posTex: WebGLTexture[] = [];
  private velTex: WebGLTexture[] = [];
  private simFbo: WebGLFramebuffer[] = [];
  private cur = 0; // read index into posTex/velTex/simFbo
  private trail: PingPong | null = null;
  private post: Post | null = null;
  private boidVAO: WebGLVertexArrayObject | null = null;

  // interaction state
  private stepIdx = 0;
  private ghostW = 1;
  private lastPtrAct = -1e3;
  private pressAt = -1e3;
  private wasDown = false;
  private pulseAt = -1e3;
  private pulsePos: [number, number] = [0.5, 0.5];
  private predData = new Float32Array(16);
  private ghostData = new Float32Array(12);
  private pulseData = new Float32Array(4);
  private colorBuf = new Float32Array(18);

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const gl = ctx.gl;
    this.gl = gl;
    this.aspect = ctx.width / Math.max(1, ctx.height);
    this.scale = Math.sqrt(this.aspect);

    // boid count scales with the quality tier
    this.side = Math.max(64, Math.round(128 * Math.sqrt(ctx.quality)));
    this.count = this.side * this.side;
    this.samples = ctx.quality >= 0.95 ? 32 : ctx.quality >= 0.65 ? 24 : 12;
    this.renderScale = Math.min(1, 0.42 + 0.42 * ctx.quality);
    // NOTE: perfScale deliberately persists across re-inits — the engine's
    // quality governor re-inits us on tier changes and the device didn't
    // suddenly get faster; the runtime valve can slowly raise it again.

    this.updateProg = compileProgram(gl, FS_TRIANGLE_VS, UPDATE_FS(this.samples), 'flock.update');
    this.boidProg = compileProgram(gl, BOID_VS, BOID_FS, 'flock.boid');
    this.fadeProg = compileProgram(gl, FS_TRIANGLE_VS, TRAIL_FADE_FS, 'flock.fade');
    this.presentProg = compileProgram(gl, FS_TRIANGLE_VS, PRESENT_FS, 'flock.present');
    this.uUpdate = new UniformSetter(gl, this.updateProg);
    this.uBoid = new UniformSetter(gl, this.boidProg);
    this.uFade = new UniformSetter(gl, this.fadeProg);
    this.uPresent = new UniformSetter(gl, this.presentProg);

    this.allocSim(gl);
    this.allocTargets(ctx.width, ctx.height);
    this.boidVAO = gl.createVertexArray();

    this.stepIdx = 0;
    this.ghostW = 1;
    this.lastPtrAct = -1e3;
    this.pressAt = -1e3;
    this.wasDown = false;
    this.pulseAt = -1e3;
    this.dtEma = 1 / 60;
    this.lastScaleDrop = 0;
    this.predData.fill(0);
    this.pulseData.fill(0);

    // pre-warm: frame 1 must already show structured sub-flocks mid-flight,
    // ribbons included. Phase 1 is timed — a software rasterizer reveals
    // itself here, and we immediately shrink the internal render targets.
    const th0 = this.effectiveTheme(ctx);
    const dtFix = 1 / 60;
    const t0 = performance.now();
    let simSteps = PREWARM_STEPS - PREWARM_TRAIL;
    for (let i = 0; i < simSteps; i++) {
      const t = ctx.time - (PREWARM_STEPS - i) * dtFix;
      this.setGhost(t, 1);
      this.step(dtFix, t);
      // slow device: settle for fewer (but sufficient) warm-up steps
      if ((i & 15) === 15 && performance.now() - t0 > 1500 && i >= 40) { simSteps = i + 1; break; }
    }
    gl.finish();
    const simMs = performance.now() - t0;
    // software rendering (or a very weak GPU) reveals itself here: drop the
    // internal resolution immediately instead of waiting for governors
    const detected = simMs > 1800 ? 0.5 : simMs > 600 ? 0.65 : 1;
    if (detected < this.perfScale) {
      this.perfScale = detected;
      this.allocTargets(ctx.width, ctx.height);
    }
    for (let i = PREWARM_TRAIL; i > 0; i--) {
      const t = ctx.time - i * dtFix;
      this.setGhost(t, 1);
      this.step(dtFix, t);
      if ((this.stepIdx & 1) === 0) this.drawTrails(dtFix * 2, t, th0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** (Re)allocate the trail + post targets at renderScale x perfScale.
   *  The scene target keeps a floor so boids stay crisp streaks; the trail
   *  buffer is deliberately low-res anyway (its linear upsample doubles as
   *  free diffusion for the ribbons) so it takes the full cut. */
  private allocTargets(w: number, h: number): void {
    const gl = this.gl!;
    const rs = this.renderScale * Math.max(this.perfScale, 0.5);
    const ts = this.renderScale * this.perfScale * 0.7;
    const tw = Math.max(1, Math.round(w * ts));
    const th = Math.max(1, Math.round(h * ts));
    if (this.trail) this.trail.resize(tw, th);
    else this.trail = new PingPong(gl, tw, th, gl.RGBA16F, gl.LINEAR);
    const pw = Math.max(1, Math.round(w * rs));
    const ph = Math.max(1, Math.round(h * rs));
    if (this.post) this.post.resize(pw, ph);
    else this.post = createPost(gl, pw, ph);
  }

  /** Seed positions as a handful of already-moving clusters (fast convergence). */
  private allocSim(gl: WebGL2RenderingContext): void {
    const n = this.count;
    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 4);
    const K = 10;
    const cx = new Float32Array(K);
    const cy = new Float32Array(K);
    const ca = new Float32Array(K);
    const cr = new Float32Array(K);
    for (let k = 0; k < K; k++) {
      cx[k] = this.aspect * (0.18 + 0.64 * Math.random());
      cy[k] = 0.18 + 0.64 * Math.random();
      ca[k] = Math.random() * Math.PI * 2;
      cr[k] = (0.05 + 0.06 * Math.random()) * this.scale;
    }
    for (let i = 0; i < n; i++) {
      const k = i % K;
      // Box-Muller gaussian scatter around the cluster center
      const u1 = Math.max(1e-6, Math.random());
      const u2 = Math.random();
      const g = Math.sqrt(-2 * Math.log(u1));
      const ox = g * Math.cos(u2 * Math.PI * 2) * cr[k] * 0.6;
      const oy = g * Math.sin(u2 * Math.PI * 2) * cr[k] * 0.6;
      const a = ca[k] + (Math.random() - 0.5) * 0.7;
      const s = 0.16 + 0.08 * Math.random();
      const o = i * 4;
      pos[o] = clamp(cx[k] + ox, 0.02, this.aspect - 0.02);
      pos[o + 1] = clamp(cy[k] + oy, 0.02, 0.98);
      pos[o + 2] = Math.random();      // seed
      pos[o + 3] = 1;                  // density estimate
      vel[o] = Math.cos(a) * s;
      vel[o + 1] = Math.sin(a) * s;
      vel[o + 2] = 0;                  // fear
      vel[o + 3] = Math.random();      // spare
    }

    this.posTex = [];
    this.velTex = [];
    this.simFbo = [];
    for (let i = 0; i < 2; i++) {
      this.posTex.push(makeTexture(gl, {
        w: this.side, h: this.side, internalFormat: gl.RGBA32F, filter: gl.NEAREST, data: i === 0 ? pos : null,
      }));
      this.velTex.push(makeTexture(gl, {
        w: this.side, h: this.side, internalFormat: gl.RGBA32F, filter: gl.NEAREST, data: i === 0 ? vel : null,
      }));
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('flock: createFramebuffer failed');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.posTex[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.velTex[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`flock: sim framebuffer incomplete (0x${status.toString(16)})`);
      }
      this.simFbo.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cur = 0;
  }

  resize(ctx: ModeContext): void {
    this.aspect = ctx.width / Math.max(1, ctx.height);
    this.scale = Math.sqrt(this.aspect);
    this.allocTargets(ctx.width, ctx.height);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!isFinite(v)) return;
    if (key === 'cohesion') this.pCoh = clamp(v, 0.5, 1.8);
    else if (key === 'fear') this.pFear = clamp(v, 0.2, 2.5);
    else if (key === 'trail') this.pTrail = clamp(v, 0.85, 0.965);
  }

  // -------------------------------------------------------------------------

  /** Three ghost-predator wander paths with staggered lunges; writes ghostData. */
  private setGhost(t: number, weight: number): void {
    const a = this.aspect;
    // per-ghost path constants: frequencies, phases, lunge periods
    const C = [
      [0.117, 1.4, 0.301, 0.8, 0.149, 4.2, 0.257, 2.3, 6.9, 0.55],
      [0.093, 3.9, 0.271, 2.1, 0.171, 0.7, 0.223, 5.1, 8.6, 0.25],
      [0.139, 5.5, 0.331, 4.4, 0.127, 2.9, 0.293, 1.2, 5.7, 0.80],
    ];
    for (let k = 0; k < 3; k++) {
      const c = C[k];
      const gx = a * (0.5 + 0.34 * Math.sin(t * c[0] + c[1]) + 0.11 * Math.sin(t * c[2] + c[3]));
      const gy = 0.5 + 0.33 * Math.sin(t * c[4] + c[5]) + 0.11 * Math.sin(t * c[6] + c[7]);
      const ph = (((t / c[8]) % 1) + 1) % 1;
      const lunge = Math.exp(-Math.pow((ph - c[9]) * 7.5, 2));
      this.ghostData[k * 4] = clamp(gx, 0.08 * a, 0.92 * a);
      this.ghostData[k * 4 + 1] = clamp(gy, 0.08, 0.92);
      this.ghostData[k * 4 + 2] = (0.22 + 0.85 * lunge) * weight;
      this.ghostData[k * 4 + 3] = GHOST_FEAR_CAP;
    }
  }

  /** One simulation step (uses whatever is in predData/ghostData/pulseData). */
  private step(dt: number, time: number): void {
    const gl = this.gl!;
    const u = this.uUpdate!;
    const write = 1 - this.cur;
    const rCoh = 0.13 * this.scale * this.pCoh;
    const expect = this.samples * Math.PI * rCoh * rCoh / Math.max(0.05, this.aspect);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simFbo[write]);
    gl.viewport(0, 0, this.side, this.side);
    gl.disable(gl.BLEND);
    gl.useProgram(this.updateProg);
    u.setTexture('uPos', this.posTex[this.cur], 0);
    u.setTexture('uVel', this.velTex[this.cur], 1);
    u.set1i('uSide', this.side);
    u.set1i('uCount', this.count);
    u.set1f('uAspect', this.aspect);
    u.set1f('uScale', this.scale);
    u.set1f('uDt', dt);
    u.set1f('uTime', time);
    u.set1f('uSeed', ((this.stepIdx++ * 0.6180339887) % 1) * 61.0);
    u.set1f('uRSep', 2.0 * this.scale / this.side);
    u.set1f('uRCoh', rCoh);
    u.set1f('uExpect', expect);
    u.set1f('uCohGain', this.pCoh);
    u.set1f('uFearGain', this.pFear);
    u.set4fv('uPred[0]', this.predData);
    u.set4fv('uGhost[0]', this.ghostData);
    this.gl!.uniform4f(u.loc('uPulse'), this.pulseData[0], this.pulseData[1], this.pulseData[2], this.pulseData[3]);
    drawFullscreen(gl);
    this.cur = write;
  }

  private uploadPalette(u: UniformSetter, th: Theme): void {
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
  }

  /** Set boid-pass uniforms shared by the trail splat and the scene pass. */
  private bindBoidPass(th: Theme, time: number, gain: number, streak: number, wide: number): void {
    const gl = this.gl!;
    const u = this.uBoid!;
    gl.useProgram(this.boidProg);
    u.setTexture('uPos', this.posTex[this.cur], 0);
    u.setTexture('uVel', this.velTex[this.cur], 1);
    u.set1i('uSide', this.side);
    u.set1f('uAspect', this.aspect);
    u.set1f('uScale', this.scale);
    u.set1f('uTime', time);
    u.set1f('uGain', gain);
    u.set1f('uStreak', streak);
    u.set1f('uWide', wide);
    this.uploadPalette(u, th);
  }

  private drawBoids(count: number): void {
    const gl = this.gl!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);            // additive, RGBA16F targets only
    gl.bindVertexArray(this.boidVAO);
    gl.drawArrays(gl.TRIANGLES, 0, count * 3);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /** Fade + splat the trail buffer. Runs every OTHER frame (dt-compensated
   *  fade) — invisible at 60fps thanks to streak overlap and the low-res
   *  blur, and it halves the cost of the whole trail stage. */
  private drawTrails(dt: number, time: number, th: Theme): void {
    const gl = this.gl!;
    const trail = this.trail!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, trail.write.fbo);
    gl.viewport(0, 0, trail.w, trail.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.fadeProg);
    const uf = this.uFade!;
    uf.setTexture('uTex', trail.read.tex, 0);
    uf.set2f('uTexel', 1 / trail.w, 1 / trail.h);
    uf.set1f('uFade', Math.pow(this.pTrail, dt * 60));
    drawFullscreen(gl);

    // half the population paints ribbons at 2x deposit — same ink, half cost
    this.bindBoidPass(th, time, 0.22, 1.15, 1.8);
    this.drawBoids(this.count >> 1);
    trail.swap();
  }

  private effectiveTheme(ctx: ModeContext): Theme {
    return ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
  }

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const gl = ctx.gl;
    if (!this.gl || !this.post || !this.trail) return;
    this.aspect = ctx.width / Math.max(1, ctx.height);
    this.scale = Math.sqrt(this.aspect);
    const th = this.effectiveTheme(ctx);

    // runtime safety valve: if real frame time stays terrible, shrink the
    // internal targets further (ctx.dt is clamped, so measure wall time);
    // recover slowly once the device proves itself fast again
    const now = performance.now();
    if (this.lastNow > 0) {
      const real = Math.min(1, (now - this.lastNow) / 1000);
      this.dtEma += (real - this.dtEma) * 0.1;
      if (this.dtEma > 0.06 && this.perfScale > 0.45 && now - this.lastScaleDrop > 1200) {
        this.perfScale = Math.max(0.45, this.perfScale * 0.72);
        this.lastScaleDrop = now;
        this.allocTargets(ctx.width, ctx.height);
      } else if (this.dtEma < 0.024 && this.perfScale < 1 && now - this.lastScaleDrop > 6000) {
        this.perfScale = Math.min(1, this.perfScale * 1.25);
        this.lastScaleDrop = now;
        this.allocTargets(ctx.width, ctx.height);
      }
    }
    this.lastNow = now;

    // --- interaction state --------------------------------------------------
    const pt = ctx.pointer;
    if (pt.down || Math.abs(pt.dx) + Math.abs(pt.dy) > 0.5) this.lastPtrAct = ctx.time;
    if (pt.down && !this.wasDown) this.pressAt = ctx.time;
    this.wasDown = pt.down;
    // a press is a full predator for 2.5s, then eases to 45% — a marathon hold
    // (or the engine's synthetic demo sweep) must not evacuate the whole sky
    const predW = clamp(1 - (ctx.time - this.pressAt - 2.5) / 2.0, 0.45, 1);

    const px2w = 1 / Math.max(1, ctx.height); // device px (GL origin) → world
    this.predData.fill(0);
    if (pt.touches.length > 0) {
      // multitouch: every touch is its own predator
      const n = Math.min(4, pt.touches.length);
      for (let i = 0; i < n; i++) {
        const t = pt.touches[i];
        this.predData[i * 4] = t.x * px2w;
        this.predData[i * 4 + 1] = t.y * px2w;
        this.predData[i * 4 + 2] = 1;
        this.predData[i * 4 + 3] = predW;
      }
    } else if (pt.down) {
      this.predData[0] = pt.x * px2w;
      this.predData[1] = pt.y * px2w;
      this.predData[2] = 1;
      this.predData[3] = predW;
    } else {
      // hovering near (recently moved, not pressed) = gentle beacon
      const w = clamp(1 - (ctx.time - this.lastPtrAct - 2.2) / 0.8, 0, 1);
      if (w > 0.001 && this.lastPtrAct > -100) {
        this.predData[0] = pt.x * px2w;
        this.predData[1] = pt.y * px2w;
        this.predData[2] = 0;
        this.predData[3] = w;
      }
    }

    // ghost predator only hunts while nobody is pressing
    const gTarget = pt.down || pt.touches.length > 0 ? 0 : 1;
    this.ghostW += (gTarget - this.ghostW) * Math.min(1, ctx.dt * 2.5);
    this.setGhost(ctx.time, this.ghostW);

    if (ctx.pulse) {
      this.pulseAt = ctx.time;
      this.pulsePos = [this.aspect * 0.5, 0.5];
    }
    const pulseAge = ctx.time - this.pulseAt;
    this.pulseData[0] = this.pulsePos[0];
    this.pulseData[1] = this.pulsePos[1];
    this.pulseData[2] = Math.max(0, pulseAge);
    this.pulseData[3] = pulseAge >= 0 && pulseAge < PULSE_LIFE ? 1 : 0;

    // --- simulate + paint ----------------------------------------------------
    this.step(ctx.dt, ctx.time);
    if ((this.stepIdx & 1) === 0) this.drawTrails(ctx.dt * 2, ctx.time, th);

    this.post.begin();
    gl.useProgram(this.presentProg);
    const up = this.uPresent!;
    up.setTexture('uTrail', this.trail.read.tex, 0);
    up.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    const gc = th.colors[Math.min(1, th.colors.length - 1)];
    up.set3f('uGlow', gc[0], gc[1], gc[2]);
    up.set1f('uTime', ctx.time);
    drawFullscreen(gl);

    this.bindBoidPass(th, ctx.time, 1.0, 1.0, 1.0);
    this.drawBoids(this.count);

    this.post.end({ exposure: 1.1, bloom: 0.45, vignette: 0.32 });

    // canonical state: post.end leaves FBO null + TEXTURE0 active; blend is off
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const p of [this.updateProg, this.boidProg, this.fadeProg, this.presentProg]) {
      if (p) gl.deleteProgram(p);
    }
    this.updateProg = this.boidProg = this.fadeProg = this.presentProg = null;
    this.uUpdate = this.uBoid = this.uFade = this.uPresent = null;
    for (const t of [...this.posTex, ...this.velTex]) gl.deleteTexture(t);
    for (const f of this.simFbo) gl.deleteFramebuffer(f);
    this.posTex = [];
    this.velTex = [];
    this.simFbo = [];
    if (this.boidVAO) gl.deleteVertexArray(this.boidVAO);
    this.boidVAO = null;
    this.trail?.destroy();
    this.trail = null;
    this.post?.destroy();
    this.post = null;
    this.gl = null;
  }
}

export const flockMode: Mode = new FlockMode();
