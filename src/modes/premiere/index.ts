/**
 * PREMIERE — 上映 / a giant-format pre-show for an audience of one.
 *
 * A ~47s staged teaser loop inside a dark auditorium, rendered as ONE
 * fullscreen analytic-raycast pass (no marching: plane hits + closed-form
 * cone scattering) plus ONE additive point draw for dust, composited in HDR
 * through post.ts.
 *
 *  A  void      — near-black hall, drifting motes, a faint hairline of light.
 *  B  beam      — the projector ignites behind/above the camera: analytic
 *                 volumetric cone (jittered samples along the ray × value
 *                 noise + a closed-form closest-approach core), dust swirls
 *                 into the light, one searchlight sweep, then lock.
 *  C  frame     — a colossal 1.43:1 screen frame traces itself in perspective
 *                 (bottom → sides climb → top closes in), height-reference
 *                 ticks climb the sides while the camera cranes UP; a
 *                 sub-bass shudder (2–3 frame camera shake) when it completes.
 *  D  countdown — film-leader 5・4・3・2・1: two-arm radial wipe, rings,
 *                 crosshair, cue-dot blips, gate weave + grain; numerals come
 *                 from an offscreen 2D-canvas glyph atlas (900-weight, with
 *                 seven-segment / dot-matrix fallbacks for fontless headless
 *                 containers — see moji's tofu caution).
 *  E  premiere  — one-frame white wall + anamorphic streak + letterbox bars;
 *                 the LUMINA wordmark blazes, then dissolves into THE FEATURE:
 *                 the session-memory atlas played oldest → newest as a slow
 *                 Ken-Burns reel (crossfade every ~3s, palette grading, film
 *                 grain). Screen light spills onto the floor and feeds the
 *                 beam/dust. Empty atlas ⇒ procedural palette "trailer shots".
 *  loop         — iris-out, then phase A again with flipped sweep direction /
 *                 palette bias / countdown start (5 vs 3).
 *
 * Interaction: pointer = parallax look-around; DRAG (A–C) steers the beam;
 * HOLD (E) = dolly push-in with FOV narrowing. Pulse = SKIP/SLAM: cut to the
 * final "1" and slam into the reveal; during E it re-runs the wordmark slam
 * with a bigger flare. Audio (guarded): level feeds beam/dust, bass attacks
 * in E shake the frame + pop the flare, highs widen the grain.
 *
 * Perf: post scene at reduced res on a wall-clock-governed ladder
 * (gravity's scheme); software-GL preset lowers scatter samples, dust count
 * and skips the second grain octave. Init starts the loop mid-B so cold
 * screenshots land on the beam igniting, never on the black void.
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { BeatDetector } from '../../core/audio';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Stage constants (shared JS/GLSL — keep in sync with the shader chunks)
// ---------------------------------------------------------------------------

// Phase clock (base seconds; テンポ scales the clock rate)
const B0 = 6;              // beam ignites
const C0 = 13;             // frame starts tracing
const D0 = 21;             // countdown begins
const E0 = 27;             // slam / premiere
const E1 = 45;             // iris-out begins
const LOOP_T = 46.5;
const SHUDDER_AT = 18.75;  // frame-complete sub-bass shudder
const D_LEN = E0 - D0;

// Auditorium geometry (world units; camera eye height 1.5). The screen is
// CLOSE and TALL — its top edge starts above the view and the crane reveals it.
const SZ = -9.0;           // screen plane z
const HW = 10.1;           // screen half width  → 20.2 wide
const SB = 0.6;            // screen bottom y
const ST = 15.0;           // screen top y       → 14.4 tall (1.40:1, towering)
const APEX: [number, number, number] = [0, 8.3, 8.5]; // projector, behind/above

const SHOT_DUR = 3.0;      // reel seconds per memory
const SHOT_XF = 0.85;      // reel crossfade seconds
const LETTERBOX = 0.13;    // letterbox bar height (fraction of screen)

const RES_LADDER = [1.0, 0.85, 0.7, 0.55] as const;

const FONT_STACK = '"Helvetica Neue", "Arial", "Noto Sans", system-ui, sans-serif';

// 5×7 dot-matrix letters — last-resort wordmark when no system font renders.
const DOT_FONT: Record<string, number[]> = {
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  I: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
};
// seven-segment digit map (a top, b tr, c br, d bottom, e bl, f tl, g mid)
const SEG: Record<number, string> = { 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd' };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ss = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const ease = (t: number) => t * t * (3 - 2 * t);
const fract1 = (x: number) => x - Math.floor(x);
const jhash = (n: number) => fract1(Math.sin(n * 127.1 + 311.7) * 43758.5453);

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

/** True for CPU rasterizers (SwiftShader, llvmpipe, …) — they pay per texel. */
function detectSoftwareGL(gl: WebGL2RenderingContext): boolean {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GLSL chunks
// ---------------------------------------------------------------------------

const COMMON_GLSL = `
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform vec3 uAccent;
uniform float uPalBias;
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/** Camera + beam-cone uniforms and evaluation, shared by both programs. */
const SCENE_GLSL = `
uniform vec3 uCamPos;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform float uFocal;
uniform vec2 uAsp;      // (w/min, h/min)
uniform vec2 uShake;
uniform vec3 uApex;
uniform vec3 uAxis;     // unit, apex → beam target
uniform float uCosIn;
uniform float uCosOut;
uniform float uBeamLen;
uniform float uBeamI;
uniform float uTime;

/** Beam-cone density at a world point: angular window × throw attenuation. */
float coneAt(vec3 X) {
  vec3 v = X - uApex;
  float d = max(length(v), 1e-4);
  float ca = dot(v, uAxis) / d;
  float ang = smoothstep(uCosOut, uCosIn, ca);
  ang *= ang;
  float att = 1.1 * exp(-d * 0.085);
  float win = smoothstep(0.4, 2.2, d) * smoothstep(uBeamLen + 4.0, uBeamLen - 1.0, d);
  return ang * att * win;
}
`;

const makeMainFS = (soft: boolean): string => `#version 300 es
precision highp float;
${COMMON_GLSL}
${SCENE_GLSL}
uniform float uHair;      // phase-A hairline envelope
uniform float uTrace;     // frame tracing 0..1 (stays 1 after C)
uniform float uTicks;     // height-tick climb 0..1
uniform float uFrameGain; // frame line brightness (dims once the show starts)
uniform float uScrDark;   // pre-show screen-face sheen
uniform float uCountOn;
uniform float uDigit;     // 1..5
uniform float uDigitF;    // 0..1 within the current digit (drives the wipe)
uniform float uClack;     // projector clack flash at digit change
uniform float uCue;       // corner cue-dot blip
uniform float uWhite;     // slam flash
uniform float uWord;      // wordmark envelope
uniform float uWordGlow;
uniform float uReelOn;
uniform float uReelMix;
uniform vec4 uRectA;      // memory-atlas slot rect (uv offset, size)
uniform vec4 uRectB;
uniform vec4 uKenA;       // (zoom, panX, panY, _)
uniform vec4 uKenB;
uniform float uHasMem;
uniform float uSeedA;
uniform float uSeedB;
uniform float uShotTA;    // per-shot anim time (procedural reel)
uniform float uShotTB;
uniform float uLetterbox;
uniform float uFlareX;    // anamorphic streak envelope
uniform float uFlareY;    // streak view-space height (screen center)
uniform float uIris;      // iris radius in sc units (2.6 = fully open)
uniform float uIrisRim;
uniform float uGrain;
uniform vec2 uWeaveOff;   // film-gate weave (JS-quantized, whole-content)
uniform float uGrainT;
uniform vec3 uScreenTint; // JS-approximated screen light color for spill
uniform float uSpotIn;    // wall-spot angular window (wider than the shaft)
uniform float uSpotOut;
uniform float uSpotGain;
uniform float uDustGain;
uniform sampler2D uGlyph;
uniform sampler2D uMem;

in vec2 vUv;
out vec4 outColor;

const float SZ = ${SZ.toFixed(1)};
const float HW = ${HW.toFixed(2)};
const float SB = ${SB.toFixed(2)};
const float ST = ${ST.toFixed(2)};
const float CASP = ${((2 * HW) / (ST - SB)).toFixed(4)}; // content aspect
const float PI = 3.14159265;
const int SCT_N = ${soft ? 5 : 9};

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 w = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
             mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), w.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), w.x), w.y);
}

