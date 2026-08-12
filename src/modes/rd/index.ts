/**
 * RD — 反応拡散 / Gray-Scott reaction-diffusion as living coral.
 *
 * Sim: RG16F ping-pong (u,v), NEAREST taps, 5-point Laplacian, forward Euler
 * (Du=0.2097, Dv=0.105, dt=1). Resolution ≈ half canvas × quality, long side
 * capped at 768. 12/9/6 substeps per frame by quality tier so growth crawls
 * in real time; init pre-warms ~320 substeps so frame 1 lands mid-growth.
 *
 * Presentation: chemical v → theme-palette LUT with a hard contrast knee +
 * gradient emboss lighting (normal from ∇v, fixed key light) so the patterns
 * read as relief, composited in HDR through post.ts. A slowly drifting spatial
 * feed-rate variation plus occasional idle micro-seeds keep the field alive
 * forever. Pointer paints v along interpolated stroke segments (multitouch)
 * with a same-frame accent ring; ctx.pulse sweeps an expanding reseed ring.
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, blit, compileProgram, createFBO, drawFullscreen, makeTexture, UniformSetter,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { BeatDetector } from '../../core/audio';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Presets (f = feed, k = kill, fVar = drifting spatial feed variation ±)
// ---------------------------------------------------------------------------

interface Preset { f: number; k: number; fVar: number; }

// Tuned for THIS discretization (Du=0.2097, Dv=0.105, dt=1, 5-point, RG16F):
// mitosis = dividing solitons (spot-seeded); waves = excitable ripples driven
// by a perpetual rain of droplets; worms = dense wriggling loops.
const PRESETS: Record<string, Preset> = {
  coral:   { f: 0.0545, k: 0.0620, fVar: 0.0070 },
  mitosis: { f: 0.0310, k: 0.0620, fVar: 0.0025 },
  waves:   { f: 0.0140, k: 0.0450, fVar: 0.0015 },
  worms:   { f: 0.0780, k: 0.0610, fVar: 0.0040 },
};
const DEFAULT_PRESET = 'coral';

const MAX_SEG = 8;
const MAX_RING = 4;
const MAX_TOUCH = 6;
const BRUSH_R = 0.045;

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const NOISE_GLSL = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), w.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), w.x), w.y);
}
`;

/**
 * Initial condition: u=1 everywhere, v = noise blobs + dots. uSpotty=1 (spot
 * regimes like mitosis) swaps the large blobs — which starve and die there —
 * for a dense field of medium dabs that collapse into dividing solitons.
 */
const SEED_FS = `#version 300 es
precision highp float;
uniform float uSeedOff;
uniform float uAspect;
uniform float uSpotty;
in vec2 vUv;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float n = 0.0;
  n += 0.50 * vnoise(p * 4.2 + uSeedOff);
  n += 0.28 * vnoise(p * 8.9 + uSeedOff * 1.7 + 11.3);
  n += 0.16 * vnoise(p * 17.5 - uSeedOff + 5.1);
  float blobLo = 0.49 + 0.25 * uSpotty;
  float v = smoothstep(blobLo, blobLo + 0.10, n) * 0.9;
  float dots = vnoise(p * 9.0 + uSeedOff * 2.3 + 31.7);
  float dotLo = mix(0.80, 0.60, uSpotty);
  v = max(v, smoothstep(dotLo, dotLo + 0.08, dots) * 0.85);
  float u = 1.0 - v * 0.6;
  outColor = vec4(u, v, 0.0, 1.0);
}
`;

/**
 * Drifting feed-variation field, baked once per frame into a tiny R8 LINEAR
 * texture so the hot substep loop pays one tap instead of per-pixel noise.
 */
const DRIFT_FS = `#version 300 es
precision highp float;
uniform float uDrift;
uniform float uAspect;
in vec2 vUv;
out vec4 outColor;
${NOISE_GLSL}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float n = 0.68 * vnoise(p * 2.5 + vec2(uDrift * 0.039, -uDrift * 0.027))
          + 0.32 * vnoise(p * 5.3 - vec2(uDrift * 0.024, uDrift * 0.031) + 7.7);
  outColor = vec4(n, 0.0, 0.0, 1.0);
}
`;

