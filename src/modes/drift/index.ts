/**
 * DRIFT — 遊泳. A first-person voyage swimming through a sea of stars.
 *
 * Starfield: a STATIC random cloud (RGBA32F texture, xyz = position in a
 * repeating [0,2)³ cube, w = seed) — no simulation. All per-frame work is in
 * the vertex shader: world = star − cameraPos wrapped into [-1,1]³ via mod,
 * perspective projection, behind-camera discard via clip. Stars render twice
 * additively into the shared HDR chain: as round point sprites (accent stars
 * get a cross-flare) and as velocity-elongated LINES whose tail is the star
 * re-projected through a virtual camera Δ seconds in the past — streaks grow
 * smoothly out of the points as speed rises, fully correct under turning.
 *
 * Motion: the camera flies forward forever. Pointer offset from screen center
 * = yaw/pitch rate (eased, flight-sim banking roll); release eases back to a
 * noise-driven auto-meander. Press/hold accelerates ~4× (two touches ~6×)
 * with FOV widen + subtle speed-shake; release decays over ~1s. Camera
 * position wraps mod 2 every frame so float precision never degrades.
 *
 * Nebula: one quarter-res pass computes two parallax fbm haze layers in ray
 * direction space (domain translated by accumulated camera motion), palette
 * tinted with a band that drifts slowly through the theme. A bright landmark
 * star with halo + diffraction arms passes by every ~15–25s, slightly
 * off-axis. Pulse = HYPERJUMP: extreme streak stretch, center white-out,
 * arrival with randomized heading + nebula band jump + afterglow.
 *
 * Perf mirrors galaxy/hanabi: software-GL preset (fewer stars, smaller scene),
 * wall-clock stride governor escalating to a desperate tier (shrunken scene,
 * nebula at half rate).
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import { compileProgram, createFBO, drawFullscreen, makeTexture, FS_TRIANGLE_VS, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { BeatDetector } from '../../core/audio';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const VOL = 2.0;             // wrapping cube side; camera pos lives in [0,VOL)
const NEAR = 0.035;
const BASE_SPEED = 0.30;     // world units/s at speed=1, no boost
const TAN_HALF_FOV = 0.70;   // vertical half-fov ≈ 70°
const ACCEL_HOLD = 4.0;      // press/hold speed multiplier
const ACCEL_TWO = 6.0;       // two touches held
const HYPER_JUMP_AT = 0.42;  // s into the hyperjump when the world swaps
const STRETCH0 = 0.05;       // base streak look-back seconds at streak=1

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

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

const PAL = `
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
`;

/** Shared by both star passes: fetch, camera-relative wrap, per-star photometry. */
const STAR_COMMON = `
uniform sampler2D uStars;   // RGBA32F: xyz = pos in [0,${VOL.toFixed(1)}), w = seed
uniform int uSide;
uniform int uStride;
uniform mat3 uView;
uniform vec3 uCamPos;
uniform vec2 uProj;         // (f/aspect, f)
uniform float uFpx;         // f * sceneH/2 — pixels per unit slope
uniform float uNear;
uniform float uBright;
uniform float uTime;
uniform vec3 uColors[6];
uniform int uNumColors;
const float HALF = ${(VOL / 2).toFixed(1)};
const float SIZE = ${VOL.toFixed(1)};
${PAL}
vec4 fetchStar(int sid) {
  return texelFetch(uStars, ivec2(sid % uSide, sid / uSide), 0);
}
vec3 relOf(vec3 sp) {
  // star position relative to the camera, wrapped into [-HALF, HALF)³
  return mod(sp - uCamPos + HALF, SIZE) - HALF;
}
// fade to zero near the wrap faces (Chebyshev) — kills wrap pops entirely
float wrapFade(vec3 rel) {
  float mc = max(abs(rel.x), max(abs(rel.y), abs(rel.z)));
  return 1.0 - smoothstep(0.76, 0.97, mc);
}
`;

