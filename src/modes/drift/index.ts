/**
 * DRIFT — 遊泳 / first-person voyage through a sea of stars.
 *
 * SCAFFOLD STUB — a single fullscreen fragment pass: three hash-based point-star
 * layers with parallax scroll (near = bigger + faster) over a slow-drifting fbm
 * haze, palette-colored, composited in HDR through post.ts. Pointer proximity
 * brightens the field; ctx.pulse fires a brief accent flash. The real mode
 * replaces the shader/body but must keep this exact plug-in surface.
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
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), w.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), w.x), w.y);
}
float fbm(vec2 p) {
  return 0.55 * vnoise(p) + 0.30 * vnoise(p * 2.13 + 5.2) + 0.15 * vnoise(p * 4.31 - 3.7);
}
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
/** One layer of hash point stars, scrolled by vel (parallax) with twinkle. */
float stars(vec2 p, float scale, vec2 vel, float seed) {
  vec2 q = p * scale + vel * uTime;
  vec2 cell = floor(q);
  float h = hash(cell + seed);
  vec2 sp = vec2(hash(cell + seed + 17.3), hash(cell + seed + 41.7)) * 0.7 + 0.15;
  float d = length(q - cell - sp);
  float tw = 0.65 + 0.35 * sin(uTime * (1.0 + 2.5 * h) + h * 47.0);
  float b = smoothstep(0.16, 0.0, d);
  return b * b * step(0.35, h) * tw;
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  // slow-drifting nebula haze — depth behind the stars, never a flat void
  float haze = fbm(p * 2.1 + vec2(uTime * 0.021, -uTime * 0.013));
  float tint = fbm(p * 4.4 - vec2(uTime * 0.015, uTime * 0.009) + 7.7);
  vec3 col = uBg * (0.55 + 0.65 * haze);
  col += pal(0.25 + 0.35 * tint) * haze * haze * 0.34;
  // three parallax layers: far/slow/dim → near/fast/bright (the voyage)
  vec2 dir = normalize(vec2(-0.86, -0.42));
  col += pal(0.55) * stars(p, 22.0, dir * 0.30, 3.1) * 0.55;
  col += pal(0.78) * stars(p, 13.0, dir * 0.46, 9.7) * 1.00;
  col += pal(0.97) * stars(p,  7.0, dir * 0.62, 5.3) * 1.55;
  // mild pointer reaction: the sea brightens near the hand
  vec2 pd = p - uPointer;
  float near = exp(-dot(pd, pd) * 16.0);
  col *= 1.0 + near * 0.9;
  col += uAccent * near * 0.14;
  // pulse: brief accent flash washing over the haze
  col += uAccent * uPulse * (0.5 + 0.7 * haze);
  outColor = vec4(col, 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class DriftMode implements Mode {
  readonly id = 'drift';
  readonly name = { ja: '遊泳', en: 'Drift' };

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private postScale = 0.7;
  private t0 = 0;
  private pulseAt = -100;
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, FS, 'drift.main');
    this.u = new UniformSetter(gl, this.prog);
    this.postScale = clamp(0.5 + 0.25 * ctx.quality, 0.5, 0.75);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    this.t0 = 40 + Math.random() * 400; // start mid-voyage — frame 1 already drifts
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
    this.post.end({ exposure: 1.15, bloom: 0.5, vignette: 0.3 });

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

export const driftMode: Mode = new DriftMode();
