/**
 * GALAXY — 銀河. A living spiral galaxy as a GPU particle simulation.
 *
 * State lives in two RGBA32F ping-pong texture pairs (positions: xy=pos,
 * z=age, w=seed; velocities: xy=vel), stepped by fragment shaders (no
 * blending into float targets). 512²×quality particles are drawn as
 * gl.POINTS via gl_VertexID + texelFetch, additively accumulated into an
 * RGBA16F trail buffer and composited through the shared HDR post chain.
 *
 * Dynamics: Plummer-softened central gravity gives strong differential
 * rotation (fast core, slow rim → perpetual shear, no equilibrium). A weak
 * rotating 2-arm density-wave potential keeps grand-design spiral arms
 * crisp forever while particles stream through them. Mild curl-noise
 * turbulence textures the disc; a gentle relaxation toward the local
 * circular orbit re-forms the disc after pulses and pointer slingshots.
 * Particles that age out or get ejected respawn onto arm-biased disc orbits.
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, compileProgram, drawFullscreen, UniformSetter,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Physics constants (shared JS/GLSL — keep in sync with SIM_COMMON below)
// ---------------------------------------------------------------------------

const GM0 = 0.09;        // central mass × G at gravity=1
const CORE = 0.14;       // Plummer softening radius
const DISC_RD = 0.175;   // exponential-disc scale length (world units)
const OMEGA_P = 0.6;     // spiral pattern speed, rad/s
const ARM_M = 2;         // number of arms
const ARM_K = 5.0;       // winding constant m/tan(pitch)
const ARM_BIAS = 0.55;   // how hard spawns are pulled onto arm ridges
const MAX_WELLS = 6;

// Seeding already produces a formed, arm-biased disc on exact orbits; the
// warm steps only shear in texture, so init stays cheap even on software GL.
const WARM_STEPS = 16;   // pre-warm sim iterations (≈0.53s of sim time)
const WARM_TRAIL = 6;    // last N warm steps also accumulate trails
const WARM_DT = 1 / 30;

const WELL_G = 0.5;          // pointer gravity-well strength
const TRAIL_STEADY = 0.045;  // steady-state accumulated brightness per particle
const BRIGHT_SINGLE = 0.055; // per-frame brightness when trails are off

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

/** Shared by both sim passes so respawn decisions/spawn states match exactly. */
const SIM_COMMON = `
const float TWO_PI  = 6.283185307179586;
const float GM0     = ${GM0.toFixed(6)};
const float CORE2   = ${(CORE * CORE).toFixed(6)};
const float DISC_RD = ${DISC_RD.toFixed(6)};
const float OMEGA_P = ${OMEGA_P.toFixed(6)};
const float ARM_M   = ${ARM_M.toFixed(1)};
const float ARM_K   = ${ARM_K.toFixed(4)};
const float ARM_BIAS= ${ARM_BIAS.toFixed(4)};
const float R_KILL2 = 1.8225; // 1.35^2

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float lifeOf(float seed) { return mix(9.0, 22.0, seed); }

float vcirc(float r) {
  float q = r * r + CORE2;
  return r * sqrt(GM0 * uGravity) * inversesqrt(q * sqrt(q)); // q^-0.75
}

// Deterministic per-seed spawn on an arm-biased exponential-disc orbit.
void spawnState(float seed, float t, out vec2 sp, out vec2 sv) {
  float u1 = hash11(seed * 7.31 + 0.17);
  float u2 = hash11(seed * 3.97 + 5.29);
  float u3 = hash11(seed * 9.13 + 2.71);
  float u4 = hash11(seed * 5.51 + 8.43);
  float u5 = hash11(seed * 2.23 + 1.62);
  float r = -DISC_RD * log(max(u1 * u2, 1e-5)); // Gamma(2) ⇒ exp. surface density
  r = clamp(r, 0.03, 0.92) * (0.97 + 0.06 * u5);
  float th = u3 * TWO_PI;
  for (int k = 0; k < 2; k++) { // pull toward the arm ridge (potential minimum s=π)
    float s = ARM_M * th + ARM_K * log(r) - ARM_M * OMEGA_P * t;
    th += ARM_BIAS * sin(s) / ARM_M;
  }
  vec2 rhat = vec2(cos(th), sin(th));
  sp = r * rhat;
  float vc = vcirc(r);
  // velocity dispersion grows toward the centre so eccentric orbits fill the
  // core (no centrifugal "hole"), while the outer disc stays cold and thin
  float disp = 0.12 + 1.0 * exp(-r * 9.0);
  sv = vec2(-rhat.y, rhat.x) * vc * (0.92 + 0.16 * u4) + rhat * (u5 - 0.5) * disp * vc;
}
`;