/** One reel shot: memory-atlas slot (Ken Burns) or a procedural trailer cut. */
vec3 reelShot(vec4 rect, vec4 ken, float seed, float tt, vec2 q) {
  // cover-crop: square capture on a wide screen → crop top/bottom, no stretch
  vec2 c = (q - 0.5) * vec2(1.0, 1.0 / CASP) / max(ken.x, 1.0) + 0.5 + ken.yz;
  if (uHasMem > 0.5) {
    c = clamp(c, 0.02, 0.98);           // inset — never bleed neighbor slots
    vec3 m = texture(uMem, rect.xy + c * rect.zw).rgb;
    return m * m * 1.7;                  // captured sRGB → linear-ish, HDR lift
  }
  float kind = floor(mod(seed, 3.0));
  vec2 r = (c - 0.5) * vec2(CASP, 1.0);
  vec3 c3;
  if (kind < 0.5) {                      // slow diagonal gradient sweep
    float h = hash12(vec2(seed, 3.1));
    vec2 dir = normalize(vec2(cos(h * 6.28), sin(h * 6.28) * 0.6 + 0.2));
    float gph = dot(r, dir) * 0.8 + tt * 0.22 - 0.3;
    c3 = pal(clamp(0.3 + 0.45 * gph + uPalBias, 0.0, 1.0)) * (0.34 + 0.22 * sin(gph * 3.0));
    c3 = max(c3, vec3(0.0));
  } else if (kind < 1.5) {               // drifting particle glints
    vec2 g = r * 5.0 + vec2(tt * 0.35, -tt * 0.22) + seed;
    vec2 id = floor(g);
    vec2 f = g - id - (0.25 + 0.5 * vec2(hash12(id + seed), hash12(id + seed + 7.0)));
    float tw = 0.5 + 0.5 * sin(tt * 3.0 + hash12(id) * 40.0);
    c3 = pal(0.75 + uPalBias) * smoothstep(0.3, 0.0, length(f)) * tw * step(0.5, hash12(id + 2.2)) * 1.4;
    c3 += pal(0.32 + uPalBias) * 0.10;
  } else {                               // glowing horizon band
    float y0 = -0.12 + 0.2 * sin(tt * 0.4 + seed);
    float dy = r.y - y0;
    c3 = pal(0.58 + uPalBias) * exp(-dy * dy * 24.0) * 0.65;
    c3 += pal(0.30 + uPalBias) * exp(-dy * dy * 3.0) * 0.14;
  }
  return c3;
}

/** Film-leader countdown field: wipe, rings, crosshair, numeral, cue dot. */
vec3 leader(vec2 cu) {
  vec2 r = (cu - 0.5) * vec2(CASP, 1.0);
  float rl = length(r);
  float a01 = fract(-atan(r.y, r.x) / 6.2831853 + 0.25); // 0 at top, clockwise
  float arm = fract(a01 * 2.0);                          // two-arm sweep
  float swept = step(arm, uDigitF);
  vec3 c = pal(0.42 + uPalBias) * (0.14 + 0.13 * swept) * (1.0 - 0.5 * rl * rl);
  c += pal(0.80 + uPalBias) * exp(-abs(arm - uDigitF) * 42.0)
     * (0.18 + 0.42 * smoothstep(0.55, 0.30, rl));                     // arm glow
  float ring = exp(-abs(rl - 0.36) * 230.0) + 0.7 * exp(-abs(rl - 0.30) * 260.0);
  c += pal(0.78 + uPalBias) * ring * 0.5;
  c *= 1.0 - 0.35 * (exp(-r.x * r.x * 9000.0) + exp(-r.y * r.y * 9000.0)); // crosshair
  // numeral from the glyph atlas (digit cells: canvas top half → v in [0,0.5],
  // v increasing DOWN the canvas — no UNPACK flip happens on upload)
  vec2 g = r * 1.32 + 0.5;
  float gd = 0.0;
  if (all(greaterThan(g, vec2(0.02))) && all(lessThan(g, vec2(0.98)))) {
    float dIdx = clamp(uDigit - 1.0, 0.0, 4.0);
    gd = texture(uGlyph, vec2((dIdx + g.x) * 0.2, 0.5 - 0.5 * g.y)).r;
  }
  gd = smoothstep(0.22, 0.78, gd);
  c += pal(0.94) * gd * (2.1 + 1.6 * uClack);
  c += pal(0.85) * uClack * 0.35;                 // whole-gate clack flash
  vec2 cd = r - vec2(0.44 * CASP - 0.06, 0.40);   // changeover cue dot
  c += pal(0.97) * exp(-dot(cd, cd) * 2200.0) * uCue * 3.0;
  return c;
}

/** LUMINA wordmark coverage (atlas bottom half; v in [0.5,1], canvas-down).
 *  Sized to ~62% of the screen so the whole mark fits a portrait view. */
float wordMark(vec2 cu) {
  vec2 r = (cu - 0.5) * vec2(CASP, 1.0);
  vec2 g = vec2(r.x / (CASP * 0.62) + 0.5, r.y * 5.75 + 0.5);
  if (any(lessThan(g, vec2(0.01))) || any(greaterThan(g, vec2(0.99)))) return 0.0;
  return smoothstep(0.30, 0.70, texture(uGlyph, vec2(g.x, 1.0 - 0.5 * g.y)).r);
}

