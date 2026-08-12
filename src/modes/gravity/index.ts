/**
 * GRAVITY — 重力 / a Gargantua-style gravitationally-lensed black hole.
 *
 * One fullscreen ray-bending pass into a reduced-resolution RGBA16F HDR
 * target (the shared post scene buffer), upscaled + bloomed by post.ts.
 * Per pixel a ray from an orbiting camera is marched with the classic
 * Schwarzschild-flavored deflection  acc = -1.5·h²·pos/r⁵  (h = conserved
 * angular momentum), which makes the photon sphere at r=1.5·r_s emerge for
 * free: background stars swirl around the shadow, and the thin equatorial
 * accretion disk (r 2.6–7) is detected as plane crossings during the march,
 * so its far side lifts into the over/under arcs — THE Gargantua look.
 * Straight-line fast-forward to a bounding sphere keeps step counts small;
 * adaptive step length grows with distance from the hole.
 *
 * Disk: differentially-rotating sheared fbm (static spiral shear + bounded
 * dynamic shear cross-faded flowmap-style so it never aliases), doppler
 * beaming (approaching side white-hot, receding side dark), palette-mapped.
 * DRAG orbits the camera (inertia on release), HOLD feeds a spiral matter
 * filament into the disk, pulse ignites a flare that spirals into the hole
 * while stretching into an arc. Perf: internal resolution ladder governed
 * by wall-clock frame time; step count fixed per quality tier and GL class
 * (software rasterizers get lower presets).
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { BeatDetector } from '../../core/audio';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Constants (shared JS/GLSL — keep in sync with the shader source below)
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;
const R_IN = 2.6;        // disk inner edge (units of r_s)
const R_OUT = 7.0;       // disk outer edge
const R0 = 10.0;         // fast-forward bounding sphere (march starts here)
const FOCAL = 1.55;      // image-plane focal length
const KEP_VIS = 2.2;     // visual angular-speed factor for disk turbulence
const OM0 = KEP_VIS * Math.pow(4, -1.5); // rigid rotation part (at r=4)
const SHEAR_T = 9.0;     // shear crossfade period (s) — bounds noise aliasing
const IDLE_AZ = 0.045;   // idle orbit drift, rad/s
const MIN_INCL = (55 * Math.PI) / 180;
const MAX_INCL = (88 * Math.PI) / 180;
const RES_LADDER = [1.0, 0.8, 0.64, 0.5] as const;

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
// GLSL
// ---------------------------------------------------------------------------

const makeFS = (steps: number): string => `#version 300 es
precision highp float;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uHalfSpan;   // image-plane half extents (w/min, h/min)
uniform float uEsc2;      // escape radius²
uniform float uRigid;     // rigid disk rotation angle
uniform float uTauA;      // shear phases (flowmap crossfade)
uniform float uTauB;
uniform float uABMix;
uniform float uDiskBright;
uniform float uAnnMin;    // plane-crossing test annulus (extends for flare/feed)
uniform float uAnnMax;
uniform float uFlareAmp;
uniform float uFlareR;
uniform float uFlarePhi;
uniform float uFlareSig;
uniform float uFlareSwell;
uniform float uFeedAmp;
uniform float uFeedR;
uniform float uFeedPhi;
uniform float uFeedPhase;
uniform float uGlow;      // photon-ring glow gain
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform vec3 uAccent;

in vec2 vUv;
out vec4 outColor;

const int STEPS = ${steps};
const float R_IN = ${R_IN.toFixed(2)};
const float R_OUT = ${R_OUT.toFixed(2)};
const float R0 = ${R0.toFixed(2)};
const float FOCAL = ${FOCAL.toFixed(3)};
const float KEP_VIS = ${KEP_VIS.toFixed(3)};
const float OM0 = ${OM0.toFixed(6)};
const float PI = 3.14159265;

vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
float wrapPi(float x) { return x - 6.2831853 * floor(x / 6.2831853 + 0.5); }
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), w.x),
             mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), w.x), w.y);
}
float fbm2(vec2 p) { return 0.65 * vnoise2(p) + 0.35 * vnoise2(p * 2.13 + 5.2); }
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
float fbm3(vec3 p) { return 0.65 * vnoise3(p) + 0.35 * vnoise3(p * 2.07 + 11.3); }

/** Hash starfield on the escape direction — lensed for free. */
float stars(vec3 d, float s) {
  vec3 g = d * s;
  vec3 id = floor(g);
  float h = hash13(id);
  vec3 sp = 0.2 + 0.6 * fract(vec3(h * 64.0, h * 512.0, h * 4096.0));
  float dd = length(g - id - sp);
  float m = smoothstep(0.34, 0.0, dd);
  float amp = hash13(id + 5.0);
  return m * m * step(0.8, hash13(id + 17.0)) * (0.15 + 0.85 * amp * amp * amp);
}