/** One Gray-Scott substep with the pre-baked spatial feed variation. */
const SIM_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uDriftTex;
uniform vec2 uTexel;
uniform float uF;
uniform float uK;
uniform float uFVar;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 c = texture(uState, vUv).rg;
  vec2 l = texture(uState, vUv - vec2(uTexel.x, 0.0)).rg;
  vec2 r = texture(uState, vUv + vec2(uTexel.x, 0.0)).rg;
  vec2 b = texture(uState, vUv - vec2(0.0, uTexel.y)).rg;
  vec2 t = texture(uState, vUv + vec2(0.0, uTexel.y)).rg;
  vec2 lap = l + r + b + t - 4.0 * c;

  float f = uF + uFVar * (texture(uDriftTex, vUv).r - 0.5) * 2.0;

  float uvv = c.x * c.y * c.y;
  float du = 0.2097 * lap.x - uvv + f * (1.0 - c.x);
  float dv = 0.1050 * lap.y + uvv - (f + uK) * c.y;
  outColor = vec4(clamp(c + vec2(du, dv), 0.0, 1.0), 0.0, 1.0);
}
`;

/** Deposit chemical: stroke segments (pointer/touches) + expanding reseed rings. */
const SPLAT_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uAspect;
uniform int uSegCount;
uniform vec4 uSeg[${MAX_SEG}];   // ax ay bx by (aspect-corrected uv)
uniform vec2 uSegR[${MAX_SEG}];  // radius, amount
uniform int uRingCount;
uniform vec4 uRing[${MAX_RING}]; // cx cy radius width
uniform vec4 uRingAmp;           // amp per ring
uniform float uSeedOff;
in vec2 vUv;
out vec4 outColor;
${NOISE_GLSL}
float distSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec2 st = texture(uState, vUv).rg;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float add = 0.0;
  for (int i = 0; i < ${MAX_SEG}; i++) {
    if (i >= uSegCount) break;
    float d = distSeg(p, uSeg[i].xy, uSeg[i].zw);
    add = max(add, uSegR[i].y * smoothstep(uSegR[i].x, uSegR[i].x * 0.35, d));
  }
  for (int i = 0; i < ${MAX_RING}; i++) {
    if (i >= uRingCount) break;
    float d = abs(length(p - uRing[i].xy) - uRing[i].z);
    float band = smoothstep(uRing[i].w, uRing[i].w * 0.2, d);
    float ns = vnoise(p * 26.0 + uSeedOff + float(i) * 7.31);
    float spots = smoothstep(0.55, 0.85, ns);
    // stir: thin out existing v where the front passes, then reseed in spots
    st.y *= 1.0 - band * uRingAmp[i] * 0.4 * (1.0 - spots);
    st.x = mix(st.x, 1.0, band * uRingAmp[i] * 0.3);
    add = max(add, band * uRingAmp[i] * spots * 0.9);
  }
  st.y = max(st.y, add * 0.95);
  st.x = min(st.x, 1.0 - add * 0.55);
  outColor = vec4(clamp(st, 0.0, 1.0), 0.0, 1.0);
}
`;

/** Fading heat trail: bright wake along strokes and pulse rings. */
const HEAT_FS = `#version 300 es
precision highp float;
uniform sampler2D uHeat;
uniform float uDecay;
uniform float uAspect;
uniform int uSegCount;
uniform vec4 uSeg[${MAX_SEG}];
uniform vec2 uSegR[${MAX_SEG}];
uniform int uRingCount;
uniform vec4 uRing[${MAX_RING}];
uniform vec4 uRingAmp;
in vec2 vUv;
out vec4 outColor;
float distSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  float h = texture(uHeat, vUv).r * uDecay;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  for (int i = 0; i < ${MAX_SEG}; i++) {
    if (i >= uSegCount) break;
    float d = distSeg(p, uSeg[i].xy, uSeg[i].zw);
    h = max(h, uSegR[i].y * smoothstep(uSegR[i].x * 0.95, uSegR[i].x * 0.1, d));
  }
  for (int i = 0; i < ${MAX_RING}; i++) {
    if (i >= uRingCount) break;
    float d = abs(length(p - uRing[i].xy) - uRing[i].z);
    float band = smoothstep(uRing[i].w, uRing[i].w * 0.2, d);
    h = max(h, band * uRingAmp[i] * 0.32);
  }
  outColor = vec4(h, 0.0, 0.0, 1.0);
}
`;

