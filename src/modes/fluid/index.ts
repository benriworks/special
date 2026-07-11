/**
 * FLUID — placeholder stub (flowing domain-warped fbm gradient).
 * The real fluid-sim agent replaces everything in src/modes/fluid/.
 * This stub proves the full pipeline: contract, theme(+mix), pointer, pulse,
 * post composer, params, clean destroy.
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
uniform float uWild;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = vUv * aspect * 2.2;
  float t = uTime * 0.14 * uSpeed;

  // domain-warped flow
  vec2 q = vec2(fbm(p + vec2(t, -t * 0.7)), fbm(p + vec2(-t * 0.6, t)));
  vec2 r = vec2(fbm(p + (2.4 + uWild * 2.0) * q + vec2(1.7, 9.2) + t * 0.4),
                fbm(p + (2.4 + uWild * 2.0) * q + vec2(8.3, 2.8) - t * 0.3));
  float f = fbm(p + 2.6 * r);

  // pointer stirs & brightens the field
  vec2 pd = (vUv - uPointer) * aspect;
  float pg = exp(-dot(pd, pd) * 55.0) * (0.5 + 0.7 * uDown);
  f += pg * 0.25;

  // f^4 shaping keeps valleys deep and ridges luminous
  float e = f * f;
  vec3 col = uBg + pal(f) * (0.05 + e * e * 0.95);
  col += pal(clamp(f + 0.3, 0.0, 1.0)) * pg * 0.55;

  // pulse: expanding radial flash
  float pdist = length((vUv - uPulsePos) * aspect);
  float ring = exp(-pow((pdist - uPulseAge * 1.5) / (0.05 + uPulseAge * 0.1), 2.0)) * exp(-uPulseAge * 2.4);
  col += pal(0.85) * ring * 1.8;

  outColor = vec4(col, 1.0);
}
`;

class FluidStub implements Mode {
  readonly id = 'fluid';
  readonly name = { ja: '流体', en: 'Fluid' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '流速', en: 'Flow speed' }, type: 'range', min: 0.2, max: 3, step: 0.05, default: 1 },
    {
      key: 'warp',
      label: { ja: 'うねり', en: 'Warp' },
      type: 'select',
      options: [
        { value: 'gentle', label: { ja: '穏やか', en: 'Gentle' } },
        { value: 'wild', label: { ja: '荒ぶる', en: 'Wild' } },
      ],
      default: 'gentle',
    },
  ];

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private simScale = 0.7;
  private speed = 1;
  private wild = 0;
  private pulseAt = -1e3;
  private pulsePos: [number, number] = [0.5, 0.5];
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    this.prog = compileProgram(ctx.gl, FS_TRIANGLE_VS, FRAG, 'fluid.stub');
    this.u = new UniformSetter(ctx.gl, this.prog);
    // field renders at quality-scaled internal res; post upsamples smoothly
    this.simScale = Math.max(0.35, 0.7 * ctx.quality);
    this.post = createPost(
      ctx.gl,
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
    this.pulseAt = -1e3;
    // shader is time-driven: frame 1 is already in mid-flow (pre-warmed)
  }

  resize(ctx: ModeContext): void {
    this.post?.resize(
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
  }

  setParam(key: string, value: number | string): void {
    if (key === 'speed') this.speed = Number(value);
    else if (key === 'warp') this.wild = value === 'wild' ? 1 : 0;
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
    for (let i = 0; i < 6; i++) {
      const c = th.colors[Math.min(i, n - 1)];
      this.colorBuf.set(c, i * 3);
    }
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', n);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set1f('uSpeed', this.speed);
    u.set1f('uWild', this.wild);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.0, bloom: 0.4, vignette: 0.3 });
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.post?.destroy();
    this.prog = null;
    this.u = null;
    this.post = null;
  }
}

export const fluidMode: Mode = new FluidStub();
