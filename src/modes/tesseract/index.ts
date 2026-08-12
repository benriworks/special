/**
 * TESSERACT — 追憶. The Interstellar tesseract: an infinite rectilinear
 * lattice of glowing cells holding THE VISITOR'S OWN PAST — frames the engine
 * quietly captured while the other modes ran (ctx.memory atlas).
 *
 * Composition: the camera drifts forever down a one-point-perspective corridor
 * of a full 3D lattice. Cell quads live on two families of infinite planes —
 * vertical "walls" (normal X) and horizontal "floors/ceilings" (normal Y) —
 * spaced S apart with cell pitch P (S = 3P), so corridors run along every
 * axis and cross-corridors show through the gaps between cells. Everything is
 * generated in the vertex shader from gl_InstanceID (no per-instance buffers):
 * world-indexed cells windowed around the camera, faded at the window edges,
 * fog-culled to degenerate triangles when invisible.
 *
 * Cell faces: a hash picks a memory slot (4-cell runs along Z repeat the same
 * moment — repeated instants, tesseract-style); valid slots show the atlas
 * frame re-dyed toward the theme palette, framed by a glowing border, with
 * projection flicker + scanline shimmer; newer slots (stamp math) glow
 * brighter and warmer. Cells whose slot doesn't exist yet render procedural
 * palette auroras — the space is beautiful before it has memories, and
 * memories blend in as the atlas fills. Light filaments (gl.LINES, also
 * bufferless) trace the shelf lines to the vanishing point plus sparse
 * vertical strings across the home corridor, with luminance dashes drifting
 * along them.
 *
 * Motion: perpetual forward drift; pointer steers eased yaw/pitch (gentler
 * than drift) + a small lateral lean; HOLD accelerates modestly and cells
 * near the pointer ease toward the camera and brighten (peering into a
 * memory). Pulse = GRAVITY WAVE: a luminous band propagates outward through
 * the lattice from the camera over ~1.5s — cells flash and displace radially,
 * filaments surge, then settle. Idle: drift + shimmer + filament travel + a
 * spontaneous faint ripple every ~40s. Audio (guarded): filament brightness,
 * cell shimmer on highs, bass attacks fire faint ripples.
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, makeTexture, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { BeatDetector } from '../../core/audio';
import { mixThemes } from '../../core/themes';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const P = 0.8;                // cell pitch (lattice unit)
const S = 2.4;                // plane spacing = 3P → corridors 3 cells wide
const CELL = 0.62;            // quad edge (0.775 fill, gaps reveal depth)
const NEAR = 0.06;
const FAR = 60.0;
const TAN_HALF_FOV = 0.78;
const BASE_SPEED = 0.45;      // units/s at speed=1
const WRAP_Z = 256 * P;       // camera z wraps here (hash period along z)
const WAVE_V = 7.5;           // gravity-wave front speed, units/s
const WAVE_W = 1.1;           // gravity-wave band width
const YAW0 = Math.PI;         // basis yaw for travel along +Z

const ZA = -(FAR + NEAR) / (FAR - NEAR);
const ZB = -(2 * FAR * NEAR) / (FAR - NEAR);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const fmt = (n: number) => n.toFixed(6);

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

const WAVE_GLSL = `
uniform vec4 uWaves[3];   // xyz world origin, w birth (shader time; -1e3 idle)
uniform vec3 uWaveAmp;
float waveAt(vec3 p, float time) {
  float w = 0.0;
  for (int i = 0; i < 3; i++) {
    float wt = time - uWaves[i].w;
    if (wt >= 0.0 && wt < 3.5) {
      float wd = length(p - uWaves[i].xyz);
      w += exp(-pow((wd - wt * ${fmt(WAVE_V)}) / ${fmt(WAVE_W)}, 2.0)) * uWaveAmp[i] * exp(-wt * 0.7);
    }
  }
  return w;
}
`;

/** Instanced cell quads — all placement math from gl_InstanceID/gl_VertexID. */
const CELL_VS = `#version 300 es
precision highp float;
uniform mat3 uView;
uniform vec3 uCamPos;
uniform vec4 uProj;       // fx, f, zA, zB
uniform float uTime;
uniform int uNY;          // transverse cells per plane
uniform int uNZ;          // depth cells
uniform int uIx0;
uniform int uIy0;
uniform int uIz0;
uniform int uUsed;
uniform int uStamp;
uniform vec3 uPtr;        // pointer ndc x, y, aspect
uniform vec2 uPeer;       // x = held peer envelope, y = hover base
uniform float uFog;
uniform float uBright;
uniform float uFpx;       // f * sceneH/2 — px per unit slope
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uAccent;
${WAVE_GLSL}
out vec2 vUv;
out vec2 vSlotBase;
out vec3 vTintA;          // memory dye / aurora low
out vec3 vTintB;          // aurora high
out vec3 vEdge;           // frame border color
out vec4 vMisc;           // bright, wave, memFlag, cellHash
out float vPx;            // projected cell size in px
out float vBorderB;       // border brightness (persists deeper than images)
const float P = ${fmt(P)};
const float S = ${fmt(S)};
const float HS = ${fmt(S / 2)};
const float CELL = ${fmt(CELL)};
${PAL}
float h1(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  int per = 4 * uNY * uNZ;
  int id = gl_InstanceID;
  int ori = id / per;                  // 0 = walls (normal X), 1 = floors (normal Y)
  int r = id - ori * per;
  int k = r / (uNY * uNZ);             // slab 0..3 → plane k-2
  int r2 = r - k * (uNY * uNZ);
  int it = r2 / uNZ;
  int iz = r2 - it * uNZ;
  int izW = uIz0 + iz;
  int izm = izW & 255;
  int runW = izm >> 2;                 // 4-cell runs repeat one moment

  float planeC = HS + float(k - 2) * S;
  int transW = (ori == 0 ? uIy0 : uIx0) + it;
  vec3 center = (ori == 0)
    ? vec3(planeC, (float(transW) + 0.5) * P, (float(izW) + 0.5) * P)
    : vec3((float(transW) + 0.5) * P, planeC, (float(izW) + 0.5) * P);

  // world-indexed hashes — camera-motion invariant
  float hRun = h1(dot(vec3(float(ori * 4 + k), float(transW), float(runW)), vec3(127.1, 311.7, 74.7)));
  float hCell = h1(dot(vec3(float(ori * 4 + k), float(transW), float(izm)), vec3(269.5, 183.3, 246.1)));
  float h2 = h1(hRun * 291.7 + 7.3);

  // memory slot pick: hash → 0..15; invalid picks get a second chance onto an
  // existing slot, so memories progressively take over as the atlas fills
  int slot = int(hRun * 15.999);
  if (uUsed > 0 && slot >= uUsed && h1(hRun * 913.7) < 0.55) slot = slot % uUsed;
  bool isMem = uUsed > 0 && slot < uUsed;
  float age = uStamp > 0 ? mod(float(uStamp - 1 - slot), 16.0) / 15.0 : 0.5;
  vSlotBase = vec2(float(slot & 3), float(slot >> 2)) * 0.25;

  vec3 dye = mix(pal(0.42 + 0.42 * h2), uAccent, 0.30 * (1.0 - age));
  vTintA = isMem ? dye : pal(0.20 + 0.45 * h2);
  vTintB = pal(0.55 + 0.42 * h1(h2 * 77.7 + 1.9));
  vEdge = mix(pal(0.80), uAccent, isMem ? 0.30 + 0.30 * (1.0 - age) : 0.22);

  // window-edge fades — enumeration bounds never pop
  float tv = (ori == 0) ? center.y - uCamPos.y : center.x - uCamPos.x;
  float halfWin = float(uNY) * P * 0.5;
  float tFade = 1.0 - smoothstep(halfWin - 1.4, halfWin - 0.3, abs(tv));
  float zSpan = float(uNZ) * P;
  float zFade = 1.0 - smoothstep(zSpan - 2.2, zSpan - 0.6, center.z - uCamPos.z);

  vec3 relC = center - uCamPos;
  float dist = max(length(relC), 0.001);
  float facing = abs(ori == 0 ? relC.x : relC.y) / dist;
  float angleF = mix(0.5, 1.0, facing);
  // exp fog + inverse-square-ish falloff: tames the additive pile-up of the
  // many far cells that project near the vanishing point. Borders decay
  // slower — the skeletal lattice recedes visibly deeper than the images.
  float fogF = exp(-dist * uFog) / (1.0 + dist * dist * 0.055);
  float fogB = exp(-dist * uFog * 0.58) / (1.0 + dist * dist * 0.018);
  float nearF = smoothstep(0.35, 0.95, dist); // cells melt away as they pass

  // hold-to-peer: screen proximity → the cell eases toward the camera
  float prox = 0.0;
  vec3 vC = uView * relC;
  if (vC.z < -0.5) {
    vec2 nd = vC.xy * uProj.xy / -vC.z;
    vec2 pd = (nd - uPtr.xy) * vec2(uPtr.z, 1.0);
    prox = exp(-dot(pd, pd) * 16.0) * smoothstep(0.9, 1.6, dist) * (1.0 - smoothstep(4.5, 7.5, dist));
  }
  float peerW = prox * uPeer.x;
  center += (uCamPos - center) * (0.48 * peerW);

  // gravity wave: luminous band + radial displacement (the "STAY" moment)
  float wave = waveAt(center, uTime);
  for (int i = 0; i < 3; i++) {
    float wt = uTime - uWaves[i].w;
    if (wt >= 0.0 && wt < 3.5) {
      vec3 wd = center - uWaves[i].xyz;
      float wdist = max(length(wd), 0.1);
      float band = exp(-pow((wdist - wt * ${fmt(WAVE_V)}) / ${fmt(WAVE_W)}, 2.0)) * uWaveAmp[i] * exp(-wt * 0.7);
      center += wd * (band * 0.30 / wdist);
    }
  }

  float ageB = isMem ? (1.28 - 0.42 * age) * 1.25 : 0.85; // recent past glows brighter
  float shared = uBright * tFade * zFade * angleF * nearF
               * (1.0 + (uPeer.y + 2.4 * uPeer.x) * prox);
  float bright = shared * fogF * ageB;
  vBorderB = shared * fogB;

  if (bright < 0.004 && vBorderB < 0.006 && wave < 0.01) { // fog-cull invisible cells
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vUv = vec2(0.0); vMisc = vec4(0.0); vPx = 0.0; vBorderB = 0.0;
    return;
  }

  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  float side = (ori == 0) ? step(planeC, uCamPos.x) : step(planeC, uCamPos.y);
  vec3 axV = (ori == 0) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 wpos = center + vec3(0.0, 0.0, 1.0) * ((corner.x - 0.5) * CELL)
                     + axV * ((corner.y - 0.5) * CELL);
  vUv = vec2(mix(corner.x, 1.0 - corner.x, side), corner.y);
  vPx = CELL * uFpx / dist;
  vMisc = vec4(bright, wave, isMem ? 1.0 : 0.0, hCell);

  vec3 v = uView * (wpos - uCamPos);
  gl_Position = vec4(v.x * uProj.x, v.y * uProj.y, ${fmt(ZA)} * v.z + ${fmt(ZB)}, -v.z);
}
`;

