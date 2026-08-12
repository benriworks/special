/**
 * HANABI — 花火. A Japanese fireworks night as a GPU particle simulation.
 *
 * State: one MRT ping-pong pair of RGBA32F textures (pos+vel updated in a
 * single fragment pass — no particle coupling, so MRT halves texel work).
 * Spawning is CPU-driven, fluid-splat style: rockets are integrated on the
 * CPU (a handful at most) and feed ranged spawn events (≤16/step) into the
 * update shader; a burst re-initializes a contiguous window of the pool.
 *
 * Shell repertoire: 牡丹 peony (projected-sphere bloom), 菊 chrysanthemum
 * (streaked, tip color shift), 柳 willow (long drooping gold), 環 ring
 * (tilted disc), 千輪 senrin (cluster of delayed small blooms). Interactions:
 * tap = rocket that bursts AT the tap point; drag = 線香花火 senko sparkler
 * stream; hold ≥450ms = charged 大玉 with a double break; pulse = finale.
 *
 * Render: particles as velocity-elongated gl.LINES, additive into an RGBA16F
 * trail buffer (the trails ARE the aesthetic — rocket streaks, chrysanthemum
 * spokes, willow droop), presented over a night-sky gradient with a brief
 * atmosphere flash after big breaks, through the shared HDR post chain.
 * Perf strategy mirrors galaxy: wall-clock stride governor + desperate
 * half-rate sim for software rasterizers.
 */

import type { Mode, ModeContext, ParamDef, Theme } from '../../engine/types';
import { FS_TRIANGLE_VS, PingPong, UniformSetter, compileProgram, drawFullscreen, makeTexture } from '../../engine/glutils';
import { createPost, type Post } from '../../engine/post';
import { mixThemes } from '../../core/themes';
import {
  DRAW_FS, DRAW_VS, FADE_FS, MAX_EVENTS, PRESENT_FS, UPDATE_FS,
  T_CHRYS, T_PEONY, T_RING, T_SENKO, T_TAIL, T_WILLOW,
} from './shaders';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const POOL_REF = 65536;        // 256² — reference pool for count/brightness scaling
const WARM_STEPS = 34;         // pre-warm iterations (≈1.13s @ 1/30)
const WARM_TRAIL = 14;         // last N warm steps also accumulate trails
const WARM_DT = 1 / 30;

const TRAIL_DEFAULT = 0.90;    // per-frame fade @60fps the deposit is normalized to
const DEPOSIT = 0.052;         // base line deposit at the default trail fade

const TAP_MAX_S = 0.34;        // press&release under this + little travel = tap
const HOLD_MIN_S = 0.45;       // stationary hold beyond this = charged shell
const HOLD_CAP_S = 1.5;

const PATTERNS = ['peony', 'chrys', 'willow', 'ring', 'senrin'] as const;
type Pattern = (typeof PATTERNS)[number];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

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

// ---------------------------------------------------------------------------
// CPU-side entities
// ---------------------------------------------------------------------------

/** A spawn event waiting for GPU upload (range assigned at flush). */
interface Ev {
  type: number;
  cx: number; cy: number;
  p0: number; p1: number;      // type-specific (see shaders.ts)
  colA: number; colB: number;
  sparkle: number; bright: number;
  count: number;
  seed: number;
}

interface Rocket {
  x0: number; y0: number;      // launch point (q)
  tx: number; ty: number;      // apex = burst point (q)
  t0: number; dur: number;
  wobAmp: number; wobFreq: number; wobPh: number;
  px: number; py: number;      // head last sim step
  pattern: Pattern | 'ozama';
  size: number;
  colA: number; colB: number; sparkle: number;
}

interface Launch { at: number; tx: number; ty: number; size: number; pattern: Pattern | 'ozama' }

interface Gesture {
  x: number; y: number;
  startT: number; travel: number; stillT: number;
}

// ---------------------------------------------------------------------------

class HanabiMode implements Mode {
  readonly id = 'hanabi';
  readonly name = { ja: '花火', en: 'Hanabi' };
  readonly params: ParamDef[] = [
    { key: 'rate', label: { ja: '打ち上げ頻度', en: 'Launch rate' }, type: 'range', min: 0.35, max: 2.5, step: 0.05, default: 1 },
    { key: 'trail', label: { ja: '尾の長さ', en: 'Trail length' }, type: 'range', min: 0.80, max: 0.95, step: 0.005, default: TRAIL_DEFAULT },
    { key: 'size', label: { ja: '大きさ', en: 'Shell size' }, type: 'range', min: 0.6, max: 1.6, step: 0.05, default: 1 },
  ];

  // live params (survive quality re-inits — the instance persists)
  private rate = 1;
  private trail = TRAIL_DEFAULT;
  private size = 1;

