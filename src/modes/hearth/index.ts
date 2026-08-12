/**
 * HEARTH — 暖炉 / a realistic fireplace fire.
 *
 * SCAFFOLD STUB — a single fullscreen fragment pass: a warm ember-glow
 * gradient rising from the bottom edge, breathing with slow fbm flicker
 * (banked coals), plus sparse spark specks drifting upward, palette-colored,
 * composited in HDR through post.ts. Pointer proximity brightens the glow;
 * ctx.pulse fires a brief surge (a log settling). The real mode replaces the
 * shader/body but must keep this exact plug-in surface.
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
/** Sparse hash-based spark specks; features drift with velocity -vel. */
float sparks(vec2 p, float scale, vec2 vel, float seed) {
  vec2 q = p * scale + vel * uTime;
  vec2 cell = floor(q);
  float h = hash(cell + seed);
  vec2 sp = vec2(hash(cell + seed + 17.3), hash(cell + seed + 41.7)) * 0.7 + 0.15;
  float d = length(q - cell - sp);
  float tw = 0.5 + 0.5 * sin(uTime * (3.0 + 5.0 * h) + h * 47.0);
  float b = smoothstep(0.10, 0.0, d);
  return b * b * step(0.82, h) * tw;
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float h = vUv.y;
  // slow fbm flicker — the breath of banked coals
  float fl = fbm(vec2(p.x * 2.3 + uTime * 0.06, h * 2.6 - uTime * 0.14));
  float fl2 = fbm(p * 4.7 + vec2(uTime * 0.04, -uTime * 0.23) + 9.1);
  float breathe = 0.82 + 0.18 * sin(uTime * 0.55 + fl * 6.28318);
  // warm glow rising from the bottom edge: soft column + hot coal core
  float bed = exp(-h * (3.3 + 1.6 * fl));
  float coals = exp(-h * (9.0 + 4.5 * fl2));
  vec3 col = uBg * (0.55 + 0.35 * fl);
  col += pal(0.55 + 0.25 * fl) * bed * breathe * 0.85;
  col += pal(0.88) * coals * (0.75 + 0.55 * fl2) * breathe;
  col += pal(1.0) * coals * coals * 0.9;
  // sparse spark specks drifting up out of the coals, fading with height
  float rise = 0.25 + exp(-h * 1.8);
  col += pal(0.95) * sparks(p, 9.0, vec2(0.05, -0.30), 3.1) * 1.3 * rise;
  col += uAccent * sparks(p, 5.0, vec2(-0.04, -0.52), 8.7) * 1.0 * rise;
  // pointer reaction: the fire brightens near the hand
  vec2 pd = p - uPointer;
  float near = exp(-dot(pd, pd) * 14.0);
  col *= 1.0 + near * 0.8;
  col += uAccent * near * 0.12;
  // pulse: a log settles — flame surges over the bed
  col += uAccent * uPulse * (0.35 + 0.85 * bed);
  outColor = vec4(col, 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class HearthMode implements Mode {
  readonly id = 'hearth';
  readonly name = { ja: '暖炉', en: 'Hearth' };

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private postScale = 0.7;
  private t0 = 0;
  private pulseAt = -100;
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, FS, 'hearth.main');
    this.u = new UniformSetter(gl, this.prog);
    this.postScale = clamp(0.5 + 0.25 * ctx.quality, 0.5, 0.75);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    this.t0 = 40 + Math.random() * 400; // the fire is already lit — frame 1 flickers
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
    this.post.end({ exposure: 1.15, bloom: 0.55, vignette: 0.32 });

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

export const hearthMode: Mode = new HearthMode();