const VEL_FS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform float uDt;
uniform float uTime;
uniform float uGravity;
uniform float uTurb;
uniform float uPulse;
uniform vec2 uPulseCenter;
uniform vec4 uWells[${MAX_WELLS}]; // xy = world pos, z = strength
uniform int uNumWells;
out vec4 outColor;
${SIM_COMMON}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// curl of value noise, analytic derivatives (single octave)
vec2 curl2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  vec2 g = du * (vec2(k1, k2) + k4 * u.yx);
  return vec2(g.y, -g.x);
}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, tc, 0);
  vec2 p = P.xy;
  float age = P.z, seed = P.w;
  float r2 = dot(p, p);
  if (age > lifeOf(seed) || !(r2 <= R_KILL2)) { // !(≤) also catches NaN
    vec2 sp, sv;
    spawnState(fract(seed + 0.61803398875), uTime, sp, sv);
    outColor = vec4(sv, 0.0, 0.0);
    return;
  }
  vec2 v = texelFetch(uVel, tc, 0).xy;
  float r = sqrt(r2);

  // Plummer-softened central gravity → differential rotation
  float inv = inversesqrt(r2 + CORE2);
  vec2 acc = -p * (GM0 * uGravity) * (inv * inv * inv);

  // rotating 2-arm density-wave potential Φ = A cos(mθ + k ln r − mΩp t)
  if (r > 0.05) {
    vec2 rhat = p / r;
    vec2 that = vec2(-rhat.y, rhat.x);
    float s = ARM_M * atan(p.y, p.x) + ARM_K * log(r) - ARM_M * OMEGA_P * uTime;
    float amp = 0.03 * uGravity * sin(s)
              * smoothstep(0.04, 0.16, r) * exp(-1.7 * r) * (r / (r2 + 0.02));
    acc += amp * (ARM_K * rhat + ARM_M * that);
  }

  // mild curl-noise turbulence, suppressed in the very core
  vec2 tf = curl2(p * 4.5 + vec2(0.0, uTime * 0.17));
  acc += tf * (0.55 * uTurb) * smoothstep(0.02, 0.18, r);

  // pointer gravity wells — softened so particles slingshot, never capture
  for (int i = 0; i < ${MAX_WELLS}; i++) {
    if (i >= uNumWells) break;
    vec2 d = uWells[i].xy - p;
    float iw = inversesqrt(dot(d, d) + 0.01); // ε = 0.1
    acc += d * (uWells[i].z * iw * iw * iw);
  }

  v += acc * uDt;

  // pulse: one-frame radial blast
  if (uPulse > 0.0) {
    vec2 d = p - uPulseCenter;
    float dd = length(d);
    vec2 dir = dd > 1e-3 ? d / dd
             : normalize(vec2(hash11(seed * 3.7 + 0.3), hash11(seed * 8.1 + 0.9)) - 0.5 + 1e-4);
    v += dir * uPulse * (0.30 + 1.20 * exp(-dd * dd * 2.5));
  }

  // slight damping: relax toward the local circular orbit (re-forms the
  // disc). Blast-fast particles damp harder so pulses re-form briskly.
  float vc = vcirc(r);
  vec2 vtar = vec2(-p.y, p.x) / max(r, 1e-3) * vc;
  float kd = 0.35 + 0.8 * smoothstep(1.3, 2.6, length(v));
  v += (vtar - v) * (1.0 - exp(-kd * uDt));

  float sp2 = dot(v, v);
  if (sp2 > 9.0) v *= 3.0 * inversesqrt(sp2);
  outColor = vec4(v, 0.0, 0.0);
}
`;

const POS_FS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel; // already-updated velocities
uniform float uDt;
uniform float uTime;
uniform float uGravity;
out vec4 outColor;
${SIM_COMMON}
void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 P = texelFetch(uPos, tc, 0);
  vec2 p = P.xy;
  float age = P.z, seed = P.w;
  float r2 = dot(p, p);
  if (age > lifeOf(seed) || !(r2 <= R_KILL2)) { // same decision as the vel pass
    float ns = fract(seed + 0.61803398875);
    vec2 sp, sv;
    spawnState(ns, uTime, sp, sv);
    outColor = vec4(sp, 0.0, ns);
    return;
  }
  vec2 v = texelFetch(uVel, tc, 0).xy;
  outColor = vec4(p + v * uDt, age + uDt, seed);
}
`;

