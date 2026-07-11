/**
 * Shared WebGL2 toolbox. FROZEN — all modes build on these helpers.
 *
 * Conventions:
 *  - All shaders are GLSL ES 3.00 (`#version 300 es` must be the first line).
 *  - Fullscreen passes use the shared fullscreen triangle: bind with
 *    `drawFullscreen(gl)` and pair your fragment shader with `FS_TRIANGLE_VS`
 *    (provides `out vec2 vUv` in [0,1]).
 */

// ---------------------------------------------------------------------------
// Program compilation
// ---------------------------------------------------------------------------

function numberSource(src: string): string {
  return src
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string, name: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`[${name}] gl.createShader failed`);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    const log = gl.getShaderInfoLog(shader) ?? '(no info log)';
    console.error(`[lumina] ${kind} shader "${name}" failed to compile:\n${log}\n${numberSource(src)}`);
    gl.deleteShader(shader);
    throw new Error(`[${name}] ${kind} shader compile error: ${log}`);
  }
  return shader;
}

/** Compile + link a program. On failure, logs the info log and numbered source, then throws. */
export function compileProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  name: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc, name);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc, name);
  const prog = gl.createProgram();
  if (!prog) throw new Error(`[${name}] gl.createProgram failed`);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '(no info log)';
    console.error(`[lumina] program "${name}" failed to link:\n${log}`);
    gl.deleteProgram(prog);
    throw new Error(`[${name}] program link error: ${log}`);
  }
  return prog;
}

// ---------------------------------------------------------------------------
// Textures & FBOs
// ---------------------------------------------------------------------------

export interface TextureOpts {
  w: number;
  h: number;
  /** e.g. gl.RGBA16F, gl.RGBA32F, gl.RG16F, gl.R32F, gl.RGBA8 */
  internalFormat: number;
  /** gl.NEAREST (default) or gl.LINEAR — note 32F needs OES_texture_float_linear for LINEAR */
  filter?: number;
  /** gl.CLAMP_TO_EDGE (default), gl.REPEAT, gl.MIRRORED_REPEAT */
  wrap?: number;
  data?: ArrayBufferView | null;
}