/** Background sampled by escape direction: palette nebula + two star layers. */
vec3 background(vec3 d) {
  float nb = fbm3(d * 3.3 + vec3(3.1, 0.9, 1.7));
  nb *= nb;
  vec3 col = uBg * 0.6;
  col += pal(0.30) * nb * 0.045;
  col += pal(0.52) * nb * nb * 0.11;
  col += mix(pal(0.88), vec3(1.0), 0.55) * (stars(d, 19.0) * 1.1);
  col += mix(pal(0.70), vec3(1.0), 0.35) * (stars(d, 37.0) * 0.6);
  return col;
}

/**
 * Disk emission at an equatorial crossing. rgb = emitted light, a = opacity.
 * rdN = normalized ray propagation direction at the crossing (for doppler).
 */
vec4 disk(vec3 hit, vec3 rdN, float mag) {
  float rc = length(hit.xz);
  float phi = atan(hit.z, hit.x);

  float edgeIn = smoothstep(R_IN, R_IN + 0.4, rc);
  float edgeOut = 1.0 - smoothstep(R_OUT * 0.62, R_OUT, rc);
  float radial = pow(2.9 / max(rc, 1.2), 1.8);

  // Differential rotation: static spiral shear (streaks baked in from frame 1)
  // + rigid rotation + bounded dynamic shear cross-faded between two phases,
  // so shear never accumulates into sub-pixel aliasing.
  float dOm = KEP_VIS * inversesqrt(rc * rc * rc) - OM0;
  float thS = -7.0 * log(rc * 0.27) + uRigid;
  float nA = fbm2(rot2(hit.xz, thS + dOm * uTauA) * 0.85);
  float nB = fbm2(rot2(hit.xz, thS + dOm * uTauB) * 0.85);
  float n = mix(nA, nB, uABMix);
  n = n * n * 1.7;

  // Doppler beaming: disk rotates clockwise seen from +y → left side approaches.
  vec2 tang = vec2(hit.z, -hit.x) / rc;
  float mu = -(rdN.x * tang.x + rdN.z * tang.y) * sqrt(0.5 / rc) * 1.25;
  float dop = clamp(1.0 / (1.0 - 1.30 * mu), 0.42, 2.5);

  float em = edgeIn * edgeOut * radial * (0.5 + 1.4 * n) * uDiskBright;

  // Feeding filament: log-spiral from the anchor into the disk's outer edge,
  // animated clumps streaming inward; brightens the disk where it lands.
  float fil = 0.0;
  if (uFeedAmp > 0.003 && rc > 4.6) {
    float dp = wrapPi(phi - (uFeedPhi - 3.2 * log(uFeedR / rc)));
    fil = exp(-dp * dp * 14.0)
        * smoothstep(uFeedR + 0.6, uFeedR - 0.9, rc)
        * smoothstep(4.6, 5.8, rc)
        * (0.6 + 0.4 * sin(rc * 3.1 - uFeedPhase * 5.0));
    // glowing head where the stream is born, at the pointer's anchor
    fil += exp(-(dp * dp * rc * rc + (rc - uFeedR) * (rc - uFeedR)) * 2.5) * 1.2;
    float lp = wrapPi(phi - (uFeedPhi - 3.2 * log(uFeedR / 6.2)));
    em *= 1.0 + uFeedAmp * 1.5 * exp(-lp * lp * 5.0) * exp(-(rc - 6.2) * (rc - 6.2) * 0.9);
  }

  em *= uFlareSwell;
  em *= dop * dop;
  em *= 1.0 + 1.2 * mag; // near-critical rays = highly magnified images (the arcs)
  em /= 1.0 + 0.14 * em; // soft knee — white-hot but bounded, so bloom stays local

  float heat = clamp(1.0 - (rc - R_IN) / (R_OUT - R_IN), 0.0, 1.0);
  vec3 col = pal(0.42 + 0.50 * heat + 0.26 * (dop - 1.0)) * em;
  col += em * 0.32 * smoothstep(0.75, 1.35, heat + 0.5 * (dop - 1.0)); // white-hot
  col += (pal(0.78) + 0.3 * uAccent) * (fil * uFeedAmp * 3.0);

  // Flare hotspot: bright arc, independent of the disk envelopes so it can
  // plunge below the inner edge (spaghettification into the shadow).
  if (uFlareAmp > 0.003) {
    float dp = wrapPi(phi - uFlarePhi);
    float g = exp(-dp * dp / (uFlareSig * uFlareSig))
            * exp(-(rc - uFlareR) * (rc - uFlareR) * 2.4);
    col += (mix(pal(0.97), uAccent, 0.35) + 0.6) * (g * uFlareAmp * 5.0) * clamp(dop, 0.6, 1.8);
  }

  float alpha = clamp((0.55 + 0.75 * n) * edgeIn * edgeOut * min(uDiskBright, 1.2), 0.0, 0.92);
  alpha = max(alpha, clamp(fil * uFeedAmp * 0.6, 0.0, 0.5));
  return vec4(col, alpha);
}