/** Present: palette LUT with hard knee + emboss relief lighting + overlays. */
const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;        // LINEAR copy of the sim
uniform sampler2D uHeat;         // fading stroke/ring wake
uniform vec2 uTexel;
uniform float uAspect;
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uKneeLo;
uniform float uKneeHi;
uniform float uDrift;
uniform int uTouchCount;
uniform vec3 uTouch[${MAX_TOUCH}];  // x, y (aspect uv), radius
uniform int uRingCount;
uniform vec4 uRing[${MAX_RING}];    // cx cy radius width
uniform vec4 uRingAlpha;
in vec2 vUv;
out vec4 outColor;
${NOISE_GLSL}
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  float v  = texture(uState, vUv).g;
  float vl = texture(uState, vUv - vec2(uTexel.x, 0.0)).g;
  float vr = texture(uState, vUv + vec2(uTexel.x, 0.0)).g;
  float vb = texture(uState, vUv - vec2(0.0, uTexel.y)).g;
  float vt = texture(uState, vUv + vec2(0.0, uTexel.y)).g;
  vec2 g = vec2(vr - vl, vt - vb);

  // hard contrast knee → crisp organic silhouettes
  float m = smoothstep(uKneeLo, uKneeHi, v);

  // emboss relief: normal from the chemical gradient, fixed key light
  vec3 nrm = normalize(vec3(-g * 14.0, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.60, 0.66));
  float diff = clamp(dot(nrm, L), 0.0, 1.0);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(nrm, H), 0.0), 32.0);

  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  // slow regional hue drift (same field family as the feed variation)
  float hue = vnoise(p * 1.7 + vec2(uDrift * 0.047, -uDrift * 0.031));
  hue = hue * 0.7 + 0.3 * vnoise(p * 6.3 - vec2(uDrift * 0.031, uDrift * 0.022) + 3.7);

  // body stays mid-palette; the top of the palette is reserved for speculars
  float ramp = clamp(m * (0.16 + 0.40 * diff) + 0.26 * smoothstep(0.26, 0.42, v)
             + (hue - 0.5) * 0.16, 0.0, 1.0);
  // faint drifting currents in the empty water — depth, never a flat void
  vec3 col = uBg * (0.72 + 0.72 * hue);
  col += pal(ramp) * m * (0.40 + 0.85 * diff);
  col += pal(min(ramp + 0.30, 1.0)) * spec * m * 0.9;
  float edge = smoothstep(0.05, 0.30, length(g));
  col += pal(0.80) * edge * edge * 0.30;   // luminous growth fronts

  // fading heat wake: freshly painted strokes / pulse sweeps stay luminous.
  // Saturated accent with a quadratic core — neon glow, never gray fog.
  float heat = texture(uHeat, vUv).r;
  col += uAccent * (0.5 * heat + 1.8 * heat * heat);
  // same-frame pointer feedback: bright ring at each active finger
  for (int i = 0; i < ${MAX_TOUCH}; i++) {
    if (i >= uTouchCount) break;
    float d = length(p - uTouch[i].xy);
    float r = uTouch[i].z;
    float ring = 1.0 - smoothstep(0.0, 0.014, abs(d - r));
    col += uAccent * ring * 2.2;
    col += uAccent * exp(-d * d / max(r * r, 1e-6)) * 0.35;
  }
  // pulse / reseed rings — the spectacle sweep
  for (int i = 0; i < ${MAX_RING}; i++) {
    if (i >= uRingCount) break;
    float d = abs(length(p - uRing[i].xy) - uRing[i].z);
    float band = 1.0 - smoothstep(0.0, uRing[i].w, d);
    col += uAccent * band * band * uRingAlpha[i] * 2.6;
  }
  outColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

interface Ring { x: number; y: number; start: number; dur: number; maxR: number; amp: number; width: number; }
interface Stroke { ax: number; ay: number; bx: number; by: number; r: number; amt: number; t: number; }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class RDMode implements Mode {
  readonly id = 'rd';
  readonly name = { ja: '反応拡散', en: 'RD' };
  readonly params: ParamDef[] = [
    {
      key: 'preset', label: { ja: 'プリセット', en: 'Preset' }, type: 'select',
      options: [
        { value: 'coral', label: { ja: '珊瑚', en: 'Coral' } },
        { value: 'mitosis', label: { ja: '分裂', en: 'Mitosis' } },
        { value: 'waves', label: { ja: '波紋', en: 'Waves' } },
        { value: 'worms', label: { ja: '蠕虫', en: 'Worms' } },
      ],
      default: DEFAULT_PRESET,
    },
    { key: 'speed', label: { ja: '速度', en: 'Speed' }, type: 'range', min: 0.25, max: 2, step: 0.05, default: 1 },
    { key: 'contrast', label: { ja: '濃度', en: 'Contrast' }, type: 'range', min: 0, max: 1, step: 0.01, default: 0.55 },
  ];

  private simProg: WebGLProgram | null = null;
  private seedProg: WebGLProgram | null = null;
  private splatProg: WebGLProgram | null = null;
  private presentProg: WebGLProgram | null = null;
  private driftProg: WebGLProgram | null = null;
  private heatProg: WebGLProgram | null = null;
  private simU: UniformSetter | null = null;
  private seedU: UniformSetter | null = null;
  private splatU: UniformSetter | null = null;
  private presentU: UniformSetter | null = null;
  private driftU: UniformSetter | null = null;
  private heatU: UniformSetter | null = null;

  private sim: PingPong | null = null;
  private heat: PingPong | null = null;
  private presentTex: WebGLTexture | null = null;
  private presentFbo: WebGLFramebuffer | null = null;
  private driftTex: WebGLTexture | null = null;
  private driftFbo: WebGLFramebuffer | null = null;
  private post: Post | null = null;

  private simW = 4;
  private simH = 4;
  private aspect = 1;
  private substepBase = 12;
  private stepBudget = 0; // fractional substeps carried across frames (per-second stepping)
  private postScale = 0.75;

  private preset = DEFAULT_PRESET;
  private speed = 1;
  private contrast = 0.55;
  private fCur = PRESETS[DEFAULT_PRESET].f;
  private kCur = PRESETS[DEFAULT_PRESET].k;
  private fVarCur = PRESETS[DEFAULT_PRESET].fVar;

