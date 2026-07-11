/**
 * FLOCK — placeholder stub (drifting triangles).
 * The real boids agent replaces everything in src/modes/flock/.
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
uniform int uCount;
in vec2 vUv;
out vec4 outColor;

float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
// signed distance to an equilateral triangle of "radius" r (iq)
float sdTriangle(vec2 p, float r) {
  const float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 uv = vUv * aspect;
  vec2 ptr = uPointer * aspect;
  vec3 col = uBg;

  for (int i = 0; i < 18; i++) {
    if (i >= uCount) break;
    float fi = float(i);
    float h1 = hash(fi + 1.0);
    float h2 = hash(fi + 27.0);
    float h3 = hash(fi + 63.0);
    float t = uTime * uSpeed * (0.10 + 0.12 * h3);
    // lissajous drift, gently attracted toward the pointer
    vec2 c = vec2(
      0.5 + 0.42 * sin(t * 1.3 + h1 * 6.28) * aspect.x,
      0.5 + 0.38 * sin(t * 1.7 + h2 * 6.28)
    );
    c = mix(c, ptr, 0.18 + 0.22 * uDown);
    vec2 d = uv - c;
    // face travel direction
    float ang = atan(cos(t * 1.7 + h2 * 6.28) * 1.7 * 0.38, cos(t * 1.3 + h1 * 6.28) * 1.3 * 0.42) - 1.5708;
    vec2 rp = vec2(cos(ang) * d.x - sin(ang) * d.y, sin(ang) * d.x + cos(ang) * d.y);
    float size = 0.028 + 0.03 * h3;
    float sd = sdTriangle(rp, size);
    float body = 1.0 - smoothstep(-0.004, 0.006, sd);
    float glow = exp(-max(sd, 0.0) * 55.0);
    vec3 tint = pal(0.25 + 0.7 * h1);
    col += tint * (body * 1.15 + glow * 0.35);
  }

  // pointer brightening
  vec2 pd = uv - ptr;
  float pg = exp(-dot(pd, pd) * 28.0) * (0.35 + 0.75 * uDown);
  col += pal(0.75) * pg;

  // pulse: expanding radial flash
  float pdist = length((vUv - uPulsePos) * aspect);
  float ring = exp(-pow((pdist - uPulseAge * 1.5) / (0.05 + uPulseAge * 0.1), 2.0)) * exp(-uPulseAge * 2.4);
  col += pal(0.9) * ring * 1.8;

  outColor = vec4(col, 1.0);
}
`;

class FlockStub implements Mode {
  readonly id = 'flock';
  readonly name = { ja: '群れ', en: 'Flock' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '速さ', en: 'Speed' }, type: 'range', min: 0.2, max: 3, step: 0.05, default: 1 },
  ];

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private simScale = 0.7;
  private speed = 1;
  private count = 18;
  private pulseAt = -1e3;
  private pulsePos: [number, number] = [0.5, 0.5];
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    this.prog = compileProgram(ctx.gl, FS_TRIANGLE_VS, FRAG, 'flock.stub');
    this.u = new UniformSetter(ctx.gl, this.prog);
    this.simScale = Math.max(0.35, 0.7 * ctx.quality);
    this.post = createPost(
      ctx.gl,
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
    this.pulseAt = -1e3;
    // agent-count scales with the quality tier, per contract
    this.count = Math.max(6, Math.round(18 * ctx.quality));
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
    u.set1i('uCount', this.count);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.25, bloom: 0.5, vignette: 0.3 });
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.post?.destroy();
    this.prog = null;
    this.u = null;
    this.post = null;
  }
}

export const flockMode: Mode = new FlockStub();