const CELL_FS = `#version 300 es
precision highp float;
uniform sampler2D uMem;
uniform float uTime;
uniform float uShim;       // audio-high shimmer boost (0 without audio)
in vec2 vUv;
in vec2 vSlotBase;
in vec3 vTintA;
in vec3 vTintB;
in vec3 vEdge;
in vec4 vMisc;
in float vPx;
in float vBorderB;
out vec4 outColor;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float bright = vMisc.x;
  float wave = vMisc.y;
  float hz = vMisc.w;
  vec2 b = min(vUv, 1.0 - vUv);
  float eb = min(b.x, b.y);
  float aa = clamp(fwidth(eb) * 1.2, 0.004, 0.12);
  float outerA = smoothstep(0.0, 0.02 + aa, eb);
  float border = 1.0 - smoothstep(0.10, 0.16 + aa, eb);   // the lattice light-lines
  float interior = smoothstep(0.08, 0.17, eb);
  vec2 c = vUv - 0.5;
  float vig = 1.0 - smoothstep(0.12, 0.55, dot(c, c) * 2.4);
  vec3 content;
  if (vMisc.z > 0.5) {
    // a remembered frame, re-dyed toward the theme, vignetted into its frame
    vec2 iuv = vSlotBase + (vec2(0.07) + vUv * 0.86) * 0.25;
    vec3 m = texture(uMem, iuv).rgb;
    m *= m;                                    // captured sRGB-ish → linear-ish
    float lum = dot(m, vec3(0.35, 0.5, 0.15));
    content = mix(m * 3.2, vTintA * (lum * 2.8 + 0.02), 0.34);
    content *= 0.45 + 0.65 * vig;
  } else {
    // procedural aurora — the space is beautiful before it has memories
    vec2 q = vUv * vec2(2.3, 1.8) + hz * 43.0;
    float n1 = vn(q + vec2(uTime * 0.045, uTime * 0.016));
    float n2 = vn(q * 2.13 - vec2(0.0, uTime * 0.028));
    float band = vUv.y - 0.5 + (n1 - 0.5) * 0.62 + (n2 - 0.5) * 0.24;
    vec3 aur = mix(vTintA, vTintB, smoothstep(-0.42, 0.42, band));
    aur += vEdge * (exp(-band * band * 9.0) * 0.5);
    content = aur * (0.26 + 0.55 * n1) * (0.35 + 0.65 * vig);
  }
  float scan = 1.0 + 0.05 * sin(vUv.y * 64.0 + uTime * 2.1 + hz * 31.0);
  float flick = 1.0 + (0.055 + uShim) * sin(uTime * (5.0 + 7.0 * hz) + hz * 61.0);
  float borderGain = smoothstep(1.5, 5.0, vPx);      // tiny far cells: no border fizz
  float sizeDim = mix(0.30, 1.0, clamp(vPx / 22.0, 0.0, 1.0));
  vec3 col = content * (interior * scan * flick * (0.8 + 0.9 * wave) * bright)
           + vEdge * (border * borderGain * (0.85 + 3.2 * wave) * vBorderB)
           + mix(vTintA, vEdge, 0.5) * (wave * 1.3 * vBorderB);
  outColor = vec4(col * (sizeDim * outerA), 1.0);
}
`;

