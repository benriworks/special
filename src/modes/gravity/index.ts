/**
 * GRAVITY — 重力 / a Gargantua-style lensed black hole.
 *
 * SCAFFOLD STUB — a single fullscreen fragment pass: dark central shadow with a
 * tight photon ring (doppler-beamed to one side), a swirling accretion glow
 * falling off outward, and a faint lensed shimmer inside the shadow so the
 * center is never flat. Palette-colored, composited in HDR through post.ts.
 * Pointer proximity brightens; ctx.pulse fires a brief accent flash. The real
 * mode replaces the shader/body but must keep this exact plug-in surface.
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
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uNumColors - 1)], fract(x));
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  vec2 rel = p - vec2(0.5 * uAspect, 0.5);
  float r = length(rel);
  float ang = atan(rel.y, rel.x);

  // rotating swirl — matter dragged around the hole
  float sw = 0.62 * vnoise(vec2(ang * 2.5 + r * 9.0 - uTime * 0.55, r * 13.0 - uTime * 0.11))
           + 0.38 * vnoise(vec2(ang * 5.0 - r * 6.0 + uTime * 0.34, r * 21.0 + 3.7));

  float R = 0.16;                                    // shadow radius
  float outside = smoothstep(R * 0.74, R * 1.04, r); // 0 inside the shadow
  // photon ring, doppler-beamed: one side burns brighter, slowly precessing
  float ring = exp(-pow((r - R * 1.10) * 30.0, 2.0));
  ring *= 0.55 + 0.55 * sin(ang + uTime * 0.22);
  // accretion glow falling off outward, stirred by the swirl
  float glow = exp(-max(r - R, 0.0) * 5.0) * outside;

  vec3 col = uBg * (0.5 + 0.4 * sw) * outside;
  col += pal(0.30 + 0.32 * sw) * glow * (0.45 + 0.65 * sw);
  col += pal(0.92) * ring * 1.7;
  col += uAccent * ring * ring * 1.1;
  // faint lensed shimmer inside the shadow — dark, but alive, never flat
  float inside = 1.0 - outside;
  col += pal(0.18 + 0.2 * sw) * inside * (0.020 + 0.055 * sw);

  // mild pointer reaction: spacetime brightens near the hand
  vec2 pd = p - uPointer;
  float near = exp(-dot(pd, pd) * 16.0);
  col *= 1.0 + near * 0.9;
  col += uAccent * near * 0.14;
  // pulse: brief flash, strongest along the ring
  col += uAccent * uPulse * (0.35 + 1.6 * ring);
  outColor = vec4(col, 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class GravityMode implements Mode {
  readonly id = 'gravity';
  readonly name = { ja: '重力', en: 'Gravity' };

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private postScale = 0.7;
  private t0 = 0;
  private pulseAt = -100;
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, FS, 'gravity.main');
    this.u = new UniformSetter(gl, this.prog);
    this.postScale = clamp(0.5 + 0.25 * ctx.quality, 0.5, 0.75);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    this.t0 = 40 + Math.random() * 400; // start mid-orbit — frame 1 already swirls
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
    this.post.end({ exposure: 1.15, bloom: 0.55, vignette: 0.3 });

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

export const gravityMode: Mode = new GravityMode();