void main() {
  vec2 sc = (vUv * 2.0 - 1.0) * uHalfSpan;
  vec3 rd = normalize(uCamFwd * FOCAL + uCamRight * sc.x + uCamUp * sc.y);

  // Fast-forward along the straight ray to the bounding sphere (or closest
  // approach for misses) — bending outside R0 is negligible, steps are not.
  float tca = -dot(uCamPos, rd);
  float b2 = dot(uCamPos, uCamPos) - tca * tca;
  vec3 pos = uCamPos + rd * max(tca - sqrt(max(R0 * R0 - b2, 0.0)), 0.0);
  vec3 vel = rd;
  vec3 hv = cross(pos, vel);
  float h2 = dot(hv, hv); // conserved angular momentum² — sets the deflection
  // photon-ring weight: only rays near the critical impact parameter
  // (b² = 27/4 r_s²) shimmer — plunging rays stay black inside the shadow
  float ringW = exp(-(h2 - 6.75) * (h2 - 6.75) * 0.30);

  vec3 col = vec3(0.0);
  float T = 1.0;      // transmittance through disk crossings
  float glow = 0.0;   // photon-ring proximity accumulator
  int nCross = 0;
  bool escaped = false;

  for (int i = 0; i < STEPS; i++) {
    float r2 = dot(pos, pos);
    if (r2 < 1.0) break;                         // captured by the horizon
    if (r2 > uEsc2) { escaped = true; break; }   // escaped to the stars
    float r = sqrt(r2);
    float dt = clamp(0.25 * (r - 0.7), 0.05, 2.0);
    vel += pos * (-1.5 * h2 / (r2 * r2 * r) * dt);
    float py = pos.y;
    pos += vel * dt;
    glow += dt * exp(-(r - 1.5) * (r - 1.5) * 3.4);
    // equatorial plane crossing inside the (possibly extended) annulus
    if (py * pos.y < 0.0) {
      float fr = py / (py - pos.y);
      vec3 hit = pos - vel * (dt * (1.0 - fr));
      float rc2 = dot(hit.xz, hit.xz);
      if (rc2 > uAnnMin * uAnnMin && rc2 < uAnnMax * uAnnMax) {
        vec4 dc = disk(hit, normalize(vel), ringW);
        col += dc.rgb * T;
        T *= 1.0 - dc.a;
        nCross++;
        if (nCross >= 3 || T < 0.05) break; // opaque enough — background is moot
      }
    }
  }
  if (escaped) col += background(normalize(vel)) * T;
  col += mix(pal(0.9), uAccent, 0.25) * (glow * ringW * uGlow);
  outColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class GravityMode implements Mode {
  readonly id = 'gravity';
  readonly name = { ja: '重力', en: 'Gravity' };
  readonly params: ParamDef[] = [
    { key: 'tilt', label: { ja: '傾き', en: 'Tilt' }, type: 'range', min: 55, max: 88, step: 1, default: 80 },
    { key: 'disk', label: { ja: '降着', en: 'Disk' }, type: 'range', min: 0.4, max: 1.6, step: 0.05, default: 1.0 },
    { key: 'zoom', label: { ja: '近さ', en: 'Zoom' }, type: 'range', min: 0.5, max: 1.5, step: 0.05, default: 1.0 },
  ];

  // live params (persist across quality re-inits — the instance survives)
  private disk = 1.0;
  private zoom = 1.0;

  // camera
  private az = Math.random() * TWO_PI;
  private azVel = IDLE_AZ;
  private incl = (80 * Math.PI) / 180;
  private inclTarget = this.incl;
  private dragEma = 0;

  // disk turbulence phases
  private diskTime = Math.random() * 100;
  private rigid0 = Math.random() * TWO_PI;

  // flare (pulse / auto / beat)
  private flareT0 = -100;
  private flareAmp = 0;
  private flareR = 3.2;
  private flarePhi = 0;
  private flareSig = 0.25;
  private nextAutoAt = -1; // set on first frame (needs ctx.time)

  // feeding filament
  private feedAmt = 0;
  private feedR = 8.4;
  private feedPhi = 0;
  private feedPhase = 0;

  // perf: wall-clock governor over the internal-resolution ladder (persists
  // across tier re-inits — the machine is still slow)
  private resIndex = 0;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1;
  private graceUntilMs = 0;
  private softGL = false;

  // GL
  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private lensW = 0;
  private lensH = 0;
  private colorBuf = new Float32Array(18);

  private beat = new BeatDetector();

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    const steps = this.softGL
      ? ctx.quality >= 0.95 ? 40 : ctx.quality >= 0.65 ? 36 : 32
      : ctx.quality >= 0.95 ? 64 : ctx.quality >= 0.65 ? 56 : 48;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, makeFS(steps), 'gravity.march');
    this.u = new UniformSetter(gl, this.prog);

    const { w, h } = this.lensSize(ctx);
    this.lensW = w;
    this.lensH = h;
    this.post = createPost(gl, w, h);

    this.lastNowMs = -1; // don't count init cost as a frame
    this.slowTime = 0;
    this.fastTime = 0;
    this.nextAutoAt = -1;
  }

  /** Internal ray-march resolution: long side ≤ preset·quality·ladder. */
  private lensSize(ctx: ModeContext): { w: number; h: number } {
    const long = Math.max(ctx.width, ctx.height, 1);
    const base = (this.softGL ? 300 : 480) * ctx.quality;
    const target = Math.min(long, Math.max(this.softGL ? 150 : 220, Math.round(base * RES_LADDER[this.resIndex])));
    const s = target / long;
    return {
      w: Math.max(1, Math.round(ctx.width * s)),
      h: Math.max(1, Math.round(ctx.height * s)),
    };
  }

  private layout(ctx: ModeContext): void {
    if (!this.post) return;
    const { w, h } = this.lensSize(ctx);
    if (w !== this.lensW || h !== this.lensH) {
      this.lensW = w;
      this.lensH = h;
      this.post.resize(w, h);
    }
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (key === 'tilt') this.inclTarget = clamp((v * Math.PI) / 180, MIN_INCL, MAX_INCL);
    else if (key === 'disk') this.disk = v;
    else if (key === 'zoom') this.zoom = v;
  }

  /**
   * Wall-clock resolution governor — rAF timestamps (and ctx.dt) are
   * virtualised in some headless/software renderers and under-report cost.
   */
  private govern(): void {
    const now = performance.now();
    if (this.lastNowMs < 0) { // first frame after init: start the warmup grace
      this.lastNowMs = now;
      this.graceUntilMs = now + 700; // shader warm-up frames must not escalate
      return;
    }
    const real = Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    if (now < this.graceUntilMs) return;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.055) {           // sustained ≤ ~18fps — danger zone
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.4 && this.resIndex < RES_LADDER.length - 1) {
        this.resIndex = Math.min(RES_LADDER.length - 1, this.resIndex + (this.frameEma > 0.09 ? 2 : 1));
        this.slowTime = 0;
      }
    } else if (this.frameEma < 0.036) {    // sustained ≥ ~28fps — headroom
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

  private flareEnv(time: number): number {
    const a = time - this.flareT0;
    if (a < 0 || a > 8) return 0;
    return this.flareAmp * (a < 0.3 ? a / 0.3 : Math.exp(-(a - 0.3) / 1.6));
  }

  private triggerFlare(time: number, amp: number, phi: number): void {
    this.flareT0 = time;
    this.flareAmp = amp;
    this.flareR = 3.2;
    this.flarePhi = phi % TWO_PI;
    this.flareSig = 0.25;
  }

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.prog || !this.u || !this.post) return;
    this.govern();
    this.layout(ctx);
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    const dt = ctx.dt;
    const pt = ctx.pointer;

    // --- camera control: DRAG orbits (same-frame), inertia on release -------
    if (pt.down) {
      const dAz = (-pt.dx * 3.0) / Math.max(1, ctx.width);
      this.az += dAz;
      this.azVel = clamp(this.azVel * 0.7 + (dAz / Math.max(dt, 1 / 240)) * 0.3, -3, 3);
      this.incl = clamp(this.incl - (pt.dy * 2.2) / Math.max(1, ctx.height), MIN_INCL, MAX_INCL);
      this.inclTarget = this.incl; // drag re-bases; the tilt param overrides on set
      this.dragEma += (Math.abs(pt.dx) + Math.abs(pt.dy) - this.dragEma) * (1 - Math.exp(-dt / 0.12));
    } else {
      this.dragEma *= Math.exp(-dt / 0.25);
      this.azVel += (IDLE_AZ - this.azVel) * (1 - Math.exp(-dt * 1.1)); // inertia → idle drift
      this.az += this.azVel * dt;
      this.incl += (this.inclTarget - this.incl) * (1 - Math.exp(-dt * 3));
    }
    this.az %= TWO_PI;

    // --- camera basis --------------------------------------------------------
    const camR = 18 - 5 * this.zoom;
    const sI = Math.sin(this.incl);
    const cx = camR * sI * Math.cos(this.az);
    const cy = camR * Math.cos(this.incl);
    const cz = camR * sI * Math.sin(this.az);
    const il = 1 / camR;
    const fx = -cx * il, fy = -cy * il, fz = -cz * il;      // forward (unit)
    let rx = -fz, rz = fx;                                   // cross(fwd, +Y).xz
    const rl = 1 / Math.max(1e-5, Math.hypot(rx, rz));
    rx *= rl; rz *= rl;                                      // right (unit, y=0)
    const upx = -rz * fy;                                    // up = cross(right, fwd)
    const upy = rz * fx - rx * fz;
    const upz = rx * fy;
    const minSide = Math.min(ctx.width, ctx.height) || 1;
    const aspX = ctx.width / minSide;
    const aspY = ctx.height / minSide;

    // --- feeding: HOLD (not dragging much) streams matter into the disk -----
    const holdStill = pt.down && pt.pressFrames > 6 && this.dragEma < 3 * ctx.dpr;
    this.feedAmt += ((holdStill ? 1 : 0) - this.feedAmt) * (1 - Math.exp(-dt * 3.5));
    if (this.feedAmt > 0.003) this.feedPhase += dt;
    if (holdStill) {
      // pointer ray → equatorial plane (straight-line approx), smoothed anchor
      const px = (pt.nx * 2 - 1) * aspX;
      const py = (pt.ny * 2 - 1) * aspY;
      let dx = fx * FOCAL + rx * px + upx * py;
      let dy = fy * FOCAL + 0 * px + upy * py;
      let dz = fz * FOCAL + rz * px + upz * py;
      const dl = 1 / Math.hypot(dx, dy, dz);
      dx *= dl; dy *= dl; dz *= dl;
      const t = cy / Math.max(0.04, -dy); // cam is above the plane (incl ≤ 88°)
      const wx = cx + dx * t, wz = cz + dz * t;
      const tr = clamp(Math.hypot(wx, wz), 7.8, 9.3);
      const tp = Math.atan2(wz, wx);
      const k = 1 - Math.exp(-dt * 8);
      this.feedR += (tr - this.feedR) * k;
      this.feedPhi += ((((tp - this.feedPhi) % TWO_PI) + 3 * Math.PI) % TWO_PI - Math.PI) * k;
    }

    // --- flares: pulse = big, bass beat = mini (audio-guarded), auto idle ---
    if (this.nextAutoAt < 0) this.nextAutoAt = ctx.time + 40 + Math.random() * 20;
    if (ctx.pulse) this.triggerFlare(ctx.time, 1.0, this.az + 0.9);
    const au = ctx.audio;
    if (au && this.beat.update(au.low, ctx.time, dt) && this.flareEnv(ctx.time) < 0.25) {
      this.triggerFlare(ctx.time, 0.5 + 0.3 * au.low, this.az - 1.2);
    }
    if (ctx.time >= this.nextAutoAt) {
      this.nextAutoAt = ctx.time + 40 + Math.random() * 20;
      if (this.flareEnv(ctx.time) < 0.1 && !ctx.pulse) this.triggerFlare(ctx.time, 0.7, this.az + 2.1);
    }
    const env = this.flareEnv(ctx.time);
    if (env > 0) {
      const a = ctx.time - this.flareT0;
      const prog = Math.min(1, a / 2.2);
      this.flareR = 3.2 - 2.0 * Math.pow(prog, 1.15);         // spirals inward…
      this.flareSig = 0.25 + 1.5 * prog;                       // …stretching into an arc
      this.flarePhi = (this.flarePhi + dt * 1.1 * Math.pow(2.6 / Math.max(this.flareR, 1.15), 1.5)) % TWO_PI;
    }

    // --- disk turbulence phases (audio-guarded speed; ×1 when audio null) ---
    this.diskTime += dt * (au ? 1 + 0.3 * au.mid : 1);
    const fA = ((this.diskTime / SHEAR_T) % 1 + 1) % 1;
    const fB = ((this.diskTime / SHEAR_T + 0.5) % 1 + 1) % 1;

    // --- uniforms + draw -----------------------------------------------------
    this.post.begin();
    gl.useProgram(this.prog);
    const u = this.u;
    u.set3f('uCamPos', cx, cy, cz);
    u.set3f('uCamRight', rx, 0, rz);
    u.set3f('uCamUp', upx, upy, upz);
    u.set3f('uCamFwd', fx, fy, fz);
    u.set2f('uHalfSpan', aspX, aspY);
    u.set1f('uEsc2', (camR + 9) * (camR + 9));
    u.set1f('uRigid', (this.rigid0 + OM0 * this.diskTime) % TWO_PI);
    u.set1f('uTauA', (fA - 0.5) * SHEAR_T);
    u.set1f('uTauB', (fB - 0.5) * SHEAR_T);
    u.set1f('uABMix', Math.abs(2 * fA - 1));
    u.set1f('uDiskBright', this.disk * (au ? 1 + 0.35 * au.level : 1) * (1 + 0.25 * this.feedAmt));
    u.set1f('uAnnMin', env > 0.01 ? Math.max(1.05, this.flareR - 0.45) : R_IN);
    u.set1f('uAnnMax', this.feedAmt > 0.003 ? Math.min(R0, this.feedR + 0.7) : R_OUT);
    u.set1f('uFlareAmp', env);
    u.set1f('uFlareR', this.flareR);
    u.set1f('uFlarePhi', this.flarePhi);
    u.set1f('uFlareSig', this.flareSig);
    u.set1f('uFlareSwell', 1 + 0.45 * env);
    u.set1f('uFeedAmp', this.feedAmt);
    u.set1f('uFeedR', this.feedR);
    u.set1f('uFeedPhi', this.feedPhi);
    u.set1f('uFeedPhase', this.feedPhase);
    u.set1f('uGlow', 0.09 * (1 + 1.0 * env));
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.12, bloom: 0.38, vignette: 0.3 });

    // canonical GL state (post.end already left FBO=null, activeTexture=0)
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.prog = null;
    this.u = null;
    this.post?.destroy();
    this.post = null;
  }
}

export const gravityMode: Mode = new GravityMode();
