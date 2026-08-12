/**
 * PREMIERE — 上映 / cinematic pre-show in a theater of light.
 *
 * SCAFFOLD STUB — a single fullscreen fragment pass: a dark void where a soft
 * horizontal light slit slowly breathes open into a glowing widescreen
 * rectangle (cheap 2D box-SDF glow — a distant screen in the darkness), with
 * faint hash-based dust specks drifting through the beam, composited in HDR
 * through post.ts. Pointer proximity brightens the dark; ctx.pulse fires a
 * brief accent flash. The real mode (projector beam, colossal screen,
 * countdown, session-memory premiere) replaces the shader/body but must keep
 * this exact plug-in surface.
 */

import type { Mode, ModeContext } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';

const FS = `#version 300 es
precision highp float;
uniform float uTime;
uniform float uAspect;
uniform vec2 uPointer;   // aspect-corrected uv: x in [0,aspect], y in [0,1]
uniform float uPulse;    // decaying flash envelope
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform vec3 uAccent;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
/** Signed distance to an axis-aligned box of half-size b centered at origin. */
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
/** One layer of drifting dust specks in the dark of the hall. */
float dust(vec2 p, float scale, vec2 vel, float seed) {
  vec2 q = p * scale + vel * uTime;
  vec2 cell = floor(q);
  float h = hash(cell + seed);
  vec2 sp = vec2(hash(cell + seed + 17.3), hash(cell + seed + 41.7)) * 0.7 + 0.15;
  float d = length(q - cell - sp);
  float tw = 0.6 + 0.4 * sin(uTime * (0.7 + 1.8 * h) + h * 47.0);
  float b = smoothstep(0.09, 0.0, d);
  return b * b * step(0.5, h) * tw;
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 c = vec2(uAspect * 0.5, 0.53); // the distant screen hangs slightly high
  // the slit breathes: a thin line of light slowly opening toward a screen
  float breath = 0.5 + 0.5 * sin(uTime * 0.16 - 1.2);
  breath = breath * breath * (3.0 - 2.0 * breath); // eased, lingers at the extremes
  float sw = min(uAspect, 1.5); // keep the screen distant on any viewport
  vec2 half_ = vec2(mix(0.10, 0.24, breath), mix(0.008, 0.135, breath)) * sw;
  float d = sdBox(p - c, half_);

  // dark void, barely lifted so the hall never reads as dead black
  vec3 col = uBg * 0.28;

  // soft SDF glow bleeding from the screen edge into the dark
  float glow = exp(-max(d, 0.0) * 10.0);
  col += pal(0.45) * glow * glow * 0.16 + uAccent * glow * 0.05;

  // the screen itself: warm interior wash, brighter toward its heart,
  // shimmering faintly as if light were already moving behind the curtain
  float inside = smoothstep(0.012, -0.012, d);
  float heart = exp(-dot(p - c, p - c) * 10.0);
  float shimmer = 0.85 + 0.15 * sin(p.y * 40.0 + uTime * 0.9) * sin(p.x * 9.0 - uTime * 0.5);
  col += (pal(0.68) * (0.30 + 0.25 * heart) + pal(0.92) * heart * 0.22) * inside * shimmer * (0.25 + 0.55 * breath);

  // faint dust drifting through the projector light, brighter near the screen
  float lit = 0.25 + 0.75 * glow;
  col += pal(0.85) * dust(p, 14.0, vec2(0.014, 0.006), 3.1) * 0.30 * lit;
  col += pal(0.60) * dust(p, 24.0, vec2(-0.010, 0.011), 9.7) * 0.18 * lit;

  // pointer: a hand raised in the dark gathers a little light
  vec2 pd = p - uPointer;
  float near = exp(-dot(pd, pd) * 16.0);
  col *= 1.0 + near * 0.8;
  col += uAccent * near * 0.12;

  // pulse: the projector flares — screen and glow flash together
  col += uAccent * uPulse * (0.35 + 0.9 * glow + 0.8 * inside);
  outColor = vec4(col, 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class PremiereMode implements Mode {
  readonly id = 'premiere';
  readonly name = { ja: '上映', en: 'Premiere' };

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private postScale = 0.7;
  private t0 = 0;
  private pulseAt = -100;
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, FS, 'premiere.main');
    this.u = new UniformSetter(gl, this.prog);
    this.postScale = clamp(0.5 + 0.25 * ctx.quality, 0.5, 0.75);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    this.t0 = 40 + Math.random() * 400; // start mid-breath — frame 1 already glows
    this.pulseAt = -100;
  }

  resize(ctx: ModeContext): void {
    this.post?.resize(
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
  }

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.prog || !this.u || !this.post) return;
    if (ctx.pulse) this.pulseAt = ctx.time;
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
    const aspect = ctx.width / Math.max(1, ctx.height);

    this.post.begin();
    gl.useProgram(this.prog);
    const u = this.u;
    u.set1f('uTime', this.t0 + ctx.time);
    u.set1f('uAspect', aspect);
    u.set2f('uPointer', ctx.pointer.nx * aspect, ctx.pointer.ny);
    u.set1f('uPulse', Math.exp(-(ctx.time - this.pulseAt) * 3.5));
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.15, bloom: 0.55, vignette: 0.35 });

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.prog = null;
    this.u = null;
    this.post?.destroy();
    this.post = null;
  }
}

export const premiereMode: Mode = new PremiereMode();