const DRAW_VS = `#version 300 es
precision highp float;
uniform sampler2D uPos;
uniform sampler2D uVel;
uniform int uSide;
uniform vec2 uW2C;        // world → clip (aspect correction)
uniform float uPointScale;
uniform float uBright;
uniform vec3 uColors[6];
uniform int uNumColors;
out vec3 vColor;
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  ivec2 tc = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);
  vec4 P = texelFetch(uPos, tc, 0);
  vec2 v = texelFetch(uVel, tc, 0).xy;
  gl_Position = vec4(P.xy * uW2C, 0.0, 1.0);
  float r = length(P.xy);
  float sp = length(v);
  // temperature ramp: hot bright core / fast streams → cool dim rim
  float heat = exp(-r * 2.1);
  float spd = clamp((sp - 0.12) * 1.15, 0.0, 1.0);
  float t = clamp(heat * 0.75 + spd * 0.50 + (P.w - 0.5) * 0.15, 0.0, 1.0);
  float fadeIn = clamp(P.z * 2.0, 0.0, 1.0); // soften respawn pop
  vColor = pal(t) * (uBright * (0.45 + 0.75 * heat + 0.80 * spd) * fadeIn);
  gl_PointSize = clamp((0.9 + 1.7 * spd + 1.2 * heat) * uPointScale, 1.0, 6.0);
}
`;

const DRAW_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float f = max(0.0, 1.0 - dot(d, d));
  outColor = vec4(vColor * f, 1.0);
}
`;

const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uFade;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec3 c = texture(uTex, vUv).rgb * uFade;
  outColor = vec4(max(c - 0.0006, 0.0), 1.0); // epsilon kills permanent ghost residue
}
`;

const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec3 uBg;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(uBg + texture(uTex, vUv).rgb, 1.0); }
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

class GalaxyMode implements Mode {
  readonly id = 'galaxy';
  readonly name = { ja: '銀河', en: 'Galaxy' };
  readonly params: ParamDef[] = [
    { key: 'gravity', label: { ja: '重力', en: 'Gravity' }, type: 'range', min: 0.4, max: 2.2, step: 0.05, default: 1.0 },
    { key: 'turb', label: { ja: '乱流', en: 'Turbulence' }, type: 'range', min: 0, max: 1, step: 0.02, default: 0.35 },
    { key: 'trail', label: { ja: '尾', en: 'Trails' }, type: 'range', min: 0, max: 0.96, step: 0.02, default: 0.90 },
  ];

  // live params (persist across quality re-inits — the instance survives)
  private gravity = 1.0;
  private turb = 0.35;
  private trail = 0.90; // trail fade factor; 0 disables the accum buffer

