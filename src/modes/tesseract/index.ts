/**
 * TESSERACT — 追憶 / an infinite lattice holding the user's own past moments.
 *
 * SCAFFOLD STUB — a single fullscreen fragment pass: a drifting one-point-
 * perspective grid corridor (screen-space perspective lines, shimmering cell
 * panes, fog glow at the vanishing point), palette-colored, composited in HDR
 * through post.ts. Pointer proximity brightens the walls; ctx.pulse fires a
 * brief accent flash. The real mode replaces the shader/body — and will sample
 * ctx.memory (the engine's session-memory atlas: frames captured while the
 * other modes ran; null until the first capture) into the lattice cells — but
 * must keep this exact plug-in surface.
 */

import type { Mode, ModeContext } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';

const FS = `#version 300 es
precision highp float;
uniform float uTime;
uniform float uAspect;
uniform vec2 uPointer;   // centered, aspect-corrected: x in [-a/2,a/2], y in [-0.5,0.5]
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
void main() {
  // centered, aspect-corrected screen coords; the vanishing point drifts slowly
  vec2 q = vec2((vUv.x - 0.5) * uAspect, vUv.y - 0.5);
  vec2 vp = vec2(sin(uTime * 0.13), cos(uTime * 0.11)) * 0.05;
  vec2 p = q - vp;

  // one-point-perspective square corridor: box distance = wall proximity
  float box = max(abs(p.x), abs(p.y)) + 1e-4;
  float z = 1.0 / box;                    // depth into the corridor
  float trav = z * 0.9 + uTime * 0.55;    // forever drifting forward
  float wallU = abs(p.x) > abs(p.y) ? p.y / box : p.x / box; // along-wall coord [-1,1]
  float wid = abs(p.x) > abs(p.y) ? (p.x > 0.0 ? 0.0 : 1.0) : (p.y > 0.0 ? 2.0 : 3.0);

  float fog = exp(-z * 0.09);             // distance haze: far lattice dissolves
  float centerGlow = exp(-box * box * 60.0); // the luminous far end of the corridor

  // lattice lines: receding rungs (depth cells) + longitudinal seams (wall cells)
  float rung = 1.0 - abs(fract(trav) * 2.0 - 1.0);
  float rungs = smoothstep(0.86, 1.0, rung);
  float seam = 1.0 - abs(fract(wallU * 2.0 + 0.5) * 2.0 - 1.0);
  float seams = smoothstep(0.9, 1.0, seam);

  vec3 col = uBg * (0.3 + 0.3 * fog);
  col += pal(0.78) * rungs * fog * 0.7;
  col += pal(0.5) * seams * fog * 0.4;

  // cell panes shimmer faintly — placeholders for the remembered frames
  float h = hash(vec2(floor(trav) + wid * 61.0, floor(wallU * 2.0 + 0.5)));
  float shimmer = (0.45 + 0.55 * sin(uTime * (0.4 + h * 1.2) + h * 44.0)) * h;
  col += pal(0.3 + 0.5 * h) * (1.0 - rungs) * (1.0 - seams) * shimmer * fog * 0.1;

  // fog glow at the vanishing point, breathing slowly
  col += uAccent * centerGlow * (0.5 + 0.2 * sin(uTime * 0.6));

  // pointer reaction: the lattice brightens near the hand
  vec2 pd = q - uPointer;
  float nearP = exp(-dot(pd, pd) * 14.0);
  col *= 1.0 + nearP * 0.8;
  col += uAccent * nearP * 0.12;

  // pulse: brief accent flash washing down the corridor
  col += uAccent * uPulse * (0.4 + 0.6 * fog);

  outColor = vec4(col, 1.0);
}
`;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class TesseractMode implements Mode {
  readonly id = 'tesseract';
  readonly name = { ja: '追憶', en: 'Tesseract' };

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private postScale = 0.7;
  private t0 = 0;
  private pulseAt = -100;
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.prog = compileProgram(gl, FS_TRIANGLE_VS, FS, 'tesseract.main');
    this.u = new UniformSetter(gl, this.prog);
    this.postScale = clamp(0.5 + 0.25 * ctx.quality, 0.5, 0.75);
    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    this.t0 = 30 + Math.random() * 300; // start mid-corridor — frame 1 already drifts
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
    u.set2f('uPointer', (ctx.pointer.nx - 0.5) * aspect, ctx.pointer.ny - 0.5);
    u.set1f('uPulse', Math.exp(-(ctx.time - this.pulseAt) * 3.5));
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set3f('uAccent', th.accent[0], th.accent[1], th.accent[2]);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.1, bloom: 0.55, vignette: 0.35 });

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

export const tesseractMode: Mode = new TesseractMode();
