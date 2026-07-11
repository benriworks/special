/**
 * MOJI — placeholder stub (pulsing 「光」 glyph pattern).
 * The real typography agent replaces everything in src/modes/moji/.
 * Renders 光 into a canvas-2D texture (with a procedural stroke fallback when
 * no CJK font is available, e.g. bare CI containers) and tiles it.
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
uniform float uDensity;
uniform sampler2D uGlyph;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453); }
vec3 pal(float t) {
  float x = clamp(t, 0.0, 1.0) * float(uNumColors - 1);
  int i = int(floor(x));
  int j = min(i + 1, uNumColors - 1);
  return mix(uColors[i], uColors[j], fract(x));
}
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 uv = vUv * aspect;
  vec2 g = uv * uDensity;
  vec2 cell = floor(g);
  vec2 local = fract(g);
  float h = hash(cell);

  // each cell's glyph breathes with its own phase; pointer wakes cells up
  vec2 cellCenter = (cell + 0.5) / uDensity;
  float pdc = length(cellCenter - uPointer * aspect);
  float wake = exp(-pdc * 5.0) * (0.7 + 1.2 * uDown);
  float breath = 0.5 + 0.5 * sin(uTime * uSpeed * (0.8 + h * 1.6) + h * 6.28);
  float scale = mix(0.55, 0.95, breath) + wake * 0.25;

  vec2 guv = (local - 0.5) / scale + 0.5;
  float inBox = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
  float glyph = texture(uGlyph, clamp(guv, 0.0, 1.0)).a * inBox;

  float bgGrad = 0.5 + 0.5 * sin(uv.x * 1.4 + uTime * 0.13 * uSpeed) * sin(uv.y * 1.7 - uTime * 0.11 * uSpeed);
  vec3 col = uBg + pal(bgGrad * 0.3) * 0.14;
  col += pal(0.3 + 0.6 * h) * glyph * (0.35 + breath * 0.9 + wake * 1.3);

  // pointer glow
  vec2 pd = uv - uPointer * aspect;
  float pg = exp(-dot(pd, pd) * 26.0) * (0.3 + 0.7 * uDown);
  col += pal(0.85) * pg;

  // pulse: expanding radial flash
  float pdist = length((vUv - uPulsePos) * aspect);
  float ring = exp(-pow((pdist - uPulseAge * 1.5) / (0.05 + uPulseAge * 0.1), 2.0)) * exp(-uPulseAge * 2.4);
  col += pal(0.9) * ring * 1.8;

  outColor = vec4(col, 1.0);
}
`;

function drawFallbackGlyph(c2: CanvasRenderingContext2D, size: number): void {
  // procedural pseudo-「光」 strokes for environments without CJK fonts
  const s = size / 256;
  c2.strokeStyle = '#fff';
  c2.lineWidth = 20 * s;
  c2.lineCap = 'round';
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    c2.beginPath();
    c2.moveTo(x1 * s, y1 * s);
    c2.lineTo(x2 * s, y2 * s);
    c2.stroke();
  };
  line(128, 36, 128, 112);   // top vertical
  line(66, 58, 88, 96);      // left dash
  line(190, 58, 168, 96);    // right dash
  line(44, 132, 212, 132);   // horizontal bar
  line(100, 132, 62, 214);   // left leg
  line(158, 132, 158, 196);  // right leg
  line(158, 196, 214, 208);  // right hook
}

function makeGlyphTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const c2 = cv.getContext('2d', { willReadFrequently: true })!;
  c2.clearRect(0, 0, size, size);
  c2.fillStyle = '#fff';
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  c2.font = `${Math.round(size * 0.78)}px "Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Noto Sans JP","Noto Sans CJK JP",sans-serif`;
  c2.fillText('光', size / 2, size / 2 + size * 0.04);

  // coverage check — tofu/blank means no CJK font; draw procedural strokes
  const data = c2.getImageData(0, 0, size, size).data;
  let covered = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 40) covered++;
  if (covered < size * size * 0.03) {
    c2.clearRect(0, 0, size, size);
    drawFallbackGlyph(c2, size);
  }

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

class MojiStub implements Mode {
  readonly id = 'moji';
  readonly name = { ja: '文字', en: 'Moji' };
  readonly params: ParamDef[] = [
    { key: 'speed', label: { ja: '鼓動', en: 'Heartbeat' }, type: 'range', min: 0.2, max: 3, step: 0.05, default: 1 },
    { key: 'density', label: { ja: '密度', en: 'Density' }, type: 'range', min: 3, max: 12, step: 1, default: 6 },
  ];

  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  private post: Post | null = null;
  private glyph: WebGLTexture | null = null;
  private simScale = 0.7;
  private speed = 1;
  private density = 6;
  private pulseAt = -1e3;
  private pulsePos: [number, number] = [0.5, 0.5];
  private colorBuf = new Float32Array(18);

  init(ctx: ModeContext): void {
    this.prog = compileProgram(ctx.gl, FS_TRIANGLE_VS, FRAG, 'moji.stub');
    this.u = new UniformSetter(ctx.gl, this.prog);
    this.simScale = Math.max(0.35, 0.7 * ctx.quality);
    this.post = createPost(
      ctx.gl,
      Math.max(1, Math.round(ctx.width * this.simScale)),
      Math.max(1, Math.round(ctx.height * this.simScale)),
    );
    this.glyph = makeGlyphTexture(ctx.gl);
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
    else if (key === 'density') this.density = Number(value);
  }

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.prog || !this.u || !this.post || !this.glyph) return;
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
    u.set1f('uDensity', this.density);
    u.setTexture('uGlyph', this.glyph, 0);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.25, bloom: 0.55, vignette: 0.3 });
  }

  destroy(gl: WebGL2RenderingContext): void {
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.glyph) gl.deleteTexture(this.glyph);
    this.post?.destroy();
    this.prog = null;
    this.u = null;
    this.post = null;
    this.glyph = null;
  }
}

export const mojiMode: Mode = new MojiStub();