  private side = 512;
  private count = 512 * 512;
  private sceneScale = 1;
  private sceneW = 1;
  private sceneH = 1;
  /**
   * Point rasterisation is per-primitive bound on software GL (SwiftShader).
   * The full population always simulates, but the draw pass renders every
   * Nth particle (texel order is random ⇒ any prefix is a uniform sample)
   * with brightness compensation; trails visually fill in the reduced star
   * count. Base stride comes from the quality tier; on top of that a fast
   * in-mode governor escalates the stride within ~1s when frames run long
   * (and relaxes it after a long fast streak), so software renderers reach
   * a stable frame rate far quicker than tier re-inits alone.
   */
  private drawStride = 1;
  private baseStride = 1;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1; // wall clock — ctx.dt/rAF timestamps can be virtualised
  private pendingDt = 0; // sim time carried over half-rate skips

  private posPP: PingPong | null = null;
  private velPP: PingPong | null = null;
  private accum: PingPong | null = null;
  private accumStale = false;
  private post: Post | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  private velProg: WebGLProgram | null = null;
  private posProg: WebGLProgram | null = null;
  private drawProg: WebGLProgram | null = null;
  private fadeProg: WebGLProgram | null = null;
  private presentProg: WebGLProgram | null = null;
  private velU: UniformSetter | null = null;
  private posU: UniformSetter | null = null;
  private drawU: UniformSetter | null = null;
  private fadeU: UniformSetter | null = null;
  private presentU: UniformSetter | null = null;

  private colorBuf = new Float32Array(18);
  private wellBuf = new Float32Array(MAX_WELLS * 4);

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.side = Math.max(256, Math.round(512 * Math.sqrt(ctx.quality)));
    this.count = this.side * this.side;
    // internal HDR target below canvas res (post upsamples smoothly)
    this.sceneScale = ctx.quality <= 0.5 ? 0.62 : Math.min(0.85, 0.5 + 0.4 * ctx.quality);
    this.baseStride = ctx.quality >= 1 ? 1 : ctx.quality > 0.5 ? 2 : 3;
    // keep an escalated stride across tier re-inits (the machine is still slow)
    this.drawStride = Math.min(8, Math.max(this.baseStride, this.drawStride));
    this.slowTime = 0;
    this.fastTime = 0;
    this.lastNowMs = -1; // don't count init cost as a frame

    this.velProg = compileProgram(gl, FS_TRIANGLE_VS, VEL_FS, 'galaxy.vel');
    this.posProg = compileProgram(gl, FS_TRIANGLE_VS, POS_FS, 'galaxy.pos');
    this.drawProg = compileProgram(gl, DRAW_VS, DRAW_FS, 'galaxy.draw');
    this.fadeProg = compileProgram(gl, FS_TRIANGLE_VS, FADE_FS, 'galaxy.fade');
    this.presentProg = compileProgram(gl, FS_TRIANGLE_VS, PRESENT_FS, 'galaxy.present');
    this.velU = new UniformSetter(gl, this.velProg);
    this.posU = new UniformSetter(gl, this.posProg);
    this.drawU = new UniformSetter(gl, this.drawProg);
    this.fadeU = new UniformSetter(gl, this.fadeProg);
    this.presentU = new UniformSetter(gl, this.presentProg);

    this.posPP = new PingPong(gl, this.side, this.side, gl.RGBA32F, gl.NEAREST);
    this.velPP = new PingPong(gl, this.side, this.side, gl.RGBA32F, gl.NEAREST);

    this.sceneW = Math.max(1, Math.round(ctx.width * this.sceneScale));
    this.sceneH = Math.max(1, Math.round(ctx.height * this.sceneScale));
    this.post = createPost(gl, this.sceneW, this.sceneH);
    this.accum = new PingPong(gl, this.sceneW, this.sceneH, gl.RGBA16F, gl.LINEAR);
    this.accumStale = false;
    this.pendingDt = 0;
    this.layout(ctx); // applies carried-over stride shrink factors

    this.vao = gl.createVertexArray();

