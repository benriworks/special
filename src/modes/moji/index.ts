/**
 * MOJI — 文字 / living calligraphy.
 *
 * 65,536 GPU particles (256² at quality 1) that form text glyphs and never
 * stop breathing.
 *
 * Technique
 *  - Targets: the current word is rasterized at 900 weight onto a hidden
 *    2048×1024 canvas-2D; every pixel with alpha > 0.5 becomes a candidate
 *    target. Particles are distributed evenly over the glyph pixels through a
 *    shuffled permutation (organic reform, dense kanji stroke coverage); a
 *    small share gets ambient orbit targets that halo the word.
 *  - Dynamics: a single RGBA32F ping-pong (pos.xy, vel.zw, NEAREST, no
 *    blending) is stepped by a fragment shader: staggered spring-seek toward
 *    the target + damping + fine curl-noise shimmer so the settled word keeps
 *    shimmering, plus a micro target wobble and sparkle twinkles so it never
 *    fully stops. Pointer repulsion is velocity-scaled and injects curl so
 *    particles stream around the finger and eddy back; all touches act at once.
 *  - Transitions: word changes and ctx.pulse reset the choreography clock —
 *    a one-frame outward kick + coarse curl storm, then the spring ramps back
 *    per-particle with a stagger keyed to target x, so the word reforms in a
 *    wave sweeping left → right.
 *  - Render: additive point sprites into post.ts's RGBA16F HDR scene
 *    (palette-only colors, bloom on, tonemapped by post).
 *
 * HEADLESS FONT CAVEAT: verify containers may lack CJK fonts. After
 * rasterizing we count lit pixels and measure fill density; a CJK string that
 * comes back blank or as hollow tofu boxes is rejected and the cycler falls
 * through to the next Latin phrase (real user devices have CJK fonts). So
 * verify screenshots may show "SPECIAL"/"LUMINA" instead of 特別 — expected.
 * If no font renders at all, a built-in dot-matrix "LUMINA" guarantees a word.
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, compileProgram, drawFullscreen, makeTexture, UniformSetter,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

const PHRASES = ['特別', 'SPECIAL', '光', 'LUMINA', '遊ぼう', 'PLAY'];
const CYCLE_S = 7.2;              // auto-cycle period
const RASTER_W = 2048;            // offscreen rasterization resolution
const RASTER_H = 1024;
const RASTER_PAD = 90;
const TEXT_THROTTLE_MS = 150;     // trailing re-rasterize throttle while typing
const AMBIENT_FRACTION = 0.06;    // share of particles orbiting as halo
const FONT_STACK =
  '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic",' +
  '"Noto Sans JP","Noto Sans CJK JP",sans-serif';
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ]/;

// 5×7 dot-matrix glyphs — last-resort word when no system font renders at all.
const DOT_FONT: Record<string, number[]> = {
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

// Simulation: one texel = one particle. pos.xy / vel.zw in "sim units":
// y spans [-0.5, 0.5] over the viewport height, x spans [-A/2, A/2].
const SIM_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPosVel;   // rg = pos, ba = vel
uniform sampler2D uTarget;   // rg = target, b = colorT (+2 => ambient), a = stagger
uniform float uTime;
uniform float uDt;
uniform float uBurstTime;    // start of the current choreography
uniform float uStaggerSpan;  // seconds the reform wave takes to sweep the word
uniform float uStorm;        // transition turbulence multiplier
uniform vec2  uKickPos;      // one-frame explosion (pulse / word change)
uniform float uKick;
uniform vec2  uBounds;       // half extents of sim space (A/2, 0.5)
uniform vec4  uPtr[4];       // pointers: pos.xy, vel.zw (sim units, /s)
uniform vec4  uPtrStr;       // per-pointer scatter strength
uniform int   uPtrCount;
uniform float uTurb;         // 乱れ param
uniform float uReturn;       // 集まる速さ param
out vec4 outPV;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
vec2 curl(vec2 p) {
  const float e = 0.11;
  float n1 = vnoise(p + vec2(0.0, e));
  float n2 = vnoise(p - vec2(0.0, e));
  float n3 = vnoise(p + vec2(e, 0.0));
  float n4 = vnoise(p - vec2(e, 0.0));
  return vec2(n1 - n2, n4 - n3) / (2.0 * e);
}
// analytic divergence-free field (curl of ψ = sin x · sin y) — far cheaper
// than noise-curl; used for the always-on shimmer/eddies hot path.
vec2 gyro(vec2 q) {
  return vec2(sin(q.x) * cos(q.y), -cos(q.x) * sin(q.y));
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec4 pv = texelFetch(uPosVel, tc, 0);
  vec4 tg = texelFetch(uTarget, tc, 0);
  vec2 p = pv.xy;
  vec2 v = pv.zw;
  float seed = hash12(vec2(tc) + 0.517);

  float ambient = step(1.5, tg.b);
  float stagger = tg.a;
  vec2 target = tg.rg;

  // ambient halo particles orbit the word slowly
  if (ambient > 0.5) {
    float w = (0.10 + 0.25 * seed) * (seed > 0.5 ? 1.0 : -1.0);
    float ca = cos(w * uTime);
    float sa = sin(w * uTime);
    target = mat2(ca, -sa, sa, ca) * target;
  }

  // micro target orbit — settled particles NEVER fully stop
  float ph = seed * 6.2831853;
  target += 0.0035 * vec2(sin(uTime * (0.8 + seed * 0.9) + ph),
                          cos(uTime * (1.1 + seed * 0.6) + ph * 1.7));

  // choreography envelope: 0 = free curl storm, 1 = fully sprung to target.
  // stagger keyed to target x => the reform sweeps across the word like a wave.
  float form = smoothstep(0.0, 0.7, (uTime - uBurstTime) - stagger * uStaggerSpan);

  // one-frame explosion kick
  if (uKick > 0.0) {
    vec2 kd = p - uKickPos;
    float kl = max(length(kd), 0.02);
    vec2 kdir = kd / kl;
    float fall = 1.0 / (1.0 + kl * 1.5);
    v += kdir * uKick * (0.55 + 0.9 * seed) * fall;
    v += vec2(-kdir.y, kdir.x) * uKick * 0.5 * (seed - 0.5) * fall;
  }

  // fine curl field: settled shimmer + pointer eddies (two-octave gyro,
  // per-particle phase offset so every particle rides its own tiny orbit)
  vec2 cFine = gyro(p * 5.2 + seed * 3.1 + vec2(uTime * 0.8, -uTime * 0.6))
             + 0.6 * gyro(vec2(p.y, -p.x) * 9.7 + seed * 7.7 + vec2(-uTime * 1.1, uTime * 0.9));

  vec2 acc = vec2(0.0);
  float shimmer = (0.012 + 0.05 * uTurb) * mix(1.6, 1.0, form) * mix(1.0, 2.2, ambient);
  acc += cFine * shimmer;
  // coarse storm swirl only while transitioning — the branch skips the second
  // curl evaluation for settled particles (big win on software rasterizers)
  float storm = (1.0 - form) * uStorm * (0.7 + 2.2 * uTurb);
  if (storm > 1e-3) {
    acc += curl(p * 1.7 + vec2(-uTime * 0.06, uTime * 0.045)) * storm;
  }

  // spring-seek target (weaker for the halo so it drifts)
  float k = uReturn * (9.0 + 7.0 * seed) * form * mix(1.0, 0.28, ambient);
  acc += (target - p) * k;

  // pointers: velocity-scaled scatter + tangential streaming + curl injection
  for (int i = 0; i < 4; i++) {
    if (i >= uPtrCount) break;
    vec2 pp = uPtr[i].xy;
    vec2 pvel = uPtr[i].zw;
    float str = uPtrStr[i];
    vec2 pd = p - pp;
    float d = length(pd);
    vec2 dir = pd / max(d, 1e-4);
    float infl = exp(-d * d * 42.0);
    acc += dir * infl * str * 3.2;
    vec2 tang = vec2(-dir.y, dir.x);
    float sgn = dot(tang, pvel) >= 0.0 ? 1.0 : -1.0;
    acc += tang * sgn * infl * min(length(pvel), 3.0) * 1.5;
    acc += cFine * infl * str * 2.2;
  }

  v += acc * uDt;
  v *= exp(-mix(2.6, 5.2, form) * uDt);   // lighter damping mid-storm
  float sp = length(v);
  if (sp > 3.0) v *= 3.0 / sp;

  // soft containment just outside the view
  vec2 lim = uBounds * 1.25;
  vec2 over = p - clamp(p, -lim, lim);
  v -= over * (40.0 * uDt);

  p += v * uDt;
  outPV = vec4(p, v);
}
`;

const RENDER_VS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPosVel;
uniform sampler2D uTarget;
uniform int   uSide;
uniform vec2  uBounds;
uniform float uTime;
uniform float uPtSize;
uniform float uGain;
uniform vec3  uColors[6];
uniform int   uNumColors;
out vec3 vColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(x);
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], x - float(i));
}

void main() {
  ivec2 tc = ivec2(gl_VertexID % uSide, gl_VertexID / uSide);
  vec4 pv = texelFetch(uPosVel, tc, 0);
  vec4 tg = texelFetch(uTarget, tc, 0);
  float ambient = step(1.5, tg.b);
  float colorT = tg.b - 2.0 * ambient;
  float seed = hash12(vec2(tc) + 0.517);

  // occasional sparkle twinkle in the brightest palette color
  float slot = floor(uTime * 1.5 + seed * 97.0);
  float tw = hash12(vec2(seed * 511.7, slot));
  float sp = step(0.982, tw) * sin(3.14159265 * fract(uTime * 1.5 + seed * 97.0));

  float speed = length(pv.zw);
  vec3 bright = uColors[uNumColors - 1];
  vec3 col = pal(colorT);
  col = mix(col, bright, clamp(speed * 0.5, 0.0, 0.6));   // fast => hotter
  float inten = mix(1.0, 0.35, ambient) * (0.55 + min(speed * 1.4, 1.1));
  vColor = (col * inten + bright * sp * 2.5) * uGain;

  gl_Position = vec4(pv.xy / uBounds, 0.0, 1.0);
  gl_PointSize = uPtSize * (0.75 + 0.5 * seed) * (1.0 + sp * 1.8);
}
`;

const RENDER_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  float fall = exp(-r2 * 9.0) * smoothstep(0.25, 0.16, r2);
  outColor = vec4(vColor * fall, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

interface RasterStats {
  count: number;
  minX: number; maxX: number; minY: number; maxY: number;
  density: number; // lit pixels / bbox area — tofu boxes come out hollow (< ~0.1)
}

type TransitionKind = 'seed' | 'cycle' | 'pulse' | 'type';

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

class MojiMode implements Mode {
  readonly id = 'moji';
  readonly name = { ja: '文字', en: 'Moji' };
  readonly params: ParamDef[] = [
    { key: 'text', label: { ja: '文字', en: 'Text' }, type: 'text', default: '', maxLength: 24, placeholder: { ja: '好きな言葉を入力', en: 'Type anything' } },
    { key: 'turbulence', label: { ja: '乱れ', en: 'Turbulence' }, type: 'range', min: 0, max: 2, step: 0.05, default: 1 },
    { key: 'return', label: { ja: '集まる速さ', en: 'Return speed' }, type: 'range', min: 0.3, max: 2.5, step: 0.05, default: 1 },
  ];

  // GL resources
  private simProg: WebGLProgram | null = null;
  private renderProg: WebGLProgram | null = null;
  private simU: UniformSetter | null = null;
  private renderU: UniformSetter | null = null;
  private pp: PingPong | null = null;           // RGBA32F pos.xy / vel.zw
  private targetTex: WebGLTexture | null = null; // RGBA32F targets
  private vao: WebGLVertexArrayObject | null = null;
  private post: Post | null = null;

  // 2D rasterization resources
  private cv: HTMLCanvasElement | null = null;
  private c2: CanvasRenderingContext2D | null = null;
  private pixels: Float32Array | null = null;   // lit-pixel (x, y) pairs, reused

  // particle bookkeeping
  private side = 256;
  private count = 65536;
  private perm: Uint32Array | null = null;      // shuffled particle → slot map
  private targetData: Float32Array | null = null;
  private colorBuf = new Float32Array(18);
  private ptrBuf = new Float32Array(16);
  private ptrStr = new Float32Array(4);

  // sim state
  private aspect = 1;
  private simScale = 0.8;
  private gain = 0.055;
  private burstTime = -100;
  private staggerSpan = 1;
  private stormMul = 1;
  private kick: { x: number; y: number; s: number } | null = null;
  private turbulence = 1;
  private returnSpeed = 1;

  // text state
  private currentText = '';
  private customText = '';
  private pendingText: string | null = null;
  private pendingAtMs = 0;
  private phraseIdx = 0;
  private nextCycleAt = 0;
  private cjkBroken = false;    // set once a CJK phrase rasterizes as tofu/blank
  private refitAtMs = 0;        // resize refit throttle (0 = none pending)

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const gl = ctx.gl;
    // particle count scales with quality at init: 65,536 at q=1, floor 128²
    this.side = Math.max(128, Math.round(256 * Math.sqrt(ctx.quality)));
    this.count = this.side * this.side;
    this.aspect = ctx.width / Math.max(1, ctx.height);
    // HDR scene at reduced res — additive point fill is the SwiftShader hot
    // path, and post upsamples smoothly, so keep this modest.
    this.simScale = Math.min(0.62, Math.max(0.4, 0.62 * ctx.quality));
    this.gain = 0.105 * (65536 / this.count);

    this.simProg = compileProgram(gl, FS_TRIANGLE_VS, SIM_FS, 'moji.sim');
    this.renderProg = compileProgram(gl, RENDER_VS, RENDER_FS, 'moji.render');
    this.simU = new UniformSetter(gl, this.simProg);
    this.renderU = new UniformSetter(gl, this.renderProg);
    this.vao = gl.createVertexArray();
    this.pp = new PingPong(gl, this.side, this.side, gl.RGBA32F); // NEAREST
    this.targetTex = makeTexture(gl, { w: this.side, h: this.side, internalFormat: gl.RGBA32F });
    this.targetData = new Float32Array(this.count * 4);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );

    this.cv = document.createElement('canvas');
    this.cv.width = RASTER_W;
    this.cv.height = RASTER_H;
    this.c2 = this.cv.getContext('2d', { willReadFrequently: true });

    this.perm = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i++) this.perm[i] = i;
    this.shufflePerm(hashString('lumina-moji'));

    // reset text/choreography state (init also runs after quality re-init)
    this.currentText = '';
    this.customText = '';
    this.pendingText = null;
    this.cjkBroken = false;
    this.refitAtMs = 0;
    this.kick = null;
    this.stormMul = 1;
    this.staggerSpan = 1;

    // first word (with CJK → Latin fallback), then seed particles ON the word
    this.seedInitialWord(gl);
    this.seedParticles(gl, ctx);

    // frame 1 must already be alive: start mid-reform so the tail of the wave
    // is still sweeping across the word while the left half shimmers in place.
    this.burstTime = ctx.time - 1.2;
    this.nextCycleAt = ctx.time + CYCLE_S;

    // pre-warm: a few sim steps so velocities/shimmer are live immediately
    for (let i = 0; i < 3; i++) this.simStep(ctx, 1 / 60, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  resize(ctx: ModeContext): void {
    if (!this.post) return;
    this.aspect = ctx.width / Math.max(1, ctx.height);
    this.post.resize(
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
    // refit targets to the new aspect (throttled — resizes come in bursts)
    this.refitAtMs = performance.now() + TEXT_THROTTLE_MS;
  }

  setParam(key: string, value: number | string): void {
    if (key === 'text') {
      const t = String(value).slice(0, 24);
      this.customText = t.trim();      // pauses/resumes cycling immediately
      this.pendingText = t.trim();     // rasterization is throttled (trailing)
      this.pendingAtMs = performance.now();
    } else if (key === 'turbulence') {
      this.turbulence = Number(value);
    } else if (key === 'return') {
      this.returnSpeed = Number(value);
    }
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.simProg) gl.deleteProgram(this.simProg);
    if (this.renderProg) gl.deleteProgram(this.renderProg);
    if (this.targetTex) gl.deleteTexture(this.targetTex);
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.pp?.destroy();
    this.post?.destroy();
    this.simProg = null;
    this.renderProg = null;
    this.simU = null;
    this.renderU = null;
    this.pp = null;
    this.targetTex = null;
    this.vao = null;
    this.post = null;
    // release 2D canvas resources
    if (this.cv) { this.cv.width = 1; this.cv.height = 1; }
    this.cv = null;
    this.c2 = null;
    this.pixels = null;
    this.perm = null;
    this.targetData = null;
    this.pendingText = null;
  }

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const gl = ctx.gl;
    if (!this.simProg || !this.renderProg || !this.pp || !this.post || !this.targetTex) return;

    const nowMs = performance.now();

    // trailing text throttle — retarget ~150ms after the last keystroke
    if (this.pendingText !== null && nowMs - this.pendingAtMs >= TEXT_THROTTLE_MS) {
      const txt = this.pendingText;
      this.pendingText = null;
      this.applyCustomText(gl, ctx, txt);
    }

    // resize refit (no choreography — the word just re-fits the new aspect)
    if (this.refitAtMs > 0 && nowMs >= this.refitAtMs) {
      this.refitAtMs = 0;
      if (this.currentText) this.applyText(gl, this.currentText);
    }

    // pulse = spectacle: explode everything outward from the pointer, reform
    if (ctx.pulse) {
      // engine convention: pointer at exact (0,0) means "never moved" → center
      const px = ctx.pointer.x || ctx.width / 2;
      const py = ctx.pointer.y || ctx.height / 2;
      const kx = (px / Math.max(1, ctx.width) - 0.5) * this.aspect;
      const ky = py / Math.max(1, ctx.height) - 0.5;
      this.startTransition(ctx, 'pulse', kx, ky);
      this.nextCycleAt = Math.max(this.nextCycleAt, ctx.time + 4.5); // let it land
    }

    // phrase auto-cycling (paused while the user has typed custom text)
    if (this.customText === '' && ctx.time >= this.nextCycleAt) {
      this.advancePhrase(gl, ctx);
      this.nextCycleAt = ctx.time + CYCLE_S;
    }

    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;

    // --- simulate (float ping-pong, blending off) ---
    this.simStep(ctx, ctx.dt, true);

    // --- render additive HDR points into post's RGBA16F scene ---
    this.post.begin();
    gl.clearColor(th.background[0], th.background[1], th.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.renderProg);
    const u = this.renderU!;
    u.setTexture('uPosVel', this.pp.read.tex, 0);
    u.setTexture('uTarget', this.targetTex, 1);
    u.set1i('uSide', this.side);
    u.set2f('uBounds', this.aspect * 0.5, 0.5);
    u.set1f('uTime', ctx.time);
    const sceneH = Math.max(1, Math.round(ctx.height * this.simScale));
    u.set1f('uPtSize', Math.min(3.2, Math.max(1.2, sceneH * 0.0045)));
    u.set1f('uGain', this.gain);
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    // tonemap + bloom to the default framebuffer; leaves FBO null, blend off,
    // active texture unit TEXTURE0 — canonical state per the contract.
    this.post.end({ exposure: 1.15, bloom: 0.7, vignette: 0.28 });
  }

  // -------------------------------------------------------------------------
  // Simulation step
  // -------------------------------------------------------------------------

  private simStep(ctx: ModeContext, dt: number, usePointers: boolean): void {
    const gl = ctx.gl;
    const pp = this.pp!;
    const u = this.simU!;

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo);
    gl.viewport(0, 0, this.side, this.side);
    gl.useProgram(this.simProg);
    u.setTexture('uPosVel', pp.read.tex, 0);
    u.setTexture('uTarget', this.targetTex!, 1);
    u.set1f('uTime', ctx.time);
    u.set1f('uDt', Math.max(1e-4, dt));
    u.set1f('uBurstTime', this.burstTime);
    u.set1f('uStaggerSpan', this.staggerSpan);
    u.set1f('uStorm', this.stormMul);
    u.set2f('uBounds', this.aspect * 0.5, 0.5);
    u.set1f('uTurb', this.turbulence);
    u.set1f('uReturn', this.returnSpeed);

    if (this.kick) {
      u.set1f('uKick', this.kick.s);
      u.set2f('uKickPos', this.kick.x, this.kick.y);
      this.kick = null;               // one-frame impulse
    } else {
      u.set1f('uKick', 0);
      u.set2f('uKickPos', 0, 0);
    }

    // pointers → sim space; scatter strength scales with velocity, press adds
    let pc = 0;
    this.ptrBuf.fill(0);
    this.ptrStr.fill(0);
    if (usePointers) {
      const P = ctx.pointer;
      const h = Math.max(1, ctx.height);
      const w = Math.max(1, ctx.width);
      const invDt = 1 / Math.max(1e-3, dt);
      const add = (x: number, y: number, dx: number, dy: number, down: boolean): void => {
        if (pc >= 4) return;
        let vx = (dx / h) * invDt;
        let vy = (dy / h) * invDt;
        const speed = Math.hypot(vx, vy);
        if (speed > 3) { vx *= 3 / speed; vy *= 3 / speed; }
        const str = Math.min(3, speed * 0.5) + (down ? 0.9 : 0);
        if (str < 0.05) return;
        const o = pc * 4;
        this.ptrBuf[o] = (x / w - 0.5) * this.aspect;
        this.ptrBuf[o + 1] = y / h - 0.5;
        this.ptrBuf[o + 2] = vx;
        this.ptrBuf[o + 3] = vy;
        this.ptrStr[pc] = str;
        pc++;
      };
      if (P.touches.length > 0) {
        for (const t of P.touches) add(t.x, t.y, t.dx, t.dy, true); // multitouch
      } else {
        add(P.x, P.y, P.dx, P.dy, P.down);
      }
    }
    u.set4fv('uPtr[0]', this.ptrBuf);
    u.set4f('uPtrStr', this.ptrStr[0], this.ptrStr[1], this.ptrStr[2], this.ptrStr[3]);
    u.set1i('uPtrCount', pc);

    drawFullscreen(gl);
    pp.swap();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // -------------------------------------------------------------------------
  // Choreography / text state
  // -------------------------------------------------------------------------

  private startTransition(ctx: ModeContext, kind: TransitionKind, kx = 0, ky = 0.02): void {
    if (kind === 'cycle' || kind === 'seed') {
      this.burstTime = ctx.time;
      this.staggerSpan = 1.0;
      this.stormMul = 1;
      this.kick = { x: 0, y: 0.02, s: 0.5 };
    } else if (kind === 'pulse') {
      this.burstTime = ctx.time;
      this.staggerSpan = 0.85;
      this.stormMul = 1.35;
      this.kick = { x: kx, y: ky, s: 1.35 };
    } else { // 'type' — soft morph per keystroke, not a full explosion
      this.burstTime = ctx.time - 0.25;
      this.staggerSpan = 0.3;
      this.stormMul = 0.35;
      this.kick = { x: 0, y: 0.02, s: 0.06 };
    }
  }

  private applyCustomText(gl: WebGL2RenderingContext, ctx: ModeContext, txt: string): void {
    const t = txt.trim();
    if (t === '') {
      // input cleared → resume cycling with a full transition to the next word
      if (this.customText === '' && !PHRASES.includes(this.currentText)) {
        this.advancePhrase(gl, ctx);
        this.nextCycleAt = ctx.time + CYCLE_S;
      }
      return;
    }
    if (t === this.currentText) return;
    // if the text can't be rasterized (blank / tofu-only), keep current targets
    if (this.applyText(gl, t)) this.startTransition(ctx, 'type');
  }

  private advancePhrase(gl: WebGL2RenderingContext, ctx: ModeContext): void {
    for (let tries = 0; tries < PHRASES.length; tries++) {
      this.phraseIdx = (this.phraseIdx + 1) % PHRASES.length;
      const p = PHRASES[this.phraseIdx];
      if (this.cjkBroken && CJK_RE.test(p)) continue; // headless: skip known-tofu
      this.shufflePerm(hashString(p) ^ (this.phraseIdx * 2654435761));
      if (this.applyText(gl, p)) {
        this.startTransition(ctx, 'cycle');
        return;
      }
      if (CJK_RE.test(p)) this.cjkBroken = true; // fall through to next (Latin) phrase
    }
    // nothing rasterized (fontless container) — keep the current word alive
  }

  private seedInitialWord(gl: WebGL2RenderingContext): void {
    for (let i = 0; i < PHRASES.length; i++) {
      const p = PHRASES[i];
      if (this.cjkBroken && CJK_RE.test(p)) continue;
      if (this.applyText(gl, p)) {
        this.phraseIdx = i;
        return;
      }
      if (CJK_RE.test(p)) this.cjkBroken = true;
    }
    // no system font rendered anything — guaranteed dot-matrix word
    this.applyDotMatrix(gl, 'LUMINA');
  }

  // -------------------------------------------------------------------------
  // Rasterization → target texture
  // -------------------------------------------------------------------------

  /** Rasterize `text`, validate coverage, rebuild + upload targets. */
  private applyText(gl: WebGL2RenderingContext, text: string): boolean {
    const stats = this.rasterizeText(text);
    if (!stats) return false;
    // tofu heuristic: missing CJK glyphs render as hollow boxes (or blank).
    // Real 900-weight glyphs fill ≳25% of their bbox; boxes are < ~10%.
    if (CJK_RE.test(text) && stats.density < 0.09) return false;
    this.buildTargets(stats, hashString(text));
    this.uploadTargets(gl);
    this.currentText = text;
    return true;
  }

  private applyDotMatrix(gl: WebGL2RenderingContext, word: string): void {
    const c2 = this.c2;
    if (!c2) return;
    c2.clearRect(0, 0, RASTER_W, RASTER_H);
    c2.fillStyle = '#fff';
    const cols = word.length * 6 - 1;
    const cell = Math.floor((RASTER_W - 2 * RASTER_PAD) / cols);
    const x0 = (RASTER_W - cols * cell) / 2;
    const y0 = (RASTER_H - 7 * cell) / 2;
    for (let li = 0; li < word.length; li++) {
      const rows = DOT_FONT[word[li]];
      if (!rows) continue;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r] & (1 << (4 - c))) {
            c2.fillRect(x0 + (li * 6 + c) * cell, y0 + r * cell, cell, cell);
          }
        }
      }
    }
    const stats = this.scanCanvas();
    if (!stats) return;
    this.buildTargets(stats, hashString(word));
    this.uploadTargets(gl);
    this.currentText = word;
  }

  /** Draw `text` fitted onto the offscreen canvas, then scan lit pixels. */
  private rasterizeText(text: string): RasterStats | null {
    const c2 = this.c2;
    if (!c2) return null;
    c2.clearRect(0, 0, RASTER_W, RASTER_H);
    c2.fillStyle = '#fff';
    c2.textAlign = 'center';
    c2.textBaseline = 'middle';
    let fs = 512;
    c2.font = `900 ${fs}px ${FONT_STACK}`;
    const m = c2.measureText(text);
    const tw = Math.max(1, m.width);
    const asc = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : fs * 0.8;
    const desc = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : fs * 0.24;
    const thh = Math.max(1, asc + desc);
    fs = Math.max(10, Math.floor(fs * Math.min(
      (RASTER_W - 2 * RASTER_PAD) / tw,
      (RASTER_H - 2 * RASTER_PAD) / thh,
    )));
    c2.font = `900 ${fs}px ${FONT_STACK}`;
    c2.fillText(text, RASTER_W / 2, RASTER_H / 2);
    return this.scanCanvas();
  }

  /** Collect all pixels with alpha > 0.5 into this.pixels; null if too few. */
  private scanCanvas(): RasterStats | null {
    const c2 = this.c2;
    if (!c2) return null;
    const img = c2.getImageData(0, 0, RASTER_W, RASTER_H);
    const a = img.data; // RGBA bytes; alpha at stride-4 offset 3
    let count = 0;
    let minX = RASTER_W; let maxX = 0; let minY = RASTER_H; let maxY = 0;
    for (let y = 0; y < RASTER_H; y++) {
      const row = y * RASTER_W;
      for (let x = 0; x < RASTER_W; x++) {
        if (a[(row + x) * 4 + 3] > 127) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (count < 40) return null;
    if (!this.pixels || this.pixels.length < count * 2) {
      this.pixels = new Float32Array(Math.ceil(count * 2 * 1.3));
    }
    const pix = this.pixels;
    let w = 0;
    for (let y = minY; y <= maxY; y++) {
      const row = y * RASTER_W;
      for (let x = minX; x <= maxX; x++) {
        if (a[(row + x) * 4 + 3] > 127) { pix[w++] = x; pix[w++] = y; }
      }
    }
    const density = count / ((maxX - minX + 1) * (maxY - minY + 1));
    return { count, minX, maxX, minY, maxY, density };
  }

  /**
   * Build per-particle targets: glyph particles evenly sample the lit pixels
   * through the shuffled permutation; the rest halo the word on an ellipse.
   * Layout: rg = target pos, b = colorT (+2 flags ambient), a = stagger.
   */
  private buildTargets(res: RasterStats, wordSeed: number): void {
    const N = this.count;
    const data = this.targetData!;
    const perm = this.perm!;
    const pix = this.pixels!;
    const rng = mulberry32(wordSeed ^ 0x9e3779b9);
    const A = this.aspect;
    const bw = res.maxX - res.minX + 1;
    const bh = res.maxY - res.minY + 1;
    // fit the word: ≤80% of view width, ≤46% of view height, centered
    // (leaves margin so the bloom halo doesn't clip at the view edges)
    const s = Math.min((0.8 * A) / bw, 0.46 / bh);
    const cx = (res.minX + res.maxX) / 2;
    const cy = (res.minY + res.maxY) / 2;
    const yOff = 0.02;
    const M = res.count;
    const ambientN = Math.min(N - 1, Math.max(Math.round(N * AMBIENT_FRACTION), N - M));
    const G = N - ambientN;
    const haloRx = Math.max(0.55 * bw * s, 0.3 * A);
    const haloRy = Math.max(1.6 * bh * s, 0.22);
    for (let j = 0; j < N; j++) {
      const k = perm[j];
      const o = j * 4;
      if (k < G) {
        const pi = Math.min(M - 1, Math.floor((k * M) / G));
        const px = pix[pi * 2];
        const py = pix[pi * 2 + 1];
        const xn = (px - res.minX) / bw;
        data[o] = (px + rng() - 0.5 - cx) * s;
        data[o + 1] = (cy - (py + rng() - 0.5)) * s + yOff;
        // color by x-band across the word + slight random (palette is dark→bright)
        data[o + 2] = Math.min(1, Math.max(0, 0.22 + 0.78 * xn + (rng() - 0.5) * 0.3));
        // stagger by x-band → the reform wave sweeps left → right
        data[o + 3] = Math.min(1, Math.max(0, xn * 0.8 + rng() * 0.2));
      } else {
        const ang = rng() * Math.PI * 2;
        const rad = 0.8 + rng() * 0.7;
        data[o] = Math.cos(ang) * haloRx * rad;
        data[o + 1] = Math.sin(ang) * haloRy * rad + yOff;
        data[o + 2] = 2 + 0.3 + 0.6 * rng(); // +2 = ambient flag
        data[o + 3] = rng();
      }
    }
  }

  private uploadTargets(gl: WebGL2RenderingContext): void {
    if (!this.targetTex || !this.targetData) return;
    gl.bindTexture(gl.TEXTURE_2D, this.targetTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, this.targetData);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Seed particle positions at their targets (± a small organic offset). */
  private seedParticles(gl: WebGL2RenderingContext, ctx: ModeContext): void {
    const N = this.count;
    const td = this.targetData!;
    const rng = mulberry32(0xc0ffee ^ N);
    const sd = new Float32Array(N * 4);
    for (let j = 0; j < N; j++) {
      const o = j * 4;
      const ang = rng() * Math.PI * 2;
      const r = 0.012 + 0.06 * rng() * rng();
      sd[o] = td[o] + Math.cos(ang) * r;
      sd[o + 1] = td[o + 1] + Math.sin(ang) * r;
      sd[o + 2] = (rng() - 0.5) * 0.06;
      sd[o + 3] = (rng() - 0.5) * 0.06;
    }
    for (const side of [this.pp!.read, this.pp!.write]) {
      gl.bindTexture(gl.TEXTURE_2D, side.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.side, this.side, gl.RGBA, gl.FLOAT, sd);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    void ctx;
  }

  private shufflePerm(seed: number): void {
    const perm = this.perm;
    if (!perm) return;
    const rng = mulberry32(seed);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
  }
}

export const mojiMode: Mode = new MojiMode();
