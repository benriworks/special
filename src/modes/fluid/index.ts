/**
 * FLUID (流体) — Stam stable-fluids in HDR.
 *
 * Per frame: semi-Lagrangian velocity advection (manual bilerp, NEAREST
 * float textures) → batched gaussian force/dye splats (pointer strokes,
 * orbiting idle emitters, pulse shockwave) → curl → vorticity confinement →
 * divergence → Jacobi pressure (24/20/14 iters by quality) → gradient
 * subtract → dye advection → HDR present through the shared post composer.
 *
 * Anti-cliché measures:
 *  - three invisible emitters orbit with incommensurate speeds/phases and
 *    opposing rotations, injecting swirl + dye from different palette
 *    indices — the idle screen is a living composition, never a black void;
 *  - dye colors come ONLY from the theme palette (slow triangle-wave cycling
 *    per stroke/emitter), never rainbow HSV;
 *  - dissipation & emitter budget tuned so the field neither saturates nor
 *    fades to black; low-end shaping in the present pass kills grey soup;
 *  - splats are velocity-scaled and interpolated along the drag path:
 *    fast flick = long thin jet, slow drag = fat plume.
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, UniformSetter, compileProgram, createFBO, drawFullscreen, makeTexture,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';
import {
  CLEAR_FS, CURL_FS, DIVERGENCE_FS, GRADIENT_FS, MAX_SPLATS, makeAdvectFS,
  PRESSURE_FS, PULSE_FS, RENDER_FS, SPLAT_FS, VORTICITY_FS,
} from './shaders';

// --- tuning ----------------------------------------------------------------

const VEL_LONG = 384;        // velocity grid long side at quality 1.0
const DYE_LONG_CAP = 1024;   // dye grid long side cap (also ≤ canvas, × quality)
// software rasterizers (SwiftShader / llvmpipe) pay per-texel on the CPU —
// use a smaller preset there so even the top quality tier stays interactive
const VEL_LONG_SOFT = 160;
const DYE_LONG_CAP_SOFT = 320;
const SPLAT_CAP = 64;        // max splats accumulated per frame (flushed in 16s)
const VEL_DECAY = 0.25;      // velocity dissipation rate /s — violent strokes calm fast
const PULSE_DUR = 0.45;      // seconds of shockwave injection
const POINTER_GAIN = 1.5;    // splat force = pointer velocity × gain
const POINTER_VMAX = 2.5;    // q-units/s force clamp — protects the dye inventory at low fps
const EMIT_GAIN = 16;        // emitter path-velocity → force gain
const DYE_K_DEFAULT = -Math.log(0.992) * 60; // default decay rate /s

interface EmitterDef {
  speed: number;   // orbit angular velocity (rad/s, sign = direction)
  phase: number;
  rBase: number;   // orbit radius (fraction of short side)
  rAmp: number;    // orbit radius breathing amplitude
  breath: number;  // breathing angular frequency (rad/s)
  wobble: number;  // orbit-center wander frequency (rad/s)
  palLo: number;   // palette sub-range — distinct per emitter so the idle
  palHi: number;   // composition always carries several hues at once
  palOff: number;  // palette cycle offset
}

const EMITTERS: EmitterDef[] = [
  { speed: 0.22, phase: 0.6, rBase: 0.30, rAmp: 0.09, breath: 0.31, wobble: 0.050, palLo: 0.55, palHi: 0.86, palOff: 0.00 },
  { speed: -0.17, phase: 2.7, rBase: 0.23, rAmp: 0.08, breath: 0.26, wobble: 0.043, palLo: 0.28, palHi: 0.62, palOff: 0.33 },
  { speed: 0.13, phase: 4.8, rBase: 0.35, rAmp: 0.10, breath: 0.22, wobble: 0.037, palLo: 0.08, palHi: 0.48, palOff: 0.67 },
];

// --- small helpers ----------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Triangle wave 0→1→0 over one unit — smooth palette cycling without wrap pops. */
const tri = (x: number) => 1 - Math.abs(1 - 2 * (x - Math.floor(x)));