const POINT_VS = `#version 300 es
precision highp float;
${STAR_COMMON}
out vec3 vColor;
out float vFlare;
void main() {
  int sid = gl_VertexID * uStride;
  vec4 S = fetchStar(sid);
  vec3 rel = relOf(S.xyz);
  vec3 v = uView * rel;
  if (v.z > -uNear) { // behind the camera → clip out
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vFlare = 0.0;
    return;
  }
  float d = length(rel);
  float h1 = fract(S.w * 7.13 + 0.37);
  float h2 = fract(S.w * 13.77 + 0.11);
  float h3 = fract(S.w * 29.31 + 0.53);
  float accent = step(0.975, h1); // ~2.5% bright accent stars with cross flares
  float tcol = mix(0.10 + 0.45 * h2, 0.72 + 0.28 * h2, accent);
  float radius = mix(0.0021 * (0.55 + 0.9 * h3), 0.0058 * (0.75 + 0.5 * h3), accent);
  float spx = uFpx * radius / d;                    // true perspective size, px
  float px = clamp(spx, 1.5, mix(6.5, 14.0, accent));
  float comp = min(spx * spx / (px * px), 2.5);     // flux conservation when clamped
  float tw = 0.78 + 0.22 * sin(uTime * (0.5 + 1.8 * h2) + h3 * 61.0);
  vColor = min(pal(tcol) * (uBright * mix(0.75, 3.6, accent) * comp * wrapFade(rel) * tw),
               vec3(9.0)); // HDR cap: accents bloom but never blow out to blocks
  vFlare = accent;
  gl_PointSize = px;
  gl_Position = vec4(v.xy * uProj / -v.z, 0.0, 1.0);
}
`;

const POINT_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vFlare;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  float g = max(0.0, 1.0 - r2);
  // tight hot center + soft round skirt — never a saturated square
  float core = 0.45 * g * g * g * g + 0.75 * exp(-r2 * 14.0);
  float ax = max(0.0, 1.0 - abs(q.x));
  float ay = max(0.0, 1.0 - abs(q.y));
  float xf = pow(ax, 9.0) * ay * ay + pow(ay, 9.0) * ax * ax; // 4-point flare
  outColor = vec4(vColor * (core + vFlare * 0.5 * xf), 1.0);
}
`;

const LINE_VS = `#version 300 es
precision highp float;
${STAR_COMMON}
uniform mat3 uViewPrev;   // virtual camera Δs in the past
uniform vec3 uCamDelta;   // camNow − camPrev = vel·Δ
uniform vec2 uRes;        // scene target size
out vec3 vColor;
void main() {
  int sid = (gl_VertexID >> 1) * uStride;
  float end = float(gl_VertexID & 1); // 1 = head (now), 0 = tail (past)
  vec4 S = fetchStar(sid);
  vec3 rel = relOf(S.xyz);
  vec3 vh = uView * rel;
  vec3 vt = uViewPrev * (rel + uCamDelta);
  if (vh.z > -uNear || vt.z > -uNear) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec3(0.0);
    return;
  }
  vec2 nh = vh.xy * uProj / -vh.z;
  vec2 nt = vt.xy * uProj / -vt.z;
  float d = length(rel);
  float h1 = fract(S.w * 7.13 + 0.37);
  float h2 = fract(S.w * 13.77 + 0.11);
  float accent = step(0.975, h1);
  float tcol = mix(0.10 + 0.45 * h2, 0.72 + 0.28 * h2, accent);
  float lenPx = length((nh - nt) * 0.5 * uRes);
  float dim = 1.0 / (1.0 + lenPx * 0.085);          // energy spread along the streak
  float near = clamp(0.09 / d, 0.25, 2.4);
  vColor = min(pal(tcol)
         * (uBright * mix(0.5, 2.4, accent) * near * wrapFade(rel) * dim * mix(0.18, 1.0, end)),
         vec3(7.0));
  gl_Position = vec4(mix(nt, nh, end), 0.0, 1.0);
}
`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }
`;

/** Quarter-res nebula: two parallax fbm layers in ray-direction space. */
const NEBULA_FS = `#version 300 es
precision highp float;
uniform mat3 uInvView;
uniform vec2 uTanFov;    // (tanHalf·aspect, tanHalf)
uniform vec3 uOff1;      // far-layer domain offset (camera motion + drift)
uniform vec3 uOff2;      // near layer — stronger parallax
uniform float uBand;     // palette band position (drifts; jumps on hyperjump)
uniform float uDensity;
uniform vec3 uColors[6];
uniform int uNumColors;
in vec2 vUv;
out vec4 outColor;
${PAL}
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x),
                mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x),
                mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm3(vec3 p) {
  return 0.55 * vnoise3(p) + 0.30 * vnoise3(p * 2.07 + 11.3) + 0.15 * vnoise3(p * 4.33 - 7.1);
}
float tri(float x) { return 1.0 - abs(1.0 - 2.0 * fract(x)); } // ping-pong through the palette
void main() {
  vec3 dir = uInvView * normalize(vec3((vUv * 2.0 - 1.0) * uTanFov, -1.0));
  float n1 = fbm3(dir * 2.1 + uOff1);
  float n2 = fbm3(dir * 3.9 + uOff2);
  // patchy wisps: most of the sky stays deep dark space
  float h1 = smoothstep(0.55, 0.88, n1);
  float h2 = smoothstep(0.60, 0.92, n2);
  // band stays inside the saturated mid-palette — never the pale top end
  vec3 c1 = pal(0.14 + 0.42 * tri(uBand + 0.22 * n1));
  vec3 c2 = pal(0.22 + 0.44 * tri(uBand + 0.37 + 0.20 * n2));
  vec3 col = (c1 * h1 * 0.30 + c2 * h2 * 0.22) * uDensity;
  outColor = vec4(col, clamp(h1 * 0.7 + h2 * 0.6, 0.0, 1.0));
}
`;