    this.seedParticles(ctx);
    this.prewarm(ctx);
  }

  /** CPU-side initial state: exponential disc on circular orbits, arm-biased. */
  private seedParticles(ctx: ModeContext): void {
    const { gl } = ctx;
    const n = this.count;
    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 4);
    const t0 = ctx.time - WARM_STEPS * WARM_DT;
    const sqrtGM = Math.sqrt(GM0 * this.gravity);
    for (let i = 0; i < n; i++) {
      const u1 = Math.random(), u2 = Math.random(), u5 = Math.random();
      let r = -DISC_RD * Math.log(Math.max(u1 * u2, 1e-5));
      r = Math.min(0.92, Math.max(0.03, r)) * (0.97 + 0.06 * u5);
      let th = Math.random() * Math.PI * 2;
      for (let k = 0; k < 2; k++) {
        const s = ARM_M * th + ARM_K * Math.log(r) - ARM_M * OMEGA_P * t0;
        th += ARM_BIAS * Math.sin(s) / ARM_M;
      }
      const cx = Math.cos(th), sy = Math.sin(th);
      const vc = r * sqrtGM * Math.pow(r * r + CORE * CORE, -0.75);
      const vt = vc * (0.92 + 0.16 * Math.random());
      const vr = (u5 - 0.5) * (0.12 + 1.0 * Math.exp(-r * 9)) * vc;
      const seed = Math.random();
      const o = i * 4;
      pos[o] = r * cx;
      pos[o + 1] = r * sy;
      pos[o + 2] = Math.random() * (9 + 13 * seed); // staggered ages
      pos[o + 3] = seed;
      vel[o] = -sy * vt + cx * vr;
      vel[o + 1] = cx * vt + sy * vr;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.posPP!.read.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, pos);
    gl.bindTexture(gl.TEXTURE_2D, this.velPP!.read.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, vel);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Run the sim (and late trail accumulation) so frame 1 is a formed galaxy. */
  private prewarm(ctx: ModeContext): void {
    const { gl } = ctx;
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    for (let i = 0; i < WARM_STEPS; i++) {
      const t = ctx.time - (WARM_STEPS - i) * WARM_DT;
      this.simStep(gl, WARM_DT, t, 0, 0, 0, 0);
      if (this.trail > 0 && i >= WARM_STEPS - WARM_TRAIL) {
        this.accumulateTrails(ctx, th, WARM_DT);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** (Re)size the HDR scene + trail targets; stride ≥4/≥8 shrinks them. */
  private layout(ctx: ModeContext): void {
    if (!this.post || !this.accum) return;
    const s = this.sceneScale * (this.drawStride >= 8 ? 0.75 : 1);
    const w = Math.max(1, Math.round(ctx.width * s));
    const h = Math.max(1, Math.round(ctx.height * s));
    if (w !== this.sceneW || h !== this.sceneH) {
      this.sceneW = w;
      this.sceneH = h;
      this.post.resize(w, h);
    }
    const a = this.drawStride >= 4 ? 0.5 : 1;
    const aw = Math.max(1, Math.round(w * a));
    const ah = Math.max(1, Math.round(h * a));
    if (aw !== this.accum.w || ah !== this.accum.h) this.accum.resize(aw, ah); // zero-inits; trails rebuild
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (key === 'gravity') this.gravity = v;
    else if (key === 'turb') this.turb = v;
    else if (key === 'trail') this.trail = v;
  }

  // -------------------------------------------------------------------------

  /** One velocity + one position pass; leaves BLEND off, swaps both pairs. */
  private simStep(
    gl: WebGL2RenderingContext, dt: number, time: number,
    numWells: number, pulse: number, pulseX: number, pulseY: number,
  ): void {
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, this.side, this.side);

    const vu = this.velU!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.velPP!.write.fbo);
    gl.useProgram(this.velProg);
    vu.setTexture('uPos', this.posPP!.read.tex, 0);
    vu.setTexture('uVel', this.velPP!.read.tex, 1);
    vu.set1f('uDt', dt);
    vu.set1f('uTime', time);
    vu.set1f('uGravity', this.gravity);
    vu.set1f('uTurb', this.turb);
    vu.set1f('uPulse', pulse);
    vu.set2f('uPulseCenter', pulseX, pulseY);
    vu.set4fv('uWells[0]', this.wellBuf);
    vu.set1i('uNumWells', numWells);
    drawFullscreen(gl);
    this.velPP!.swap();

    const pu = this.posU!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.posPP!.write.fbo);
    gl.useProgram(this.posProg);
    pu.setTexture('uPos', this.posPP!.read.tex, 0);
    pu.setTexture('uVel', this.velPP!.read.tex, 1); // updated velocities
    pu.set1f('uDt', dt);
    pu.set1f('uTime', time);
    pu.set1f('uGravity', this.gravity);
    drawFullscreen(gl);
    this.posPP!.swap();
  }

  /**
   * Additive point splat. Caller has bound target FBO + viewport + blend;
   * `targetW` is the render target's width (for point sizing in target px).
   */
  private drawPoints(ctx: ModeContext, th: Theme, bright: number, targetW: number): void {
    const { gl } = ctx;
    const u = this.drawU!;
    gl.useProgram(this.drawProg);
    u.setTexture('uPos', this.posPP!.read.tex, 0);
    u.setTexture('uVel', this.velPP!.read.tex, 1);
    u.set1i('uSide', this.side);
    u.set2f('uW2C', Math.min(1, ctx.height / ctx.width), Math.min(1, ctx.width / ctx.height));
    u.set1f('uPointScale', ctx.dpr * (targetW / Math.max(1, ctx.width)));
    u.set1f('uBright', bright * this.drawStride);
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, Math.ceil(this.count / this.drawStride));
    gl.bindVertexArray(null);
  }

  /** fade previous accum → splat fresh points → swap. */
  private accumulateTrails(ctx: ModeContext, th: Theme, dt: number): void {
    const { gl } = ctx;
    // param is the per-frame fade at 60fps; keep trail LENGTH fps-independent
    const base = Math.min(0.96, this.trail);
    const fade = Math.min(0.98, Math.pow(base, Math.max(dt, 1e-4) * 60));
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum!.write.fbo);
    gl.viewport(0, 0, this.accum!.w, this.accum!.h);
    gl.useProgram(this.fadeProg);
    this.fadeU!.setTexture('uTex', this.accum!.read.tex, 0);
    this.fadeU!.set1f('uFade', fade);
    drawFullscreen(gl);

    // brightness normalised so steady-state accumulation ≈ TRAIL_STEADY vs
    // fade; a low-res accum concentrates splats, so scale down by area ratio
    const countScale = (512 * 512) / this.count;
    const areaScale = (this.accum!.w / this.sceneW) ** 2;
    const bright = TRAIL_STEADY * (1 - fade) * countScale * areaScale;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive into RGBA16F — allowed
    this.drawPoints(ctx, th, bright, this.accum!.w);
    gl.disable(gl.BLEND);
    this.accum!.swap();
  }

  // -------------------------------------------------------------------------

  /**
   * Fast in-mode stride governor — reacts quicker than the engine's tier
   * governor. Measures REAL wall-clock frame time itself: rAF timestamps
   * (and hence ctx.dt) are virtualised in some headless/software renderers
   * and vastly under-report frame cost there.
   */
  private governStride(): void {
    const now = performance.now();
    const real = this.lastNowMs < 0 ? 1 / 60 : Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.045) {          // sustained ≤ ~22fps
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.3 && this.drawStride < 8) {
        // very slow (software GL) jumps straight past intermediate strides
        const mult = this.frameEma > 0.07 ? 4 : 2;
        this.drawStride = Math.min(8, this.drawStride * mult);
        this.slowTime = 0;
      }
    } else if (this.frameEma < 0.022) {   // sustained ≥ ~45fps
      this.fastTime += real;
      this.slowTime = 0;
      if (this.fastTime > 5 && this.drawStride > this.baseStride) {
        this.drawStride = Math.max(this.baseStride, this.drawStride >> 1);
        this.fastTime = 0;
      }
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
  }

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.post || !this.posPP || !this.velPP || !this.accum) return;
    this.governStride();
    this.layout(ctx);
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;

    // world-space pointer wells: every touch is a gravity well; mouse = one well
    // (screen→world mapping inlined — no per-frame closures)
    const w2cx = Math.min(1, ctx.height / ctx.width);
    const w2cy = Math.min(1, ctx.width / ctx.height);
    let numWells = 0;
    const wells = this.wellBuf;
    wells.fill(0);
    if (ctx.pointer.touches.length > 0) {
      for (const t of ctx.pointer.touches) {
        if (numWells >= MAX_WELLS) break;
        const o = numWells * 4;
        wells[o] = ((t.x / ctx.width) * 2 - 1) / w2cx;
        wells[o + 1] = ((t.y / ctx.height) * 2 - 1) / w2cy;
        wells[o + 2] = WELL_G;
        numWells++;
      }
    } else if (ctx.pointer.down) {
      wells[0] = ((ctx.pointer.x / ctx.width) * 2 - 1) / w2cx;
      wells[1] = ((ctx.pointer.y / ctx.height) * 2 - 1) / w2cy;
      wells[2] = WELL_G;
      numWells = 1;
    }

    const pulse = ctx.pulse ? 0.9 : 0;
    const px = (((ctx.pointer.x || ctx.width / 2) / ctx.width) * 2 - 1) / w2cx;
    const py = (((ctx.pointer.y || ctx.height / 2) / ctx.height) * 2 - 1) / w2cy;
    // desperate mode (stride 8 = software GL) runs the sim at half rate,
    // carrying the skipped dt over; a pulse always simulates immediately
    this.pendingDt = Math.min(0.06, this.pendingDt + ctx.dt);
    const desperate = this.drawStride >= 8;
    const skipSim = desperate && pulse === 0 && (ctx.frame & 1) === 1;
    if (!skipSim) {
      const simDt = this.pendingDt;
      this.pendingDt = 0;
      // substep large dts while wells/pulse act, so slingshots stay stable
      const steps = simDt > 0.04 && (numWells > 0 || pulse > 0) && !desperate ? 2 : 1;
      const sdt = simDt / steps;
      for (let s = 0; s < steps; s++) {
        const t = ctx.time - (steps - 1 - s) * sdt;
        this.simStep(gl, sdt, t, numWells, s === steps - 1 ? pulse : 0, px, py);
      }
    }

    if (this.trail > 0.001) {
      if (this.accumStale) { // trails were just re-enabled: start from black
        this.accumStale = false;
        for (const side of [this.accum.read, this.accum.write]) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, side.fbo);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }
      this.accumulateTrails(ctx, th, ctx.dt);
      this.post.begin(); // scene FBO + viewport + blend off
      gl.useProgram(this.presentProg);
      this.presentU!.setTexture('uTex', this.accum.read.tex, 0);
      this.presentU!.set3f('uBg', th.background[0], th.background[1], th.background[2]);
      drawFullscreen(gl);
    } else {
      this.accumStale = true;
      this.post.begin();
      gl.clearColor(th.background[0], th.background[1], th.background[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.drawPoints(ctx, th, BRIGHT_SINGLE * ((512 * 512) / this.count), this.sceneW);
      gl.disable(gl.BLEND);
    }

    this.post.end({ exposure: 1.0, bloom: 0.5, vignette: 0.32 });

    // canonical GL state (post.end already left FBO=null, activeTexture=0)
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const p of [this.velProg, this.posProg, this.drawProg, this.fadeProg, this.presentProg]) {
      if (p) gl.deleteProgram(p);
    }
    this.velProg = this.posProg = this.drawProg = this.fadeProg = this.presentProg = null;
    this.velU = this.posU = this.drawU = this.fadeU = this.presentU = null;
    this.posPP?.destroy();
    this.velPP?.destroy();
    this.accum?.destroy();
    this.posPP = this.velPP = this.accum = null;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    this.post?.destroy();
    this.post = null;
  }
}

export const galaxyMode: Mode = new GalaxyMode();
