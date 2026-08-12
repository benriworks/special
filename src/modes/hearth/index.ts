/**
 * HEARTH — 暖炉. A realistic fireplace fire you could leave on all evening.
 *
 * Flame body (two engines, one composite — see shaders.ts):
 *  (a) heat/velocity field sim (RGBA16F ping-pong, ≤256-long-side × quality):
 *      buoyant self-advection + curl-noise turbulence, heat splat-injected at
 *      the log line — hardware GL. Forced testable via #…&hearthsim=1.
 *  (b) procedural advected-fbm flame shaped by a CPU-flickered bed profile —
 *      the software-GL (SwiftShader) preset.
 * Around it: banked Worley-cell coals breathing individually, log silhouettes
 * with pulsing crack veins, spark particles (MRT pool, gl.LINES), heat
 * shimmer, and firelight spill that lags the flames by ~100ms.
 *
 * Life: 5 emitter flickers on incommensurate frequencies (0.3Hz breath →
 * ~10Hz micro-flicker), random pops (6–15s) with spark bursts + log
 * micro-settles, and a ~2min idle bank-down to glowing coals (any touch
 * flares it back). Interactions: drag = 火かき棒 poker (stirs heat, kicks
 * sparks, bends flames), hold = ふいご bellows (local roar-up), pulse =
 * 焚き付け kindling toss (bed-wide surge + spark fountain + persistent
 * embers). Audio (null ⇒ bit-identical): level swells the fire; a sustained
 * broadband spike — blowing on the mic — bends the flames downwind.
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import {
  FS_TRIANGLE_VS, PingPong, UniformSetter, compileProgram, drawFullscreen, makeTexture,
} from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';
import {
  MAX_SEVENTS, MAX_SPLATS, SIM_FS, SK_COAL, SK_FOUNTAIN, SK_POP, SK_STROKE,
  SPARK_DRAW_FS, SPARK_DRAW_VS, SPARK_UPDATE_FS, SPLAT_FS, makeCompositeFS,
} from './shaders';

// --- tuning ----------------------------------------------------------------

const FIELD_LONG = 256;        // heat-field long side at quality 1.0 (sim path)
const SPARK_REF = 3136;        // 56² — reference pool for count scaling
const N_EMIT = 5;
const EMIT_FX = [-0.72, -0.36, 0.04, 0.42, 0.74];          // × bedHalf
const EMIT_W = [0.11, 0.13, 0.16, 0.13, 0.10];             // gaussian halfwidth (q at bedHalf 0.42)
const EMIT_W1 = [2.1, 2.7, 1.7, 2.4, 3.1];                 // slow breath (rad/s)
const EMIT_W2 = [9.3, 11.7, 8.1, 10.9, 12.7];              // flame flap
const EMIT_W3 = [57, 66, 74, 61, 69];                      // ~9–12Hz micro-flicker
const EMIT_PH = [0.7, 2.9, 5.1, 1.9, 4.2];
const LOG_SEED = [0.17, 0.55, 0.91];
const STIR_N = 8;
const STIR_TAU = 1.1;          // poker disturbance decay (s)
const BANK_IDLE_S = 115;       // untouched this long → start banking down
const KINDLE_TAU = 0.9;
const WARM_STEPS = 30;
const WARM_DT = 1 / 30;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

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

interface SparkEv { kind: number; count: number; b0: number; b1: number; b2: number; b3: number; seed: number }

class HearthMode implements Mode {
  readonly id = 'hearth';
  readonly name = { ja: '暖炉', en: 'Hearth' };
  readonly params: ParamDef[] = [
    { key: 'intensity', label: { ja: '火力', en: 'Intensity' }, type: 'range', min: 0.4, max: 1.6, step: 0.05, default: 1 },
    { key: 'sparks', label: { ja: '火の粉', en: 'Sparks' }, type: 'range', min: 0.3, max: 2, step: 0.05, default: 1 },
    { key: 'shimmer', label: { ja: '揺らぎ', en: 'Shimmer' }, type: 'range', min: 0, max: 1.5, step: 0.05, default: 0.8 },
  ];

  // live params (instance persists across quality re-inits)
  private intensity = 1;
  private sparkAmt = 1;
  private shimmer = 0.8;

  // programs
  private simProg: WebGLProgram | null = null;
  private splatProg: WebGLProgram | null = null;
  private compProg: WebGLProgram | null = null;
  private supdProg: WebGLProgram | null = null;
  private sdrawProg: WebGLProgram | null = null;
  private simU: UniformSetter | null = null;
  private splatU: UniformSetter | null = null;
  private compU: UniformSetter | null = null;
  private supdU: UniformSetter | null = null;
  private sdrawU: UniformSetter | null = null;

  // targets
  private field: PingPong | null = null;
  private sparkPairs: { pos: WebGLTexture; vel: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private sparkRead = 0;
  private sparkVao: WebGLVertexArrayObject | null = null;
  private post: Post | null = null;

  // geometry / presets
  private softGL = false;
  private useSim = false;
  private postScale = 0.6;
  private fieldW = 2;
  private fieldH = 2;
  private simMin = 2;            // field texels per q unit
  private sparkSide = 40;
  private sparkCount = 1600;
  private cScale = 1;
  private minSide = 1;
  private aspectX = 1;
  private aspectY = 1;
  private cx = 0.5;
  private bedHalf = 0.42;
  private baseY = 0.12; // hearth floor line (q) — lifts the fire clear of the UI bar

  // wall-clock detail governor
  private detail = 1;
  private frameEma = 1 / 60;
  private lastNowMs = -1;
  private slowT = 0;
  private fastT = 0;
  private sparkStride = 1;

  // fire state
  private ready = false;
  private t0 = 0;
  private lastInteract = 0;
  private bank = 1;
  private kindleT = -1e3;
  private fountainUntil = -1e3;
  private lumEma = 0.5;
  private coalAcc = 0;
  private bellowsAcc = 0;
  private nextPopAt = 0;
  private nextSettleAt = 0;
  private popX = 0.5;
  private popY = 0.08;
  private popT = -1e3;
  private embers: { x: number; y: number; s: number }[] = [];
  private eFlick = new Float32Array(N_EMIT);
  private emitX = new Float32Array(N_EMIT);
  private emitW = new Float32Array(N_EMIT);

  // logs: base endpoints (recomputed on resize) + settle animation
  private logBase: { ax: number; ay: number; bx: number; by: number; r: number }[] = [];
  private logDy = new Float32Array(3);
  private logDyFrom = new Float32Array(3);
  private logDyTo = new Float32Array(3);
  private logSettleT = new Float32Array(3).fill(-1e3);

  // poker stirs (ring buffer)
  private stirs: { x: number; y: number; vx: number; vy: number; t0: number }[] = [];
  private stirIdx = 0;
  private lastStirX = -10;
  private lastStirY = -10;
  private lastStirT = -10;

  // bellows
  private stillT = 0;
  private bellows = 0;
  private bellowsX = 0.5;
  private bellowsY = 0.3;
  private wasDown = false;

  // audio (all zero when ctx.audio === null → exact no-op)
  private aLevel = 0;
  private fastEma = 0;
  private slowEma = 0;
  private blowHold = 0;
  private gust = 0;
  private gustDir = 1;

  // splat staging (sim path)
  private splatPosRad = new Float32Array(MAX_SPLATS * 4);
  private splatVal = new Float32Array(MAX_SPLATS * 4);
  private splatCount = 0;

  // spark spawn staging
  private pendingSp: SparkEv[] = [];
  private sparkCursor = 0;
  private spA = new Float32Array(MAX_SEVENTS * 4);
  private spB = new Float32Array(MAX_SEVENTS * 4);

  // scratch
  private colorBuf = new Float32Array(18);
  private tmp3 = new Float32Array(3);
  private hotCol = new Float32Array(3);
  private coolCol = new Float32Array(3);
  private emitBuf = new Float32Array(N_EMIT * 4);
  private logABuf = new Float32Array(12);
  private logBBuf = new Float32Array(12);
  private emberBuf = new Float32Array(24);
  private stirBuf = new Float32Array(STIR_N * 4);

  // ---------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    // (a) honest heat sim on real GPUs; (b) procedural preset on software GL.
    // #…&hearthsim=1 forces (a) so the sim path stays testable under SwiftShader.
    this.useSim = !this.softGL || /hearthsim=1/.test(location.hash);
    this.postScale = this.softGL
      ? clamp(0.42 + 0.12 * ctx.quality, 0.42, 0.54)
      : clamp(0.58 + 0.22 * ctx.quality, 0.6, 0.8);
    this.detail = this.softGL && ctx.quality <= 0.5 ? 0 : 1;
    this.sparkStride = 1;
    this.frameEma = 1 / 60;
    this.lastNowMs = -1;
    this.slowT = 0;
    this.fastT = 0;

    this.compProg = compileProgram(gl, FS_TRIANGLE_VS, makeCompositeFS(this.useSim), 'hearth.composite');
    this.supdProg = compileProgram(gl, FS_TRIANGLE_VS, SPARK_UPDATE_FS, 'hearth.spark.update');
    this.sdrawProg = compileProgram(gl, SPARK_DRAW_VS, SPARK_DRAW_FS, 'hearth.spark.draw');
    this.compU = new UniformSetter(gl, this.compProg);
    this.supdU = new UniformSetter(gl, this.supdProg);
    this.sdrawU = new UniformSetter(gl, this.sdrawProg);

    this.computeGeometry(ctx);

    if (this.useSim) {
      this.simProg = compileProgram(gl, FS_TRIANGLE_VS, SIM_FS, 'hearth.sim');
      this.splatProg = compileProgram(gl, FS_TRIANGLE_VS, SPLAT_FS, 'hearth.splat');
      this.simU = new UniformSetter(gl, this.simProg);
      this.splatU = new UniformSetter(gl, this.splatProg);
      const grid = fitGrid(Math.max(128, Math.round(FIELD_LONG * ctx.quality)), ctx.width, ctx.height);
      this.fieldW = grid.w;
      this.fieldH = grid.h;
      this.simMin = Math.min(grid.w, grid.h);
      this.field = new PingPong(gl, grid.w, grid.h, gl.RGBA16F);
    }

    // spark pool: MRT RGBA32F pos/vel pair (hanabi idiom), zero-inited = dead
    const sideBase = this.softGL ? 40 : 56;
    this.sparkSide = Math.max(30, Math.round(sideBase * Math.sqrt(ctx.quality)));
    this.sparkCount = this.sparkSide * this.sparkSide;
    this.cScale = this.sparkCount / SPARK_REF;
    this.sparkPairs = [];
    for (let i = 0; i < 2; i++) {
      const pos = makeTexture(gl, { w: this.sparkSide, h: this.sparkSide, internalFormat: gl.RGBA32F });
      const vel = makeTexture(gl, { w: this.sparkSide, h: this.sparkSide, internalFormat: gl.RGBA32F });
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('hearth: createFramebuffer failed');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pos, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, vel, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`hearth: MRT framebuffer incomplete (0x${status.toString(16)})`);
      }
      this.sparkPairs.push({ pos, vel, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.sparkRead = 0;
    this.sparkVao = gl.createVertexArray();

    this.post = createPost(
      gl,
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );

    // state reset — the fire has been burning for a while already
    this.t0 = 40 + Math.random() * 400;
    this.lastInteract = ctx.time;
    this.bank = 1;
    this.kindleT = -1e3;
    this.fountainUntil = -1e3;
    this.lumEma = 0.55;
    this.coalAcc = 0;
    this.bellowsAcc = 0;
    this.popT = -1e3;
    this.nextPopAt = ctx.time + rand(4, 9);
    this.nextSettleAt = ctx.time + rand(20, 40);
    this.embers.length = 0;
    this.stirs.length = 0;
    this.stirIdx = 0;
    this.lastStirT = -10;
    this.stillT = 0;
    this.bellows = 0;
    this.wasDown = false;
    this.aLevel = 0;
    this.fastEma = 0;
    this.slowEma = 0;
    this.blowHold = 0;
    this.gust = 0;
    this.pendingSp.length = 0;
    this.sparkCursor = 0;
    this.logDy.fill(0);
    this.logDyFrom.fill(0);
    this.logDyTo.fill(0);
    this.logSettleT.fill(-1e3);
    this.ready = true;

    this.prewarm(ctx);
  }

  /** Pre-warm: the field carries a developed plume and sparks are mid-flight
   *  so frame 1 is already a living fire (contract). */
  private prewarm(ctx: ModeContext): void {
    const { gl } = ctx;
    if (this.field) {
      for (const side of [this.field.read, this.field.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, side.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
    for (let i = 0; i < WARM_STEPS; i++) {
      const t = ctx.time - (WARM_STEPS - i) * WARM_DT;
      this.updateFlicker(t, 1);
      if (this.useSim) {
        this.splatCount = 0;
        this.addEmitterSplats(WARM_DT);
        this.stepField(gl, WARM_DT, t, 0);
      }
      if (i % 4 === 0) {
        this.queueSpark(SK_COAL, Math.max(2, Math.round(3 * this.cScale * this.sparkAmt)),
          this.emitX[i % N_EMIT] + rand(-0.05, 0.05), this.baseY + 0.07, 0.06, Math.random());
      }
      this.stepSparks(gl, WARM_DT, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  resize(ctx: ModeContext): void {
    if (!this.ready) return;
    this.computeGeometry(ctx);
    this.post?.resize(
      Math.max(1, Math.round(ctx.width * this.postScale)),
      Math.max(1, Math.round(ctx.height * this.postScale)),
    );
    if (this.field) {
      const grid = fitGrid(Math.max(128, Math.round(FIELD_LONG * ctx.quality)), ctx.width, ctx.height);
      if (grid.w !== this.fieldW || grid.h !== this.fieldH) {
        this.fieldW = grid.w;
        this.fieldH = grid.h;
        this.simMin = Math.min(grid.w, grid.h);
        this.field.resize(grid.w, grid.h);
      }
      this.prewarm(ctx);
    }
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (key === 'intensity') this.intensity = clamp(v, 0.4, 1.6);
    else if (key === 'sparks') this.sparkAmt = clamp(v, 0.3, 2);
    else if (key === 'shimmer') this.shimmer = clamp(v, 0, 1.5);
  }

  // --- geometry & theme -------------------------------------------------------

  private computeGeometry(ctx: ModeContext): void {
    this.minSide = Math.max(1, Math.min(ctx.width, ctx.height));
    this.aspectX = ctx.width / this.minSide;
    this.aspectY = ctx.height / this.minSide;
    this.cx = this.aspectX * 0.5;
    this.bedHalf = Math.min(0.46, this.aspectX * 0.40);
    this.baseY = Math.max(0.16, 0.115 * this.aspectY);
    const s = this.bedHalf / 0.42;
    for (let i = 0; i < N_EMIT; i++) {
      this.emitX[i] = this.cx + EMIT_FX[i] * this.bedHalf;
      this.emitW[i] = EMIT_W[i] * s;
    }
    const rs = Math.min(1, 0.55 + 0.45 * s);
    // a shallow X of two logs + a short stub behind — distinct silhouettes
    this.logBase = [
      { ax: this.cx - 0.370 * s, ay: 0.070, bx: this.cx + 0.260 * s, by: 0.100, r: 0.045 * rs },
      { ax: this.cx - 0.200 * s, ay: 0.155, bx: this.cx + 0.370 * s, by: 0.085, r: 0.038 * rs },
      { ax: this.cx - 0.100 * s, ay: 0.185, bx: this.cx + 0.140 * s, by: 0.200, r: 0.028 * rs },
    ];
  }

  private effTheme(ctx: ModeContext): Theme {
    return ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
  }

  // --- CPU fire life ----------------------------------------------------------

  /** Per-emitter flicker envelopes (slow breath × flap + micro-flicker),
   *  scaled by the global fire scale. Fills eFlick + returns the mean. */
  private updateFlicker(t: number, fireScale: number): number {
    let sum = 0;
    for (let i = 0; i < N_EMIT; i++) {
      const breath = 0.5 + 0.5 * Math.sin(t * EMIT_W1[i] + EMIT_PH[i]);
      const flap = 0.55 + 0.45 * Math.sin(t * EMIT_W2[i] + EMIT_PH[i] * 2.3);
      const micro = 0.14 * Math.sin(t * EMIT_W3[i] + EMIT_PH[i] * 4.1);
      const f = clamp(0.42 + 0.44 * breath * flap + micro, 0.12, 1.3) * fireScale;
      this.eFlick[i] = f;
      sum += f;
    }
    return sum / N_EMIT;
  }

  private kindleEnv(t: number): number {
    const e = Math.exp(-(t - this.kindleT) / KINDLE_TAU);
    return e > 0.01 ? e : 0;
  }

  private triggerSettle(t: number, log: number): void {
    this.logDyFrom[log] = this.logDy[log];
    this.logDyTo[log] = Math.max(-0.02, this.logDy[log] - rand(0.003, 0.008));
    this.logSettleT[log] = t;
  }

  private triggerPop(t: number): void {
    const e = Math.floor(Math.random() * N_EMIT);
    this.popX = this.emitX[e] + rand(-0.08, 0.08);
    this.popY = 0.05 + Math.random() * 0.07;
    this.popT = t;
    const n = Math.max(4, Math.round(rand(10, 30) * this.cScale * this.sparkAmt));
    this.queueSpark(SK_POP, n, this.popX, this.baseY + this.popY, rand(0.45, 0.85), 0);
    if (Math.random() < 0.4) {
      // the pop unsettles a log — pick the one nearest the pop
      let best = 0;
      let bd = 1e9;
      for (let i = 0; i < 3; i++) {
        const mx = (this.logBase[i].ax + this.logBase[i].bx) * 0.5;
        const d = Math.abs(mx - this.popX);
        if (d < bd) { bd = d; best = i; }
      }
      this.triggerSettle(t, best);
    }
    this.nextPopAt = t + rand(6, 15);
  }

  // --- pointer: poker strokes & bellows --------------------------------------

  private pushStir(x: number, y: number, vx: number, vy: number, t: number): void {
    if (this.stirs.length < STIR_N) this.stirs.push({ x, y, vx, vy, t0: t });
    else {
      const s = this.stirs[this.stirIdx % STIR_N];
      s.x = x; s.y = y; s.vx = vx; s.vy = vy; s.t0 = t;
    }
    this.stirIdx++;
    this.lastStirX = x;
    this.lastStirY = y;
    this.lastStirT = t;
  }

  private handlePointer(ctx: ModeContext, t: number, dt: number): void {
    const p = ctx.pointer;
    const m = this.minSide;
    if (p.down && !this.wasDown) this.lastInteract = t;
    this.wasDown = p.down;

    interface Pt { x: number; y: number; dx: number; dy: number }
    const pts: Pt[] = [];
    if (p.touches.length > 0) for (const tc of p.touches) pts.push(tc);
    else if (p.down) pts.push(p);

    let anyStroke = false;
    for (const pt of pts) {
      const qx = pt.x / m;
      const qy = pt.y / m;
      const dqx = pt.dx / m;
      const dqy = pt.dy / m;
      const speed = Math.hypot(dqx, dqy) / Math.max(dt, 1e-4);
      if (speed > 0.25) {
        anyStroke = true;
        this.lastInteract = t;
        // record a stir when we've moved on from the last one
        if (Math.hypot(qx - this.lastStirX, qy - this.lastStirY) > 0.05 || t - this.lastStirT > 0.09) {
          const vm = Math.min(2.5, speed);
          this.pushStir(qx, qy, (dqx / Math.max(dt, 1e-4)) * (vm / speed), (dqy / Math.max(dt, 1e-4)) * (vm / speed), t);
        }
        // sparks kicked along the stroke segment
        const n = Math.max(2, Math.min(48, Math.round((Math.hypot(dqx, dqy) * 240 + 3) * this.cScale * this.sparkAmt)));
        this.queueSpark(SK_STROKE, n, qx, qy, qx - dqx, qy - dqy);
        // sim path: inject velocity + a whiff of heat along the path
        if (this.useSim) {
          const g = Math.min(1.5, dt * 60) * 0.85;
          const steps = 3;
          for (let k = 1; k <= steps; k++) {
            const f = k / steps;
            this.pushSplat(qx - dqx * (1 - f), qy - dqy * (1 - f), 0.06,
              (dqx / Math.max(dt, 1e-4)) * g * this.simMin,
              (dqy / Math.max(dt, 1e-4)) * g * this.simMin,
              qy < 0.6 ? 0.9 * dt : 0);
          }
        }
      }
    }

    // bellows: primary pointer held still
    if (p.down && !anyStroke && Math.hypot(p.dx, p.dy) < 3 * ctx.dpr) this.stillT += dt;
    else this.stillT = 0;
    const target = p.down && this.stillT > 0.28 ? Math.min(1, (this.stillT - 0.28) / 1.1) : 0;
    const tau = target > this.bellows ? 0.22 : 0.3;
    this.bellows += (target - this.bellows) * Math.min(1, dt / tau);
    if (this.bellows < 0.01 && target === 0) this.bellows = 0;
    if (this.bellows > 0.03) {
      this.lastInteract = t;
      this.bellowsX = p.x / m;
      this.bellowsY = p.y / m;
      // rush of sparks while the bellows blow
      this.bellowsAcc += 26 * this.bellows * this.sparkAmt * this.cScale * dt;
      const n = Math.floor(this.bellowsAcc);
      if (n > 0) {
        this.bellowsAcc -= n;
        this.queueSpark(SK_FOUNTAIN, Math.min(n, 24), this.bellowsX, this.baseY + 0.08, 0.09, 0.8 + 0.5 * this.bellows);
      }
      if (this.useSim) {
        this.pushSplat(this.bellowsX, this.baseY + 0.1, 0.08,
          0, 3.2 * this.bellows * this.simMin * dt, 7.5 * this.bellows * dt);
      }
    }
  }

  // --- audio: swell + blow-gust (null ⇒ every value stays exactly 0) ----------

  private handleAudio(ctx: ModeContext, dt: number): void {
    const au = ctx.audio;
    if (au) {
      this.aLevel = au.level;
      this.fastEma += (au.level - this.fastEma) * Math.min(1, dt / 0.05);
      this.slowEma += (au.level - this.slowEma) * Math.min(1, dt / 1.6);
      // a blow is a SUSTAINED broadband spike — speech spikes don't hold 150ms
      const blowing = this.fastEma > this.slowEma * 1.8 + 0.12;
      this.blowHold = blowing ? this.blowHold + dt : 0;
      if (this.blowHold > 0.15) {
        if (this.gust < 0.05) this.gustDir = Math.random() < 0.5 ? -1 : 1;
        const target = Math.min(1, (this.fastEma - this.slowEma * 1.4) * 1.6);
        this.gust += (target - this.gust) * Math.min(1, dt / 0.12);
      } else {
        this.gust *= Math.exp(-dt / 0.4);
      }
    } else {
      this.aLevel = 0;
      this.fastEma = 0;
      this.slowEma = 0;
      this.blowHold = 0;
      this.gust *= Math.exp(-dt / 0.4);
    }
    if (this.gust < 0.01) this.gust = 0;
  }

  // --- sim path (a) -----------------------------------------------------------

  private pushSplat(x: number, y: number, r: number, vx: number, vy: number, heat: number): void {
    if (this.splatCount >= MAX_SPLATS) return;
    const o = this.splatCount * 4;
    this.splatPosRad[o] = x; this.splatPosRad[o + 1] = y; this.splatPosRad[o + 2] = r; this.splatPosRad[o + 3] = 0;
    this.splatVal[o] = vx; this.splatVal[o + 1] = vy; this.splatVal[o + 2] = heat; this.splatVal[o + 3] = 0;
    this.splatCount++;
  }

  /** Heat + updraft at the log line, driven by the flicker envelopes.
   *  Per-step adds are dt-scaled: heat equilibrium ≈ rate × residence time
   *  (the plume carries heat out of the injection zone in ~0.1s). */
  private addEmitterSplats(dt: number): void {
    for (let i = 0; i < N_EMIT; i++) {
      const f = this.eFlick[i];
      this.pushSplat(this.emitX[i], this.baseY + 0.09, this.emitW[i] * 0.8,
        0, 2.2 * f * this.simMin * dt, 3.6 * f * dt);
    }
  }

  /** One field step: advect+forces, then flush injection splats. */
  private stepField(gl: WebGL2RenderingContext, dt: number, t: number, windG: number): void {
    const field = this.field!;
    gl.disable(gl.BLEND);
    gl.useProgram(this.simProg);
    const u = this.simU!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, field.write.fbo);
    gl.viewport(0, 0, this.fieldW, this.fieldH);
    u.setTexture('uField', field.read.tex, 0);
    u.set2f('uTexel', 1 / this.fieldW, 1 / this.fieldH);
    u.set2f('uAspect', this.aspectX, this.aspectY);
    u.set1f('uDt', dt);
    u.set1f('uT', this.t0 + t);
    u.set1f('uBase', this.baseY);
    u.set1f('uSimMin', this.simMin);
    u.set1f('uWindG', windG * 0.9);
    u.set1f('uBuoy', 2.8);
    u.set1f('uTurb', 0.62);
    drawFullscreen(gl);
    field.swap();

    if (this.splatCount > 0) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, field.read.fbo);
      gl.viewport(0, 0, this.fieldW, this.fieldH);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE); // additive into RGBA16F — allowed
      gl.useProgram(this.splatProg);
      const su = this.splatU!;
      su.set2f('uAspect', this.aspectX, this.aspectY);
      su.set1i('uCount', this.splatCount);
      su.set4fv('uPosRad[0]', this.splatPosRad);
      su.set4fv('uVal[0]', this.splatVal);
      drawFullscreen(gl);
      gl.disable(gl.BLEND);
      this.splatCount = 0;
    }
  }

  // --- sparks -----------------------------------------------------------------

  private queueSpark(kind: number, count: number, b0: number, b1: number, b2: number, b3: number): void {
    if (this.pendingSp.length > 24) {
      const i = this.pendingSp.findIndex((e) => e.kind === SK_COAL);
      if (i >= 0) this.pendingSp.splice(i, 1);
      else return;
    }
    this.pendingSp.push({ kind, count, b0, b1, b2, b3, seed: Math.random() });
  }

  private stepSparks(gl: WebGL2RenderingContext, dt: number, windG: number): void {
    const read = this.sparkPairs[this.sparkRead];
    const write = this.sparkPairs[1 - this.sparkRead];
    const n = Math.min(MAX_SEVENTS, this.pendingSp.length);
    for (let i = 0; i < n; i++) {
      const ev = this.pendingSp[i];
      const cnt = clamp(Math.round(ev.count), 1, Math.floor(this.sparkCount * 0.25));
      const o = i * 4;
      this.spA[o] = this.sparkCursor;
      this.spA[o + 1] = cnt;
      this.spA[o + 2] = ev.kind;
      this.spA[o + 3] = ev.seed;
      this.spB[o] = ev.b0;
      this.spB[o + 1] = ev.b1;
      this.spB[o + 2] = ev.b2;
      this.spB[o + 3] = ev.b3;
      this.sparkCursor = (this.sparkCursor + cnt) % this.sparkCount;
    }
    if (n > 0) this.pendingSp.splice(0, n);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, this.sparkSide, this.sparkSide);
    gl.useProgram(this.supdProg);
    const u = this.supdU!;
    u.setTexture('uPos', read.pos, 0);
    u.setTexture('uVel', read.vel, 1);
    u.set1f('uDt', dt);
    u.set1f('uSideF', this.sparkSide);
    u.set1f('uCountF', this.sparkCount);
    u.set1f('uWindG', windG);
    u.set1i('uNumSpawns', n);
    u.set4fv('uSpA[0]', this.spA);
    u.set4fv('uSpB[0]', this.spB);
    drawFullscreen(gl);
    this.sparkRead = 1 - this.sparkRead;
  }

  // --- wall-clock detail governor ---------------------------------------------

  private govern(): void {
    const now = performance.now();
    const real = this.lastNowMs < 0 ? 1 / 60 : Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.05) {
      this.slowT += real;
      this.fastT = 0;
      if (this.slowT > 0.5) {
        if (this.detail > 0) this.detail = 0;
        else this.sparkStride = 2;
        this.slowT = 0;
      }
    } else if (this.frameEma < 0.03) {
      this.fastT += real;
      this.slowT = 0;
      if (this.fastT > 4) {
        if (this.sparkStride > 1) this.sparkStride = 1;
        else if (!this.softGL || this.frameEma < 0.024) this.detail = 1;
        this.fastT = 0;
      }
    } else {
      this.slowT = 0;
      this.fastT = 0;
    }
  }

  // --- frame ------------------------------------------------------------------

  frame(ctx: ModeContext): void {
    if (!this.ready || !this.post) return;
    const { gl } = ctx;
    this.govern();
    const t = ctx.time;
    const dt = clamp(ctx.dt, 1 / 240, 1 / 20);
    const simDt = clamp(ctx.dt, 1 / 240, 1 / 30);
    const th = this.effTheme(ctx);

    // -- inputs & audio
    this.handleAudio(ctx, dt);
    this.handlePointer(ctx, t, dt);
    if (ctx.pulse) {
      this.lastInteract = t;
      this.kindleT = t;
      this.fountainUntil = t + 0.55;
      // a few fresh embers catch and persist in the coal bed
      const nEmb = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < nEmb; i++) {
        const e = { x: this.cx + rand(-0.85, 0.85) * this.bedHalf, y: rand(0.02, 0.09), s: 1 };
        if (this.embers.length < 6) this.embers.push(e);
        else this.embers[Math.floor(Math.random() * 6)] = e;
      }
    }
    // returning to a banked fire flares it back — the reward for coming back
    if (this.lastInteract === t && this.bank < 0.6) this.kindleT = t;

    // -- envelopes
    const kindle = this.kindleEnv(t);
    const idleT = t - this.lastInteract;
    const bankTarget = idleT > BANK_IDLE_S ? 0.3 : 1;
    const bankTau = bankTarget < this.bank ? 14 : 1.6;
    this.bank += (bankTarget - this.bank) * Math.min(1, dt / bankTau);
    for (const e of this.embers) e.s *= Math.exp(-dt / 75);
    if (t >= this.nextPopAt && this.bank > 0.45) this.triggerPop(t);
    if (t >= this.nextSettleAt) {
      this.triggerSettle(t, Math.floor(Math.random() * 3));
      this.nextSettleAt = t + rand(25, 50);
    }

    const breath = 1 + 0.05 * Math.sin(t * 3.14 + Math.sin(t * 0.61) * 1.7); // ~0.5Hz, never loops
    const fireScale = Math.pow(this.intensity, 0.8) * this.bank * breath
      * (1 + 0.3 * this.aLevel) * (1 + 1.5 * kindle) * (1 + 0.35 * this.gust);
    const lumInst = this.updateFlicker(t, fireScale);
    this.lumEma += (lumInst - this.lumEma) * Math.min(1, dt / 0.1); // ~100ms lag
    const windG = this.gustDir * this.gust * 0.55;
    const flameH = clamp(
      (0.55 + 0.45 * this.bank) * Math.pow(this.intensity, 0.55)
      * (1 + 0.28 * this.aLevel + 0.45 * kindle + 0.15 * this.gust),
      0.3, 2.2);

    // -- ambient spark trickle + kindling fountain
    this.coalAcc += (8 + 30 * this.lumEma) * this.sparkAmt * this.cScale * (0.4 + 0.6 * this.bank) * dt;
    let nc = Math.floor(this.coalAcc);
    if (nc > 0) {
      this.coalAcc -= nc;
      nc = Math.min(nc, 8);
      const e = Math.floor(Math.random() * N_EMIT);
      this.queueSpark(SK_COAL, nc,
        this.emitX[e] + rand(-1, 1) * this.emitW[e],
        this.baseY + 0.07, nc > 2 ? this.bedHalf : 0.05, Math.random());
    }
    if (t < this.fountainUntil) {
      const n = Math.max(3, Math.round(210 * this.sparkAmt * this.cScale * dt));
      this.queueSpark(SK_FOUNTAIN, n, this.cx, this.baseY + 0.08, this.bedHalf * 0.9, 1.05);
    }

    // -- sim step (a)
    if (this.useSim && this.field) {
      this.addEmitterSplats(simDt);
      if (kindle > 0.05) {
        this.pushSplat(this.cx, this.baseY + 0.1, this.bedHalf * 0.8, 0, 2.2 * kindle * this.simMin * simDt, 0);
      }
      this.stepField(gl, simDt, t, windG);
    }

    // -- spark step
    this.stepSparks(gl, simDt, windG);

    // -- render
    this.buildUniformBuffers(th, t);
    this.post.begin();
    gl.useProgram(this.compProg);
    const u = this.compU!;
    u.set2f('uAspect', this.aspectX, this.aspectY);
    u.set1f('uT', this.t0 + t);
    u.set3fv('uColors[0]', this.colorBuf);
    u.set1i('uNumColors', Math.min(6, th.colors.length));
    u.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    u.set1f('uLum', this.lumEma);
    u.set1f('uFlameH', flameH);
    u.set1f('uGlow', 0.62 + 0.5 * this.bank);
    u.set1f('uKindle', kindle);
    u.set1f('uWindG', windG);
    u.set1f('uShim', this.shimmer);
    u.set1f('uDetail', this.detail);
    u.set1f('uBase', this.baseY);
    u.set1f('uCx', this.cx);
    u.set1f('uBedHalf', this.bedHalf);
    u.set4fv('uEmit[0]', this.emitBuf);
    u.set4fv('uLogA[0]', this.logABuf);
    u.set4fv('uLogB[0]', this.logBBuf);
    u.set4fv('uEmbers[0]', this.emberBuf);
    u.set4fv('uStir[0]', this.stirBuf);
    const popFlash = Math.exp(-(t - this.popT) * 22);
    const popFlare = Math.exp(-(t - this.popT) * 2.2);
    u.set4f('uPop', this.popX, this.popY, popFlash > 0.01 ? popFlash : 0, popFlare > 0.01 ? popFlare : 0);
    u.set4f('uBellows', this.bellowsX, this.bellowsY - this.baseY, this.bellows, 0);
    if (this.useSim && this.field) {
      u.setTexture('uHeat', this.field.read.tex, 0);
      u.set2f('uHeatTexel', 1 / this.fieldW, 1 / this.fieldH);
    }
    drawFullscreen(gl);

    // sparks: additive velocity-elongated lines over the HDR scene
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.sdrawProg);
    const sd = this.sdrawU!;
    const read = this.sparkPairs[this.sparkRead];
    sd.setTexture('uPos', read.pos, 0);
    sd.setTexture('uVel', read.vel, 1);
    sd.set1i('uSide', this.sparkSide);
    sd.set1i('uStride', this.sparkStride);
    sd.set1i('uCount', this.sparkCount);
    sd.set2f('uQ2C', 2 / this.aspectX, 2 / this.aspectY);
    sd.set1f('uT', this.t0 + t);
    sd.set1f('uBright', (1.05 + 0.45 * this.bank) * this.sparkStride);
    sd.set1f('uStretch', clamp(ctx.dt, 1 / 120, 1 / 45) * 1.15);
    const sceneMin = Math.max(1, Math.round(this.minSide * this.postScale));
    sd.set1f('uMinLen', 1.5 / sceneMin);
    sd.set3f('uHot', this.hotCol[0], this.hotCol[1], this.hotCol[2]);
    sd.set3f('uCool', this.coolCol[0], this.coolCol[1], this.coolCol[2]);
    gl.bindVertexArray(this.sparkVao);
    gl.drawArrays(gl.LINES, 0, 2 * Math.ceil(this.sparkCount / this.sparkStride));
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    this.post.end({ exposure: 1.12, bloom: 0.6, vignette: 0.34 });

    // canonical GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Palette + emitter + log + ember + stir uniform arrays for this frame. */
  private buildUniformBuffers(th: Theme, t: number): void {
    const n = Math.min(6, th.colors.length);
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    pal(th.colors, 0.96, this.tmp3);
    this.hotCol[0] = this.tmp3[0] * 1.2; this.hotCol[1] = this.tmp3[1] * 1.2; this.hotCol[2] = this.tmp3[2] * 1.2;
    pal(th.colors, 0.5, this.tmp3);
    this.coolCol[0] = this.tmp3[0] * 0.75; this.coolCol[1] = this.tmp3[1] * 0.75; this.coolCol[2] = this.tmp3[2] * 0.75;

    for (let i = 0; i < N_EMIT; i++) {
      const o = i * 4;
      this.emitBuf[o] = this.emitX[i];
      this.emitBuf[o + 1] = this.emitW[i];
      this.emitBuf[o + 2] = this.eFlick[i];
      this.emitBuf[o + 3] = 0;
    }

    for (let i = 0; i < 3; i++) {
      // settle animation: fast eased drop with a tiny rebound
      const u01 = clamp((t - this.logSettleT[i]) / 0.35, 0, 1);
      const ease = 1 - Math.pow(1 - u01, 3);
      const bounce = Math.sin(Math.min(1, u01) * Math.PI) * 0.15;
      this.logDy[i] = this.logDyFrom[i] + (this.logDyTo[i] - this.logDyFrom[i]) * (ease + bounce * (1 - u01));
      const L = this.logBase[i];
      const o = i * 4;
      this.logABuf[o] = L.ax;
      this.logABuf[o + 1] = L.ay + this.logDy[i] * 0.7;
      this.logABuf[o + 2] = L.bx;
      this.logABuf[o + 3] = L.by + this.logDy[i] * 1.3;
      const glow = Math.exp(-(t - this.logSettleT[i]) / 1.1);
      this.logBBuf[o] = L.r;
      this.logBBuf[o + 1] = LOG_SEED[i];
      this.logBBuf[o + 2] = glow > 0.01 ? glow : 0;
      this.logBBuf[o + 3] = 0;
    }

    this.emberBuf.fill(0);
    for (let i = 0; i < Math.min(6, this.embers.length); i++) {
      const e = this.embers[i];
      const o = i * 4;
      this.emberBuf[o] = e.x;
      this.emberBuf[o + 1] = e.y;
      this.emberBuf[o + 2] = e.s > 0.02 ? e.s : 0;
      this.emberBuf[o + 3] = 0;
    }

    this.stirBuf.fill(0);
    for (let i = 0; i < this.stirs.length; i++) {
      const s = this.stirs[i];
      const env = Math.exp(-(t - s.t0) / STIR_TAU);
      if (env < 0.02) continue;
      const o = i * 4;
      let vx = s.vx * 0.055 * env;
      let vy = s.vy * 0.055 * env;
      const vm = Math.hypot(vx, vy);
      if (vm > 0.14) { vx *= 0.14 / vm; vy *= 0.14 / vm; }
      this.stirBuf[o] = s.x;
      this.stirBuf[o + 1] = s.y - this.baseY;
      this.stirBuf[o + 2] = vx;
      this.stirBuf[o + 3] = vy;
    }
  }

  // ---------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const p of [this.simProg, this.splatProg, this.compProg, this.supdProg, this.sdrawProg]) {
      if (p) gl.deleteProgram(p);
    }
    this.simProg = this.splatProg = this.compProg = this.supdProg = this.sdrawProg = null;
    this.simU = this.splatU = this.compU = this.supdU = this.sdrawU = null;
    this.field?.destroy();
    this.field = null;
    for (const pair of this.sparkPairs) {
      gl.deleteTexture(pair.pos);
      gl.deleteTexture(pair.vel);
      gl.deleteFramebuffer(pair.fbo);
    }
    this.sparkPairs = [];
    if (this.sparkVao) gl.deleteVertexArray(this.sparkVao);
    this.sparkVao = null;
    this.post?.destroy();
    this.post = null;
    this.pendingSp.length = 0;
    this.stirs.length = 0;
    this.embers.length = 0;
    this.ready = false;
  }
}

export const hearthMode: Mode = new HearthMode();