/** Background composite into the HDR scene: nebula + landmark star + hyper flash. */
const BG_FS = `#version 300 es
precision highp float;
uniform sampler2D uNebula;
uniform vec3 uBg;
uniform vec4 uLm;        // xy = screen uv, z = intensity, w = halo radius (uv)
uniform vec3 uLmCol;
uniform float uFlash;
uniform vec3 uFlashCol;
uniform vec2 uAspect;    // (w/h, 1)
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 neb = texture(uNebula, vUv);
  vec3 col = uBg * (0.7 + 0.6 * neb.a) + neb.rgb;
  if (uLm.z > 0.001) {
    vec2 d = (vUv - uLm.xy) * uAspect;
    float r2 = dot(d, d);
    float ir2 = 1.0 / (uLm.w * uLm.w);
    float halo = exp(-r2 * ir2 * 1.1);
    float core = exp(-r2 * ir2 * 60.0) * 1.6 + exp(-r2 * ir2 * 14.0) * 0.5;
    float arm = exp(-abs(d.y) / (uLm.w * 0.045)) * exp(-abs(d.x) / (uLm.w * 0.42))
              + exp(-abs(d.x) / (uLm.w * 0.045)) * exp(-abs(d.y) / (uLm.w * 0.42));
    col += uLmCol * uLm.z * (0.5 * halo + 3.0 * core + 0.55 * arm);
  }
  if (uFlash > 0.001) {
    vec2 q = (vUv - 0.5) * uAspect;
    col += uFlashCol * uFlash * (0.18 + 2.4 * exp(-dot(q, q) * 5.5));
  }
  outColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

interface Target { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number }

class DriftMode implements Mode {
  readonly id = 'drift';
  readonly name = { ja: '遊泳', en: 'Drift' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '速度', en: 'Speed' }, type: 'range', min: 0.4, max: 2.5, step: 0.05, default: 1 },
    { key: 'nebula', label: { ja: '靄', en: 'Nebula' }, type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8 },
    { key: 'streak', label: { ja: '流星', en: 'Streaks' }, type: 'range', min: 0.5, max: 2, step: 0.05, default: 1 },
  ];

  // live params (persist across quality re-inits — the instance survives)
  private speedP = 1;
  private nebulaP = 0.8;
  private streakP = 1;

  // ---- camera state (persists across re-inits: no visual jump on tier change)
  private camX = Math.random() * VOL;
  private camY = Math.random() * VOL;
  private camZ = Math.random() * VOL;
  private yaw = Math.random() * Math.PI * 2;
  private pitch = rand(-0.15, 0.15);
  private roll = 0;
  private yawRate = 0;
  private pitchRate = 0;
  private accelEnv = 1;
  private m1 = Math.random() * Math.PI * 2; // meander phases
  private m2 = Math.random() * Math.PI * 2;
  private m3 = Math.random() * Math.PI * 2;

  // rolled camera basis, rebuilt each frame (no per-frame allocation)
  private fwX = 0; private fwY = 0; private fwZ = -1;
  private rX = 1; private rY = 0; private rZ = 0;
  private uX = 0; private uY = 1; private uZ = 0;

  // nebula domain accumulators (float64 on CPU; wrapped on hyperjump)
  private off1x = Math.random() * 64; private off1y = Math.random() * 64; private off1z = Math.random() * 64;
  private off2x = Math.random() * 64; private off2y = Math.random() * 64; private off2z = Math.random() * 64;
  private band = Math.random();

  // hyperjump
  private hyperStart = -1e3;
  private hyperJumped = true;

  // landmark star (position stored camera-relative — survives cam wrap)
  private lmActive = false;
  private lmX = 0; private lmY = 0; private lmZ = 0;
  private lmBorn = -1e3;
  private lmSeed = 0;
  private nextLmAt = 0;
  private lmFlare = 0; // audio bass-attack flare envelope (0 forever without audio)
  private beat = new BeatDetector();

  // ---- pool / targets
  private side = 256;
  private count = 256 * 256;
  private softGL = false;
  private sceneScale = 1;
  private sceneW = 1;
  private sceneH = 1;

  // wall-clock stride governor (galaxy's scheme — rAF dt can be virtualised)
  private drawStride = 1;
  private baseStride = 1;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1;

  // GL resources
  private starTex: WebGLTexture | null = null;
  private neb: Target | null = null;
  private nebFresh = true;
  private post: Post | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private pointProg: WebGLProgram | null = null;
  private lineProg: WebGLProgram | null = null;
  private nebProg: WebGLProgram | null = null;
  private bgProg: WebGLProgram | null = null;
  private pointU: UniformSetter | null = null;
  private lineU: UniformSetter | null = null;
  private nebU: UniformSetter | null = null;
  private bgU: UniformSetter | null = null;

  // scratch (reused — zero per-frame allocation)
  private colorBuf = new Float32Array(18);
  private mView = new Float32Array(9);
  private mViewPrev = new Float32Array(9);
  private mInv = new Float32Array(9);
  private palN = 5;

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    const softC = this.softGL ? 0.66 : 1;
    this.side = Math.max(96, Math.round(256 * Math.sqrt(ctx.quality) * softC));
    this.count = this.side * this.side;
    this.sceneScale = ctx.quality <= 0.5 ? 0.62 : Math.min(0.85, 0.5 + 0.4 * ctx.quality);
    if (this.softGL) this.sceneScale = Math.min(this.sceneScale, 0.72);
    this.baseStride = (ctx.quality > 0.5 ? 1 : 2) * (this.softGL ? 2 : 1);
    this.drawStride = Math.min(8, Math.max(this.baseStride, this.drawStride));
    this.slowTime = 0;
    this.fastTime = 0;
    this.lastNowMs = -1; // don't count init cost as a frame

    this.pointProg = compileProgram(gl, POINT_VS, POINT_FS, 'drift.points');
    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS, 'drift.lines');
    this.nebProg = compileProgram(gl, FS_TRIANGLE_VS, NEBULA_FS, 'drift.nebula');
    this.bgProg = compileProgram(gl, FS_TRIANGLE_VS, BG_FS, 'drift.bg');
    this.pointU = new UniformSetter(gl, this.pointProg);
    this.lineU = new UniformSetter(gl, this.lineProg);
    this.nebU = new UniformSetter(gl, this.nebProg);
    this.bgU = new UniformSetter(gl, this.bgProg);

    // static star cloud — the only "sim state", uploaded once, never written
    const data = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      const o = i * 4;
      data[o] = Math.random() * VOL;
      data[o + 1] = Math.random() * VOL;
      data[o + 2] = Math.random() * VOL;
      data[o + 3] = Math.random();
    }
    this.starTex = makeTexture(gl, { w: this.side, h: this.side, internalFormat: gl.RGBA32F, data });

    this.sceneW = Math.max(1, Math.round(ctx.width * this.sceneScale));
    this.sceneH = Math.max(1, Math.round(ctx.height * this.sceneScale));
    this.post = createPost(gl, this.sceneW, this.sceneH);
    this.allocNebula(gl);
    this.vao = gl.createVertexArray();
    this.layout(ctx);

    // pre-warm: mid-voyage camera is already set (fields persist); guarantee
    // the first minute has a landmark by placing one ahead right now
    if (!this.lmActive) {
      this.computeBasis(this.yaw, this.pitch, this.roll);
      this.spawnLandmark(rand(1.0, 1.3));
      this.lmBorn = ctx.time - 0.6; // partly ramped in on frame 1
    }
  }

  private allocNebula(gl: WebGL2RenderingContext): void {
    if (this.neb) {
      gl.deleteTexture(this.neb.tex);
      gl.deleteFramebuffer(this.neb.fbo);
    }
    const w = Math.max(1, Math.round(this.sceneW / 4));
    const h = Math.max(1, Math.round(this.sceneH / 4));
    const tex = makeTexture(gl, { w, h, internalFormat: gl.RGBA16F, filter: gl.LINEAR });
    this.neb = { tex, fbo: createFBO(gl, tex), w, h };
    this.nebFresh = true;
  }

  /** (Re)size scene + nebula targets; desperate stride shrinks the scene. */
  private layout(ctx: ModeContext): void {
    if (!this.post) return;
    const s = this.sceneScale * (this.drawStride >= 8 ? 0.75 : 1);
    const w = Math.max(1, Math.round(ctx.width * s));
    const h = Math.max(1, Math.round(ctx.height * s));
    if (w !== this.sceneW || h !== this.sceneH) {
      this.sceneW = w;
      this.sceneH = h;
      this.post.resize(w, h);
      this.allocNebula(ctx.gl);
    }
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (key === 'speed') this.speedP = clamp(v, 0.4, 2.5);
    else if (key === 'nebula') this.nebulaP = clamp(v, 0, 1.5);
    else if (key === 'streak') this.streakP = clamp(v, 0.5, 2);
  }

  // -------------------------------------------------------------------------
  // Camera helpers
  // -------------------------------------------------------------------------

  /** Build the rolled orthonormal camera basis into fw/r/u fields. */
  private computeBasis(yaw: number, pitch: number, roll: number): void {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    // right = normalize(cross(fw, worldUp))
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    // up = cross(right, fw)
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    // roll around forward
    const cr = Math.cos(roll), sr = Math.sin(roll);
    this.rX = rx * cr + ux * sr; this.rY = uy * sr; this.rZ = rz * cr + uz * sr;
    this.uX = ux * cr - rx * sr; this.uY = uy * cr; this.uZ = uz * cr - rz * sr;
    this.fwX = fx; this.fwY = fy; this.fwZ = fz;
  }

  /** Column-major world→view matrix (rows: right, up, −forward) from the basis. */
  private fillView(m: Float32Array): void {
    m[0] = this.rX; m[1] = this.uX; m[2] = -this.fwX;
    m[3] = this.rY; m[4] = this.uY; m[5] = -this.fwY;
    m[6] = this.rZ; m[7] = this.uZ; m[8] = -this.fwZ;
  }

  /** Column-major view→world (transpose) from the basis. */
  private fillInv(m: Float32Array): void {
    m[0] = this.rX; m[1] = this.rY; m[2] = this.rZ;
    m[3] = this.uX; m[4] = this.uY; m[5] = this.uZ;
    m[6] = -this.fwX; m[7] = -this.fwY; m[8] = -this.fwZ;
  }

  private spawnLandmark(dist: number): void {
    const lat = (Math.random() < 0.5 ? -1 : 1) * rand(0.22, 0.52);
    const vert = rand(-0.28, 0.28);
    this.lmX = this.fwX * dist + this.rX * lat + this.uX * vert;
    this.lmY = this.fwY * dist + this.rY * lat + this.uY * vert;
    this.lmZ = this.fwZ * dist + this.rZ * lat + this.uZ * vert;
    this.lmSeed = Math.random();
    this.lmActive = true;
  }

  private buildColors(th: Theme): void {
    const n = Math.min(6, th.colors.length);
    this.palN = n;
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
  }

  /** Wall-clock stride governor (galaxy's scheme). */
  private governStride(): void {
    const now = performance.now();
    const real = this.lastNowMs < 0 ? 1 / 60 : Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.045) {
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.3 && this.drawStride < 8) {
        const mult = this.frameEma > 0.07 ? 4 : 2;
        this.drawStride = Math.min(8, this.drawStride * mult);
        this.slowTime = 0;
      }
    } else if (this.frameEma < 0.022) {
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

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.post || !this.starTex || !this.neb) return;
    this.governStride();
    this.layout(ctx);
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    this.buildColors(th);
    const t = ctx.time;
    const dt = ctx.dt;

    // ---- audio (null ⇒ every factor exactly neutral, no state advances)
    const au = ctx.audio;
    const aSpeed = au ? 1 + 0.3 * au.level : 1;
    const aStreak = au ? 1 + 0.4 * au.level : 1;
    if (au && this.beat.update(au.low, t, dt)) {
      this.lmFlare = Math.min(1.6, this.lmFlare + 0.5 + 0.9 * au.low);
    }
    this.lmFlare *= Math.exp(-dt * 3.0);

    // ---- hyperjump timeline
    if (ctx.pulse) {
      this.hyperStart = t;
      this.hyperJumped = false;
    }
    const ht = t - this.hyperStart;
    let hyperAccel = 0;
    let hyperStreak = 0;
    let flash = 0;
    let afterglow = 0;
    if (ht >= 0 && ht < 5) {
      const up = clamp(ht / HYPER_JUMP_AT, 0, 1);
      const rise = up * up * (3 - 2 * up);
      const fall = Math.exp(-Math.max(0, ht - HYPER_JUMP_AT) * 3.2);
      hyperStreak = ht < HYPER_JUMP_AT ? rise : fall;
      hyperAccel = hyperStreak;
      flash = ht < HYPER_JUMP_AT ? rise * rise * rise : Math.exp(-(ht - HYPER_JUMP_AT) * 5.5);
      afterglow = ht >= HYPER_JUMP_AT ? Math.exp(-(ht - HYPER_JUMP_AT) * 1.8) : 0;
      if (!this.hyperJumped && ht >= HYPER_JUMP_AT) {
        // ARRIVE: new heading, new star pattern, new nebula region — hidden
        // behind the white-out peak
        this.hyperJumped = true;
        this.yaw += (Math.random() < 0.5 ? -1 : 1) * rand(1.2, 2.8);
        this.pitch = rand(-0.4, 0.4);
        this.camX = Math.random() * VOL;
        this.camY = Math.random() * VOL;
        this.camZ = Math.random() * VOL;
        this.band = Math.random();
        this.off1x = (this.off1x % 256) + rand(10, 60);
        this.off1y = (this.off1y % 256) + rand(10, 60);
        this.off1z = (this.off1z % 256) + rand(10, 60);
        this.off2x = (this.off2x % 256) + rand(10, 60);
        this.off2y = (this.off2y % 256) + rand(10, 60);
        this.off2z = (this.off2z % 256) + rand(10, 60);
        this.lmActive = false;
        this.nextLmAt = t + rand(3, 7); // a landmark greets the new region soon
      }
    }

    // ---- pointer → steering + acceleration (GL-oriented, same-frame)
    const p = ctx.pointer;
    let steer = false;
    let sx = 0;
    let sy = 0;
    let boost = 1;
    if (p.touches.length > 0) {
      let ax = 0, ay = 0;
      for (const tc of p.touches) { ax += tc.x; ay += tc.y; }
      ax /= p.touches.length * ctx.width;
      ay /= p.touches.length * ctx.height;
      sx = clamp(ax * 2 - 1, -1, 1);
      sy = clamp(ay * 2 - 1, -1, 1);
      steer = true;
      boost = p.touches.length >= 2 ? ACCEL_TWO : ACCEL_HOLD;
    } else if (p.down) {
      sx = clamp(p.nx * 2 - 1, -1, 1);
      sy = clamp(p.ny * 2 - 1, -1, 1);
      steer = true;
      boost = ACCEL_HOLD;
    }

    const accelTarget = steer ? boost : 1;
    const kA = accelTarget > this.accelEnv ? 4.5 : 2.2; // fast in, ~1s out
    this.accelEnv += (accelTarget - this.accelEnv) * (1 - Math.exp(-dt * kA));
    const accel01 = clamp((this.accelEnv - 1) / (ACCEL_HOLD - 1), 0, 1.4);

    // heading rates: pointer offset = rate while held; noise meander otherwise
    let tYaw: number;
    let tPitch: number;
    let kR: number;
    if (steer) {
      tYaw = -sx * Math.abs(sx) * 1.25;   // quadratic response — soft near center
      tPitch = sy * Math.abs(sy) * 0.95;
      kR = 5.0;
    } else {
      tYaw = 0.055 * Math.sin(t * 0.11 + this.m1) + 0.035 * Math.sin(t * 0.041 + this.m2);
      tPitch = -this.pitch * 0.22 + 0.045 * Math.sin(t * 0.067 + this.m3);
      kR = 1.1;
    }
    const eR = 1 - Math.exp(-dt * kR);
    this.yawRate += (tYaw - this.yawRate) * eR;
    this.pitchRate += (tPitch - this.pitchRate) * eR;
    this.yaw += this.yawRate * dt;
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -1.25, 1.25);
    const tRoll = -this.yawRate * 0.32; // banking
    this.roll += (tRoll - this.roll) * (1 - Math.exp(-dt * 3.0));

    // display-only speed shake (never integrated into the heading)
    const shakeAmt = 0.0045 * accel01 + 0.006 * hyperAccel;
    const jYaw = shakeAmt * (Math.sin(t * 31.0) + 0.5 * Math.sin(t * 47.7 + 1.3));
    const jPitch = shakeAmt * 0.7 * Math.sin(t * 39.3 + 0.7);
    this.computeBasis(this.yaw + jYaw, clamp(this.pitch + jPitch, -1.3, 1.3), this.roll);

    // ---- speed, position (wrapped mod VOL — float precision stays pristine)
    const spd = BASE_SPEED * this.speedP * this.accelEnv * aSpeed * (1 + 5.5 * hyperAccel);
    const vx = this.fwX * spd, vy = this.fwY * spd, vz = this.fwZ * spd;
    this.camX = (((this.camX + vx * dt) % VOL) + VOL) % VOL;
    this.camY = (((this.camY + vy * dt) % VOL) + VOL) % VOL;
    this.camZ = (((this.camZ + vz * dt) % VOL) + VOL) % VOL;
    // nebula parallax domains follow camera motion + a slow autonomous drift
    this.off1x += vx * 0.40 * dt + 0.006 * dt;
    this.off1y += vy * 0.40 * dt + 0.004 * dt;
    this.off1z += vz * 0.40 * dt;
    this.off2x += vx * 0.95 * dt;
    this.off2y += vy * 0.95 * dt + 0.007 * dt;
    this.off2z += vz * 0.95 * dt;
    this.band += dt * 0.0055; // palette band keeps evolving over a 60s idle

    // ---- streak look-back time
    let delta = STRETCH0 * this.streakP * (0.30 + 1.3 * accel01) * aStreak
              + 0.40 * hyperStreak * this.streakP;
    delta = Math.min(delta, 0.6);

    // view matrices (now + Δs ago) — landmark math reuses the current basis
    this.fillView(this.mView);
    this.fillInv(this.mInv);
    const rXn = this.rX, rYn = this.rY, rZn = this.rZ;
    const uXn = this.uX, uYn = this.uY, uZn = this.uZ;
    const fXn = this.fwX, fYn = this.fwY, fZn = this.fwZ;
    this.computeBasis(
      this.yaw - this.yawRate * delta,
      clamp(this.pitch - this.pitchRate * delta, -1.3, 1.3),
      this.roll,
    );
    this.fillView(this.mViewPrev);
    // restore current basis fields
    this.rX = rXn; this.rY = rYn; this.rZ = rZn;
    this.uX = uXn; this.uY = uYn; this.uZ = uZn;
    this.fwX = fXn; this.fwY = fYn; this.fwZ = fZn;

    // ---- projection (FOV widens under boost / hyperjump)
    const tanH = TAN_HALF_FOV * (1 + 0.16 * Math.min(accel01, 1) + 0.22 * hyperAccel);
    const f = 1 / tanH;
    const aspect = this.sceneW / Math.max(1, this.sceneH);
    const fx = f / aspect;
    const fpx = f * this.sceneH * 0.5;

    // ---- landmark star lifecycle (camera-relative position)
    this.lmX -= vx * dt; this.lmY -= vy * dt; this.lmZ -= vz * dt;
    let lmI = 0, lmU = 0.5, lmV = 0.5, lmR = 0.1;
    if (this.lmActive) {
      const d = Math.hypot(this.lmX, this.lmY, this.lmZ);
      const viewZ = -(fXn * this.lmX + fYn * this.lmY + fZn * this.lmZ);
      if (d > 2.6 || viewZ > 0.3) {
        this.lmActive = false;
        this.nextLmAt = t + rand(15, 25); // the ~15-25s landmark cadence
      } else if (viewZ < -0.02) {
        const vxv = rXn * this.lmX + rYn * this.lmY + rZn * this.lmZ;
        const vyv = uXn * this.lmX + uYn * this.lmY + uZn * this.lmZ;
        const invz = -1 / viewZ;
        lmU = vxv * fx * invz * 0.5 + 0.5;
        lmV = vyv * f * invz * 0.5 + 0.5;
        const vis = clamp((-viewZ - 0.03) / 0.12, 0, 1);
        const ramp = clamp((t - this.lmBorn) / 1.4, 0, 1);
        const distFade = 1 - clamp((d - 1.9) / 0.6, 0, 1);
        const tw = 0.82 + 0.18 * Math.sin(t * 2.6 + this.lmSeed * 23);
        lmI = 1.9 * ramp * vis * distFade * tw * (1 + 1.8 * this.lmFlare);
        lmR = clamp(0.05 + 0.09 / Math.max(d, 0.25), 0.06, 0.26);
      }
    } else if (t >= this.nextLmAt) {
      this.spawnLandmark(rand(1.4, 2.0));
      this.lmBorn = t;
    }

    // palette-derived feature colors
    const top = th.colors[this.palN - 1];
    const acc = th.accent;
    const lmR_ = top[0] * 0.65 + acc[0] * 0.35;
    const lmG_ = top[1] * 0.65 + acc[1] * 0.35;
    const lmB_ = top[2] * 0.65 + acc[2] * 0.35;
    const flLum = (acc[0] + acc[1] + acc[2] + top[0] + top[1] + top[2]) / 6;
    const flR = ((acc[0] + top[0]) * 0.5 * 0.4 + flLum * 0.6) * 2.4;
    const flG = ((acc[1] + top[1]) * 0.5 * 0.4 + flLum * 0.6) * 2.4;
    const flB = ((acc[2] + top[2]) * 0.5 * 0.4 + flLum * 0.6) * 2.4;

    // =========================================================================
    // Render
    // =========================================================================
    const neb = this.neb;
    const nebSkip = this.drawStride >= 4 && (ctx.frame & 1) === 1 && flash < 0.02 && !this.nebFresh;
    if (!nebSkip) {
      this.nebFresh = false;
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, neb.fbo);
      gl.viewport(0, 0, neb.w, neb.h);
      gl.useProgram(this.nebProg);
      const nu = this.nebU!;
      nu.setMat3('uInvView', this.mInv);
      nu.set2f('uTanFov', tanH * aspect, tanH);
      nu.set3f('uOff1', this.off1x, this.off1y, this.off1z);
      nu.set3f('uOff2', this.off2x, this.off2y, this.off2z);
      nu.set1f('uBand', this.band % 1);
      nu.set1f('uDensity', this.nebulaP * (1 + 1.1 * afterglow));
      nu.set3fv('uColors[0]', this.colorBuf);
      nu.set1i('uNumColors', this.palN);
      drawFullscreen(gl);
    }

    // background composite into the HDR scene
    this.post.begin(); // scene FBO + viewport + blend off
    gl.useProgram(this.bgProg);
    const bu = this.bgU!;
    bu.setTexture('uNebula', neb.tex, 0);
    bu.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    bu.set4f('uLm', lmU, lmV, lmI, lmR);
    bu.set3f('uLmCol', lmR_, lmG_, lmB_);
    bu.set1f('uFlash', flash * 4.2);
    bu.set3f('uFlashCol', flR, flG, flB);
    bu.set2f('uAspect', aspect, 1);
    drawFullscreen(gl);

    // stars — additive into RGBA16F (allowed; never into RGBA32F)
    const drawCount = Math.ceil(this.count / this.drawStride);
    const bright = 1.15 * this.drawStride;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.vao);

    gl.useProgram(this.pointProg);
    const pu = this.pointU!;
    pu.setTexture('uStars', this.starTex, 0);
    pu.set1i('uSide', this.side);
    pu.set1i('uStride', this.drawStride);
    pu.setMat3('uView', this.mView);
    pu.set3f('uCamPos', this.camX, this.camY, this.camZ);
    pu.set2f('uProj', fx, f);
    pu.set1f('uFpx', fpx);
    pu.set1f('uNear', NEAR);
    pu.set1f('uBright', bright);
    pu.set1f('uTime', t);
    pu.set3fv('uColors[0]', this.colorBuf);
    pu.set1i('uNumColors', this.palN);
    gl.drawArrays(gl.POINTS, 0, drawCount);

    if (spd * delta > 0.0003) {
      gl.useProgram(this.lineProg);
      const lu = this.lineU!;
      lu.setTexture('uStars', this.starTex, 0);
      lu.set1i('uSide', this.side);
      lu.set1i('uStride', this.drawStride);
      lu.setMat3('uView', this.mView);
      lu.setMat3('uViewPrev', this.mViewPrev);
      lu.set3f('uCamPos', this.camX, this.camY, this.camZ);
      lu.set3f('uCamDelta', vx * delta, vy * delta, vz * delta);
      lu.set2f('uProj', fx, f);
      lu.set1f('uFpx', fpx);
      lu.set1f('uNear', NEAR);
      lu.set1f('uBright', bright * 0.8);
      lu.set1f('uTime', t);
      lu.set2f('uRes', this.sceneW, this.sceneH);
      lu.set3fv('uColors[0]', this.colorBuf);
      lu.set1i('uNumColors', this.palN);
      gl.drawArrays(gl.LINES, 0, drawCount * 2);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    this.post.end({
      exposure: 1.15 + 0.25 * afterglow,
      bloom: 0.55 + 0.5 * Math.min(1, flash),
      vignette: 0.30,
    });

    // canonical GL state (post.end already left FBO=null, activeTexture=0)
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const prog of [this.pointProg, this.lineProg, this.nebProg, this.bgProg]) {
      if (prog) gl.deleteProgram(prog);
    }
    this.pointProg = this.lineProg = this.nebProg = this.bgProg = null;
    this.pointU = this.lineU = this.nebU = this.bgU = null;
    if (this.starTex) gl.deleteTexture(this.starTex);
    this.starTex = null;
    if (this.neb) {
      gl.deleteTexture(this.neb.tex);
      gl.deleteFramebuffer(this.neb.fbo);
      this.neb = null;
    }
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    this.post?.destroy();
    this.post = null;
  }
}

export const driftMode: Mode = new DriftMode();