  // pool geometry
  private side = 256;
  private count = POOL_REF;
  private cScale = 1;          // count / POOL_REF
  private aspectX = 1;
  private aspectY = 1;
  private minSide = 1;         // device px per q unit
  private softGL = false;

  // scene targets
  private sceneScale = 1;
  private sceneW = 1;
  private sceneH = 1;

  // stride governor (galaxy's wall-clock scheme)
  private drawStride = 1;
  private baseStride = 1;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;
  private lastNowMs = -1;
  private pendingDt = 0;

  // GL resources
  private pairs: { pos: WebGLTexture; vel: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private readIdx = 0;
  private accum: PingPong | null = null;
  private post: Post | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private updateProg: WebGLProgram | null = null;
  private drawProg: WebGLProgram | null = null;
  private fadeProg: WebGLProgram | null = null;
  private presentProg: WebGLProgram | null = null;
  private updateU: UniformSetter | null = null;
  private drawU: UniformSetter | null = null;
  private fadeU: UniformSetter | null = null;
  private presentU: UniformSetter | null = null;

  // spawn plumbing
  private cursor = 0;
  private pending: Ev[] = [];
  private scheduled: { at: number; ev: Ev }[] = [];
  private spawnA = new Float32Array(MAX_EVENTS * 4);
  private spawnB = new Float32Array(MAX_EVENTS * 4);
  private spawnC = new Float32Array(MAX_EVENTS * 4);

  // sky entities & show state
  private rockets: Rocket[] = [];
  private launches: Launch[] = [];
  private nextLaunchAt = 0;
  private nextFinaleAt = 0;
  private flash = 0;
  private flashColor = new Float32Array(3);

  // pointer gestures
  private gestures = new Map<number, Gesture>();

  // audio (null-safe: everything stays 0 ⇒ exactly default behavior)
  private bassEma = 0;
  private beatCooldownUntil = 0;
  private audioBoost = 0;

  // scratch
  private colorBuf = new Float32Array(24); // 8 × vec3
  private palN = 5;
  private warmIdx = 4;

  // -------------------------------------------------------------------------

  init(ctx: ModeContext): void {
    const { gl } = ctx;
    this.softGL = detectSoftwareGL(gl);
    this.side = Math.max(128, Math.round(256 * Math.sqrt(ctx.quality)));
    this.count = this.side * this.side;
    this.cScale = this.count / POOL_REF;
    this.sceneScale = ctx.quality <= 0.5 ? 0.62 : Math.min(0.85, 0.5 + 0.4 * ctx.quality);
    this.baseStride = ctx.quality > 0.5 ? 1 : 2;
    this.drawStride = Math.min(8, Math.max(this.baseStride, this.drawStride));
    this.slowTime = 0;
    this.fastTime = 0;
    this.lastNowMs = -1;
    this.pendingDt = 0;

    this.updateProg = compileProgram(gl, FS_TRIANGLE_VS, UPDATE_FS, 'hanabi.update');
    this.drawProg = compileProgram(gl, DRAW_VS, DRAW_FS, 'hanabi.draw');
    this.fadeProg = compileProgram(gl, FS_TRIANGLE_VS, FADE_FS, 'hanabi.fade');
    this.presentProg = compileProgram(gl, FS_TRIANGLE_VS, PRESENT_FS, 'hanabi.present');
    this.updateU = new UniformSetter(gl, this.updateProg);
    this.drawU = new UniformSetter(gl, this.drawProg);
    this.fadeU = new UniformSetter(gl, this.fadeProg);
    this.presentU = new UniformSetter(gl, this.presentProg);

    // MRT ping-pong pair: pos + vel as two RGBA32F attachments (zero-inited
    // ⇒ life 0 ⇒ the whole pool starts dead in the reservoir)
    this.pairs = [];
    for (let i = 0; i < 2; i++) {
      const pos = makeTexture(gl, { w: this.side, h: this.side, internalFormat: gl.RGBA32F });
      const vel = makeTexture(gl, { w: this.side, h: this.side, internalFormat: gl.RGBA32F });
      const fbo = gl.createFramebuffer();
      if (!fbo) throw new Error('hanabi: createFramebuffer failed');
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pos, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, vel, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`hanabi: MRT framebuffer incomplete (0x${status.toString(16)})`);
      }
      this.pairs.push({ pos, vel, fbo });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.readIdx = 0;

    this.computeAspect(ctx);
    this.sceneW = Math.max(1, Math.round(ctx.width * this.sceneScale));
    this.sceneH = Math.max(1, Math.round(ctx.height * this.sceneScale));
    this.post = createPost(gl, this.sceneW, this.sceneH);
    this.accum = new PingPong(gl, this.sceneW, this.sceneH, gl.RGBA16F, gl.LINEAR);
    this.vao = gl.createVertexArray();
    this.layout(ctx);

    // reset show state
    this.cursor = 0;
    this.pending.length = 0;
    this.scheduled.length = 0;
    this.rockets.length = 0;
    this.launches.length = 0;
    this.gestures.clear();
    this.flash = 0;
    this.bassEma = 0;
    this.audioBoost = 0;
    this.beatCooldownUntil = 0;

    this.prewarm(ctx);

    // guarantee the first minute is alive: two early aimed shells bracket the
    // typical capture window, then the idle cadence takes over forever
    const t = ctx.time;
    this.launches.push(this.mkLaunch(t + 0.45, this.aspectX * rand(0.30, 0.44), this.aspectY * rand(0.60, 0.72), 1.0, 'chrys'));
    this.launches.push(this.mkLaunch(t + 1.55, this.aspectX * rand(0.58, 0.74), this.aspectY * rand(0.56, 0.70), 1.05, 'peony'));
    this.nextLaunchAt = t + 3.2 / this.rate;
    this.nextFinaleAt = t + rand(40, 52);
  }