/** What the colossal screen shows right now, in HDR. */
vec3 content(vec2 cu) {
  cu += uWeaveOff;                                 // film-gate weave
  vec3 c = pal(0.30 + uPalBias) * uScrDark * (0.05 + 0.02 * sin(cu.y * 30.0 + uTime * 0.7));
  if (uCountOn > 0.5) {
    c = leader(cu);
  } else {
    if (uReelOn > 0.003) {
      vec3 a = reelShot(uRectA, uKenA, uSeedA, uShotTA, cu);
      vec3 b = reelShot(uRectB, uKenB, uSeedB, uShotTB, cu);
      vec3 m = mix(a, b, uReelMix);
      vec2 r = (cu - 0.5) * vec2(CASP, 1.0);
      m *= 1.0 - 0.5 * dot(r, r);                  // in-frame vignette
      m *= mix(vec3(1.0), 1.6 * pal(0.62 + uPalBias), 0.22); // palette grade
      m += pal(0.30 + uPalBias) * 0.02;            // shadow lift
      c += m * uReelOn;
    }
    if (uWord > 0.003) {
      c *= 1.0 - 0.8 * uWord;                      // dim the reel under the mark
      float wv = wordMark(cu);
      c += mix(pal(0.96), vec3(1.0), 0.30) * wv * uWord * (2.6 + 2.6 * uWordGlow);
      c += pal(0.55 + uPalBias) * uWord * 0.05;
    }
  }
  float bar = step(abs(cu.y - 0.5), 0.5 - uLetterbox);
  c *= bar;
  c += mix(pal(0.95), vec3(1.0), 0.6) * uWhite * mix(0.15, 1.0, bar);
  float gr = hash12(cu * 631.0 + vec2(uGrainT, uGrainT * 1.7)) - 0.5;
  ${soft ? '' : 'gr += 0.5 * (hash12(cu * 1523.0 + vec2(uGrainT * 2.3, 7.7)) - 0.5);'}
  c *= 1.0 + gr * uGrain;
  return c;
}

void main() {
  vec2 sc = (vUv * 2.0 - 1.0) * uAsp + uShake;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uFwd * uFocal + uRight * sc.x + uUp * sc.y);

  // ---- analytic hits: screen plane (z=SZ), floor (y=0) ---------------------
  float tScr = 1e5;
  bool hitScr = false;
  if (rd.z < -1e-4) {
    float t = (SZ - ro.z) / rd.z;
    if (t > 0.0) { tScr = t; hitScr = true; }
  }
  float tFlr = 1e5;
  bool hitFlr = false;
  if (rd.y < -1e-3) {
    float t = -ro.y / rd.y;
    if (t > 0.0 && t < tScr) {
      if ((ro + rd * t).z > SZ - 0.01) { tFlr = t; hitFlr = true; }
    }
  }
  float tMax = min(min(tScr, tFlr), 34.0);

  // ---- base: the hall is never dead black ---------------------------------
  vec3 col = uBg * (0.20 - 0.08 * clamp(rd.y, -1.0, 1.0)) + pal(0.30 + uPalBias) * 0.008;

  if (hitFlr) {
    // matte floor washed by the screen's light (diffuse spill, no hard mirror)
    vec3 fh = ro + rd * tFlr;
    float g = exp(-(fh.z - SZ) * 0.16) * exp(-fh.x * fh.x * 0.006);
    float n = 0.65 + 0.35 * vnoise2(fh.xz * vec2(0.6, 0.25) + vec2(0.0, uTime * 0.02));
    col += uScreenTint * (g * n * 0.3);
    col += coneAt(fh) * uBeamI * pal(0.60 + uPalBias) * 0.4;  // direct beam splash
    // sheen: the wall spot mirrored in the glossy floor, smeared by noise
    vec3 rr = vec3(rd.x, -rd.y, rd.z);
    if (rr.z < -1e-4) {
      vec3 hr = fh + rr * ((SZ - fh.z) / rr.z);
      float car = dot(hr - uApex, uAxis) / max(length(hr - uApex), 1e-4);
      float spotR = pow(smoothstep(uSpotOut, uSpotIn, car), 1.5);
      col += pal(0.58 + uPalBias) * spotR * uSpotGain * 0.14 * n * exp(-(fh.z - SZ) * 0.10);
    }
  } else if (hitScr) {
    vec3 hit = ro + rd * tScr;
    float sx = hit.x;
    float sy = hit.y;
    float haze = exp(-tScr * 0.024);            // distance dims → scale cue

    // beam landing spot on the back wall / screen — wider than the visible
    // shaft; sweeps tight, then expands to fill the frame as it traces, and
    // dims once the show itself owns the screen.
    vec3 v = hit - uApex;
    float caw = dot(v, uAxis) / max(length(v), 1e-4);
    float spotN = 0.85 + 0.3 * vnoise2(hit.xy * 0.35 + vec2(0.0, uTime * 0.05));
    float spot = pow(smoothstep(uSpotOut, uSpotIn, caw), 1.5) * 0.45
               + pow(smoothstep(uSpotOut, 1.0, caw), 6.0) * 0.55;
    col += pal(0.55 + uPalBias) * spot * uSpotGain * spotN * haze;

    // phase-A hairline: a thin breath of light where the screen will be
    float hl = exp(-(sy - 7.0) * (sy - 7.0) * 140.0) * smoothstep(HW * 0.9, HW * 0.45, abs(sx));
    col += pal(0.62 + uPalBias) * hl * uHair * 0.45;

    // ---- the frame draws itself: bottom sweep → sides climb → top closes --
    if (uTrace > 0.001) {
      float lw = 380.0;                          // line sharpness
      float fb = HW * smoothstep(0.0, 0.24, uTrace);
      float litB = step(abs(sx), fb) * exp(-(sy - SB) * (sy - SB) * lw);
      float climb = (ST - SB) * smoothstep(0.18, 0.78, uTrace);
      float dsx = abs(sx) - HW;
      float litS = step(SB - 0.1, sy) * step(sy, SB + climb) * exp(-dsx * dsx * lw);
      float fromC = HW * (1.0 - smoothstep(0.72, 1.0, uTrace));
      float litT = step(fromC, abs(sx)) * step(abs(sx), HW + 0.1) * exp(-(sy - ST) * (sy - ST) * lw);
      float lines = max(litB, max(litS, litT));
      col += pal(0.86 + uPalBias) * lines * 2.6 * uFrameGain;
      // tracer heads: hot points at the drawing frontier
      float headS = exp(-dsx * dsx * lw) * exp(-(sy - (SB + climb)) * (sy - (SB + climb)) * 30.0)
                  * step(0.02, uTrace * (1.0 - uTrace));
      col += (pal(0.95) + uAccent * 0.5) * headS * 3.0 * uFrameGain;
      // height-reference ticks climbing the sides (every unit, 5th brighter)
      float tickY = fract(sy);
      float five = step(mod(floor(sy), 5.0), 0.5);
      float tickLen = 0.42 + 0.45 * five;
      float tick = step(tickY, 0.10) * step(HW - tickLen, abs(sx)) * step(abs(sx), HW - 0.12)
                 * step(sy, SB + (ST - SB) * uTicks) * step(SB, sy);
      col += pal(0.70 + uPalBias) * tick * (0.7 + 0.8 * five) * uFrameGain * uTicks;
    }

    // ---- the screen face ---------------------------------------------------
    if (abs(sx) < HW && sy > SB && sy < ST) {
      vec2 cu = vec2(sx / HW * 0.5 + 0.5, (sy - SB) / (ST - SB));
      col += content(cu) * 1.35 * mix(haze, 1.0, 0.6);
    }
  } else {
    // looking away from the screen: the projector porthole burns overhead
    vec3 va = normalize(uApex - ro);
    float da = max(dot(rd, va), 0.0);
    col += mix(pal(0.9), vec3(1.0), 0.4) * pow(da, 600.0) * uBeamI * 6.0;
    col += pal(0.75 + uPalBias) * pow(da, 40.0) * uBeamI * 0.35;
  }

  // ---- volumetric cone: jittered samples concentrated around the ray's
  // closest approach to the beam axis (the cone is thin — sampling the whole
  // ray wastes samples and shows as salt noise), + an analytic core.
  if (uBeamI > 0.001) {
    vec3 w0m = ro - uApex;
    float bb = dot(rd, uAxis);
    float dd = dot(rd, w0m);
    float ee = dot(uAxis, w0m);
    float den = 1.0 - bb * bb;
    float tR = den > 1e-3 ? clamp((ee * bb - dd) / den, 0.0, tMax) : tMax * 0.5;
    float t0 = max(0.3, tR - 5.5);
    float t1 = min(tMax, tR + 5.5);
    float sct = 0.0;
    if (t1 > t0) {
      float jit = hash12(vUv * 913.7 + fract(uTime) * 7.1);
      float dstep = (t1 - t0) / float(SCT_N);
      for (int i = 0; i < SCT_N; i++) {
        float t = t0 + (float(i) + jit) * dstep;
        vec3 X = ro + rd * t;
        float b = coneAt(X);
        if (b > 0.002) {
          float n = vnoise3(X * 0.45 + vec3(0.0, -uTime * 0.16, uTime * 0.09));
          sct += b * (0.65 + 0.45 * n);
        }
      }
      sct *= dstep * 0.16;
    }
    // closest-approach core: the tight bright shaft inside the haze
    if (den > 1e-3) {
      float sA = ee + tR * bb;
      if (tR > 0.5 && tR < tMax && sA > 1.0 && sA < uBeamLen) {
        vec3 dc = (ro + rd * tR) - (uApex + uAxis * sA);
        sct += exp(-dot(dc, dc) * 3.0) * exp(-sA * 0.07) * 0.45;
      }
    }
    sct = sct / (1.0 + 0.30 * sct);      // soft knee — the shaft never fogs out
    col += (pal(0.72 + uPalBias) * 0.85 + uAccent * 0.15) * sct * uBeamI * uDustGain;
  }

  // ---- anamorphic streak (slam) -------------------------------------------
  if (uFlareX > 0.001) {
    float dy = sc.y - uFlareY;
    float fl = exp(-dy * dy * 60.0) * (0.25 + 0.75 * exp(-abs(sc.x) * 0.8));
    col += mix(pal(0.90), uAccent, 0.45) * fl * uFlareX * 2.0;
  }

  // ---- iris ---------------------------------------------------------------
  float r2d = length(sc - vec2(0.0, uAsp.y * 0.05));
  col *= smoothstep(uIris, uIris - 0.30, r2d);
  col += uAccent * exp(-abs(r2d - uIris) * 12.0) * uIrisRim;

  outColor = vec4(col, 1.0);
}
`;

const DUST_VS = `#version 300 es
precision highp float;
${COMMON_GLSL}
${SCENE_GLSL}
uniform float uSwirl;
uniform float uDustAmb;
uniform float uDustGain;
uniform float uPtScale;
out vec3 vCol;

