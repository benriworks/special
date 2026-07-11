/**
 * GALAXY — placeholder stub (rotating starburst / spiral arms).
 * The real particle-galaxy agent replaces everything in src/modes/galaxy/.
 */

import type { Mode, ModeContext, ParamDef } from '../../engine/types';
import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uPointer;
uniform float uDown;
uniform vec2 uPulsePos;
uniform float uPulseAge;
uniform vec3 uColors[6];
uniform int uNumColors;
uniform vec3 uBg;
uniform float uSpeed;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(419.2, 371.9))) * 833458.57832); }
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  // galaxy center drifts gently toward the pointer while pressed
  vec2 center = mix(vec2(0.5), uPointer, 0.25 * uDown + 0.08);
  vec2 p = (vUv - center) * aspect * 1.45;
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = uTime * 0.22 * uSpeed;

  // two log-spiral arms
  float swirl = a + 4.5 * log(r + 0.06) - t * 2.2;
  float ac = 0.5 + 0.5 * cos(swirl * 2.0);
  float arms = ac * ac;
  arms *= arms * ac; // ac^5 — thin, luminous arms
  float core = exp(-r * 9.0);
  float disk = exp(-r * 3.6);

  // star sparkle field, rotating with the disk
  vec2 sp = vec2(cos(-t) * p.x - sin(-t) * p.y, sin(-t) * p.x + cos(-t) * p.y);
  vec2 cell = floor(sp * 42.0);
  float star = step(0.985, hash(cell)) * (0.5 + 0.5 * sin(uTime * 3.0 + hash(cell + 7.0) * 40.0));

  vec3 col = uBg;
  col += pal(clamp(arms * disk * 1.2, 0.0, 1.0)) * arms * disk * 1.15;
  col += pal(0.95) * core * 1.2;
  col += pal(0.8) * star * disk * 0.8;

  // pointer brightening
  vec2 pd = (vUv - uPointer) * aspect;
  float pg = exp(-dot(pd, pd) * 30.0) * (0.3 + 0.6 * uDown);
  col += pal(0.7) * pg;

  // pulse: expanding radial flash
  float pdist = length((vUv - uPulsePos) * aspect);
  float ring = exp(-pow((pdist - uPulseAge * 1.5) / (0.05 + uPulseAge * 0.1), 2.0)) * exp(-uPulseAge * 2.4);
  col += pal(0.9) * ring * 1.8;

  outColor = vec4(col, 1.0);
}
`;

class GalaxyStub implements Mode {
  readonly id = 'galaxy';
  readonly name = { ja: '銀河', en: 'Galaxy' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '回転', en: 'Spin' }, type: 'range', min: 0.2, max: 3, step: 0.05, default: 1 },
  ];

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private simScale = 0.7;
  private speed = 1;
  private pulseAt = -1e3;
  private pulsePos: [number, number] = [0.5, 0.5];
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    this.prog = compileProgram(ctx.gl, FS_TRIANGLE_VS, FRAG, 'galaxy.stub');
    this.u = new UniformSetter(ctx.gl, this.prog);
    this.simScale = Math.max(0.35, 0.7 * ctx.quality);
    this.post = createPost(
      ctx.gl,
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
    this.pulseAt = -1e3;
  }

  resize(ctx: ModeContext): void {
    this.post?.resize(
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
  }

  setParam(key: string, value: number | string): void {
    if (key === 'speed') this.speed = Number(value);
  }

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.prog || !this.u || !this.post) return;
    if (ctx.pulse) {
      this.pulseAt = ctx.time;
      this.pulsePos = [ctx.pointer.nx, ctx.pointer.ny];
    }
    const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;

    this.post.begin();
    gl.clearColor(th.background[0], th.background[1], th.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    const u = this.u;
    u.set2f('uRes', ctx.width, ctx.height);
    u.set1f('uTime', ctx.time);
    u.set2f('uPointer', ctx.pointer.nx, ctx.pointer.ny);
    u.set1f('uDown', ctx.pointer.down ? 1 : 0);
    u.set2f('uPulsePos', this.pulsePos[0], this.pulsePos[1]);
    u.set1f('uPulseAge', ctx.time - this.pulseAt);
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set1f('uSpeed', this.speed);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.05, bloom: 0.45, vignette: 0.35 });
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.post?.destroy();
    this.prog = null;
    this.u = null;
    this.post = null;
  }
}

export const galaxyMode: Mode = new GalaxyStub();