  /** Scripted opening: a drooping willow + a mid-bloom peony + a rocket in flight. */
  private prewarm(ctx: ModeContext): void {
    const { gl } = ctx;
    const th = this.effTheme(ctx);
    this.buildColors(th);
    for (let i = 0; i < WARM_STEPS; i++) {
      const t = ctx.time - (WARM_STEPS - i) * WARM_DT;
      if (i === 0) this.queueBurst('willow', this.aspectX * 0.30, this.aspectY * 0.64, 1.1, t);
      if (i === 11) this.queueBurst('peony', this.aspectX * 0.70, this.aspectY * 0.60, 0.95, t);
      if (i === WARM_STEPS - 8) {
        this.launchRocket(this.aspectX * 0.46, this.aspectY * 0.72, 1.0, this.pickPattern(), t, 0.78);
      }
      this.stepRockets(t, WARM_DT);
      this.popScheduled(t);
      this.simStep(gl, WARM_DT, t);
      this.flash *= Math.exp(-WARM_DT * 3.2);
      if (i >= WARM_STEPS - WARM_TRAIL) this.accumulateTrails(ctx, WARM_DT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // -------------------------------------------------------------------------
  // Geometry / theme helpers
  // -------------------------------------------------------------------------

  private computeAspect(ctx: ModeContext): void {
    this.minSide = Math.max(1, Math.min(ctx.width, ctx.height));
    this.aspectX = ctx.width / this.minSide;
    this.aspectY = ctx.height / this.minSide;
  }

  private layout(ctx: ModeContext): void {
    if (!this.post || !this.accum) return;
    this.computeAspect(ctx);
    const s = this.sceneScale * (this.drawStride >= 8 ? 0.75 : 1);
    const w = Math.max(1, Math.round(ctx.width * s));
    const h = Math.max(1, Math.round(ctx.height * s));
    if (w !== this.sceneW || h !== this.sceneH) {
      this.sceneW = w;
      this.sceneH = h;
      this.post.resize(w, h);
    }
    const a = this.drawStride >= 8 ? 0.5 : this.drawStride >= 4 ? 0.72 : 1;
    const aw = Math.max(1, Math.round(w * a));
    const ah = Math.max(1, Math.round(h * a));
    if (aw !== this.accum.w || ah !== this.accum.h) this.accum.resize(aw, ah);
  }

  resize(ctx: ModeContext): void {
    this.layout(ctx);
  }

  setParam(key: string, value: number | string): void {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    if (key === 'rate') this.rate = clamp(v, 0.2, 3);
    else if (key === 'trail') this.trail = clamp(v, 0.7, 0.96);
    else if (key === 'size') this.size = clamp(v, 0.4, 2);
  }

  private effTheme(ctx: ModeContext): Theme {
    return ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;
  }

  /** uColors table: 0..5 palette (clamped), 6 accent, 7 white-hot top. */
  private buildColors(th: Theme): void {
    const n = Math.min(6, th.colors.length);
    this.palN = n;
    for (let i = 0; i < 6; i++) this.colorBuf.set(th.colors[Math.min(i, n - 1)], i * 3);
    this.colorBuf.set(th.accent, 18);
    const top = th.colors[n - 1];
    this.colorBuf[21] = top[0] * 1.35;
    this.colorBuf[22] = top[1] * 1.35;
    this.colorBuf[23] = top[2] * 1.35;
    // warm/bright palette end — willow gold, senko embers, rocket tails
    let best = n - 1;
    let bestScore = -1e9;
    for (let i = 0; i < n; i++) {
      const c = th.colors[i];
      const score = c[0] * 1.25 + c[1] * 0.6 - c[2] * 0.85 + (c[0] + c[1] + c[2]) * 0.35;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    this.warmIdx = best;
  }

  // -------------------------------------------------------------------------
  // Show direction: shells, rockets, cadence
  // -------------------------------------------------------------------------

  private pickPattern(): Pattern {
    const r = Math.random();
    return r < 0.30 ? 'peony' : r < 0.56 ? 'chrys' : r < 0.72 ? 'willow' : r < 0.84 ? 'ring' : 'senrin';
  }

  /** 1–2 palette colors from the bright half (+ accent handled via sparkle). */
  private pickColors(): { a: number; b: number } {
    const n = this.palN;
    const a = clamp(Math.floor(n * (0.35 + 0.6 * Math.random())), 1, n - 1);
    let b = a;
    if (Math.random() < 0.72) {
      b = clamp(a + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2)), 0, n - 1);
    }
    return { a, b };
  }

  private queueEv(ev: Ev): void {
    // keep the queue bounded: shed cosmetic events first, never bursts
    if (this.pending.length > 40) {
      const i = this.pending.findIndex((e) => e.type === T_SENKO || e.type === T_TAIL);
      if (i >= 0) this.pending.splice(i, 1);
      else return;
    }
    this.pending.push(ev);
  }

  private mkLaunch(at: number, tx: number, ty: number, size: number, pattern: Pattern | 'ozama'): Launch {
    return { at, tx, ty, size, pattern };
  }

  private launchRocket(
    tx: number, ty: number, size: number, pattern: Pattern | 'ozama', t: number, dur?: number,
  ): void {
    if (this.rockets.length >= 14) this.rockets.shift();
    const x0 = clamp(tx + rand(-0.15, 0.15) * this.aspectX, 0.06 * this.aspectX, 0.94 * this.aspectX);
    const col = this.pickColors();
    this.rockets.push({
      x0, y0: -0.03,
      tx, ty, t0: t,
      dur: dur ?? 0.85 + 0.30 * (ty / Math.max(0.001, this.aspectY)) + rand(0, 0.25),
      wobAmp: rand(0.010, 0.030), wobFreq: rand(6, 11), wobPh: rand(0, Math.PI * 2),
      px: x0, py: -0.03,
      pattern, size,
      colA: col.a, colB: col.b, sparkle: rand(0.05, 0.14),
    });
  }

  /** Parametric ease-out flight — arrives with ~zero velocity exactly at the apex. */
  private rocketHead(r: Rocket, s: number): { x: number; y: number } {
    const e = 1 - (1 - s) * (1 - s);
    return {
      x: r.x0 + (r.tx - r.x0) * e + Math.sin(s * r.wobFreq + r.wobPh) * r.wobAmp * Math.sin(Math.PI * s),
      y: r.y0 + (r.ty - r.y0) * e,
    };
  }

  private stepRockets(t: number, dt: number): void {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const s = (t - r.t0) / r.dur;
      if (s < 0) continue;
      if (s >= 1) {
        this.burstFromRocket(r, t);
        this.rockets.splice(i, 1);
        continue;
      }
      const h = this.rocketHead(r, s);
      const dist = Math.hypot(h.x - r.px, h.y - r.py);
      this.queueEv({
        type: T_TAIL, cx: h.x, cy: h.y, p0: r.px, p1: r.py,
        colA: this.warmIdx, colB: Math.max(0, this.warmIdx - 1),
        sparkle: 0, bright: 1,
        count: clamp(Math.round((dt * 480 + dist * 420) * this.cScale), 4, 40),
        seed: Math.random(),
      });
      r.px = h.x;
      r.py = h.y;
    }
  }

  private burstFromRocket(r: Rocket, t: number): void {
    if (r.pattern === 'ozama') this.queueOzama(r.tx, r.ty, r.size, t, r.colA, r.colB);
    else this.queueBurst(r.pattern, r.tx, r.ty, r.size, t, r.colA, r.colB, r.sparkle);
  }

  /** The atmosphere flash — a big break briefly lights the sky, then fades. */
  private bumpFlash(size: number, colIdx: number, k: number): void {
    this.flash = Math.min(0.34, this.flash + 0.030 * size * k);
    const o = clamp(colIdx, 0, 7) * 3;
    for (let i = 0; i < 3; i++) {
      this.flashColor[i] += (this.colorBuf[o + i] - this.flashColor[i]) * 0.6;
    }
  }

  private queueBurst(
    pattern: Pattern, x: number, y: number, size: number, t: number,
    colA?: number, colB?: number, sparkle?: number,
  ): void {
    const col = colA === undefined ? this.pickColors() : { a: colA, b: colB ?? colA };
    const sp = sparkle ?? rand(0.05, 0.14);
    const sizeF = Math.sqrt(size);
    const seed = Math.random();
    switch (pattern) {
      case 'peony':
        this.queueEv({
          type: T_PEONY, cx: x, cy: y, p0: 0.62 * sizeF, p1: 0,
          colA: col.a, colB: col.b, sparkle: sp, bright: 1,
          count: Math.round(850 * size * this.cScale), seed,
        });
        this.bumpFlash(size, col.a, 1);
        break;
      case 'chrys':
        this.queueEv({
          type: T_CHRYS, cx: x, cy: y, p0: 0.60 * sizeF, p1: 0,
          colA: col.a, colB: col.b, sparkle: sp * 1.3, bright: 1,
          count: Math.round(1050 * size * this.cScale), seed,
        });
        this.bumpFlash(size, col.a, 1);
        break;
      case 'willow':
        this.queueEv({
          type: T_WILLOW, cx: x, cy: y, p0: 0.55 * sizeF, p1: 0,
          colA: this.warmIdx, colB: Math.min(7, this.palN - 1), sparkle: 0.05, bright: 1,
          count: Math.round(680 * size * this.cScale), seed,
        });
        this.bumpFlash(size, this.warmIdx, 0.9);
        break;
      case 'ring':
        this.queueEv({
          type: T_RING, cx: x, cy: y, p0: 0.66 * sizeF, p1: rand(0.35, 1),
          colA: col.a, colB: col.b, sparkle: sp, bright: 1,
          count: Math.round(440 * size * this.cScale), seed,
        });
        this.bumpFlash(size, col.a, 0.8);
        break;
      case 'senrin': {
        // 千輪 — a modest parent bloom, then a cluster of delayed small blooms
        this.queueEv({
          type: T_PEONY, cx: x, cy: y, p0: 0.30 * sizeF, p1: 0,
          colA: col.a, colB: col.b, sparkle: 0.04, bright: 0.8,
          count: Math.round(260 * size * this.cScale), seed,
        });
        const subs = 5 + Math.floor(Math.random() * 3);
        for (let i = 0; i < subs; i++) {
          const a = (i / subs) * Math.PI * 2 + rand(-0.4, 0.4);
          const rad = rand(0.09, 0.19) * sizeF;
          this.scheduled.push({
            at: t + rand(0.14, 0.66),
            ev: {
              type: T_PEONY, cx: x + Math.cos(a) * rad, cy: y + Math.sin(a) * rad * 0.85,
              p0: rand(0.26, 0.38), p1: 0,
              colA: i % 2 === 0 ? col.a : col.b, colB: col.b, sparkle: 0.10, bright: 0.95,
              count: Math.round(180 * size * this.cScale), seed: Math.random(),
            },
          });
        }
        this.bumpFlash(size, col.a, 0.7);
        break;
      }
    }
  }

  /** 大玉 — charged big shell with a double break (main bloom spawns sub-bursts). */
  private queueOzama(x: number, y: number, size: number, t: number, colA: number, colB: number): void {
    const sizeF = Math.sqrt(size);
    this.queueEv({
      type: T_PEONY, cx: x, cy: y, p0: 0.62 * sizeF, p1: 0,
      colA, colB, sparkle: 0.16, bright: 1.15,
      count: Math.round(1300 * size * this.cScale), seed: Math.random(),
    });
    const radius = 0.62 * sizeF / 2.55; // ≈ v0/drag = star travel distance
    const subs = 4 + Math.floor(Math.random() * 2);
    for (let i = 0; i < subs; i++) {
      const a = rand(0, Math.PI * 2);
      const rad = radius * rand(0.55, 0.85);
      this.scheduled.push({
        at: t + rand(0.30, 0.44),
        ev: {
          type: i % 2 === 0 ? T_CHRYS : T_PEONY,
          cx: x + Math.cos(a) * rad, cy: y + Math.sin(a) * rad,
          p0: rand(0.24, 0.34), p1: 0,
          colA: colB, colB: colA, sparkle: 0.12, bright: 0.9,
          count: Math.round(210 * size * this.cScale), seed: Math.random(),
        },
      });
    }
    this.bumpFlash(size, colA, 1.6);
  }

  /** Staggered volley across the sky (pulse / periodic mini-finale). */
  private finale(t: number, n: number, span: number): void {
    for (let k = 0; k < n; k++) {
      const pat = Math.random() < 0.8 ? this.pickPattern() : 'ozama';
      this.launches.push(this.mkLaunch(
        t + Math.random() * span,
        this.aspectX * (0.12 + 0.76 * ((k + Math.random() * 0.9) / n)),
        this.aspectY * rand(0.52, 0.82),
        rand(0.8, 1.35) * this.size,
        pat === 'ozama' ? 'ozama' : pat,
      ));
    }
    this.nextLaunchAt = Math.max(this.nextLaunchAt, t + span + 2.2);
  }

  // -------------------------------------------------------------------------
  // Pointer: tap / drag-senko / charged hold — per touch, GL-oriented
  // -------------------------------------------------------------------------

  private emitSenko(xq: number, yq: number, pxq: number, pyq: number, distQ: number, dt: number, charge: number): void {
    const count = clamp(
      Math.round((dt * 300 * (1 + 2.4 * charge) + distQ * 1600) * this.cScale), 2, 220,
    );
    this.queueEv({
      type: T_SENKO, cx: xq, cy: yq,
      p0: pxq, p1: pyq,
      colA: this.warmIdx, colB: Math.max(0, this.warmIdx - 1),
      sparkle: 0.10, bright: 1 + 0.5 * charge,
      count, seed: Math.random(),
    });
  }

  private handlePointer(ctx: ModeContext, t: number): void {
    const p = ctx.pointer;
    const m = this.minSide;
    const dpr = ctx.dpr;

    interface Pt { id: number; x: number; y: number; dx: number; dy: number }
    const pts: Pt[] = [];
    if (p.touches.length > 0) {
      for (const tc of p.touches) pts.push(tc);
    } else if (p.down) {
      pts.push({ id: -1, x: p.x, y: p.y, dx: p.dx, dy: p.dy });
    }

    for (const pt of pts) {
      let g = this.gestures.get(pt.id);
      if (!g) {
        g = { x: pt.x, y: pt.y, startT: t, travel: 0, stillT: 0 };
        this.gestures.set(pt.id, g);
      }
      const dist = Math.hypot(pt.dx, pt.dy);
      g.travel += dist;
      if (dist < 2.5 * dpr) g.stillT += ctx.dt;
      else g.stillT = 0;
      g.x = pt.x;
      g.y = pt.y;

      const charge = g.stillT >= 0.30 ? Math.min(1, (g.stillT - 0.30) / (HOLD_CAP_S - 0.30)) : 0;
      if (dist > 0.5) {
        // sparkler stream, seeded along the whole inter-frame segment
        this.emitSenko(pt.x / m, pt.y / m, (pt.x - pt.dx) / m, (pt.y - pt.dy) / m, dist / m, ctx.dt, 0);
      } else if (charge > 0) {
        // fuse-charging shimmer while holding still
        this.emitSenko(pt.x / m, pt.y / m, pt.x / m, pt.y / m, 0, ctx.dt, charge);
      }
    }

    // releases: classify tap / charged hold
    for (const [id, g] of this.gestures) {
      let active = false;
      for (const pt of pts) if (pt.id === id) { active = true; break; }
      if (active) continue;
      this.gestures.delete(id);
      const dur = t - g.startT;
      if (g.stillT >= HOLD_MIN_S) {
        const c = Math.min(1, (g.stillT - HOLD_MIN_S) / (HOLD_CAP_S - HOLD_MIN_S));
        this.launchRocket(g.x / m, g.y / m, (1.25 + 1.05 * c) * this.size, 'ozama', t, 0.7);
      } else if (dur < TAP_MAX_S && g.travel < 30 * dpr) {
        this.launchRocket(g.x / m, g.y / m, rand(0.8, 1.1) * this.size, this.pickPattern(), t);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Audio (mic is optional & may not exist — null must equal default behavior)
  // -------------------------------------------------------------------------

  private handleAudio(ctx: ModeContext, t: number): void {
    const au = ctx.audio;
    if (!au) { this.audioBoost = 0; return; }
    this.bassEma += (au.low - this.bassEma) * Math.min(1, ctx.dt * 2);
    if (au.low > 0.14 && au.low > this.bassEma * 1.45 && t >= this.beatCooldownUntil) {
      this.beatCooldownUntil = t + 0.3;
      this.audioBoost = Math.min(1, this.audioBoost + 0.5);
      // subtly pull the next launch closer on a bass hit
      if (this.nextLaunchAt - t > 0.8) this.nextLaunchAt = t + rand(0.25, 0.65);
    }
    this.audioBoost *= Math.exp(-ctx.dt * 1.1);
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  private popScheduled(t: number): void {
    for (let i = this.scheduled.length - 1; i >= 0; i--) {
      if (this.scheduled[i].at <= t) {
        this.pending.push(this.scheduled[i].ev);
        this.scheduled.splice(i, 1);
      }
    }
    if (this.scheduled.length > 64) this.scheduled.splice(0, this.scheduled.length - 64);
  }

  /** One MRT update step; flushes ≤MAX_EVENTS pending spawns. Leaves BLEND off. */
  private simStep(gl: WebGL2RenderingContext, dt: number, time: number): void {
    const read = this.pairs[this.readIdx];
    const write = this.pairs[1 - this.readIdx];
    const n = Math.min(MAX_EVENTS, this.pending.length);
    for (let i = 0; i < n; i++) {
      const ev = this.pending[i];
      const cnt = clamp(Math.round(ev.count), 1, Math.floor(this.count * 0.25));
      const o = i * 4;
      this.spawnA[o] = this.cursor;
      this.spawnA[o + 1] = cnt;
      this.spawnA[o + 2] = ev.type;
      this.spawnA[o + 3] = ev.seed;
      this.spawnB[o] = ev.cx;
      this.spawnB[o + 1] = ev.cy;
      this.spawnB[o + 2] = ev.p0;
      this.spawnB[o + 3] = ev.p1;
      this.spawnC[o] = ev.colA;
      this.spawnC[o + 1] = ev.colB;
      this.spawnC[o + 2] = ev.sparkle;
      this.spawnC[o + 3] = ev.bright;
      this.cursor = (this.cursor + cnt) % this.count;
    }
    if (n > 0) this.pending.splice(0, n);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo);
    gl.viewport(0, 0, this.side, this.side);
    gl.useProgram(this.updateProg);
    const u = this.updateU!;
    u.setTexture('uPos', read.pos, 0);
    u.setTexture('uVel', read.vel, 1);
    u.set1f('uDt', dt);
    u.set1f('uWind', 0.012 * Math.sin(time * 0.09 + 1.7) + 0.006 * Math.sin(time * 0.023));
    u.set1f('uSideF', this.side);
    u.set1f('uCountF', this.count);
    u.set1i('uNumSpawns', n);
    u.set4fv('uSpawnA[0]', this.spawnA);
    u.set4fv('uSpawnB[0]', this.spawnB);
    u.set4fv('uSpawnC[0]', this.spawnC);
    drawFullscreen(gl);
    this.readIdx = 1 - this.readIdx;
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  /** Additive line splat into the bound target. Caller set FBO/viewport/blend. */
  private drawLines(ctx: ModeContext, dt: number): void {
    const { gl } = ctx;
    const read = this.pairs[this.readIdx];
    const u = this.drawU!;
    gl.useProgram(this.drawProg);
    u.setTexture('uPos', read.pos, 0);
    u.setTexture('uVel', read.vel, 1);
    u.set1i('uSide', this.side);
    u.set1i('uStride', this.drawStride);
    u.set1i('uCount', this.count);
    u.set2f('uQ2C', 2 / this.aspectX, 2 / this.aspectY);
    u.set1f('uTime', ctx.time);
    const fade = this.fadeFor(dt);
    const energyComp = Math.min(2.3, Math.sqrt(POOL_REF / this.count));
    u.set1f('uBright', DEPOSIT * ((1 - fade) / (1 - TRAIL_DEFAULT)) * energyComp * this.drawStride);
    u.set1f('uStretch', clamp(dt, 1 / 120, 1 / 45));
    u.set1f('uMinLen', 1.7 / Math.max(1, Math.min(this.accum!.w, this.accum!.h)));
    u.set3fv('uColors[0]', this.colorBuf);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.LINES, 0, 2 * Math.ceil(this.count / this.drawStride));
    gl.bindVertexArray(null);
  }

  private fadeFor(dt: number): number {
    // param is per-frame fade @60fps; keep trail LENGTH fps-independent
    return Math.min(0.975, Math.pow(clamp(this.trail, 0.7, 0.96), Math.max(dt, 1e-4) * 60));
  }

  private accumulateTrails(ctx: ModeContext, dt: number): void {
    const { gl } = ctx;
    const accum = this.accum!;
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, accum.write.fbo);
    gl.viewport(0, 0, accum.w, accum.h);
    gl.useProgram(this.fadeProg);
    this.fadeU!.setTexture('uTex', accum.read.tex, 0);
    this.fadeU!.set1f('uFade', this.fadeFor(dt));
    drawFullscreen(gl);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive into RGBA16F — allowed
    this.drawLines(ctx, dt);
    gl.disable(gl.BLEND);
    accum.swap();
  }

  /** Wall-clock stride governor (galaxy's scheme — rAF dt can be virtualised). */
  private governStride(): void {
    const now = performance.now();
    const real = this.lastNowMs < 0 ? 1 / 60 : Math.min(1, (now - this.lastNowMs) / 1000);
    this.lastNowMs = now;
    this.frameEma += (real - this.frameEma) * 0.15;
    if (this.frameEma > 0.045) {
      this.slowTime += real;
      this.fastTime = 0;
      if (this.slowTime > 0.3 && this.drawStride < 8) {
        const mult = this.frameEma > 0.07 ? 4 : 2;
        this.drawStride = Math.min(8, this.drawStride * mult);
        this.slowTime = 0;
      }
    } else if (this.frameEma < 0.022) {
      this.fastTime += real;
      this.slowTime = 0;
      if (this.fastTime > 5 && this.drawStride > this.baseStride) {
        this.drawStride = Math.max(this.baseStride, this.drawStride >> 1);
        this.fastTime = 0;
      }
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
  }

  frame(ctx: ModeContext): void {
    const { gl } = ctx;
    if (!this.post || !this.accum || this.pairs.length < 2) return;
    this.governStride();
    this.layout(ctx);
    const th = this.effTheme(ctx);
    this.buildColors(th);
    const t = ctx.time;

    this.handlePointer(ctx, t);
    this.handleAudio(ctx, t);

    // cadence: idle launches forever; pulse & timer finales
    if (ctx.pulse) this.finale(t, 6 + Math.floor(Math.random() * 4), 1.5);
    if (t >= this.nextFinaleAt) {
      this.finale(t, 5 + Math.floor(Math.random() * 2), 1.2);
      this.nextFinaleAt = t + rand(40, 54);
    }
    if (t >= this.nextLaunchAt) {
      const size = rand(0.85, 1.25) * this.size * (1 + 0.3 * this.audioBoost);
      this.launchRocket(
        this.aspectX * rand(0.14, 0.86), this.aspectY * rand(0.50, 0.82),
        size, this.pickPattern(), t,
      );
      if (Math.random() < 0.22) { // occasional doubles
        this.launches.push(this.mkLaunch(
          t + rand(0.25, 0.55),
          this.aspectX * rand(0.14, 0.86), this.aspectY * rand(0.50, 0.82),
          rand(0.8, 1.1) * this.size, this.pickPattern(),
        ));
      }
      this.nextLaunchAt = t + rand(2.5, 4.0) / this.rate;
    }
    for (let i = this.launches.length - 1; i >= 0; i--) {
      const L = this.launches[i];
      if (L.at <= t) {
        this.launchRocket(L.tx, L.ty, L.size, L.pattern, t, L.pattern === 'ozama' ? 0.7 : undefined);
        this.launches.splice(i, 1);
      }
    }

    // sim — desperate mode (software GL) integrates at half rate, carrying dt
    this.pendingDt = Math.min(0.06, this.pendingDt + ctx.dt);
    const desperate = this.drawStride >= 8;
    const skipSim = desperate && !ctx.pulse && (ctx.frame & 1) === 1;
    if (!skipSim) {
      const simDt = this.pendingDt;
      this.pendingDt = 0;
      this.stepRockets(t, simDt);
      this.popScheduled(t);
      this.simStep(gl, simDt, t);
      this.flash *= Math.exp(-simDt * 3.6);
    }

    this.accumulateTrails(ctx, ctx.dt);

    this.post.begin();
    gl.useProgram(this.presentProg);
    const pu = this.presentU!;
    pu.setTexture('uTrail', this.accum.read.tex, 0);
    pu.set3f('uBg', th.background[0], th.background[1], th.background[2]);
    pu.set3f('uFlashCol', this.flashColor[0], this.flashColor[1], this.flashColor[2]);
    pu.set1f('uFlash', this.flash);
    drawFullscreen(gl);
    this.post.end({ exposure: 1.12, bloom: 0.62, vignette: 0.30 });

    // canonical GL state (post.end already left FBO=null, activeTexture=0)
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // -------------------------------------------------------------------------

  destroy(gl: WebGL2RenderingContext): void {
    for (const p of [this.updateProg, this.drawProg, this.fadeProg, this.presentProg]) {
      if (p) gl.deleteProgram(p);
    }
    this.updateProg = this.drawProg = this.fadeProg = this.presentProg = null;
    this.updateU = this.drawU = this.fadeU = this.presentU = null;
    for (const pair of this.pairs) {
      gl.deleteTexture(pair.pos);
      gl.deleteTexture(pair.vel);
      gl.deleteFramebuffer(pair.fbo);
    }
    this.pairs = [];
    this.accum?.destroy();
    this.accum = null;
    this.post?.destroy();
    this.post = null;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = null;
    this.pending.length = 0;
    this.scheduled.length = 0;
    this.rockets.length = 0;
    this.launches.length = 0;
    this.gestures.clear();
  }
}

export const hanabiMode: Mode = new HanabiMode();