  private rings: Ring[] = [];
  private strokeHist: Stroke[] = []; // recent paint, replayed across re-inits
  private lastTime = 0;
  private framesSinceInit = 0;
  private lastSplatAt = -100;
  private lastSprinkleAt = 0;
  private heatCool = 1e9;
  private pendingReseed = false;
  private seedOff = 0;
  private drift = 0;

  // audio reactivity (bias exactly 0 / no seeds when ctx.audio === null)
  private beatStrong = new BeatDetector(1.6, 0.14, 0.45);
  private aFBias = 0;
  private lastAudioSeedAt = -100;

  private colorBuf = new Float32Array(18);
  private segBuf = new Float32Array(MAX_SEG * 4);
  private segRBuf = new Float32Array(MAX_SEG * 2);
  private ringBuf = new Float32Array(MAX_RING * 4);
  private ringAmpBuf = new Float32Array(4);
  private touchBuf = new Float32Array(MAX_TOUCH * 3);
  private ringAlphaBuf = new Float32Array(4);
  // per-frame gather counters (methods below, not per-frame closures)
  private segCount = 0;
  private touchCount = 0;

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.simProg = compileProgram(gl, FS_TRIANGLE_VS, SIM_FS, 'rd.sim');
    this.seedProg = compileProgram(gl, FS_TRIANGLE_VS, SEED_FS, 'rd.seed');
    this.splatProg = compileProgram(gl, FS_TRIANGLE_VS, SPLAT_FS, 'rd.splat');
    this.presentProg = compileProgram(gl, FS_TRIANGLE_VS, PRESENT_FS, 'rd.present');
    this.driftProg = compileProgram(gl, FS_TRIANGLE_VS, DRIFT_FS, 'rd.drift');
    this.heatProg = compileProgram(gl, FS_TRIANGLE_VS, HEAT_FS, 'rd.heat');
    this.simU = new UniformSetter(gl, this.simProg);
    this.seedU = new UniformSetter(gl, this.seedProg);
    this.splatU = new UniformSetter(gl, this.splatProg);
    this.presentU = new UniformSetter(gl, this.presentProg);
    this.driftU = new UniformSetter(gl, this.driftProg);
    this.heatU = new UniformSetter(gl, this.heatProg);

    this.substepBase = ctx.quality >= 0.95 ? 12 : ctx.quality >= 0.6 ? 9 : 6;
    this.postScale = clamp(0.6 * ctx.quality + 0.05, 0.42, 0.65);
    this.computeSimSize(ctx);