const float SZm = ${SZ.toFixed(1)};

void main() {
  float id = float(gl_VertexID);
  float h1 = hash12(vec2(id, 1.3));
  float h2 = hash12(vec2(id, 7.7));
  float h3 = hash12(vec2(id, 13.1));
  float h4 = hash12(vec2(id, 19.7));
  float h5 = hash12(vec2(id, 27.3));

  // wrapped drifting base position filling the hall volume
  vec3 span = vec3(16.0, 9.5, 18.5);
  vec3 vel = vec3(0.10 * (h4 - 0.5), -0.02 - 0.05 * h5, 0.08 * (h3 - 0.5));
  vec3 p = vec3(-8.0, 0.1, SZm - 0.2) + mod(vec3(h1, h2, h3) * span + vel * uTime, span);
  p.x += 0.35 * sin(uTime * (0.11 + 0.23 * h4) + h1 * 40.0);
  p.y += 0.25 * sin(uTime * (0.13 + 0.19 * h5) + h2 * 40.0);

  // ignition swirl: motes stream toward the beam and eddy around its axis
  if (uSwirl > 0.001) {
    vec3 ax = uApex + uAxis * clamp(dot(p - uApex, uAxis), 1.0, uBeamLen);
    vec3 to = ax - p;
    float dl = max(length(to), 0.3);
    vec3 dir = to / dl;
    float pullF = uSwirl * (0.5 + 0.5 * sin(uTime * 0.8 + h1 * 6.28));
    p += dir * min(dl, 2.2) * 0.4 * pullF;
    p += cross(uAxis, dir) * (0.6 * uSwirl * (0.3 + 0.7 * h4));
  }

  vec3 rel = p - uCamPos;
  vec3 vpos = vec3(dot(rel, uRight), dot(rel, uUp), dot(rel, uFwd));
  if (vpos.z < 0.25) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    gl_PointSize = 0.0;
    vCol = vec3(0.0);
    return;
  }
  vec2 ndc = (vpos.xy * uFocal / vpos.z - uShake) / uAsp;
  gl_Position = vec4(ndc, 0.0, 1.0);

  float cb = coneAt(p);
  float b = cb * uBeamI * 3.2 + uDustAmb * (0.4 + 0.6 * h5);
  float tw = 0.65 + 0.35 * sin(uTime * (0.9 + 1.7 * h2) + h3 * 47.0);
  vCol = pal(0.55 + 0.35 * h4 + uPalBias) * (b * tw * uDustGain);
  gl_PointSize = clamp(uPtScale * (0.6 + 1.1 * h2) / vpos.z * (1.0 + cb * 0.6), 1.0, 6.0);
}
`;

const DUST_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  float f = exp(-r2 * 10.0) * smoothstep(0.25, 0.12, r2);
  outColor = vec4(vCol * f, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

class PremiereMode implements Mode {
  readonly id = 'premiere';
  readonly name = { ja: '上映', en: 'Premiere' };
  readonly params: ParamDef[] = [
    { key: 'tempo', label: { ja: 'テンポ', en: 'Tempo' }, type: 'range', min: 0.6, max: 1.8, step: 0.05, default: 1.0 },
    { key: 'dust', label: { ja: '塵', en: 'Dust' }, type: 'range', min: 0.3, max: 1.5, step: 0.05, default: 1.0 },
    { key: 'flare', label: { ja: '余韻', en: 'Flare' }, type: 'range', min: 0.4, max: 1.6, step: 0.05, default: 1.0 },
  ];

  // live params (persist across quality re-inits — the instance survives)
  private tempo = 1.0;
  private dustP = 1.0;
  private flareP = 1.0;

  // GL
  private prog: WebGLProgram | null = null;
  private dustProg: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private du: UniformSetter | null = null;
  private dustVao: WebGLVertexArrayObject | null = null;
  private glyphTex: WebGLTexture | null = null;
  private post: Post | null = null;
  private postW = 0;
  private postH = 0;
  private colorBuf = new Float32Array(18);

  // stage clock
  private u_ = 8.6;               // loop time — init lands mid-B (beam alive)
  private prevU = 8.6;
  private loopN = 0;
  private sweepDir = 1;
  private palBias = 0;
  private countStart = 5;
  private slamU = -1e3;           // loop-time of the last slam
  private flareBoost = 1;
  private slamFrame = false;
  private seedT = 0;              // noise-time offset (per init)

  // camera state
  private yaw = 0;
  private pitch = 0.05;
  private push = 0;
  private beamTx = 0;
  private beamTy = 5.8;

  // shake (real-time envelope)
  private shakeT0 = -1e3;
  private shakeAmp = 0;

  // audio
  private beat = new BeatDetector(1.5, 0.1, 0.3);
  private popT0 = -1e3;
  private popAmp = 0;

  // perf: wall-clock governor over the post-resolution ladder
  private lastFrameMs = -1e9;   // distinguishes governor re-init from fresh entry
  private softGL = false;
  private resIndex = 0;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1;
  private graceUntilMs = 0;
  private dustN = 1200;
  private kenBuf = new Float32Array(8);

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, makeMainFS(this.softGL), 'premiere.main');
    this.dustProg = compileProgram(gl, DUST_VS, DUST_FS, 'premiere.dust');
    this.u = new UniformSetter(gl, this.prog);
    this.du = new UniformSetter(gl, this.dustProg);
    this.dustVao = gl.createVertexArray();
    this.glyphTex = this.buildGlyphTexture(gl);

    const { w, h } = this.postSize(ctx);
    this.postW = w;
    this.postH = h;
    this.post = createPost(gl, w, h);

    this.dustN = Math.round((this.softGL ? 700 : 1600) * (0.5 + 0.5 * ctx.quality));

    // A quality-governor re-init (frame() ran a moment ago) must NOT restart
    // the show — only a fresh mode entry resets the stage clock.
    const resume = performance.now() - this.lastFrameMs < 500;
    if (!resume) {
      // start the loop mid-B (beam already igniting) — frame 1 is alive, and
      // cold screenshots land on the beam / frame-tracing poster shots.
      this.u_ = B0 + 3.0;
      this.prevU = this.u_;
      this.slamU = -1e3;
      this.loopN = 0;
      this.sweepDir = Math.random() < 0.5 ? -1 : 1;
      this.palBias = 0;
      this.countStart = 5;
      this.flareBoost = 1;
      this.seedT = Math.random() * 200;
      this.yaw = 0;
      this.pitch = 0.05;
      this.push = 0;
      this.beamTx = this.sweepDir * 7.0;
      this.beamTy = 10.8;
      this.shakeT0 = -1e3;
      this.popT0 = -1e3;
    }
    this.lastNowMs = -1;
    this.slowTime = 0;
    this.fastTime = 0;
  }

  private postSize(ctx: ModeContext): { w: number; h: number } {
    const base = this.softGL ? 0.46 : clamp(0.5 + 0.28 * ctx.quality, 0.55, 0.78);
    const s = Math.max(0.3, base * RES_LADDER[this.resIndex]);
    return {
      w: Math.max(1, Math.round(ctx.width * s)),
      h: Math.max(1, Math.round(ctx.height * s)),
    };
  }

  private layout(ctx: ModeContext): void {
    if (!this.post) return;
    const { w, h } = this.postSize(ctx);
    if (w !== this.postW || h !== this.postH) {
      this.postW = w;
      this.postH = h;
      this.post.resize(w, h);
    }
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (key === 'tempo') this.tempo = v;
    else if (key === 'dust') this.dustP = v;
    else if (key === 'flare') this.flareP = v;
  }

  /** Wall-clock resolution governor (gravity's scheme — rAF dt can lie). */
  private govern(): void {
    const now = performance.now();
    if (this.lastNowMs < 0) {
      this.lastNowMs = now;
      this.graceUntilMs = now + 700;
      return;
    }
    const real = Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    if (now < this.graceUntilMs) return;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.055) {
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.4 && this.resIndex < RES_LADDER.length - 1) {
        this.resIndex = Math.min(RES_LADDER.length - 1, this.resIndex + (this.frameEma > 0.09 ? 2 : 1));
        this.slowTime = 0;
      }
    } else if (this.frameEma < 0.036) {
      this.fastTime += real;
      this.slowTime = 0;
      if (this.fastTime > 3 && this.resIndex > 0) {
        this.resIndex--;
        this.fastTime = 0;
      }
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
  }

  private shake(amp: number, time: number): void {
    if (amp > this.shakeAmp * Math.exp(-(time - this.shakeT0) * 16)) {
      this.shakeT0 = time;
      this.shakeAmp = amp;
    }
  }

  /** Ken Burns transform for reel shot k → (zoom, panX, panY, 0) at `prog`. */
  private kenFor(shotIdx: number, prog: number, off: number): void {
    const rng = mulberry32(((shotIdx * 2654435761) ^ (this.loopN * 97 + 13)) >>> 0);
    const zoomIn = rng() < 0.55;
    const z0 = 1.08 + rng() * 0.08;
    const za = zoomIn ? z0 : z0 + 0.16;
    const zb = zoomIn ? z0 + 0.16 : z0;
    const px0 = (rng() - 0.5) * 0.08;
    const px1 = (rng() - 0.5) * 0.08;
    const py0 = (rng() - 0.5) * 0.06;
    const py1 = (rng() - 0.5) * 0.06;
    const e = ease(clamp(prog, 0, 1));
    this.kenBuf[off] = za + (zb - za) * e;
    this.kenBuf[off + 1] = px0 + (px1 - px0) * e;
    this.kenBuf[off + 2] = py0 + (py1 - py0) * e;
    this.kenBuf[off + 3] = 0;
  }

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.prog || !this.dustProg || !this.u || !this.du || !this.post || !this.glyphTex) return;
    this.lastFrameMs = performance.now();
    this.govern();
    this.layout(ctx);
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    const dt = ctx.dt;
    const time = ctx.time;
    const pt = ctx.pointer;
    const au = ctx.audio;
    const level = au ? au.level : 0;
    const high = au ? au.high : 0;

    // ---- phase clock --------------------------------------------------------
    const digitDur = D_LEN / this.countStart;
    this.prevU = this.u_;
    this.u_ += dt * this.tempo;
    this.slamFrame = false;

    if (ctx.pulse) {
      if (this.u_ >= E0 && this.u_ < E1) {
        // re-run the wordmark slam with a bigger flare
        this.slamU = this.u_;
        this.flareBoost = 1.7;
        this.slamFrame = true;
        this.shake(0.012, time);
      } else {
        // cut to the countdown's final "1" — the slam follows naturally
        this.u_ = E0 - digitDur;
        this.prevU = this.u_;
        this.shake(0.006, time);
      }
    }
    if (this.u_ >= LOOP_T) {
      // next loop: vary beam direction, palette emphasis, countdown start
      this.u_ -= LOOP_T;
      this.prevU = this.u_;
      this.loopN++;
      this.sweepDir = -this.sweepDir;
      this.palBias = (jhash(this.loopN * 7.31) - 0.5) * 0.24;
      this.countStart = this.loopN % 3 === 2 ? 3 : 5;
      this.slamU = -1e3;
      this.flareBoost = 1;
    }
    const u = this.u_;
    if (this.prevU < SHUDDER_AT && u >= SHUDDER_AT) this.shake(0.014, time); // frame completes
    if (this.prevU < E0 && u >= E0) {
      this.slamU = E0;
      this.flareBoost = 1;
      this.slamFrame = true;
      this.shake(0.016, time);
    }

    // ---- phase envelopes ----------------------------------------------------
    const ignite = ss(B0, B0 + 1.6, u);
    const sputter = 1 - 0.45 * Math.exp(-(Math.max(u - B0, 0)) * 1.4)
      * (0.5 + 0.5 * Math.sin(u * 43 + Math.sin(u * 17) * 3));
    const countOn = u >= D0 && u < E0;
    const eOn = u >= E0;
    // countdown
    let digit = 0;
    let digitF = 0;
    let clack = 0;
    let cue = 0;
    if (countOn) {
      const k = Math.floor((u - D0) / digitDur);
      digit = clamp(this.countStart - k, 1, 5);
      digitF = fract1((u - D0) / digitDur);
      clack = Math.exp(-digitF * 16);
      cue = ss(0.78, 0.83, digitF) * (1 - ss(0.90, 0.96, digitF));
    }
    // premiere
    const eT = u - this.slamU;
    const white = eOn ? 1.5 * Math.exp(-Math.max(eT, 0) * 9) + (this.slamFrame ? 1.4 : 0) : 0;
    const word = eOn ? ss(this.slamU + 0.06, this.slamU + 0.5, u) * (1 - ss(this.slamU + 2.3, this.slamU + 3.4, u)) : 0;
    const letterbox = LETTERBOX * ss(E0 + 0.4, E0 + 1.8, u);
    const reelOn = ss(E0 + 2.4, E0 + 3.6, u);
    const reelT = Math.max(0, u - (E0 + 2.6));
    const trace = ease(ss(C0, C0 + 5.6, u));
    const ticks = ss(C0 + 1.4, C0 + 6.4, u);
    const frameGain = 1 - 0.55 * ss(E0, E0 + 1, u);
    const hair = (0.25 + 0.75 * ss(2.0, 5.8, u)) * (1 - ss(B0 + 0.2, B0 + 1.0, u))
      * (0.75 + 0.25 * Math.sin(time * 13) * Math.sin(time * 7.7));
    // audio pops (guarded — never fire with audio null)
    if (au && eOn && this.beat.update(au.low, time, dt)) {
      this.shake(0.005 + 0.01 * au.low, time);
      this.popT0 = time;
      this.popAmp = 0.25 + 0.5 * au.low;
    }
    const pop = this.popAmp * Math.exp(-(time - this.popT0) * 5);
    // screen luminance proxy → spill, beam feedback, dust
    const scrLum = countOn
      ? 0.5 + 0.3 * clack
      : eOn
        ? clamp(white * 1.2 + word * 0.9 + reelOn * 0.5, 0, 1.6)
        : trace * 0.05;
    const beamI = ignite * sputter * (1 + 0.35 * (eOn ? scrLum : 0)) * (1 + 0.4 * level);
    const flareX = eOn && u < E1 + 1.5
      ? this.flareP * (this.flareBoost * 1.2 * Math.exp(-Math.max(eT, 0) * 1.9) + pop)
      : 0;
    // iris
    let iris = 2.6;
    let irisRim = 0;
    if (u >= E1) {
      const it = (u - E1) / (LOOP_T - E1);
      iris = 2.6 * (1 - ease(it));
      irisRim = 0.18;
    } else if (u < 1.2 && this.loopN > 0) {
      iris = 2.6 * ease(ss(0, 1.1, u));
      irisRim = 0.18;
    }

    // ---- camera -------------------------------------------------------------
    const pxr = pt.x || ctx.width / 2;   // (0,0) = never moved → treat as center
    const pyr = pt.y || ctx.height / 2;
    const nx = pxr / Math.max(1, ctx.width);
    const ny = pyr / Math.max(1, ctx.height);
    const kCam = 1 - Math.exp(-dt * 6);
    this.yaw += (-(nx - 0.5) * 0.22 - this.yaw) * kCam;
    const craneP = 0.04
      + 0.44 * ease(ss(C0, C0 + 6.2, u))
      - 0.18 * ease(ss(C0 + 7.0, D0 + 1.2, u))
      + 0.04 * ease(ss(E0, E0 + 2.5, u));
    const pitchTarget = craneP + (ny - 0.5) * 0.16;
    this.pitch += (pitchTarget - this.pitch) * kCam;
    const yawS = this.yaw + 0.010 * Math.sin(time * 0.11);
    const pitchS = this.pitch + 0.006 * Math.sin(time * 0.17);
    // HOLD during E = slow push-in (dolly + FOV narrow)
    const dragging = pt.down;
    const holdE = eOn && dragging && pt.pressFrames > 6;
    const kPush = 1 - Math.exp(-dt * (holdE ? 1.6 : 0.9));
    this.push += ((holdE ? 1 : 0) - this.push) * kPush;
    const focal = 1.35 + 0.42 * this.push;
    const camX = 0;
    const camY = 1.5 + 0.2 * this.push;
    const camZ = -3.6 * this.push;
    const cp = Math.cos(pitchS);
    const spn = Math.sin(pitchS);
    const fx = Math.sin(yawS) * cp;
    const fy = spn;
    const fz = -Math.cos(yawS) * cp;
    const rx = Math.cos(yawS);
    const rz = Math.sin(yawS);
    const ux = -rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy;
    const minSide = Math.min(ctx.width, ctx.height) || 1;
    const aspX = ctx.width / minSide;
    const aspY = ctx.height / minSide;
    const shakeE = this.shakeAmp * Math.exp(-(time - this.shakeT0) * 16);
    const shX = shakeE * Math.sin(time * 143.0);
    const shY = shakeE * Math.cos(time * 127.0);

    // ---- beam target: script sweep, drag steers during A–C ------------------
    const lockT = ease(ss(B0 + 1.2, B0 + 5.2, u));
    let tgtX = this.sweepDir * 8.0 * (1 - lockT) + 0.15 * Math.sin(time * 0.5) * lockT;
    let tgtY = 11.0 + (7.0 - 11.0) * lockT + 0.1 * Math.sin(time * 0.7) * lockT;
    const steer = dragging && u < D0;
    if (steer) {
      tgtX = (nx - 0.5) * 2 * HW * 1.15;
      tgtY = SB + ny * (ST - SB) * 1.05;
    }
    const kBeam = 1 - Math.exp(-dt * (steer ? 14 : 2.2));
    this.beamTx += (tgtX - this.beamTx) * kBeam;
    this.beamTy += (tgtY - this.beamTy) * kBeam;
    // wall-spot aperture: tight searchlight → expands to fill the frame → dims
    const spotHalf = 0.15 + 0.25 * ease(ss(B0 + 4.6, C0 + 4.5, u));
    const spotGain = beamI * (1 - 0.85 * ss(D0 - 0.8, D0 + 0.3, u));
    let axx = this.beamTx - APEX[0];
    let axy = this.beamTy - APEX[1];
    let axz = SZ - APEX[2];
    const beamLen = Math.hypot(axx, axy, axz);
    axx /= beamLen; axy /= beamLen; axz /= beamLen;
    const swirl = ss(B0 + 0.2, B0 + 2.2, u) * (1 - ss(C0 + 0.5, C0 + 3.0, u)) + (steer ? 0.5 : 0);

    // ---- reel shots ---------------------------------------------------------
    const mem = ctx.memory ?? null;
    const hasMem = !!(mem && mem.used > 0);
    const nShots = hasMem ? mem!.used : 6;
    const cyc = SHOT_DUR * nShots;
    const lt = cyc > 0 ? reelT % cyc : 0;
    const idxA = Math.floor(lt / SHOT_DUR);
    const local = lt - idxA * SHOT_DUR;
    const reelMix = ss(SHOT_DUR - SHOT_XF, SHOT_DUR, local);
    const idxB = (idxA + 1) % nShots;
    this.kenFor(idxA, local / SHOT_DUR, 0);
    this.kenFor(idxB, (local - (SHOT_DUR - SHOT_XF)) / SHOT_DUR, 4);
    let rectA = [0, 0, 1, 1];
    let rectB = [0, 0, 1, 1];
    if (hasMem) {
      // oldest → newest: shot k shows capture stamp-used+k (slot = s mod slots)
      const m = mem!;
      const slots = m.cols * m.rows;
      const slotOf = (k: number) => {
        const s = m.stamp - m.used + k;
        return ((s % slots) + slots) % slots;
      };
      const sA = slotOf(idxA);
      const sB = slotOf(idxB);
      rectA = [(sA % m.cols) / m.cols, Math.floor(sA / m.cols) / m.rows, 1 / m.cols, 1 / m.rows];
      rectB = [(sB % m.cols) / m.cols, Math.floor(sB / m.cols) / m.rows, 1 / m.cols, 1 / m.rows];
    }

    // ---- screen tint (JS-side spill approximation, palette-only) ------------
    const nCol = Math.min(6, th.colors.length);
    const mid = th.colors[Math.min(nCol - 1, 3)];
    const tintGain = 0.9 * scrLum;
    const wGain = white * 0.8;
    const tintR = mid[0] * 0.7 * tintGain + th.accent[0] * 0.1 * tintGain + wGain;
    const tintG = mid[1] * 0.7 * tintGain + th.accent[1] * 0.1 * tintGain + wGain;
    const tintB = mid[2] * 0.7 * tintGain + th.accent[2] * 0.1 * tintGain + wGain;

    // gate weave + grain (quantized at 24fps like a film gate)
    const qt = Math.floor(time * 24);
    const weaveAmp = countOn || reelOn > 0 ? 0.0022 : 0;
    const weaveX = (jhash(qt * 1.13) - 0.5) * weaveAmp;
    const weaveY = (jhash(qt * 2.71) - 0.5) * weaveAmp + clack * 0.006;
    const grain = (countOn ? 0.16 : 0.11 * reelOn) * (1 + 1.1 * high);
    const dustGain = this.dustP * (1 + 0.4 * level);

    // ---- draw ---------------------------------------------------------------
    this.post.begin();
    gl.useProgram(this.prog);
    const U = this.u;
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, nCol - 1)], i * 3);
    U.set3fv('uColors[0]', this.colorBuf);
    U.set1i('uNumColors', nCol);
    U.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    U.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
    U.set1f('uPalBias', this.palBias);
    U.set3f('uCamPos', camX, camY, camZ);
    U.set3f('uRight', rx, 0, rz);
    U.set3f('uUp', ux, uy, uz);
    U.set3f('uFwd', fx, fy, fz);
    U.set1f('uFocal', focal);
    U.set2f('uAsp', aspX, aspY);
    U.set2f('uShake', shX, shY);
    U.set3f('uApex', APEX[0], APEX[1], APEX[2]);
    U.set3f('uAxis', axx, axy, axz);
    U.set1f('uCosIn', Math.cos(0.055));
    U.set1f('uCosOut', Math.cos(0.20));
    U.set1f('uBeamLen', beamLen);
    U.set1f('uBeamI', beamI);
    U.set1f('uTime', this.seedT + time);
    U.set1f('uHair', hair);
    U.set1f('uTrace', trace);
    U.set1f('uTicks', ticks);
    U.set1f('uFrameGain', frameGain);
    U.set1f('uScrDark', trace * 0.5);
    U.set1f('uCountOn', countOn ? 1 : 0);
    U.set1f('uDigit', digit);
    U.set1f('uDigitF', digitF);
    U.set1f('uClack', clack);
    U.set1f('uCue', cue);
    U.set1f('uWhite', white);
    U.set1f('uWord', word);
    U.set1f('uWordGlow', (this.flareBoost - 1) * 1.2 + 0.25 * this.flareP);
    U.set1f('uReelOn', reelOn);
    U.set1f('uReelMix', reelMix);
    U.set4f('uRectA', rectA[0], rectA[1], rectA[2], rectA[3]);
    U.set4f('uRectB', rectB[0], rectB[1], rectB[2], rectB[3]);
    U.set4f('uKenA', this.kenBuf[0], this.kenBuf[1], this.kenBuf[2], 0);
    U.set4f('uKenB', this.kenBuf[4], this.kenBuf[5], this.kenBuf[6], 0);
    U.set1f('uHasMem', hasMem ? 1 : 0);
    U.set1f('uSeedA', idxA + this.loopN * 7);
    U.set1f('uSeedB', idxB + this.loopN * 7);
    U.set1f('uShotTA', local + idxA * 2.3);
    U.set1f('uShotTB', local - (SHOT_DUR - SHOT_XF) + idxB * 2.3);
    U.set1f('uLetterbox', letterbox);
    U.set1f('uFlareX', flareX);
    // project the screen center into view space for the anamorphic streak
    const relX = 0 - camX;
    const relY = (SB + ST) * 0.5 - camY;
    const relZ = SZ - camZ;
    const vz = relX * fx + relY * fy + relZ * fz;
    const vy = relX * ux + relY * uy + relZ * uz;
    U.set1f('uFlareY', vz > 0.5 ? (vy * focal) / vz : 0);
    U.set1f('uIris', iris);
    U.set1f('uIrisRim', irisRim);
    U.set1f('uGrain', grain);
    U.set2f('uWeaveOff', weaveX, weaveY);
    U.set1f('uGrainT', qt * 0.618);
    U.set3f('uScreenTint', tintR, tintG, tintB);
    U.set1f('uDustGain', dustGain);
    U.set1f('uSpotIn', Math.cos(spotHalf * 0.35));
    U.set1f('uSpotOut', Math.cos(spotHalf));
    U.set1f('uSpotGain', spotGain);
    U.setTexture('uGlyph', this.glyphTex, 0);
    U.setTexture('uMem', mem ? mem.texture : this.glyphTex, 1); // bind-only; engine-owned params untouched
    drawFullscreen(gl);

    // ---- dust motes (procedural, attributeless, additive) -------------------
    const drawn = Math.max(0, Math.round(this.dustN * this.dustP * (this.resIndex >= 2 ? 0.7 : 1)));
    if (drawn > 0) {
      gl.useProgram(this.dustProg);
      const D = this.du;
      D.set3fv('uColors[0]', this.colorBuf);
      D.set1i('uNumColors', nCol);
      D.set3f('uBg', th.background[0], th.background[1], th.background[2]);
      D.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
      D.set1f('uPalBias', this.palBias);
      D.set3f('uCamPos', camX, camY, camZ);
      D.set3f('uRight', rx, 0, rz);
      D.set3f('uUp', ux, uy, uz);
      D.set3f('uFwd', fx, fy, fz);
      D.set1f('uFocal', focal);
      D.set2f('uAsp', aspX, aspY);
      D.set2f('uShake', shX, shY);
      D.set3f('uApex', APEX[0], APEX[1], APEX[2]);
      D.set3f('uAxis', axx, axy, axz);
      D.set1f('uCosIn', Math.cos(0.055));
      D.set1f('uCosOut', Math.cos(0.20));
      D.set1f('uBeamLen', beamLen);
      D.set1f('uBeamI', beamI);
      D.set1f('uTime', this.seedT + time);
      D.set1f('uSwirl', clamp(swirl, 0, 1));
      D.set1f('uDustAmb', (0.045 + 0.05 * (1 - ss(B0, B0 + 2, u))) * (1 + 0.6 * scrLum));
      D.set1f('uDustGain', dustGain);
      D.set1f('uPtScale', Math.max(1.4, this.postH * 0.006));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.dustVao);
      gl.drawArrays(gl.POINTS, 0, drawn);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    this.post.end({
      exposure: 1.15,
      bloom: 0.42 + 0.3 * this.flareP * clamp(0.3 + scrLum, 0, 1),
      vignette: 0.34,
    });

    // canonical GL state; release the engine-owned memory texture from unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  // -------------------------------------------------------------------------
  // Glyph atlas: 1600×640 canvas — digits 1..5 (320² cells, top half) +
  // LUMINA wordmark (bottom half). White ink on transparent; shader reads .r.
  // Fallbacks (fontless headless containers): seven-segment digits and a
  // dot-matrix wordmark, so the countdown NEVER shows tofu or blank.
  // -------------------------------------------------------------------------

  private buildGlyphTexture(gl: WebGL2RenderingContext): WebGLTexture {
    const W = 1600;
    const H = 640;
    const CELL = 320;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    if (c2) {
      c2.clearRect(0, 0, W, H);
      c2.fillStyle = '#fff';
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      // digits
      c2.font = `900 252px ${FONT_STACK}`;
      for (let d = 1; d <= 5; d++) c2.fillText(String(d), (d - 1) * CELL + CELL / 2, 172);
      if (this.litCount(c2, 0, 0, CELL, CELL) < 80) {
        c2.clearRect(0, 0, W, CELL);
        for (let d = 1; d <= 5; d++) this.drawSevenSeg(c2, d, (d - 1) * CELL);
      }
      // wordmark — wide tracking, drawn per character
      const word = 'LUMINA';
      c2.font = `800 200px ${FONT_STACK}`;
      const track = 100;
      const widths = word.split('').map((ch) => c2.measureText(ch).width);
      const total = widths.reduce((a, b) => a + b, 0) + track * (word.length - 1);
      let x = (W - Math.min(total, W - 60)) / 2;
      const scaleX = total > W - 60 ? (W - 60) / total : 1;
      c2.save();
      c2.translate(0, 0);
      c2.scale(scaleX, 1);
      c2.textAlign = 'left';
      let xx = x / scaleX;
      for (let i = 0; i < word.length; i++) {
        c2.fillText(word[i], xx, CELL + 168);
        xx += widths[i] + track;
      }
      c2.restore();
      if (this.litCount(c2, 0, CELL, W, CELL) < 80) {
        c2.clearRect(0, CELL, W, CELL);
        this.drawDotWord(c2, word, CELL);
      }
    }
    const tex = gl.createTexture();
    if (!tex) throw new Error('premiere: glyph texture allocation failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    cv.width = 1;
    cv.height = 1;
    return tex;
  }

  private litCount(c2: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): number {
    const a = c2.getImageData(x, y, w, h).data;
    let n = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] > 127) n++;
    return n;
  }

  private drawSevenSeg(c2: CanvasRenderingContext2D, digit: number, cellX: number): void {
    const segs = SEG[digit] ?? 'abcdef';
    const w = 190;
    const h = 250;
    const t = 36;
    const ox = cellX + (320 - w) / 2;
    const oy = (320 - h) / 2;
    const hSeg = (y: number) => c2.fillRect(ox + t * 0.7, y, w - 1.4 * t, t);
    const vSeg = (x: number, y: number) => c2.fillRect(x, y + t * 0.7, t, h / 2 - 1.2 * t);
    if (segs.includes('a')) hSeg(oy);
    if (segs.includes('g')) hSeg(oy + h / 2 - t / 2);
    if (segs.includes('d')) hSeg(oy + h - t);
    if (segs.includes('f')) vSeg(ox, oy);
    if (segs.includes('b')) vSeg(ox + w - t, oy);
    if (segs.includes('e')) vSeg(ox, oy + h / 2);
    if (segs.includes('c')) vSeg(ox + w - t, oy + h / 2);
  }

  private drawDotWord(c2: CanvasRenderingContext2D, word: string, yOff: number): void {
    const cols = word.length * 6 - 1;
    const cell = Math.floor(1500 / cols);
    const x0 = (1600 - cols * cell) / 2;
    const y0 = yOff + (320 - 7 * cell) / 2;
    for (let li = 0; li < word.length; li++) {
      const rows = DOT_FONT[word[li]];
      if (!rows) continue;
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if (rows[r] & (1 << (4 - c))) {
            c2.fillRect(x0 + (li * 6 + c) * cell, y0 + r * cell, cell - 1, cell - 1);
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.dustProg) gl.deleteProgram(this.dustProg);
    if (this.dustVao) gl.deleteVertexArray(this.dustVao);
    if (this.glyphTex) gl.deleteTexture(this.glyphTex);
    this.prog = null;
    this.dustProg = null;
    this.dustVao = null;
    this.glyphTex = null;
    this.u = null;
    this.du = null;
    this.post?.destroy();
    this.post = null;
  }
}

export const premiereMode: Mode = new PremiereMode();
