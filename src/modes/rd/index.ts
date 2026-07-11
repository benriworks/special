/**
 * RD (reaction-diffusion) — placeholder stub (cellular interference rings).
 * The real Gray-Scott agent replaces everything in src/modes/rd/.
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

float hash(float n) { return fract(sin(n * 91.17) * 43758.5453); }
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 uv = vUv * aspect;
  float t = uTime * uSpeed * 0.5;

  // interference of concentric waves from drifting emitters — cellular rings
  float field = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(
      0.5 + 0.34 * sin(t * (0.23 + 0.08 * hash(fi)) + fi * 2.4) * aspect.x,
      0.5 + 0.30 * cos(t * (0.31 + 0.06 * hash(fi + 9.0)) + fi * 1.7)
    );
    float d = length(uv - c);
    field += sin(d * 46.0 - t * 4.0 + fi) * exp(-d * 2.1);
  }
  // the pointer is a strong extra emitter
  float pd = length(uv - uPointer * aspect);
  field += sin(pd * 52.0 - t * 6.0) * exp(-pd * 2.6) * (1.0 + 1.4 * uDown);

  // fold the field into organic bands
  float v = field * 0.5 + 0.5;
  float cells = smoothstep(0.42, 0.5, abs(fract(v * 1.8) - 0.5));
  float soft = clamp(v * 0.45, 0.0, 1.0);

  vec3 col = uBg + pal(soft) * (0.16 + cells * 0.85);
  col += pal(clamp(soft + 0.35, 0.0, 1.0)) * exp(-pd * 5.0) * (0.5 + 0.8 * uDown);

  // pulse: expanding radial flash
  float pdist = length((vUv - uPulsePos) * aspect);
  float ring = exp(-pow((pdist - uPulseAge * 1.5) / (0.05 + uPulseAge * 0.1), 2.0)) * exp(-uPulseAge * 2.4);
  col += pal(0.9) * ring * 1.8;

  outColor = vec4(col, 1.0);
}
`;

class RDStub implements Mode {
  readonly id = 'rd';
  readonly name = { ja: '反応拡散', en: 'RD' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '脈動', en: 'Pulse rate' }, type: 'range', min: 0.2, max: 3, step: 0.05, default: 1 },
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
    this.prog = compileProgram(ctx.gl, FS_TRIANGLE_VS, FRAG, 'rd.stub');
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
    this.post.end({ exposure: 1.05, bloom: 0.45, vignette: 0.3 });
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    this.post?.destroy();
    this.prog = null;
    this.u = null;
    this.post = null;
  }
}

export const rdMode: Mode = new RDStub();
