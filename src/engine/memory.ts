/**
 * Session-memory atlas — the engine quietly snapshots small squares of the
 * user's play ("memories") into a 4×4 RGB8 ring atlas that the tesseract mode
 * later displays. Owned by the engine; modes only ever see the read-only
 * `ctx.memory` view (see types.ts for the full capture-rule contract).
 *
 * Capture pipeline (all GPU-side, zero per-capture JS allocation):
 *   1. copyTexSubImage2D of the CENTERED SQUARE of the default framebuffer
 *      into a square RGB8 intermediate texture. The default framebuffer is
 *      alpha:false → its color format is RGB, and WebGL2 forbids RGBA copies
 *      from an RGB source (GL_INVALID_OPERATION) — so the intermediate must be
 *      RGB8, exactly like the engine's crossfade fade texture.
 *   2. one 4-tap box-downsample draw through a private FBO into the next ring
 *      slot of the atlas (copyTexSubImage2D cannot scale, hence the draw).
 *
 * All GL objects are allocated lazily on the first capture, so sessions that
 * never make a memory never pay for one. On context loss every handle is
 * dropped (not deleted — they are already dead) and the HISTORY IS LOST; this
 * is acceptable: memories are session-scoped and the atlas refills lazily
 * after restore. destroy() deletes atlas + intermediate + FBO + program.
 */

import { FS_TRIANGLE_VS, compileProgram, drawFullscreen, UniformSetter } from './glutils';
import type { ModeContext } from './types';

/** Slot edge in texels; 4×4 slots → 1152×1152 RGB8 atlas (≈4 MB). */
const SLOT = 288;
const COLS = 4;
const ROWS = 4;
const SLOTS = COLS * ROWS;

const DOWNSAMPLE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel; // 1/src size
in vec2 vUv;
out vec4 outColor;
void main() {
  // 4-tap diagonal box — smooths the large (canvas-min-side → 288) reduction.
  vec3 a = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 b = texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 d = texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  outColor = vec4((a + b + c + d) * 0.25, 1.0);
}
`;

type MemoryView = NonNullable<ModeContext['memory']>;

export class MemoryAtlas {
  /** Per-slot source-mode ids (metadata; slot i is valid while i < used). */
  readonly slotModes: string[] = new Array<string>(SLOTS).fill('');

  private atlasTex: WebGLTexture | null = null;
  private atlasFbo: WebGLFramebuffer | null = null;
  private interTex: WebGLTexture | null = null;
  private interSide = 0;
  private prog: WebGLProgram | null = null;
  private u: UniformSetter | null = null;
  /** Set when the RGB8 atlas FBO turns out incomplete (paranoia; RGB8 is
   *  color-renderable per ES 3.0) — captures become no-ops until restore. */
  private unusable = false;

  /** Total captures this GL-context generation; also drives the ring index. */
  private stampCounter = 0;
  private view: MemoryView | null = null;

  constructor(private gl: WebGL2RenderingContext) {}

  /** Valid slot count (0..16; slots fill 0→15, then ring-overwrite oldest). */
  get used(): number { return Math.min(this.stampCounter, SLOTS); }
  get stamp(): number { return this.stampCounter; }
  /** The single mutated ctx.memory object — null until the first capture. */
  get info(): MemoryView | null { return this.view; }

  /**
   * Snapshot the centered square of the default framebuffer (which must hold a
   * pure mode frame RIGHT NOW) into the next ring slot. The caller (engine)
   * enforces every WHEN rule; this method only performs the GL work. Leaves
   * program/texture/framebuffer bindings clean, viewport dirty (the engine's
   * resetGLState / overlay passes restore it).
   */
  capture(width: number, height: number, modeId: string): void {
    const gl = this.gl;
    if (this.unusable) return;
    const side = Math.min(width, height);
    if (side < 8) return;

    if (!this.prog) {
      this.prog = compileProgram(gl, FS_TRIANGLE_VS, DOWNSAMPLE_FS, 'memory.downsample');
      this.u = new UniformSetter(gl, this.prog);
    }

    if (!this.atlasTex) {
      this.atlasTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, COLS * SLOT, ROWS * SLOT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.atlasFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlasFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.atlasTex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.deleteFramebuffer(this.atlasFbo);
        gl.deleteTexture(this.atlasTex);
        this.atlasFbo = null;
        this.atlasTex = null;
        this.unusable = true;
        gl.bindTexture(gl.TEXTURE_2D, null);
        return;
      }
    }

    // Intermediate square (reallocated only when the canvas min-side changes —
    // resizes are rare; steady-state captures allocate nothing).
    if (!this.interTex || this.interSide !== side) {
      if (this.interTex) gl.deleteTexture(this.interTex);
      this.interTex = gl.createTexture();
      this.interSide = side;
      gl.bindTexture(gl.TEXTURE_2D, this.interTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, side, side);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.interTex);
    }

    // 1) centered square of the default framebuffer → intermediate (RGB←RGB).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, (width - side) >> 1, (height - side) >> 1, side, side);

    // 2) box-downsample the intermediate into the next ring slot (row-major).
    const slot = this.stampCounter % SLOTS;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.atlasFbo);
    gl.viewport((slot % COLS) * SLOT, ((slot / COLS) | 0) * SLOT, SLOT, SLOT);
    gl.useProgram(this.prog);
    this.u!.setTexture('uTex', this.interTex, 0);
    this.u!.set2f('uTexel', 1 / side, 1 / side);
    drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Metadata + the single mutated view object (identity stable per contract).
    this.slotModes[slot] = modeId;
    this.stampCounter++;
    if (!this.view) {
      this.view = { texture: this.atlasTex, cols: COLS, rows: ROWS, used: 0, stamp: 0 };
    }
    this.view.texture = this.atlasTex;
    this.view.used = this.used;
    this.view.stamp = this.stampCounter;
  }

  /**
   * Context LOST: all handles are already dead — drop them without delete
   * calls and forget the history. Everything reallocates lazily on the next
   * capture after restore (the engine also resets ctx.memory to null).
   */
  invalidate(): void {
    this.atlasTex = null;
    this.atlasFbo = null;
    this.interTex = null;
    this.interSide = 0;
    this.prog = null;
    this.u = null;
    this.unusable = false;
    this.stampCounter = 0;
    this.slotModes.fill('');
    this.view = null;
  }

  /** Free everything (live context). */
  destroy(): void {
    const gl = this.gl;
    if (this.atlasFbo) gl.deleteFramebuffer(this.atlasFbo);
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
    if (this.interTex) gl.deleteTexture(this.interTex);
    if (this.prog) gl.deleteProgram(this.prog);
    this.invalidate();
  }
}