/** Bufferless light filaments: shelf lines to the vanishing point + strings. */
const LINE_VS = `#version 300 es
precision highp float;
uniform mat3 uView;
uniform vec3 uCamPos;
uniform vec4 uProj;
uniform float uTime;
uniform int uNB;          // boundary lines per plane (NY+1)
uniform int uNZ;
uniform int uLongSegs;    // total longitudinal segments
uniform int uIx0;
uniform int uIy0;
uniform int uIz0;
uniform float uFog;
uniform float uFil;       // 輝線 density knob
uniform float uFilB;      // brightness (incl. audio)
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uAccent;
${WAVE_GLSL}
out vec3 vCol;
const float P = ${fmt(P)};
const float S = ${fmt(S)};
const float HS = ${fmt(S / 2)};
${PAL}
float h1(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  int sid = gl_VertexID >> 1;
  float end = float(gl_VertexID & 1);
  vec3 pos;
  float along;
  float weight;
  float hL;
  float edgeFade = 1.0;
  if (sid < uLongSegs) {
    // shelf lines receding to the vanishing point
    int line = sid / uNZ;
    int seg = sid - line * uNZ;
    int ori = line / (4 * uNB);
    int r = line - ori * 4 * uNB;
    int k = r / uNB;
    int ib = r - k * uNB;
    float planeC = HS + float(k - 2) * S;
    int bW = (ori == 0 ? uIy0 : uIx0) + ib;
    float bC = float(bW) * P;
    float z = float(uIz0 + seg) * P + end * P;
    pos = (ori == 0) ? vec3(planeC, bC, z) : vec3(bC, planeC, z);
    along = z;
    hL = h1(dot(vec2(float(ori * 4 + k), float(bW)), vec2(113.5, 271.9)));
    weight = (k == 1 || k == 2) ? 1.0 : 0.45;  // denser near the home corridor
    float tvd = abs(bC - (ori == 0 ? uCamPos.y : uCamPos.x));
    float halfWin = float(uNB - 1) * P * 0.5;
    edgeFade = 1.0 - smoothstep(halfWin - 1.4, halfWin - 0.3, tvd);
  } else {
    // sparse vertical strings crossing the home corridor (the strings Cooper touches)
    int s2 = sid - uLongSegs;
    int str = s2 >> 2;
    int seg = s2 & 3;
    int ixb = str / uNZ;
    int izI = str - ixb * uNZ;
    int izW = uIz0 + izI;
    float hs = h1(dot(vec2(float(ixb), float(izW & 255)), vec2(419.2, 371.9)));
    float exist = step(hs, 0.16);
    pos = vec3(float(ixb - 1) * P, -HS + (float(seg) + end) * (S / 4.0), float(izW) * P);
    along = pos.y;
    weight = 0.85 * exist;
    hL = h1(hs * 191.3 + 3.7);
  }
  weight *= step(h1(hL * 57.1 + 11.3), clamp(uFil * 1.35, 0.0, 1.0));

  vec3 rel = pos - uCamPos;
  float dist = max(length(rel), 0.001);
  float fogF = exp(-dist * uFog * 0.62) / (1.0 + dist * dist * 0.022);
  float zSpan = float(uNZ) * P;
  float zFade = 1.0 - smoothstep(zSpan - 2.2, zSpan - 0.6, pos.z - uCamPos.z);
  // slow luminance travel: soft dashes drifting forward along each line
  float dash = 0.3 + 0.7 * exp(-pow((fract(along * 0.38 - uTime * 0.45 + hL * 9.0) - 0.5) * 3.2, 2.0));
  float wave = waveAt(pos, uTime);
  vCol = mix(pal(0.5 + 0.45 * hL), uAccent, 0.35)
       * (uFilB * weight * fogF * zFade * edgeFade * dash * (1.0 + 4.0 * wave));
  vec3 v = uView * rel;
  gl_Position = vec4(v.x * uProj.x, v.y * uProj.y, ${fmt(ZA)} * v.z + ${fmt(ZB)}, -v.z);
}
`;