    this.sim = new PingPong(gl, this.simW, this.simH, gl.RG16F, gl.NEAREST, gl.CLAMP_TO_EDGE);
    this.heat = new PingPong(gl, this.simW, this.simH, gl.R8, gl.LINEAR, gl.CLAMP_TO_EDGE);
    this.allocPresentTarget(gl);
    if (this.driftTex) gl.deleteTexture(this.driftTex);
    if (this.driftFbo) gl.deleteFramebuffer(this.driftFbo);
    this.driftTex = makeTexture(gl, { w: 64, h: 64, internalFormat: gl.R8, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE });
    this.driftFbo = createFBO(gl, this.driftTex);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );

    this.rings.length = 0;
    this.framesSinceInit = 0;
    this.stepBudget = 0;
    this.lastSplatAt = -100;
    this.lastSprinkleAt = 0;
    this.aFBias = 0;
    this.lastAudioSeedAt = -100;
    this.heatCool = 1e9; // fresh heat texture is zero — nothing to decay yet
    this.pendingReseed = false;
    this.drift = Math.random() * 500;
    // preset persists across re-inits (tier change); snap f/k to it
    const p = PRESETS[this.preset] ?? PRESETS[DEFAULT_PRESET];
    this.fCur = p.f; this.kCur = p.k; this.fVarCur = p.fVar;

    // ZERO-INPUT LIFE: seed noise blobs, then run mid-growth pre-warm so the
    // very first presented frame already shows developed, crawling patterns.
    this.seedAndPrewarm(gl);
    // a quality-tier re-init must not eat the user's fresh painting
    this.replayStrokes(gl);
  }

  /** Re-splat recent strokes (chemical + aged heat) into a fresh field. */
  private replayStrokes(gl: WebGL2RenderingContext): void {
    const now = this.lastTime;
    this.strokeHist = this.strokeHist.filter((s) => now - s.t < 4);
    if (!this.sim || !this.heat || !this.splatProg || !this.splatU || !this.heatProg || !this.heatU) return;
    if (this.strokeHist.length === 0) return;
    gl.viewport(0, 0, this.simW, this.simH);
    const seg = this.segBuf;
    const segR = this.segRBuf;
    for (let ofs = 0; ofs < this.strokeHist.length; ofs += MAX_SEG) {
      const batch = this.strokeHist.slice(ofs, ofs + MAX_SEG);
      for (let i = 0; i < batch.length; i++) {
        const s = batch[i];
        seg[i * 4] = s.ax; seg[i * 4 + 1] = s.ay; seg[i * 4 + 2] = s.bx; seg[i * 4 + 3] = s.by;
        segR[i * 2] = s.r; segR[i * 2 + 1] = s.amt;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim.write.fbo);
      gl.useProgram(this.splatProg);
      const su = this.splatU;
      su.setTexture('uState', this.sim.read.tex, 0);
      su.set1f('uAspect', this.aspect);
      su.set1i('uSegCount', batch.length);
      gl.uniform4fv(su.loc('uSeg[0]'), seg);
      gl.uniform2fv(su.loc('uSegR[0]'), segR);
      su.set1i('uRingCount', 0);
      su.set1f('uSeedOff', this.seedOff);
      drawFullscreen(gl);
      this.sim.swap();
      // heat replay, faded by stroke age
      for (let i = 0; i < batch.length; i++) segR[i * 2 + 1] = batch[i].amt * Math.exp(-(now - batch[i].t) * 1.5);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.heat.write.fbo);
      gl.useProgram(this.heatProg);
      const hu = this.heatU;
      hu.setTexture('uHeat', this.heat.read.tex, 0);
      hu.set1f('uDecay', 1);
      hu.set1f('uAspect', this.aspect);
      hu.set1i('uSegCount', batch.length);
      gl.uniform4fv(hu.loc('uSeg[0]'), seg);
      gl.uniform2fv(hu.loc('uSegR[0]'), segR);
      hu.set1i('uRingCount', 0);
      drawFullscreen(gl);
      this.heat.swap();
    }
    this.heatCool = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private computeSimSize(ctx: ModeContext): void {
    let w = ctx.width * 0.5 * ctx.quality;
    let h = ctx.height * 0.5 * ctx.quality;
    const long = Math.max(w, h);
    if (long > 768) { const s = 768 / long; w *= s; h *= s; }
    this.simW = Math.max(64, Math.round(w));
    this.simH = Math.max(64, Math.round(h));
    this.aspect = this.simW / this.simH;
  }

  private allocPresentTarget(gl: WebGL2RenderingContext): void {
    if (this.presentTex) gl.deleteTexture(this.presentTex);
    if (this.presentFbo) gl.deleteFramebuffer(this.presentFbo);
    // LINEAR half-float copy of the sim for smooth presentation gradients
    // (sim taps themselves stay NEAREST).
    this.presentTex = makeTexture(gl, {
      w: this.simW, h: this.simH, internalFormat: gl.RG16F, filter: gl.LINEAR, wrap: gl.CLAMP_TO_EDGE,
    });
    this.presentFbo = createFBO(gl, this.presentTex);
  }

  private bakeDrift(gl: WebGL2RenderingContext): void {
    if (!this.driftProg || !this.driftU || !this.driftFbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.driftFbo);
    gl.viewport(0, 0, 64, 64);
    gl.useProgram(this.driftProg);
    this.driftU.set1f('uDrift', this.drift);
    this.driftU.set1f('uAspect', this.aspect);
    drawFullscreen(gl);
  }

  private seedAndPrewarm(gl: WebGL2RenderingContext): void {
    if (!this.sim || !this.seedProg || !this.seedU) return;
    this.seedOff = Math.random() * 100;
    this.bakeDrift(gl);
    // Mitosis solitons sit below their minimum stable radius at half res, so
    // that preset warms at full resolution (fewer steps to bound the stall).
    // Everything else grows at half sim res (4x cheaper — keeps init and
    // tier-change stalls short even under SwiftShader), then upsamples and
    // refines at full res. Either way frame 1 lands mid-growth.
    const fullRes = this.preset === 'mitosis';
    // waves is transient by nature — a short warm-up leaves the seed ripples
    // still mid-flight on the first presented frame
    const steps = fullRes ? 220 : this.preset === 'worms' ? 400 : this.preset === 'waves' ? 140 : 320;
    const pw = fullRes ? this.simW : Math.max(48, this.simW >> 1);
    const ph = fullRes ? this.simH : Math.max(48, this.simH >> 1);
    const spotty = this.preset === 'mitosis' ? 1 : this.preset === 'worms' ? 0.65 : 0;
    gl.viewport(0, 0, pw, ph);
    const seedInto = (fbo: WebGLFramebuffer) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.useProgram(this.seedProg);
      this.seedU!.set1f('uSeedOff', this.seedOff);
      this.seedU!.set1f('uAspect', this.aspect);
      this.seedU!.set1f('uSpotty', spotty);
      drawFullscreen(gl);
    };
    if (fullRes) {
      seedInto(this.sim.write.fbo);
      this.sim.swap();
      for (let i = 0; i < steps; i++) this.stepOnce(gl);
    } else {
      const warm = new PingPong(gl, pw, ph, gl.RG16F, gl.NEAREST, gl.CLAMP_TO_EDGE);
      seedInto(warm.write.fbo);
      warm.swap();
      for (let i = 0; i < steps; i++) this.stepPing(gl, warm, pw, ph);
      gl.viewport(0, 0, this.simW, this.simH);
      blit(gl, warm.read.tex, this.sim.write.fbo);
      this.sim.swap();
      warm.destroy();
      for (let i = 0; i < 24; i++) this.stepOnce(gl); // smooth the upsample, resume growth
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private stepPing(gl: WebGL2RenderingContext, pp: PingPong, w: number, h: number): void {
    if (!this.simProg || !this.simU) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.write.fbo);
    gl.useProgram(this.simProg);
    const u = this.simU;
    u.setTexture('uState', pp.read.tex, 0);
    u.setTexture('uDriftTex', this.driftTex!, 1);
    u.set2f('uTexel', 1 / w, 1 / h);
    u.set1f('uF', this.fCur + this.aFBias);
    u.set1f('uK', this.kCur);
    u.set1f('uFVar', this.fVarCur);
    drawFullscreen(gl);
    pp.swap();
  }

  private stepOnce(gl: WebGL2RenderingContext): void {
    if (this.sim) this.stepPing(gl, this.sim, this.simW, this.simH);
  }

  resize(ctx: ModeContext): void {
    const { gl } = ctx;
    const ow = this.simW;
    const oh = this.simH;
    this.computeSimSize(ctx);
    if (this.sim && (this.simW !== ow || this.simH !== oh)) {
      this.sim.resize(this.simW, this.simH);   // contents lost → re-warm
      this.heat?.resize(this.simW, this.simH);
      this.allocPresentTarget(gl);
      this.seedAndPrewarm(gl);
      // a resize (device rotation) must not eat the user's fresh painting
      this.replayStrokes(gl);
    }
    this.post?.resize(
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
  }

  setParam(key: string, value: number | string): void {
    if (key === 'preset') {
      const id = String(value);
      const p = PRESETS[id];
      if (!p || id === this.preset) return;
      this.preset = id;
      if (this.framesSinceInit < 2) {
        // applied right after init (deep link / restored param): snap f/k and
        // regrow under the correct regime — the coral-grown prewarm may not
        // survive a hard jump to another (f,k).
        this.fCur = p.f; this.kCur = p.k; this.fVarCur = p.fVar;
        this.pendingReseed = true;
      } else {
        // live switch: f/k glide toward the new regime (in frame()) + local
        // reseed rings inject fresh chemical — never a blank reset.
        for (let i = 0; i < 3; i++) {
          this.pushRing({
            x: (0.12 + 0.76 * Math.random()) * this.aspect,
            y: 0.12 + 0.76 * Math.random(),
            start: this.lastTime, dur: 1.1, maxR: 0.5, amp: 0.85, width: 0.05,
          });
        }
      }
    } else if (key === 'speed') {
      const v = Number(value);
      if (Number.isFinite(v)) this.speed = clamp(v, 0.25, 2);
    } else if (key === 'contrast') {
      const v = Number(value);
      if (Number.isFinite(v)) this.contrast = clamp(v, 0, 1);
    }
  }

  private pushRing(r: Ring): void {
    if (this.rings.length >= MAX_RING) this.rings.shift();
    this.rings.push(r);
  }

  /** Append a stroke segment for this frame's splat/heat passes. */
  private addSeg(ax: number, ay: number, bx: number, by: number, radius: number, amount: number, record = false): void {
    if (this.segCount >= MAX_SEG) return;
    const seg = this.segBuf;
    const segR = this.segRBuf;
    seg[this.segCount * 4] = ax; seg[this.segCount * 4 + 1] = ay;
    seg[this.segCount * 4 + 2] = bx; seg[this.segCount * 4 + 3] = by;
    segR[this.segCount * 2] = radius; segR[this.segCount * 2 + 1] = amount;
    this.segCount++;
    if (record) {
      // lastTime === ctx.time (set at the top of frame())
      this.strokeHist.push({ ax, ay, bx, by, r: radius, amt: amount, t: this.lastTime });
      if (this.strokeHist.length > 96) this.strokeHist.splice(0, this.strokeHist.length - 96);
    }
  }

  /** Append a same-frame pointer feedback ring for the present pass. */
  private addTouchVis(x: number, y: number): void {
    if (this.touchCount >= MAX_TOUCH) return;
    this.touchBuf[this.touchCount * 3] = x;
    this.touchBuf[this.touchCount * 3 + 1] = y;
    this.touchBuf[this.touchCount * 3 + 2] = BRUSH_R;
    this.touchCount++;
  }

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.sim || !this.post || !this.presentProg || !this.presentU || !this.splatProg || !this.splatU) return;
    this.lastTime = ctx.time;
    this.framesSinceInit++;
    this.drift += ctx.dt;
    if (this.pendingReseed) {
      this.pendingReseed = false;
      this.seedAndPrewarm(gl); // regrow under the deep-linked preset's f/k
    }

    // glide f/k toward the active preset (smooth preset transitions)
    const p = PRESETS[this.preset] ?? PRESETS[DEFAULT_PRESET];
    const glide = 1 - Math.exp(-2.2 * ctx.dt);
    this.fCur += (p.f - this.fCur) * glide;
    this.kCur += (p.k - this.kCur) * glide;
    this.fVarCur += (p.fVar - this.fVarCur) * glide;

    // pulse → expanding reseed ring from the pointer (SPECTACLE)
    if (ctx.pulse) {
      const cx = ctx.pointer.nx * this.aspect;
      const cy = ctx.pointer.ny;
      const maxR = Math.hypot(Math.max(cx, this.aspect - cx), Math.max(cy, 1 - cy)) * 1.05;
      this.pushRing({ x: cx, y: cy, start: ctx.time, dur: 1.5, maxR, amp: 1.0, width: 0.05 });
    }
    // expire rings (in place — no per-frame array/closure) and stale strokes
    if (this.rings.length > 0) {
      let w = 0;
      for (let i = 0; i < this.rings.length; i++) {
        const r = this.rings[i];
        if (ctx.time - r.start < r.dur) this.rings[w++] = r;
      }
      this.rings.length = w;
    }
    while (this.strokeHist.length > 0 && ctx.time - this.strokeHist[0].t > 4) this.strokeHist.shift();

    // --- gather paint strokes (multitouch; GL-oriented; same-frame) ---------
    const invH = 1 / Math.max(1, ctx.height);
    this.segCount = 0;
    this.touchCount = 0;
    const seg = this.segBuf;
    const segR = this.segRBuf;
    const pt = ctx.pointer;
    if (pt.touches.length > 0) {
      for (const t of pt.touches) {
        const bx = t.x * invH, by = t.y * invH;
        this.addSeg(bx - t.dx * invH, by - t.dy * invH, bx, by, BRUSH_R, 1.0, true);
        this.addTouchVis(bx, by);
      }
    } else if (pt.down) {
      const bx = pt.x * invH, by = pt.y * invH;
      this.addSeg(bx - pt.dx * invH, by - pt.dy * invH, bx, by, BRUSH_R, 1.0, true);
      this.addTouchVis(bx, by);
    }
    if (this.segCount > 0) this.lastSplatAt = ctx.time;
    const userSegs = this.segCount; // sprinkles below stay out of the heat trail

    // anti-stagnation: tiny random seeds when nothing has stirred for a while.
    // The excitable waves regime is self-extinguishing by nature, so it gets a
    // perpetual rain of droplets — each launches an expanding ripple ring.
    const rains = this.preset === 'waves';
    const idleGate = rains ? 2 : 6;
    const gap = rains ? 1.2 : 3.2;
    if (ctx.time - this.lastSplatAt > idleGate && ctx.time - this.lastSprinkleAt > gap) {
      this.lastSprinkleAt = ctx.time;
      const x = (0.08 + 0.84 * Math.random()) * this.aspect;
      const y = 0.08 + 0.84 * Math.random();
      this.addSeg(x, y, x, y, rains ? 0.028 : 0.02, rains ? 0.9 : 0.8);
    }

    // audio: feed rate leans with the bass (patterns fatten/thin with the
    // music); a strong beat sprinkles one tiny seed via the same micro-seed
    // machinery. ctx.audio === null → bias exactly 0 and no extra segs.
    const au = ctx.audio;
    this.aFBias = au ? 0.0035 * au.low : 0;
    if (au !== null && this.beatStrong.update(au.low, ctx.time, ctx.dt)
      && ctx.time - this.lastAudioSeedAt > 0.9) {
      this.lastAudioSeedAt = ctx.time;
      const x = (0.1 + 0.8 * Math.random()) * this.aspect;
      const y = 0.1 + 0.8 * Math.random();
      this.addSeg(x, y, x, y, 0.02, 0.8);
    }

    // --- splat + heat passes (once per frame, before substeps) ---------------
    this.bakeDrift(gl);
    gl.viewport(0, 0, this.simW, this.simH);
    const ringN = this.rings.length;
    const rb = this.ringBuf;
    const ra = this.ringAmpBuf;
    for (let i = 0; i < ringN; i++) {
      const r = this.rings[i];
      const t = clamp((ctx.time - r.start) / r.dur, 0, 1);
      const ease = 1 - (1 - t) * (1 - t);
      rb[i * 4] = r.x; rb[i * 4 + 1] = r.y;
      rb[i * 4 + 2] = ease * r.maxR;
      rb[i * 4 + 3] = r.width * (1 + 0.5 * t);
      ra[i] = r.amp * (1 - 0.6 * t);
    }
    if (this.segCount > 0 || ringN > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim.write.fbo);
      gl.useProgram(this.splatProg);
      const su = this.splatU;
      su.setTexture('uState', this.sim.read.tex, 0);
      su.set1f('uAspect', this.aspect);
      su.set1i('uSegCount', this.segCount);
      gl.uniform4fv(su.loc('uSeg[0]'), seg);
      gl.uniform2fv(su.loc('uSegR[0]'), segR);
      su.set1i('uRingCount', ringN);
      gl.uniform4fv(su.loc('uRing[0]'), rb);
      su.set4f('uRingAmp', ra[0], ra[1], ra[2], ra[3]);
      su.set1f('uSeedOff', this.seedOff);
      drawFullscreen(gl);
      this.sim.swap();
    }
    // fading heat trail (decays every frame; strokes and ring sweeps recharge it)
    this.heatCool = userSegs > 0 || ringN > 0 ? 0 : this.heatCool + 1;
    if (this.heat && this.heatProg && this.heatU && this.heatCool < 180) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.heat.write.fbo);
      gl.useProgram(this.heatProg);
      const hu = this.heatU;
      hu.setTexture('uHeat', this.heat.read.tex, 0);
      hu.set1f('uDecay', 0.965);
      hu.set1f('uAspect', this.aspect);
      hu.set1i('uSegCount', userSegs);
      gl.uniform4fv(hu.loc('uSeg[0]'), seg);
      gl.uniform2fv(hu.loc('uSegR[0]'), segR);
      hu.set1i('uRingCount', ringN);
      gl.uniform4fv(hu.loc('uRing[0]'), rb);
      hu.set4f('uRingAmp', ra[0], ra[1], ra[2], ra[3]);
      drawFullscreen(gl);
      this.heat.swap();
    }

    // --- reaction substeps: growth crawls in real time -----------------------
    // budgeted per SECOND, not per frame — 120Hz phones run half the substeps
    // per frame (same speed, same GPU cost/s as 60fps); 30fps runs double.
    // At exactly 60fps this yields substepBase*speed steps/frame, unchanged.
    this.stepBudget += this.substepBase * this.speed * ctx.dt * 60;
    const maxSub = Math.min(24, this.substepBase * 2);
    const substeps = Math.min(Math.floor(this.stepBudget), maxSub);
    // keep the fractional remainder; drop backlog beyond the cap (no long
    // fast-forward bursts after a hiccup)
    this.stepBudget = Math.min(this.stepBudget - substeps, 1);
    for (let i = 0; i < substeps; i++) this.stepOnce(gl);

    // --- LINEAR copy for smooth presentation gradients -----------------------
    gl.viewport(0, 0, this.simW, this.simH);
    blit(gl, this.sim.read.tex, this.presentFbo);

    // --- present in HDR through post ------------------------------------------
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    this.post.begin();
    gl.clearColor(th.background[0], th.background[1], th.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.presentProg);
    const u = this.presentU;
    u.setTexture('uState', this.presentTex!, 0);
    if (this.heat) u.setTexture('uHeat', this.heat.read.tex, 1);
    u.set2f('uTexel', 1 / this.simW, 1 / this.simH);
    u.set1f('uAspect', this.aspect);
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
    const half = 0.13 - 0.10 * this.contrast; // contrast → knee hardness
    u.set1f('uKneeLo', Math.max(0.02, 0.16 - half));
    u.set1f('uKneeHi', 0.16 + half);
    u.set1f('uDrift', this.drift);
    u.set1i('uTouchCount', this.touchCount);
    gl.uniform3fv(u.loc('uTouch[0]'), this.touchBuf);
    u.set1i('uRingCount', ringN);
    const rv = this.ringBuf;
    const rva = this.ringAlphaBuf;
    for (let i = 0; i < ringN; i++) {
      const r = this.rings[i];
      const t = clamp((ctx.time - r.start) / r.dur, 0, 1);
      const ease = 1 - (1 - t) * (1 - t);
      rv[i * 4] = r.x; rv[i * 4 + 1] = r.y;
      rv[i * 4 + 2] = ease * r.maxR;
      rv[i * 4 + 3] = 0.035 + 0.05 * t;
      rva[i] = (1 - t) * r.amp;
    }
    gl.uniform4fv(u.loc('uRing[0]'), rv);
    u.set4f('uRingAlpha', rva[0], rva[1], rva[2], rva[3]);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.15, bloom: 0.4, vignette: 0.28 });

    // canonical GL state (blend was never enabled; post.end left FBO null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    if (this.simProg) gl.deleteProgram(this.simProg);
    if (this.seedProg) gl.deleteProgram(this.seedProg);
    if (this.splatProg) gl.deleteProgram(this.splatProg);
    if (this.presentProg) gl.deleteProgram(this.presentProg);
    if (this.driftProg) gl.deleteProgram(this.driftProg);
    if (this.heatProg) gl.deleteProgram(this.heatProg);
    this.simProg = this.seedProg = this.splatProg = this.presentProg = this.driftProg = this.heatProg = null;
    this.simU = this.seedU = this.splatU = this.presentU = this.driftU = this.heatU = null;
    this.sim?.destroy();
    this.sim = null;
    this.heat?.destroy();
    this.heat = null;
    if (this.presentTex) gl.deleteTexture(this.presentTex);
    if (this.presentFbo) gl.deleteFramebuffer(this.presentFbo);
    if (this.driftTex) gl.deleteTexture(this.driftTex);
    if (this.driftFbo) gl.deleteFramebuffer(this.driftFbo);
    this.presentTex = null;
    this.presentFbo = null;
    this.driftTex = null;
    this.driftFbo = null;
    this.post?.destroy();
    this.post = null;
    this.rings.length = 0;
  }
}

export const rdMode: Mode = new RDMode();