/** Sample the theme palette (dark→bright) at t∈[0,1] into `out`. */
function pal(colors: [number, number, number][], t: number, out: Float32Array): void {
  const n = colors.length;
  const x = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const f = x - i;
  const a = colors[i];
  const b = colors[Math.min(i + 1, n - 1)];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
}

/** Grid dimensions with square cells matching the canvas aspect. */
function fitGrid(longSide: number, w: number, h: number): { w: number; h: number } {
  if (w >= h) return { w: longSide, h: Math.max(2, Math.round((longSide * h) / w)) };
  return { w: Math.max(2, Math.round((longSide * w) / h)), h: longSide };
}

/** True for CPU rasterizers (SwiftShader, llvmpipe, …) — they pay per texel. */
function detectSoftwareGL(gl: WebGL2RenderingContext): boolean {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

// --- the mode ----------------------------------------------------------------

class FluidMode implements Mode {
  readonly id = 'fluid';
  readonly name = { ja: '流体', en: 'Fluid' };
  readonly params: ParamDef[] = [
    { key: 'vorticity', label: { ja: '渦の強さ', en: 'Vorticity' }, type: 'range', min: 0, max: 50, step: 1, default: 30 },
    { key: 'persistence', label: { ja: '残り香', en: 'Persistence' }, type: 'range', min: 0.95, max: 0.999, step: 0.001, default: 0.992 },
    { key: 'brush', label: { ja: 'にじみ', en: 'Brush size' }, type: 'range', min: 0.3, max: 2.5, step: 0.05, default: 1 },
  ];

  // programs
  private velAdvProg: WebGLProgram | null = null;
  private advectProg: WebGLProgram | null = null;
  private splatProg: WebGLProgram | null = null;
  private curlProg: WebGLProgram | null = null;
  private vortProg: WebGLProgram | null = null;
  private divProg: WebGLProgram | null = null;
  private clearProg: WebGLProgram | null = null;
  private pressureProg: WebGLProgram | null = null;
  private gradProg: WebGLProgram | null = null;
  private pulseProg: WebGLProgram | null = null;
  private renderProg: WebGLProgram | null = null;
  private velAdvU: UniformSetter | null = null;
  private advectU: UniformSetter | null = null;
  private splatU: UniformSetter | null = null;
  private curlU: UniformSetter | null = null;
  private vortU: UniformSetter | null = null;
  private divU: UniformSetter | null = null;
  private clearU: UniformSetter | null = null;
  private pressureU: UniformSetter | null = null;
  private gradU: UniformSetter | null = null;
  private pulseU: UniformSetter | null = null;
  private renderU: UniformSetter | null = null;

  // targets
  private velocity: PingPong | null = null;
  private dye: PingPong | null = null;
  private pressure: PingPong | null = null;
  private curlTex: WebGLTexture | null = null;
  private curlFbo: WebGLFramebuffer | null = null;
  private divTex: WebGLTexture | null = null;
  private divFbo: WebGLFramebuffer | null = null;
  private post: Post | null = null;

  // geometry
  private softGL = false;
  private velW = 2; private velH = 2;
  private dyeW = 2; private dyeH = 2;
  private minSide = 1;
  private aspectX = 1; private aspectY = 1;
  private orbitRx = 1; private orbitRy = 1;
  private jacobi = 24;

  // params
  private vorticity = 30;
  private persistence = 0.992;
  private brush = 1;

  // runtime
  private ready = false;
  private wasDown = false;
  private strokeSeed = 0.17;
  private pulseStart = -1e3;

  // splat staging (flushed in chunks of MAX_SPLATS)
  private velPosRad = new Float32Array(SPLAT_CAP * 4);
  private velVal = new Float32Array(SPLAT_CAP * 4);
  private velCount = 0;
  private dyePosRad = new Float32Array(SPLAT_CAP * 4);
  private dyeVal = new Float32Array(SPLAT_CAP * 4);
  private dyeCount = 0;

  // scratch
  private tmpColor = new Float32Array(3);
  private posA = new Float32Array(2);
  private posB = new Float32Array(2);

  // ---------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const gl = ctx.gl;
    this.velAdvProg = compileProgram(gl, FS_TRIANGLE_VS, makeAdvectFS(true), 'fluid.advect.vel');
    this.advectProg = compileProgram(gl, FS_TRIANGLE_VS, makeAdvectFS(false), 'fluid.advect');
    this.splatProg = compileProgram(gl, FS_TRIANGLE_VS, SPLAT_FS, 'fluid.splat');
    this.curlProg = compileProgram(gl, FS_TRIANGLE_VS, CURL_FS, 'fluid.curl');
    this.vortProg = compileProgram(gl, FS_TRIANGLE_VS, VORTICITY_FS, 'fluid.vorticity');
    this.divProg = compileProgram(gl, FS_TRIANGLE_VS, DIVERGENCE_FS, 'fluid.divergence');
    this.clearProg = compileProgram(gl, FS_TRIANGLE_VS, CLEAR_FS, 'fluid.clear');
    this.pressureProg = compileProgram(gl, FS_TRIANGLE_VS, PRESSURE_FS, 'fluid.pressure');
    this.gradProg = compileProgram(gl, FS_TRIANGLE_VS, GRADIENT_FS, 'fluid.gradient');
    this.pulseProg = compileProgram(gl, FS_TRIANGLE_VS, PULSE_FS, 'fluid.pulse');
    this.renderProg = compileProgram(gl, FS_TRIANGLE_VS, RENDER_FS, 'fluid.render');
    this.velAdvU = new UniformSetter(gl, this.velAdvProg);
    this.advectU = new UniformSetter(gl, this.advectProg);
    this.splatU = new UniformSetter(gl, this.splatProg);
    this.curlU = new UniformSetter(gl, this.curlProg);
    this.vortU = new UniformSetter(gl, this.vortProg);
    this.divU = new UniformSetter(gl, this.divProg);
    this.clearU = new UniformSetter(gl, this.clearProg);
    this.pressureU = new UniformSetter(gl, this.pressureProg);
    this.gradU = new UniformSetter(gl, this.gradProg);
    this.pulseU = new UniformSetter(gl, this.pulseProg);
    this.renderU = new UniformSetter(gl, this.renderProg);

    this.softGL = detectSoftwareGL(gl);
    this.computeGeometry(ctx);
    const vel = fitGrid(this.velLong(ctx), ctx.width, ctx.height);
    const dye = fitGrid(this.dyeLong(ctx), ctx.width, ctx.height);
    this.velW = vel.w; this.velH = vel.h;
    this.dyeW = dye.w; this.dyeH = dye.h;
    this.velocity = new PingPong(gl, vel.w, vel.h, gl.RG16F);
    this.dye = new PingPong(gl, dye.w, dye.h, gl.RGBA16F);
    this.pressure = new PingPong(gl, vel.w, vel.h, gl.R16F);
    this.curlTex = makeTexture(gl, { w: vel.w, h: vel.h, internalFormat: gl.R16F });
    this.curlFbo = createFBO(gl, this.curlTex);
    this.divTex = makeTexture(gl, { w: vel.w, h: vel.h, internalFormat: gl.R16F });
    this.divFbo = createFBO(gl, this.divTex);
    // HDR scene at exactly dye resolution → single-tap present, LINEAR upsample
    this.post = createPost(gl, dye.w, dye.h);
    this.jacobi = this.softGL
      ? (ctx.quality >= 0.95 ? 14 : ctx.quality >= 0.65 ? 12 : 10)
      : (ctx.quality >= 0.95 ? 24 : ctx.quality >= 0.65 ? 20 : 14);

    this.pulseStart = -1e3;
    this.wasDown = false;
    this.velCount = 0;
    this.dyeCount = 0;
    this.ready = true;

    // zero-input life: seed a composition + pre-warm so frame 1 is alive
    this.seed(ctx, this.effTheme(ctx), this.softGL ? 8 : 14);
  }

  resize(ctx: ModeContext): void {
    if (!this.ready) return;
    const gl = ctx.gl;
    this.computeGeometry(ctx);
    const vel = fitGrid(this.velLong(ctx), ctx.width, ctx.height);
    const dye = fitGrid(this.dyeLong(ctx), ctx.width, ctx.height);
    this.post?.resize(dye.w, dye.h);
    if (vel.w === this.velW && vel.h === this.velH && dye.w === this.dyeW && dye.h === this.dyeH) return;
    this.velW = vel.w; this.velH = vel.h;
    this.dyeW = dye.w; this.dyeH = dye.h;
    this.velocity!.resize(vel.w, vel.h);
    this.dye!.resize(dye.w, dye.h);
    this.pressure!.resize(vel.w, vel.h);
    if (this.curlTex) gl.deleteTexture(this.curlTex);
    if (this.curlFbo) gl.deleteFramebuffer(this.curlFbo);
    if (this.divTex) gl.deleteTexture(this.divTex);
    if (this.divFbo) gl.deleteFramebuffer(this.divFbo);
    this.curlTex = makeTexture(gl, { w: vel.w, h: vel.h, internalFormat: gl.R16F });
    this.curlFbo = createFBO(gl, this.curlTex);
    this.divTex = makeTexture(gl, { w: vel.w, h: vel.h, internalFormat: gl.R16F });
    this.divFbo = createFBO(gl, this.divTex);
    this.seed(ctx, this.effTheme(ctx), this.softGL ? 8 : 12);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (key === 'vorticity') this.vorticity = clamp(v, 0, 50);
    else if (key === 'persistence') this.persistence = clamp(v, 0.9, 0.9995);
    else if (key === 'brush') this.brush = clamp(v, 0.1, 4);
  }

  frame(ctx: ModeContext): void {
    if (!this.ready || !this.post) return;
    const gl = ctx.gl;
    if (ctx.pulse) this.pulseStart = ctx.time;
    const p = ctx.pointer;
    if (p.down && !this.wasDown) this.strokeSeed = (this.strokeSeed + 0.383) % 1;
    this.wasDown = p.down;
    const th = this.effTheme(ctx);
    // advection stays accurate at ≤1/30; injection/decay budgets follow the
    // engine-clamped real dt so brightness balance survives low fps.
    const dtSim = clamp(ctx.dt, 1 / 240, 1 / 30);
    const dtReal = clamp(ctx.dt, 1 / 240, 1 / 20);

    this.step(ctx, dtSim, dtReal, ctx.time, th, true, this.jacobi);

    this.post.begin();
    gl.useProgram(this.renderProg);
    const u = this.renderU!;
    u.setTexture('uDye', this.dye!.read.tex, 0);
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.35, bloom: 0.75, vignette: 0.32 });
    // post.end leaves: FBO null, blend off, VAO null, activeTexture TEXTURE0
  }

  destroy(gl: WebGL2RenderingContext): void {
    const progs = [
      this.velAdvProg, this.advectProg, this.splatProg, this.curlProg, this.vortProg, this.divProg,
      this.clearProg, this.pressureProg, this.gradProg, this.pulseProg, this.renderProg,
    ];
    for (const prog of progs) if (prog) gl.deleteProgram(prog);
    this.velAdvProg = this.advectProg = this.splatProg = this.curlProg = this.vortProg = this.divProg = null;
    this.clearProg = this.pressureProg = this.gradProg = this.pulseProg = this.renderProg = null;
    this.velAdvU = this.advectU = this.splatU = this.curlU = this.vortU = this.divU = null;
    this.clearU = this.pressureU = this.gradU = this.pulseU = this.renderU = null;
    this.velocity?.destroy();
    this.dye?.destroy();
    this.pressure?.destroy();
    this.velocity = this.dye = this.pressure = null;
    if (this.curlTex) gl.deleteTexture(this.curlTex);
    if (this.curlFbo) gl.deleteFramebuffer(this.curlFbo);
    if (this.divTex) gl.deleteTexture(this.divTex);
    if (this.divFbo) gl.deleteFramebuffer(this.divFbo);
    this.curlTex = this.divTex = null;
    this.curlFbo = this.divFbo = null;
    this.post?.destroy();
    this.post = null;
    this.ready = false;
  }

  // --- geometry & theme -------------------------------------------------------

  private computeGeometry(ctx: ModeContext): void {
    this.minSide = Math.max(1, Math.min(ctx.width, ctx.height));
    this.aspectX = ctx.width / this.minSide;
    this.aspectY = ctx.height / this.minSide;
    // stretch emitter orbits along the long axis so they fill the frame
    this.orbitRx = 1 + 0.55 * (this.aspectX - 1);
    this.orbitRy = 1 + 0.55 * (this.aspectY - 1);
  }

  private velLong(ctx: ModeContext): number {
    return Math.max(64, Math.round((this.softGL ? VEL_LONG_SOFT : VEL_LONG) * ctx.quality));
  }

  private dyeLong(ctx: ModeContext): number {
    const cap = this.softGL ? DYE_LONG_CAP_SOFT : DYE_LONG_CAP;
    return Math.max(128, Math.round(Math.min(cap, Math.max(ctx.width, ctx.height)) * ctx.quality));
  }

  private effTheme(ctx: ModeContext): Theme {
    return ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
  }

  // --- one simulation step -----------------------------------------------------

  private step(ctx: ModeContext, dt: number, dtReal: number, time: number, th: Theme, live: boolean, iters: number): void {
    const gl = ctx.gl;
    const vel = this.velocity!;
    const dye = this.dye!;
    const pr = this.pressure!;
    const vtx = 1 / this.velW;
    const vty = 1 / this.velH;

    gl.disable(gl.BLEND);

    // 1) advect velocity by itself (self variant: single-tap trace start)
    gl.useProgram(this.velAdvProg);
    const vau = this.velAdvU!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
    gl.viewport(0, 0, this.velW, this.velH);
    vau.setTexture('uVelocity', vel.read.tex, 0);
    vau.setTexture('uSource', vel.read.tex, 1);
    vau.set2f('uVelTexel', vtx, vty);
    vau.set2f('uSrcTexel', vtx, vty);
    vau.set1f('uDt', dt);
    vau.set1f('uDissipation', Math.exp(-VEL_DECAY * dtReal));
    drawFullscreen(gl);
    vel.swap();

    // 2) forces & dye injection (same frame as the input)
    this.velCount = 0;
    this.dyeCount = 0;
    this.addEmitterSplats(dtReal, time, th);
    if (live) this.addPointerSplats(ctx, dt, time, th);
    this.flushSplats(gl, vel.read.fbo, this.velW, this.velH, this.velPosRad, this.velVal, this.velCount);
    this.flushSplats(gl, dye.read.fbo, this.dyeW, this.dyeH, this.dyePosRad, this.dyeVal, this.dyeCount);
    if (live) this.applyPulse(ctx, dt, dtReal, time, th);

    // 3) curl
    gl.useProgram(this.curlProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.curlFbo);
    gl.viewport(0, 0, this.velW, this.velH);
    this.curlU!.setTexture('uVelocity', vel.read.tex, 0);
    this.curlU!.set2f('uTexel', vtx, vty);
    drawFullscreen(gl);

    // 4) vorticity confinement
    gl.useProgram(this.vortProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
    const vu = this.vortU!;
    vu.setTexture('uVelocity', vel.read.tex, 0);
    vu.setTexture('uCurl', this.curlTex!, 1);
    vu.set2f('uTexel', vtx, vty);
    vu.set1f('uStrength', this.vorticity);
    vu.set1f('uDt', dt);
    drawFullscreen(gl);
    vel.swap();

    // 5) divergence
    gl.useProgram(this.divProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.divFbo);
    this.divU!.setTexture('uVelocity', vel.read.tex, 0);
    this.divU!.set2f('uTexel', vtx, vty);
    drawFullscreen(gl);

    // 6) pressure warm start (p *= 0.8) then Jacobi
    gl.useProgram(this.clearProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pr.write.fbo);
    this.clearU!.setTexture('uTex', pr.read.tex, 0);
    this.clearU!.set1f('uValue', 0.8);
    drawFullscreen(gl);
    pr.swap();

    gl.useProgram(this.pressureProg);
    const pu = this.pressureU!;
    pu.setTexture('uDivergence', this.divTex!, 1);
    pu.set2f('uTexel', vtx, vty);
    for (let i = 0; i < iters; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, pr.write.fbo);
      pu.setTexture('uPressure', pr.read.tex, 0);
      drawFullscreen(gl);
      pr.swap();
    }

    // 7) subtract pressure gradient
    gl.useProgram(this.gradProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, vel.write.fbo);
    const gu = this.gradU!;
    gu.setTexture('uPressure', pr.read.tex, 0);
    gu.setTexture('uVelocity', vel.read.tex, 1);
    gu.set2f('uTexel', vtx, vty);
    drawFullscreen(gl);
    vel.swap();

    // 8) advect dye (manual bilerp on both velocity and dye)
    gl.useProgram(this.advectProg);
    const au = this.advectU!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dye.write.fbo);
    gl.viewport(0, 0, this.dyeW, this.dyeH);
    au.setTexture('uVelocity', vel.read.tex, 0);
    au.setTexture('uSource', dye.read.tex, 1);
    au.set2f('uVelTexel', vtx, vty);
    au.set2f('uSrcTexel', 1 / this.dyeW, 1 / this.dyeH);
    au.set1f('uDt', dt);
    au.set1f('uDissipation', Math.exp(Math.log(this.persistence) * 60 * dtReal));
    drawFullscreen(gl);
    dye.swap();
  }

  // --- splat sources ------------------------------------------------------------

  private pushVel(x: number, y: number, r: number, vx: number, vy: number): void {
    if (this.velCount >= SPLAT_CAP) return;
    const o = this.velCount * 4;
    this.velPosRad[o] = x; this.velPosRad[o + 1] = y; this.velPosRad[o + 2] = r; this.velPosRad[o + 3] = 0;
    this.velVal[o] = vx; this.velVal[o + 1] = vy; this.velVal[o + 2] = 0; this.velVal[o + 3] = 0;
    this.velCount++;
  }

  private pushDye(x: number, y: number, r: number, cr: number, cg: number, cb: number): void {
    if (this.dyeCount >= SPLAT_CAP) return;
    const o = this.dyeCount * 4;
    this.dyePosRad[o] = x; this.dyePosRad[o + 1] = y; this.dyePosRad[o + 2] = r; this.dyePosRad[o + 3] = 0;
    this.dyeVal[o] = cr; this.dyeVal[o + 1] = cg; this.dyeVal[o + 2] = cb; this.dyeVal[o + 3] = 0;
    this.dyeCount++;
  }

  private flushSplats(
    gl: WebGL2RenderingContext,
    fbo: WebGLFramebuffer, w: number, h: number,
    posRad: Float32Array, val: Float32Array, count: number,
  ): void {
    if (count === 0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive into RGBA16F/RG16F — allowed
    gl.useProgram(this.splatProg);
    const u = this.splatU!;
    u.set2f('uAspect', this.aspectX, this.aspectY);
    for (let o = 0; o < count; o += MAX_SPLATS) {
      const n = Math.min(MAX_SPLATS, count - o);
      u.set1i('uCount', n);
      u.set4fv('uPosRad[0]', posRad.subarray(o * 4, (o + n) * 4));
      u.set4fv('uVal[0]', val.subarray(o * 4, (o + n) * 4));
      drawFullscreen(gl);
    }
    gl.disable(gl.BLEND);
  }

  /** Orbit position of idle emitter `i` at time `t`, in q-space. */
  private emitterPos(i: number, t: number, out: Float32Array): void {
    const e = EMITTERS[i];
    const a = e.phase + t * e.speed;
    const r = e.rBase + e.rAmp * Math.sin(t * e.breath + e.phase * 3.1);
    const cx = this.aspectX * 0.5 + Math.sin(t * e.wobble + i * 2.3) * 0.05 * this.aspectX;
    const cy = this.aspectY * 0.5 + Math.cos(t * e.wobble * 1.13 + i * 1.7) * 0.05 * this.aspectY;
    out[0] = cx + Math.cos(a) * r * this.orbitRx;
    out[1] = cy + Math.sin(a) * r * this.orbitRy;
  }

  /** 2–3 invisible orbiting emitters: gentle swirl + palette-tinted dye forever. */
  private addEmitterSplats(dt: number, time: number, th: Theme): void {
    const simMin = Math.min(this.velW, this.velH);
    const dt60 = Math.min(3, dt * 60);
    // keep the idle dye budget balanced when persistence changes
    const dyeK = -Math.log(this.persistence) * 60;
    const budget = clamp(dyeK / DYE_K_DEFAULT, 0.35, 1.6);
    for (let i = 0; i < EMITTERS.length; i++) {
      this.emitterPos(i, time, this.posA);
      this.emitterPos(i, time - 0.25, this.posB);
      const pvx = (this.posA[0] - this.posB[0]) / 0.25; // q/s path velocity
      const pvy = (this.posA[1] - this.posB[1]) / 0.25;
      // tangential push along the path + a slowly rotating shear component
      const s = Math.sin(time * 0.5 + i * 2.1) * 0.7;
      const fx = (pvx + -pvy * s) * EMIT_GAIN * dt60 * simMin;
      const fy = (pvy + pvx * s) * EMIT_GAIN * dt60 * simMin;
      this.pushVel(this.posA[0], this.posA[1], 0.08, fx, fy);

      // avoid the near-white palette top for broad idle sources
      const e = EMITTERS[i];
      const palT = e.palLo + (e.palHi - e.palLo) * tri(e.palOff + time * 0.011);
      pal(th.colors, palT, this.tmpColor);
      // slow amplitude breathing → waves of brightness drifting through idle
      const breathe = 0.75 + 0.35 * Math.sin(time * 0.11 + i * 2.6);
      const amt = 0.048 * dt60 * budget * breathe;
      this.pushDye(this.posA[0], this.posA[1], 0.055, this.tmpColor[0] * amt, this.tmpColor[1] * amt, this.tmpColor[2] * amt);
    }
  }

  /** Pointer (and multitouch) strokes, interpolated along the drag path. */
  private addPointerSplats(ctx: ModeContext, dt: number, time: number, th: Theme): void {
    const p = ctx.pointer;
    const m = this.minSide;
    if (p.touches.length > 0) {
      for (let i = 0; i < p.touches.length; i++) {
        const t = p.touches[i];
        this.stroke(t.x / m, t.y / m, t.dx / m, t.dy / m, i, dt, time, th);
      }
    } else if (p.down) {
      this.stroke(p.x / m, p.y / m, p.dx / m, p.dy / m, 0, dt, time, th);
    }
  }

  private stroke(qx: number, qy: number, dqx: number, dqy: number, idx: number, dt: number, time: number, th: Theme): void {
    const simMin = Math.min(this.velW, this.velH);
    const dist = Math.hypot(dqx, dqy);   // q-units travelled this frame
    const speedPS = dist / dt;           // q-units/second — fps-independent
    // slow drag = fat plume, fast flick = long thin jet
    const radius = 0.05 * this.brush * (0.5 + 1.0 / (1 + speedPS * 1.2));
    let vx = (dqx / dt) * POINTER_GAIN;
    let vy = (dqy / dt) * POINTER_GAIN;
    const vm = Math.hypot(vx, vy);
    if (vm > POINTER_VMAX) { vx *= POINTER_VMAX / vm; vy *= POINTER_VMAX / vm; }
    vx *= simMin;
    vy *= simMin;

    const palT = 0.45 + 0.55 * tri(this.strokeSeed + idx * 0.23 + time * 0.02);
    pal(th.colors, palT, this.tmpColor);
    // sub-splats at ~0.7 radius spacing → deposit scales with path length and
    // stays fps-independent; a stationary hold only smolders, never floods
    const amt = 0.42 * Math.min(1, 0.12 + speedPS * 0.9);

    const n = Math.max(1, Math.min(8, Math.ceil(dist / (radius * 0.7))));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = qx - dqx * (1 - t);
      const y = qy - dqy * (1 - t);
      this.pushVel(x, y, radius * 1.3, vx, vy);
      this.pushDye(x, y, radius, this.tmpColor[0] * amt, this.tmpColor[1] * amt, this.tmpColor[2] * amt);
    }
  }

  /** Pulse = spectacle: expanding radial shockwave + dye ring from center. */
  private applyPulse(ctx: ModeContext, dt: number, dtReal: number, time: number, th: Theme): void {
    const age = time - this.pulseStart;
    if (age < 0 || age > PULSE_DUR) return;
    const gl = ctx.gl;
    const k = 1 - age / PULSE_DUR;
    const simMin = Math.min(this.velW, this.velH);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pulseProg);
    const u = this.pulseU!;
    u.set2f('uAspect', this.aspectX, this.aspectY);
    u.set2f('uCenter', this.aspectX * 0.5, this.aspectY * 0.5);
    u.set1f('uRadius', 0.05 + age * 2.4);
    u.set1f('uWidth', 0.1 + age * 0.25);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.velocity!.read.fbo);
    gl.viewport(0, 0, this.velW, this.velH);
    u.set1f('uMode', 0);
    u.set1f('uVelAmp', 30 * dt * k * k * simMin);
    drawFullscreen(gl);

    pal(th.colors, 0.88, this.tmpColor);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.dye!.read.fbo);
    gl.viewport(0, 0, this.dyeW, this.dyeH);
    u.set1f('uMode', 1);
    u.set3f('uColor', this.tmpColor[0], this.tmpColor[1], this.tmpColor[2]);
    u.set1f('uDyeAmp', 5 * dtReal * k);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
  }

  // --- seeding / pre-warm ---------------------------------------------------------

  private clearTarget(gl: WebGL2RenderingContext, fbo: WebGLFramebuffer): void {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Paint an initial composition (dye blobs + counter-rotating vortices), then pre-warm. */
  private seed(ctx: ModeContext, th: Theme, prewarm: number): void {
    const gl = ctx.gl;
    for (const pp of [this.velocity!, this.dye!, this.pressure!]) {
      this.clearTarget(gl, pp.read.fbo);
      this.clearTarget(gl, pp.write.fbo);
    }
    this.clearTarget(gl, this.curlFbo!);
    this.clearTarget(gl, this.divFbo!);

    const simMin = Math.min(this.velW, this.velH);
    const cx = this.aspectX * 0.5;
    const cy = this.aspectY * 0.5;
    this.velCount = 0;
    this.dyeCount = 0;
    const NB = 5;
    for (let i = 0; i < NB; i++) {
      const a = i * 2.399 + 0.9; // golden-angle spiral composition
      const rad = 0.12 + 0.3 * (i / (NB - 1));
      const x = cx + Math.cos(a) * rad * this.orbitRx;
      const y = cy + Math.sin(a) * rad * this.orbitRy;
      const R = 0.1 + 0.05 * tri(i * 0.41 + 0.2);
      pal(th.colors, 0.2 + 0.65 * (i / (NB - 1)), this.tmpColor);
      this.pushDye(x, y, R, this.tmpColor[0] * 0.55, this.tmpColor[1] * 0.55, this.tmpColor[2] * 0.55);
      const dir = i % 2 === 0 ? 1 : -1;
      for (let k = 0; k < 6; k++) {
        const b = (k / 6) * Math.PI * 2;
        this.pushVel(
          x + Math.cos(b) * R * 0.7, y + Math.sin(b) * R * 0.7, R * 0.5,
          -Math.sin(b) * dir * 1.5 * simMin, Math.cos(b) * dir * 1.5 * simMin,
        );
      }
    }
    this.flushSplats(gl, this.velocity!.read.fbo, this.velW, this.velH, this.velPosRad, this.velVal, this.velCount);
    this.flushSplats(gl, this.dye!.read.fbo, this.dyeW, this.dyeH, this.dyePosRad, this.dyeVal, this.dyeCount);
    this.velCount = 0;
    this.dyeCount = 0;

    // pre-warm: bigger dt + under-solved pressure keep the init hitch small
    const iters = Math.min(this.jacobi, 6);
    for (let s = 0; s < prewarm; s++) {
      this.step(ctx, 1 / 30, 1 / 30, ctx.time - (prewarm - s) / 30, th, false, iters);
    }
  }
}

export const fluidMode: Mode = new FluidMode();