/** format/type pair for a sized internal format. */
export function formatFor(gl: WebGL2RenderingContext, internalFormat: number): { format: number; type: number } {
  switch (internalFormat) {
    case gl.RGBA32F: return { format: gl.RGBA, type: gl.FLOAT };
    case gl.RGBA16F: return { format: gl.RGBA, type: gl.HALF_FLOAT };
    case gl.RG32F: return { format: gl.RG, type: gl.FLOAT };
    case gl.RG16F: return { format: gl.RG, type: gl.HALF_FLOAT };
    case gl.R32F: return { format: gl.RED, type: gl.FLOAT };
    case gl.R16F: return { format: gl.RED, type: gl.HALF_FLOAT };
    case gl.RGBA8: return { format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    case gl.RG8: return { format: gl.RG, type: gl.UNSIGNED_BYTE };
    case gl.R8: return { format: gl.RED, type: gl.UNSIGNED_BYTE };
    default:
      throw new Error(`formatFor: unsupported internalFormat 0x${internalFormat.toString(16)}`);
  }
}

/** Allocate an immutable-size 2D texture (mip level 0 only). */
export function makeTexture(gl: WebGL2RenderingContext, opts: TextureOpts): WebGLTexture {
  const { w, h, internalFormat } = opts;
  const filter = opts.filter ?? gl.NEAREST;
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  const { format, type } = formatFor(gl, internalFormat);
  const tex = gl.createTexture();
  if (!tex) throw new Error('makeTexture: gl.createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, opts.data ?? null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

/** Create an FBO with `texture` as COLOR_ATTACHMENT0; throws if incomplete. */
export function createFBO(gl: WebGL2RenderingContext, texture: WebGLTexture): WebGLFramebuffer {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('createFBO: gl.createFramebuffer failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`createFBO: framebuffer incomplete (status 0x${status.toString(16)})`);
  }
  return fbo;
}

/**
 * Ping-pong pair of texture+FBO for iterative simulations.
 * Render into `write.fbo` while sampling `read.tex`, then `swap()`.
 */
export class PingPong {
  read!: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  write!: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  w: number;
  h: number;

  constructor(
    private gl: WebGL2RenderingContext,
    w: number,
    h: number,
    private internalFormat: number,
    private filter?: number,
    private wrap?: number,
  ) {
    this.w = w;
    this.h = h;
    this.allocate();
  }

  private allocate(): void {
    const { gl } = this;
    const mk = () => {
      const tex = makeTexture(gl, {
        w: this.w, h: this.h,
        internalFormat: this.internalFormat,
        filter: this.filter, wrap: this.wrap,
      });
      return { tex, fbo: createFBO(gl, tex) };
    };
    this.read = mk();
    this.write = mk();
  }

  swap(): void {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }

  /** Re-allocate both targets at a new size (contents are lost). */
  resize(w: number, h: number): void {
    this.destroy();
    this.w = w;
    this.h = h;
    this.allocate();
  }

  destroy(): void {
    const { gl } = this;
    for (const side of [this.read, this.write]) {
      if (side) {
        gl.deleteTexture(side.tex);
        gl.deleteFramebuffer(side.fbo);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fullscreen triangle
// ---------------------------------------------------------------------------

/**
 * Vertex shader for fullscreen passes. No attributes needed (gl_VertexID trick);
 * provides `out vec2 vUv` covering [0,1]² across the viewport.
 */
export const FS_TRIANGLE_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

interface SharedCache {
  vao: WebGLVertexArrayObject | null;
  blitProg: WebGLProgram | null;
  blitTexLoc: WebGLUniformLocation | null;
}
const sharedCache = new WeakMap<WebGL2RenderingContext, SharedCache>();

function cacheFor(gl: WebGL2RenderingContext): SharedCache {
  let c = sharedCache.get(gl);
  if (!c) {
    c = { vao: null, blitProg: null, blitTexLoc: null };
    sharedCache.set(gl, c);
  }
  return c;
}

/** Drop per-context cached objects (call after webglcontextrestored). */
export function invalidateGLCaches(gl: WebGL2RenderingContext): void {
  sharedCache.delete(gl);
}

/** Shared empty VAO used by all fullscreen-triangle passes. */
export function getFullscreenVAO(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const c = cacheFor(gl);
  if (!c.vao) {
    c.vao = gl.createVertexArray();
    if (!c.vao) throw new Error('getFullscreenVAO: createVertexArray failed');
  }
  return c.vao;
}

/** Bind the shared VAO and draw the fullscreen triangle. Program must already be in use. */
export function drawFullscreen(gl: WebGL2RenderingContext): void {
  gl.bindVertexArray(getFullscreenVAO(gl));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
}

const BLIT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }
`;

/**
 * Copy `tex` to `targetFbo` (or the default framebuffer when null).
 * Caller is responsible for the viewport. Leaves program/texture bindings dirty.
 */
export function blit(gl: WebGL2RenderingContext, tex: WebGLTexture, targetFbo: WebGLFramebuffer | null): void {
  const c = cacheFor(gl);
  if (!c.blitProg) {
    c.blitProg = compileProgram(gl, FS_TRIANGLE_VS, BLIT_FS, 'glutils.blit');
    c.blitTexLoc = gl.getUniformLocation(c.blitProg, 'uTex');
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
  gl.useProgram(c.blitProg);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(c.blitTexLoc, 0);
  drawFullscreen(gl);
}

// ---------------------------------------------------------------------------
// Uniform convenience
// ---------------------------------------------------------------------------

/** Cached-location uniform setter for one program. */
export class UniformSetter {
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(private gl: WebGL2RenderingContext, private prog: WebGLProgram) {}

  loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.locs.get(name) ?? null;
  }

  set1f(name: string, x: number): void { this.gl.uniform1f(this.loc(name), x); }
  set2f(name: string, x: number, y: number): void { this.gl.uniform2f(this.loc(name), x, y); }
  set3f(name: string, x: number, y: number, z: number): void { this.gl.uniform3f(this.loc(name), x, y, z); }
  set4f(name: string, x: number, y: number, z: number, w: number): void { this.gl.uniform4f(this.loc(name), x, y, z, w); }
  set1i(name: string, x: number): void { this.gl.uniform1i(this.loc(name), x); }
  set3fv(name: string, v: Float32Array | number[]): void { this.gl.uniform3fv(this.loc(name), v); }
  set4fv(name: string, v: Float32Array | number[]): void { this.gl.uniform4fv(this.loc(name), v); }
  setMat3(name: string, v: Float32Array | number[]): void { this.gl.uniformMatrix3fv(this.loc(name), false, v); }

  /** Bind `tex` to texture unit `unit` and set the sampler uniform. */
  setTexture(name: string, tex: WebGLTexture, unit: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(name), unit);
  }
}