const LINE_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
out vec4 outColor;
void main() { outColor = vec4(vCol, 1.0); }
`;

/** Deep-fog background + breathing glow at the corridor's vanishing point. */
const BG_FS = `#version 300 es
precision highp float;
uniform vec3 uBg;
uniform vec3 uHaze;
uniform vec3 uVpCol;
uniform vec3 uVp;        // ndc x, y, intensity (0 when +Z is behind)
uniform float uAspect;
uniform float uWaveVis;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  vec2 d = (q - uVp.xy) * vec2(uAspect, 1.0);
  float r2 = dot(d, d);
  float g = exp(-r2 * 7.0);
  float g2 = exp(-r2 * 0.6);
  vec3 col = uBg * (0.85 + 0.15 * g2)
           + uHaze * (0.06 * g2)
           + uVpCol * (uVp.z * (0.20 * g + 0.025 * g2))
           + uVpCol * (uWaveVis * 0.08);
  outColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

class TesseractMode implements Mode {
  readonly id = 'tesseract';
  readonly name = { ja: '追憶', en: 'Tesseract' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '速度', en: 'Speed' }, type: 'range', min: 0.3, max: 2, step: 0.05, default: 0.8 },
    { key: 'fog', label: { ja: '霧', en: 'Depth' }, type: 'range', min: 0.5, max: 1.5, step: 0.05, default: 1 },
    { key: 'fil', label: { ja: '輝線', en: 'Filaments' }, type: 'range', min: 0, max: 1.5, step: 0.05, default: 1 },
  ];

  // live params (persist across quality re-inits — the instance survives)
  private speedP = 0.8;
  private fogP = 1;
  private filP = 1;

  // ---- camera state (persists across re-inits: no jump on tier change)
  private camZ = Math.random() * WRAP_Z;
  private camX = 0;
  private camY = 0;
  private yawOff = rand(-0.12, 0.12);
  private pitch = rand(-0.05, 0.05);
  private roll = 0;
  private yawRate = 0;
  private pitchRate = 0;
  private leanX = 0;
  private leanY = 0;
  private peerE = 0;
  private m1 = Math.random() * Math.PI * 2;
  private m2 = Math.random() * Math.PI * 2;
  private tOff = Math.random() * 120; // shader-time offset — variety on reload

  // rolled camera basis (rebuilt each frame, zero allocation)
  private fwX = 0; private fwY = 0; private fwZ = 1;
  private rX = -1; private rY = 0; private rZ = 0;
  private uX = 0; private uY = 1; private uZ = 0;

  // gravity waves: 3 slots of [x, y, z, birth(shader time)]
  private waveData = new Float32Array([0, 0, 0, -1e3, 0, 0, 0, -1e3, 0, 0, 0, -1e3]);
  private waveAmp = new Float32Array(3);
  private waveIdx = 0;
  private nextRippleAt = -1;
  private lastAudioWaveAt = -1e3;
  private beat = new BeatDetector();

  // ---- tier / targets
  private softGL = false;
  private NY = 8;
  private NZbase = 14;
  private NZdyn = 14;
  private sceneScale = 0.7;
  private sceneW = 1;
  private sceneH = 1;

  // wall-clock governor (drift's scheme — rAF dt can be virtualised)
  private level = 0;          // 0 full, 1 shorter corridor, 2 desperate
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1;

  // GL resources
  private cellProg: WebGLProgram | null = null;
  private lineProg: WebGLProgram | null = null;
  private bgProg: WebGLProgram | null = null;
  private cellU: UniformSetter | null = null;
  private lineU: UniformSetter | null = null;
  private bgU: UniformSetter | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private fallbackTex: WebGLTexture | null = null; // bound while the atlas is null
  private post: Post | null = null;

  // scratch (reused — zero per-frame allocation)
  private colorBuf = new Float32Array(18);
  private mView = new Float32Array(9);
  private palN = 5;

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    const q = ctx.quality;
    this.NY = q >= 0.9 ? 10 : 8;
    this.NZbase = q >= 0.9 ? 22 : q >= 0.6 ? 18 : 14;
    if (this.softGL) {
      this.NY = Math.max(6, this.NY - 2);
      this.NZbase = Math.max(10, Math.round(this.NZbase * 0.8));
    }
    this.applyLevel(); // keep any prior governor level; recompute NZdyn
    this.sceneScale = q <= 0.5 ? 0.62 : Math.min(0.82, 0.5 + 0.4 * q);
    if (this.softGL) this.sceneScale = Math.min(this.sceneScale, 0.68);
    this.slowTime = 0;
    this.fastTime = 0;
    this.lastNowMs = -1; // don't count init cost as a frame

    this.cellProg = compileProgram(gl, CELL_VS, CELL_FS, 'tesseract.cells');
    this.lineProg = compileProgram(gl, LINE_VS, LINE_FS, 'tesseract.lines');
    this.bgProg = compileProgram(gl, FS_TRIANGLE_VS, BG_FS, 'tesseract.bg');
    this.cellU = new UniformSetter(gl, this.cellProg);
    this.lineU = new UniformSetter(gl, this.lineProg);
    this.bgU = new UniformSetter(gl, this.bgProg);
    this.vao = gl.createVertexArray();
    // 1×1 black stand-in so uMem always has a complete texture bound
    this.fallbackTex = makeTexture(gl, {
      w: 1, h: 1, internalFormat: gl.RGBA8, data: new Uint8Array([0, 0, 0, 255]),
    });

    this.sceneW = Math.max(1, Math.round(ctx.width * this.sceneScale));
    this.sceneH = Math.max(1, Math.round(ctx.height * this.sceneScale));
    this.post = createPost(gl, this.sceneW, this.sceneH);

    // pre-warm: camera is already mid-flight (fields persist / random start);
    // first spontaneous ripple lands within the first idle minute
    if (this.nextRippleAt < 0) this.nextRippleAt = this.tOff + ctx.time + rand(24, 40);
  }

  private applyLevel(): void {
    this.NZdyn = this.level === 0 ? this.NZbase
      : this.level === 1 ? Math.max(6, Math.round(this.NZbase * 0.72))
      : Math.max(6, Math.round(this.NZbase * 0.55));
  }

  /** (Re)size the HDR scene; the desperate governor level also shrinks it. */
  private layout(ctx: ModeContext): void {
    if (!this.post) return;
    const s = this.sceneScale * (this.level >= 2 ? 0.8 : 1);
    const w = Math.max(1, Math.round(ctx.width * s));
    const h = Math.max(1, Math.round(ctx.height * s));
    if (w !== this.sceneW || h !== this.sceneH) {
      this.sceneW = w;
      this.sceneH = h;
      this.post.resize(w, h);
    }
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (key === 'speed') this.speedP = clamp(v, 0.3, 2);
    else if (key === 'fog') this.fogP = clamp(v, 0.5, 1.5);
    else if (key === 'fil') this.filP = clamp(v, 0, 1.5);
  }

  // -------------------------------------------------------------------------

  /** Rolled orthonormal basis into fw/r/u fields (drift's idiom). */
  private computeBasis(yaw: number, pitch: number, roll: number): void {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = -sy * cp, fy = sp, fz = -cy * cp;
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    this.rX = rx * cr + ux * sr; this.rY = uy * sr; this.rZ = rz * cr + uz * sr;
    this.uX = ux * cr - rx * sr; this.uY = uy * cr; this.uZ = uz * cr - rz * sr;
    this.fwX = fx; this.fwY = fy; this.fwZ = fz;
  }

  /** Column-major world→view (rows: right, up, −forward). */
  private fillView(m: Float32Array): void {
    m[0] = this.rX; m[1] = this.uX; m[2] = -this.fwX;
    m[3] = this.rY; m[4] = this.uY; m[5] = -this.fwY;
    m[6] = this.rZ; m[7] = this.uZ; m[8] = -this.fwZ;
  }

  private buildColors(th: Theme): void {
    const n = Math.min(6, th.colors.length);
    this.palN = n;
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
  }

  private spawnWave(x: number, y: number, z: number, amp: number, time: number): void {
    const i = this.waveIdx;
    this.waveIdx = (i + 1) % 3;
    const o = i * 4;
    this.waveData[o] = x;
    this.waveData[o + 1] = y;
    this.waveData[o + 2] = z;
    this.waveData[o + 3] = time;
    this.waveAmp[i] = amp;
  }

  /** Wall-clock governor: shorten the corridor (and scene) under duress. */
  private governStride(): void {
    const now = performance.now();
    const real = this.lastNowMs < 0 ? 1 / 60 : Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.045) {
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.35 && this.level < 2) {
        this.level = Math.min(2, this.level + (this.frameEma > 0.075 ? 2 : 1));
        this.slowTime = 0;
        this.applyLevel();
      }
    } else if (this.frameEma < 0.022) {
      this.fastTime += real;
      this.slowTime = 0;
      if (this.fastTime > 6 && this.level > 0) {
        this.level--;
        this.fastTime = 0;
        this.applyLevel();
      }
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
  }

  // -------------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.post || !this.cellProg || !this.lineProg || !this.bgProg) return;
    this.governStride();
    this.layout(ctx);
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    this.buildColors(th);
    const dt = ctx.dt;
    const tt = this.tOff + ctx.time; // shader time (waves stored in this clock)

    // ---- audio (null ⇒ every factor exactly neutral, no state advances)
    const au = ctx.audio;
    const aFil = au ? 1 + 0.4 * au.level : 1;
    const aShim = au ? 0.10 * au.high : 0;
    if (au && this.beat.update(au.low, ctx.time, dt) && tt - this.lastAudioWaveAt > 2.2) {
      this.lastAudioWaveAt = tt;
      this.spawnWave(this.camX, this.camY, this.camZ + 0.8, 0.45, tt);
    }

    // ---- pulse = gravity wave; idle gets a spontaneous faint ripple
    if (ctx.pulse) this.spawnWave(this.camX, this.camY, this.camZ + 1.0, 1.0, tt);
    if (tt >= this.nextRippleAt) {
      this.spawnWave(this.camX, this.camY, this.camZ + 2.2, 0.32, tt);
      this.nextRippleAt = tt + rand(34, 52);
    }
    let waveVis = 0;
    for (let i = 0; i < 3; i++) {
      const wt = tt - this.waveData[i * 4 + 3];
      if (wt >= 0 && wt < 3.5) waveVis += this.waveAmp[i] * Math.exp(-wt * 0.7);
    }
    waveVis = Math.min(waveVis, 1.2);

    // ---- pointer → gentle steering + hold-to-peer (GL-oriented, same-frame)
    const p = ctx.pointer;
    let steer = false;
    let sx = 0;
    let sy = 0;
    if (p.touches.length > 0) {
      let ax = 0, ay = 0;
      for (const tc of p.touches) { ax += tc.x; ay += tc.y; }
      ax /= p.touches.length * ctx.width;
      ay /= p.touches.length * ctx.height;
      sx = clamp(ax * 2 - 1, -1, 1);
      sy = clamp(ay * 2 - 1, -1, 1);
      steer = true;
    } else if (p.down) {
      sx = clamp(p.nx * 2 - 1, -1, 1);
      sy = clamp(p.ny * 2 - 1, -1, 1);
      steer = true;
    }
    const held = steer;
    this.peerE += ((held ? 1 : 0) - this.peerE) * (1 - Math.exp(-dt * (held ? 4 : 2.2)));

    // contemplative heading: soft rates held, slow recenter + meander idle
    let tYaw: number;
    let tPitch: number;
    let kR: number;
    if (steer) {
      tYaw = -sx * Math.abs(sx) * 0.34;
      tPitch = sy * Math.abs(sy) * 0.26;
      kR = 3.5;
    } else {
      tYaw = -this.yawOff * 0.10 + 0.030 * Math.sin(ctx.time * 0.05 + this.m1);
      tPitch = -this.pitch * 0.14 + 0.022 * Math.sin(ctx.time * 0.043 + this.m2);
      kR = 0.9;
    }
    const eR = 1 - Math.exp(-dt * kR);
    this.yawRate += (tYaw - this.yawRate) * eR;
    this.pitchRate += (tPitch - this.pitchRate) * eR;
    this.yawOff = clamp(this.yawOff + this.yawRate * dt, -1.15, 1.15);
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -0.7, 0.7);
    this.roll += (-this.yawRate * 0.15 - this.roll) * (1 - Math.exp(-dt * 3));

    // lateral lean inside the corridor + perpetual sway
    const eL = 1 - Math.exp(-dt * 1.8);
    this.leanX += ((steer ? sx * 0.22 : 0) - this.leanX) * eL;
    this.leanY += ((steer ? sy * 0.18 : 0) - this.leanY) * eL;
    this.camX = 0.38 * Math.sin(ctx.time * 0.059 + this.m1) + this.leanX;
    this.camY = 0.30 * Math.sin(ctx.time * 0.047 + this.m2) + this.leanY;

    // forward drift (hold accelerates modestly); wrap keeps precision pristine
    const spd = BASE_SPEED * this.speedP * (1 + 0.85 * this.peerE);
    const prevZ = this.camZ;
    this.camZ = (this.camZ + spd * dt) % WRAP_Z;
    if (this.camZ < prevZ) { // wrapped: shift live wave origins with the camera
      for (let i = 0; i < 3; i++) this.waveData[i * 4 + 2] -= WRAP_Z;
    }

    this.computeBasis(YAW0 + this.yawOff, this.pitch, this.roll);
    this.fillView(this.mView);

    // ---- projection + windows
    const aspect = this.sceneW / Math.max(1, this.sceneH);
    const f = 1 / TAN_HALF_FOV;
    const fx = f / aspect;
    const fpx = f * this.sceneH * 0.5;
    const NY = this.NY;
    const NZ = this.NZdyn;
    const ix0 = Math.floor(this.camX / P) - (NY >> 1);
    const iy0 = Math.floor(this.camY / P) - (NY >> 1);
    const iz0 = Math.floor(this.camZ / P) - 1;
    const instances = 2 * 4 * NY * NZ;
    const NB = NY + 1;
    const longSegs = 2 * 4 * NB * NZ;
    const lineVerts = (longSegs + 3 * NZ * 4) * 2;
    const fog = (5.2 / (NZ * P)) * this.fogP;

    // vanishing point: world +Z projected (third view column)
    const vpx = this.mView[6];
    const vpy = this.mView[7];
    const vpz = this.mView[8];
    let vpU = 0, vpV = 0, vpI = 0;
    if (vpz < -0.1) {
      vpU = (vpx * fx) / -vpz;
      vpV = (vpy * f) / -vpz;
      vpI = clamp(-vpz, 0, 1) * (0.55 + 0.15 * Math.sin(tt * 0.5));
    }

    // palette-derived feature colors
    const bg = th.background;
    const c1 = th.colors[Math.min(1, this.palN - 1)];
    const top = th.colors[this.palN - 1];
    const acc = th.accent;
    const hzR = bg[0] * 0.55 + c1[0] * 0.45;
    const hzG = bg[1] * 0.55 + c1[1] * 0.45;
    const hzB = bg[2] * 0.55 + c1[2] * 0.45;
    const vpR = c1[0] * 0.65 + acc[0] * 0.35;
    const vpG = c1[1] * 0.65 + acc[1] * 0.35;
    const vpB = c1[2] * 0.65 + acc[2] * 0.35;

    // memory atlas view (engine-owned; bind-only, filters untouched)
    const mem = ctx.memory;
    const hasMem = !!(mem && mem.used > 0);

    // =========================================================================
    // Render
    // =========================================================================
    this.post.begin(); // scene FBO + viewport + blend off

    gl.useProgram(this.bgProg);
    const bu = this.bgU!;
    bu.set3f('uBg', bg[0], bg[1], bg[2]);
    bu.set3f('uHaze', hzR, hzG, hzB);
    bu.set3f('uVpCol', vpR, vpG, vpB);
    bu.set3f('uVp', vpU, vpV, vpI);
    bu.set1f('uAspect', aspect);
    bu.set1f('uWaveVis', waveVis);
    drawFullscreen(gl);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive into RGBA16F (allowed; never 32F)
    gl.bindVertexArray(this.vao);

    gl.useProgram(this.cellProg);
    const cu = this.cellU!;
    cu.setMat3('uView', this.mView);
    cu.set3f('uCamPos', this.camX, this.camY, this.camZ);
    cu.set4f('uProj', fx, f, 0, 0); // zA/zB baked into the shader
    cu.set1f('uTime', tt);
    cu.set1i('uNY', NY);
    cu.set1i('uNZ', NZ);
    cu.set1i('uIx0', ix0);
    cu.set1i('uIy0', iy0);
    cu.set1i('uIz0', iz0);
    cu.set1i('uUsed', hasMem ? mem!.used : 0);
    cu.set1i('uStamp', hasMem ? mem!.stamp : 0);
    cu.setTexture('uMem', hasMem ? mem!.texture : this.fallbackTex!, 0);
    cu.set3f('uPtr', p.nx * 2 - 1, p.ny * 2 - 1, aspect);
    cu.set2f('uPeer', this.peerE, 0);
    cu.set1f('uFog', fog);
    cu.set1f('uBright', 1.0);
    cu.set1f('uFpx', fpx);
    cu.set4fv('uWaves[0]', this.waveData);
    cu.set3f('uWaveAmp', this.waveAmp[0], this.waveAmp[1], this.waveAmp[2]);
    cu.set3fv('uColors[0]', this.colorBuf);
    cu.set1i('uNumColors', this.palN);
    cu.set3f('uAccent', acc[0], acc[1], acc[2]);
    cu.set1f('uShim', aShim);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances);

    if (this.filP > 0.001) {
      gl.useProgram(this.lineProg);
      const lu = this.lineU!;
      lu.setMat3('uView', this.mView);
      lu.set3f('uCamPos', this.camX, this.camY, this.camZ);
      lu.set4f('uProj', fx, f, 0, 0);
      lu.set1f('uTime', tt);
      lu.set1i('uNB', NB);
      lu.set1i('uNZ', NZ);
      lu.set1i('uLongSegs', longSegs);
      lu.set1i('uIx0', ix0);
      lu.set1i('uIy0', iy0);
      lu.set1i('uIz0', iz0);
      lu.set1f('uFog', fog);
      lu.set1f('uFil', this.filP);
      lu.set1f('uFilB', 0.9 * this.filP * aFil);
      lu.set4fv('uWaves[0]', this.waveData);
      lu.set3f('uWaveAmp', this.waveAmp[0], this.waveAmp[1], this.waveAmp[2]);
      lu.set3fv('uColors[0]', this.colorBuf);
      lu.set1i('uNumColors', this.palN);
      lu.set3f('uAccent', acc[0], acc[1], acc[2]);
      gl.drawArrays(gl.LINES, 0, lineVerts);
    }

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    const wv = Math.min(waveVis, 1);
    this.post.end({
      exposure: 1.16 + 0.18 * wv,
      bloom: 0.45 + 0.3 * wv,
      vignette: 0.32,
    });

    // canonical GL state (post.end left FBO=null, activeTexture=0)
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const prog of [this.cellProg, this.lineProg, this.bgProg]) {
      if (prog) gl.deleteProgram(prog);
    }
    this.cellProg = this.lineProg = this.bgProg = null;
    this.cellU = this.lineU = this.bgU = null;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    if (this.fallbackTex) gl.deleteTexture(this.fallbackTex);
    this.fallbackTex = null; // the memory atlas is engine-owned — NEVER deleted here
    this.post?.destroy();
    this.post = null;
  }
}

export const tesseractMode: Mode = new TesseractMode();
