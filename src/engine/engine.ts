/**
 * The conductor: rAF loop, ModeContext assembly, mode lifecycle with capture
 * crossfade, theme crossfade, quality governor, pulse ring, ghost pointer,
 * frame capture and the debug hook backing store.
 */

import type { AudioLevels, Mode, ModeContext, Theme } from './types';
import type { GLHandle } from './gl';
import { AudioInput } from '../core/audio';
import { PointerInput } from './pointer';
import {
  FS_TRIANGLE_VS, compileProgram, drawFullscreen, invalidateGLCaches, UniformSetter,
} from './glutils';
import { MemoryAtlas } from './memory';
import { DEFAULT_THEME_ID, getTheme, linearToCss, mixThemes, themes } from '../core/themes';

const QUALITY_TIERS = [1.0, 0.7, 0.45] as const;
/**
 * Drawing-buffer scale per quality tier. Sim-resolution tiers alone can't save
 * a software rasterizer: display-resolution passes (post composite, trails,
 * present) dominate once sims are cheap. Lower tiers therefore also shrink the
 * drawing buffer itself — CSS size is untouched, the browser upscales, so this
 * is a soft dynamic-resolution drop rather than a layout change. Modes see it
 * only through ctx.width/height/dpr, which already flow through init/resize.
 */
const DISPLAY_SCALES = [1.0, 0.85, 0.7] as const;
const MODE_FADE_S = 0.4;
const THEME_FADE_S = 0.8;
const PULSE_RING_S = 0.3;
/** Canvas/viewport track size changes instantly; the (possibly expensive) mode
 *  rebuild waits until the size has been stable this long. */
const RESIZE_SETTLE_S = 0.2;
const TOUCHED_KEY = 'lumina.touched';

// -- session-memory atlas capture policy (full rules: types.ts ctx.memory) --
/** Cadence of periodic captures during active play. */
const MEMORY_INTERVAL_S = 5;
/** Pointer/pulse activity must be at most this recent for a frame to count as
 *  a "moment the user actually touched" (idle only ever seeds an empty atlas). */
const MEMORY_ACTIVITY_MS = 8000;
/** After a quality-governor re-init, mid-reseed frames are held out of the atlas. */
const MEMORY_REINIT_HOLD_S = 1;
/** The mode that VIEWS the memories never feeds them. */
const MEMORY_EXEMPT_MODE = 'tesseract';

const FADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = vec4(texture(uTex, vUv).rgb, uAlpha); }
`;

const RING_FS = `#version 300 es
precision highp float;
uniform vec2 uCenter;     // device px
uniform float uRadius;    // device px
uniform float uWidth;     // device px
uniform float uAlpha;
uniform vec3 uColor;      // sRGB-ish, drawn straight to default framebuffer
out vec4 outColor;
void main() {
  float d = abs(length(gl_FragCoord.xy - uCenter) - uRadius);
  float a = (1.0 - smoothstep(0.0, uWidth, d)) * uAlpha;
  outColor = vec4(uColor * a, a);
}
`;

export type EngineEvent = 'modechange' | 'themechange' | 'qualitychange' | 'audiochange';

export interface EngineOptions {
  initialModeId?: string;
  initialThemeId?: string;
  initialQuality?: number;
  /** Deep-linked visits skip the first-visit attract demo. */
  skipAttract?: boolean;
  debug?: boolean;
}

interface Ghost {
  kind: 'scurve' | 'swirl';
  start: number; // engine time
  dur: number;
}

export interface EngineStats {
  fps: number;
  frame: number;
  modeId: string;
  luma: number;
  variance: number;
  /** Snapshot of the current mic levels; null while audio is off. */
  audio: AudioLevels | null;
}

export class Engine {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  readonly pointer: PointerInput;
  readonly modes: Mode[];

  /** Resolves after the first rendered frame of the initial mode. */
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private readyDone = false;

  private ctx: ModeContext;
  private activeMode: Mode | null = null;
  private pendingSwitchId: string | null = null;
  private pendingReinit = false;
  /** Engine time at which a deferred activeMode.resize() fires (-1 = none). */
  private modeResizeAt = -1;

  private theme: Theme;
  private themeFrom: Theme | null = null;
  private themeMixStart = -1;

  private tierIndex = 0;
  private emaDt = 1 / 60;
  private lowTime = 0;
  private highTime = 0;
  private governorHoldUntil = 0;
  /** Best sustained (EMA) fps since boot — used to detect an rAF cap. */
  private maxEmaFps = 0;
  private lastRaiseAt = -1e9;
  /** Raise followed quickly by a drop → tier raises locked until this time. */
  private raiseLockUntil = 0;

  private pulseQueued = false;
  private ring: { x: number; y: number; start: number } | null = null;

  private audioIn: AudioInput | null = null;
  private audioOn = false; // emitted state — dedupes 'audiochange'

  private memory: MemoryAtlas;
  /** Engine time before which no periodic memory capture fires. */
  private memNextAt = 0;
  /** Engine time until which captures are held after a governor re-init. */
  private memHoldUntil = 0;
  /** performance.now() of the last real pointer/pulse activity (memory gate). */
  private lastMemActivity = -1e9;

  private fadeTex: WebGLTexture | null = null;
  private fadeSize: [number, number] = [0, 0];
  private fadeStart = -1;
  private fadeProg: WebGLProgram | null = null;
  private fadeU: UniformSetter | null = null;
  private ringProg: WebGLProgram | null = null;
  private ringU: UniformSetter | null = null;

  private ghost: Ghost | null = null;
  private touched: boolean;
  private skipAttract: boolean;
  private reducedMotion: boolean;
  private lastRealActivity = performance.now();
  private bootAt = performance.now();

  private captureResolvers: { resolve: (b: Blob) => void; reject: (e: Error) => void }[] = [];

  private debug: boolean;
  private statLuma = 0;
  private statVariance = 0;
  private statPixels: Uint8Array | null = null;
  private statBuf: WebGLBuffer | null = null;
  private statFence: WebGLSync | null = null;
  private statSize = 0;

  private rafId = 0;
  private running = false;
  private lastMs = -1;
  private time = 0;
  private frame = 0;

  private paramState = new Map<string, Record<string, number | string>>();
  private listeners = new Map<EngineEvent, Set<(detail: string) => void>>();

  constructor(handle: GLHandle, modes: Mode[], opts: EngineOptions = {}) {
    this.gl = handle.gl;
    this.canvas = handle.canvas;
    this.modes = modes;
    this.debug = !!opts.debug;
    this.skipAttract = !!opts.skipAttract;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.touched = (() => {
      try { return localStorage.getItem(TOUCHED_KEY) === '1'; } catch { return true; }
    })();

    this.theme = getTheme(opts.initialThemeId ?? DEFAULT_THEME_ID) ?? themes[0];
    document.documentElement.style.setProperty('--ui-accent', linearToCss(this.theme.accent));

    if (opts.initialQuality !== undefined) {
      let best = 0;
      for (let i = 0; i < QUALITY_TIERS.length; i++) {
        if (Math.abs(QUALITY_TIERS[i] - opts.initialQuality) < Math.abs(QUALITY_TIERS[best] - opts.initialQuality)) best = i;
      }
      this.tierIndex = best;
    }

    this.ready = new Promise<void>((res) => { this.resolveReady = res; });

    this.pointer = new PointerInput(this.canvas, {
      onRealPointerDown: () => this.markTouched(),
      onRealActivity: () => {
        this.lastRealActivity = performance.now();
        this.lastMemActivity = performance.now();
      },
      onPulse: () => this.requestPulse(),
    });

    const gl = this.gl;
    this.memory = new MemoryAtlas(gl); // GL allocation is lazy — free until first capture
    this.ctx = {
      gl,
      canvas: this.canvas,
      width: 1, height: 1, dpr: 1,
      time: 0, dt: 1 / 60, frame: 0,
      pointer: this.pointer.state,
      theme: this.theme,
      themeMix: null,
      quality: QUALITY_TIERS[this.tierIndex],
      audio: null,
      pulse: false,
      memory: null,
    };

    this.createOverlayResources();

    handle.onContextLost = () => {
      this.disableAudio(); // mic must not stay hot while GL is gone
      this.stopLoop();
    };
    handle.onContextRestored = () => this.handleContextRestored();

    const initial = opts.initialModeId && modes.some((m) => m.id === opts.initialModeId)
      ? opts.initialModeId
      : modes[0]?.id;
    if (initial) this.pendingSwitchId = initial;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastMs = -1;
    this.rafId = requestAnimationFrame(this.loop);
  }

  destroy(): void {
    this.disableAudio();
    this.stopLoop();
    this.rejectCaptures('engine destroyed');
    this.pointer.destroy();
    const gl = this.gl;
    if (this.activeMode) { try { this.activeMode.destroy(gl); } catch { /* already gone */ } }
    this.activeMode = null;
    this.memory.destroy();
    if (this.fadeTex) gl.deleteTexture(this.fadeTex);
    if (this.fadeProg) gl.deleteProgram(this.fadeProg);
    if (this.ringProg) gl.deleteProgram(this.ringProg);
    if (this.statFence) gl.deleteSync(this.statFence);
    if (this.statBuf) gl.deleteBuffer(this.statBuf);
    this.statFence = null;
    this.statBuf = null;
  }

  get activeModeId(): string {
    return this.pendingSwitchId ?? this.activeMode?.id ?? '';
  }

  get themeId(): string { return this.theme.id; }
  get quality(): number { return QUALITY_TIERS[this.tierIndex]; }
  get currentTheme(): Theme { return this.theme; }

  on(event: EngineEvent, fn: (detail: string) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(event: EngineEvent, detail: string): void {
    for (const fn of this.listeners.get(event) ?? []) fn(detail);
  }

  /** Queue a mode switch; the crossfade happens inside the frame loop. */
  switchMode(id: string): void {
    if (!this.modes.some((m) => m.id === id)) return;
    if (id === this.activeModeId) return;
    this.pendingSwitchId = id;
    this.emit('modechange', id);
  }

  setTheme(id: string): void {
    const next = getTheme(id);
    if (!next || next.id === this.theme.id) return;
    // start crossfade from the current *effective* theme (handles rapid cycling)
    this.themeFrom = this.effectiveThemeFrom();
    this.theme = next;
    this.ctx.theme = next;
    this.themeMixStart = this.time;
    document.documentElement.style.setProperty('--ui-accent', linearToCss(next.accent));
    this.emit('themechange', next.id);
  }

  private effectiveThemeFrom(): Theme {
    if (this.themeMixStart >= 0 && this.themeFrom) {
      const t = Math.min(1, (this.time - this.themeMixStart) / THEME_FADE_S);
      // snapshot the mid-fade blend as the new "from"
      return mixThemes(this.themeFrom, this.theme, t);
    }
    return this.theme;
  }

  cycleTheme(dir = 1): void {
    const i = themes.findIndex((t) => t.id === this.theme.id);
    const next = themes[(i + dir + themes.length) % themes.length];
    this.setTheme(next.id);
  }

  /** Space / two-finger tap. ctx.pulse is true for exactly one frame. */
  requestPulse(): void {
    this.pulseQueued = true;
    this.lastMemActivity = performance.now(); // pulses count as memory-worthy activity
  }

  // -------------------------------------------------------------------------
  // Microphone audio reactivity
  // -------------------------------------------------------------------------

  /**
   * Ask for the mic and start feeding ctx.audio (sampled once per frame,
   * before mode.frame). Rejects with the original getUserMedia error on
   * permission denial — the caller decides the UI. Idempotent while running.
   */
  async enableAudio(): Promise<void> {
    if (!this.audioIn) this.audioIn = new AudioInput();
    await this.audioIn.start();
    if (!this.audioOn && this.audioIn.running) {
      this.audioOn = true;
      this.emit('audiochange', 'on');
    }
  }

  /** Release the mic; ctx.audio returns to null immediately. */
  disableAudio(): void {
    this.audioIn?.stop();
    this.ctx.audio = null;
    if (this.audioOn) {
      this.audioOn = false;
      this.emit('audiochange', 'off');
    }
  }

  get audioEnabled(): boolean {
    return this.audioIn !== null && this.audioIn.running;
  }

  /** Set a param on the active mode (persisted across re-inits). */
  setModeParam(key: string, value: number | string): void {
    const id = this.activeModeId;
    if (!id) return;
    let store = this.paramState.get(id);
    if (!store) { store = {}; this.paramState.set(id, store); }
    store[key] = value;
    if (this.activeMode?.id === id) this.activeMode.setParam?.(key, value);
  }

  /** Stored (user-set) params for a mode — merge over ParamDef defaults in UI. */
  getParamValues(modeId: string): Record<string, number | string> {
    return { ...(this.paramState.get(modeId) ?? {}) };
  }

  /** Seed params (from URL) before/at boot for a given mode. */
  seedParams(modeId: string, params: Record<string, number | string>): void {
    const store = this.paramState.get(modeId) ?? {};
    Object.assign(store, params);
    this.paramState.set(modeId, store);
  }

  /** UI keystrokes etc. count as activity for the idle-attract timer. */
  noteActivity(): void {
    this.lastRealActivity = performance.now();
  }

  markTouched(): void {
    this.ghostStop();
    if (!this.touched) {
      this.touched = true;
      try { localStorage.setItem(TOUCHED_KEY, '1'); } catch { /* ignore */ }
    }
  }

  /** Resolves with a PNG of the next rendered frame (no preserveDrawingBuffer needed). */
  captureFrame(): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      this.captureResolvers.push({ resolve, reject });
    });
  }

  getStats(): EngineStats {
    const a = this.ctx.audio;
    return {
      fps: this.emaDt > 0 ? 1 / this.emaDt : 0,
      frame: this.frame,
      modeId: this.activeMode?.id ?? '',
      luma: this.statLuma,
      variance: this.statVariance,
      audio: a ? { level: a.level, low: a.low, mid: a.mid, high: a.high } : null,
    };
  }

  get isReady(): boolean { return this.readyDone; }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private stopLoop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    // queued Save promises must not hang forever once the loop halts
    this.rejectCaptures('render loop stopped before capture');
  }

  private rejectCaptures(reason: string): void {
    if (this.captureResolvers.length === 0) return;
    const waiting = this.captureResolvers;
    this.captureResolvers = [];
    const err = new Error(`captureFrame failed: ${reason}`);
    for (const w of waiting) w.reject(err);
  }

  private loop = (nowMs: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const rawDt = this.lastMs < 0 ? 1 / 60 : Math.min(1, Math.max(0.0001, (nowMs - this.lastMs) / 1000));
    this.lastMs = nowMs;
    const dt = Math.min(rawDt, 1 / 20);
    this.time += dt;
    this.frame++;

    this.resizeIfNeeded();
    this.pointer.beginFrame();
    this.updateGhost();

    const ctx = this.ctx;
    ctx.time = this.time;
    ctx.dt = dt;
    ctx.frame = this.frame;
    ctx.quality = QUALITY_TIERS[this.tierIndex];
    ctx.theme = this.theme;
    ctx.themeMix = null;
    if (this.themeMixStart >= 0 && this.themeFrom) {
      const t = (this.time - this.themeMixStart) / THEME_FADE_S;
      if (t >= 1) {
        this.themeMixStart = -1;
        this.themeFrom = null;
      } else {
        ctx.themeMix = { from: this.themeFrom, t };
      }
    }

    ctx.pulse = this.pulseQueued;
    if (this.pulseQueued) {
      this.ring = { x: ctx.pointer.x || ctx.width / 2, y: ctx.pointer.y || ctx.height / 2, start: this.time };
      this.pulseQueued = false;
    }

    // mic levels: one sample per frame, before mode.frame — sample() mutates
    // and returns the same AudioLevels object (no per-frame allocation)
    ctx.audio = this.audioIn !== null && this.audioIn.running ? this.audioIn.sample() : null;

    let plainFrame = false; // an ordinary activeMode.frame() — no switch/reinit
    try {
      if (this.pendingSwitchId !== null) {
        this.performSwitch(this.pendingSwitchId);
      } else if (this.pendingReinit) {
        this.pendingReinit = false;
        // governor reseed: mid-reseed frames are held out of the memory atlas
        this.memHoldUntil = this.time + MEMORY_REINIT_HOLD_S;
        this.restartActiveMode();
      } else if (this.activeMode) {
        this.activeMode.frame(ctx);
        plainFrame = true;
      }
    } catch (err) {
      console.error('[lumina] mode frame failed:', err);
      this.stopLoop();
      throw err;
    }
    this.resetGLState();

    // Periodic memory capture: only plain frames (switch frames go through the
    // goodbye path inside performSwitch, reinit frames are skipped), and
    // always BEFORE the fade overlay — the crossfade blend is never captured.
    if (plainFrame) this.maybeCaptureMemory();

    this.drawFadeOverlay();
    this.drawPulseRing();
    this.resetGLState();

    ctx.pulse = false;

    if (this.debug && this.frame % 5 === 0) this.sampleStats();

    if (this.captureResolvers.length > 0) {
      const waiting = this.captureResolvers;
      this.captureResolvers = [];
      // same task as the render → drawing buffer still valid
      this.canvas.toBlob((blob) => {
        for (const w of waiting) {
          if (blob) w.resolve(blob);
          else w.reject(new Error('canvas.toBlob returned null'));
        }
      }, 'image/png');
    }

    if (!this.readyDone && this.activeMode) {
      this.readyDone = true;
      this.resolveReady();
    }

    this.updateGovernor(rawDt);
  };

  private resizeIfNeeded(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1) * DISPLAY_SCALES[this.tierIndex];
    const w = Math.max(1, Math.round((this.canvas.clientWidth || 1) * dpr));
    const h = Math.max(1, Math.round((this.canvas.clientHeight || 1) * dpr));
    if (w !== this.canvas.width || h !== this.canvas.height || dpr !== this.ctx.dpr) {
      // presentation tracks the new size immediately (stays crisp) ...
      this.canvas.width = w;
      this.canvas.height = h;
      this.ctx.width = w;
      this.ctx.height = h;
      this.ctx.dpr = dpr;
      this.pointer.setBufferSize(w, h);
      this.gl.viewport(0, 0, w, h);
      // ... but the (potentially expensive) mode rebuild is debounced: a
      // window-edge drag emits 1-2px deltas every frame, and a per-frame
      // resize() would reseed heavy sims (RD: hundreds of substeps) each one.
      this.modeResizeAt = this.time + RESIZE_SETTLE_S;
    }
    if (this.modeResizeAt >= 0 && this.time >= this.modeResizeAt) {
      this.modeResizeAt = -1;
      // pendingReinit rebuilds the mode at the current ctx dims this very
      // frame — a resize() first would just double the multi-hundred-ms stall.
      if (this.activeMode && this.pendingSwitchId === null && !this.pendingReinit) {
        try { this.activeMode.resize(this.ctx); } catch (err) { console.error('[lumina] resize failed:', err); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Mode lifecycle
  // -------------------------------------------------------------------------

  private performSwitch(newId: string): void {
    const next = this.modes.find((m) => m.id === newId);
    this.pendingSwitchId = null;
    if (!next) return;

    if (this.activeMode) {
      // one last old-mode frame, capture it, then tear down
      this.activeMode.frame(this.ctx);
      this.resetGLState();
      this.captureCanvas();
      // "goodbye frame": the crossfade capture moment doubles as a memory
      this.tryMemoryCapture(this.activeMode.id);
      this.destroyActive();
      this.fadeStart = this.time;
    }

    this.activeMode = next;
    this.initActive();
  }

  private restartActiveMode(): void {
    if (!this.activeMode) return;
    this.activeMode.frame(this.ctx);
    this.resetGLState();
    this.captureCanvas();
    this.destroyActive();
    this.fadeStart = this.time;
    this.initActive();
  }

  private destroyActive(): void {
    const gl = this.gl;
    if (!this.activeMode) return;
    try {
      this.activeMode.destroy(gl);
    } catch (err) {
      console.error(`[lumina] destroy of mode "${this.activeMode.id}" failed:`, err);
    }
    if (this.debug) {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) {
        console.warn(`[lumina] GL error 0x${err.toString(16)} left after destroying "${this.activeMode.id}"`);
      }
    }
    this.resetGLState();
  }

  private initActive(): void {
    if (!this.activeMode) return;
    const mode = this.activeMode;
    this.modeResizeAt = -1; // init builds at current ctx dims — absorbs any pending deferred resize
    mode.init(this.ctx); // contract: pre-warmed, frame 1 already alive
    const stored = this.paramState.get(mode.id);
    if (stored && mode.setParam) {
      for (const [k, v] of Object.entries(stored)) mode.setParam(k, v);
    }
    this.resetGLState();
    // fresh mode gets a governor grace period
    this.governorHoldUntil = this.time + 1.5;
    this.lowTime = 0;
    this.highTime = 0;
    // render the new mode's first frame immediately so this rAF isn't stale
    mode.frame(this.ctx);
    this.resetGLState();
  }

  private captureCanvas(): void {
    const gl = this.gl;
    const w = this.ctx.width;
    const h = this.ctx.height;
    if (!this.fadeTex || this.fadeSize[0] !== w || this.fadeSize[1] !== h) {
      if (this.fadeTex) gl.deleteTexture(this.fadeTex);
      this.fadeTex = gl.createTexture();
      this.fadeSize = [w, h];
      gl.bindTexture(gl.TEXTURE_2D, this.fadeTex);
      // The default framebuffer is alpha:false → its color format is RGB, and
      // WebGL2 forbids RGBA copies from an RGB source (GL_INVALID_OPERATION).
      // Allocate immutable RGB8 storage once per size; the copy below is then
      // an always-legal RGB←RGB (or RGB←RGBA) transfer.
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGB8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.fadeTex);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // -------------------------------------------------------------------------
  // Session-memory atlas (feeds the tesseract mode via ctx.memory)
  // -------------------------------------------------------------------------

  /** Time-gate for the periodic ("every ~5s of active play") capture path. */
  private maybeCaptureMemory(): void {
    if (!this.activeMode) return;
    if (this.time < this.memNextAt || this.time < this.memHoldUntil) return;
    this.tryMemoryCapture(this.activeMode.id);
  }

  /**
   * Shared gate + capture for both memory paths (periodic and mode-switch
   * goodbye frame). Snapshots the default framebuffer AS IT STANDS — callers
   * only invoke it while it holds a pure mode frame (never the crossfade
   * blend, never a mid-reseed frame). On success the ctx.memory view goes (or
   * stays) live and the periodic cadence restarts.
   */
  private tryMemoryCapture(modeId: string): void {
    if (modeId === MEMORY_EXEMPT_MODE) return; // the memory viewer never feeds the atlas
    if (document.hidden) return;               // background tabs make no memories
    const touchedRecently = performance.now() - this.lastMemActivity < MEMORY_ACTIVITY_MS;
    // memories = moments the user actually touched; pure idle never overwrites
    // them — but a completely empty atlas accepts idle frames so the tesseract
    // is never starved.
    if (!touchedRecently && this.memory.used > 0) return;
    this.memory.capture(this.ctx.width, this.ctx.height, modeId);
    this.ctx.memory = this.memory.info;
    this.memNextAt = this.time + MEMORY_INTERVAL_S;
  }

  /** Debug hook (window.__lumina.memory): atlas fill state. */
  getMemoryInfo(): { used: number; stamp: number } {
    return { used: this.memory.used, stamp: this.memory.stamp };
  }

  // -------------------------------------------------------------------------
  // Overlays
  // -------------------------------------------------------------------------

  private createOverlayResources(): void {
    const gl = this.gl;
    this.fadeProg = compileProgram(gl, FS_TRIANGLE_VS, FADE_FS, 'engine.fade');
    this.fadeU = new UniformSetter(gl, this.fadeProg);
    this.ringProg = compileProgram(gl, FS_TRIANGLE_VS, RING_FS, 'engine.ring');
    this.ringU = new UniformSetter(gl, this.ringProg);
  }

  private drawFadeOverlay(): void {
    if (this.fadeStart < 0 || !this.fadeTex || !this.fadeProg || !this.fadeU) return;
    const t = (this.time - this.fadeStart) / MODE_FADE_S;
    if (t >= 1) {
      this.fadeStart = -1;
      return;
    }
    const gl = this.gl;
    const alpha = 1 - t * t * (3 - 2 * t); // smoothstep out
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.ctx.width, this.ctx.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.fadeProg);
    this.fadeU.setTexture('uTex', this.fadeTex, 0);
    this.fadeU.set1f('uAlpha', alpha);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
  }

  private drawPulseRing(): void {
    if (!this.ring || !this.ringProg || !this.ringU) return;
    const t = (this.time - this.ring.start) / PULSE_RING_S;
    if (t >= 1) {
      this.ring = null;
      return;
    }
    const gl = this.gl;
    const w = this.ctx.width;
    const h = this.ctx.height;
    const maxR = Math.min(w, h) * 0.45;
    const ease = 1 - (1 - t) * (1 - t);
    const accent = this.theme.accent;
    // linear → approx sRGB for direct display write
    const srgb = accent.map((c) => Math.pow(Math.max(0, c), 1 / 2.2)) as unknown as [number, number, number];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // additive
    gl.useProgram(this.ringProg);
    this.ringU.set2f('uCenter', this.ring.x, this.ring.y);
    this.ringU.set1f('uRadius', 12 + ease * maxR);
    this.ringU.set1f('uWidth', (10 + 26 * t) * this.ctx.dpr);
    this.ringU.set1f('uAlpha', 0.85 * (1 - t));
    this.ringU.set3f('uColor', srgb[0], srgb[1], srgb[2]);
    drawFullscreen(gl);
    gl.disable(gl.BLEND);
  }

  private resetGLState(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.viewport(0, 0, this.ctx.width, this.ctx.height);
  }

  // -------------------------------------------------------------------------
  // Quality governor
  // -------------------------------------------------------------------------

  private updateGovernor(rawDt: number): void {
    this.emaDt += (rawDt - this.emaDt) * 0.08;
    if (this.time < this.governorHoldUntil || this.pendingSwitchId !== null || this.pendingReinit) return;
    const fps = 1 / this.emaDt;
    // maxEmaFps only updates past the post-init hold, so the optimistic
    // 60fps EMA seed never masquerades as a measured 60Hz cap on 30Hz devices.
    if (fps > this.maxEmaFps) this.maxEmaFps = fps;

    // rAF-cap detection: devices capped below their real capability (e.g. iOS
    // Low Power Mode pins rAF at 30Hz) hover just under the cap forever — the
    // raise threshold is then unreachable and every hiccup would one-way
    // ratchet quality to the floor. If the EMA sits within ~8% of the nearest
    // standard cap to the best fps ever sustained, the device is delivering
    // what rAF allows: never demote.
    const best = this.maxEmaFps;
    const cap = Math.abs(best - 30) < Math.abs(best - 60) ? 30
      : Math.abs(best - 60) < Math.abs(best - 120) ? 60 : 120;
    const atCap = fps >= cap * 0.92;

    if (fps < 27 && !atCap) { // margin below a 30Hz rAF cap
      this.lowTime += rawDt;
      this.highTime = 0;
      // catastrophic fps (software rasterizers, very weak GPUs) descends a
      // tier per second instead of per two — reach a usable rate quickly.
      const dropAfter = fps < 18 ? 1 : 2;
      if (this.lowTime > dropAfter && this.tierIndex < QUALITY_TIERS.length - 1) {
        this.tierIndex++;
        this.lowTime = 0;
        // a raise that immediately re-drops means we're oscillating around a
        // boundary — lock further raises so it settles at the lower tier.
        if (this.time - this.lastRaiseAt < 20) this.raiseLockUntil = this.time + 180;
        this.pendingReinit = true; // re-init active mode at lower sim res (display res untouched)
        this.emit('qualitychange', String(QUALITY_TIERS[this.tierIndex]));
      }
    } else if (fps > 55) {
      this.highTime += rawDt;
      this.lowTime = 0;
      if (this.highTime > 10 && this.tierIndex > 0 && this.time >= this.raiseLockUntil) {
        this.tierIndex--;
        this.highTime = 0;
        this.lastRaiseAt = this.time;
        this.pendingReinit = true;
        this.emit('qualitychange', String(QUALITY_TIERS[this.tierIndex]));
      }
    } else {
      this.lowTime = 0;
      this.highTime = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Ghost pointer (attract mode)
  // -------------------------------------------------------------------------

  private ghostStop(): void {
    if (this.ghost) {
      this.pointer.syntheticUp();
      this.ghost = null;
    }
  }

  private updateGhost(): void {
    if (this.touched) return;
    const now = performance.now();

    if (!this.ghost) {
      const sinceBoot = now - this.bootAt;
      const idleFor = now - this.lastRealActivity;
      if (!this.skipAttract && sinceBoot > 1200 && sinceBoot < 30000 && this.frame > 30) {
        this.ghost = { kind: 'scurve', start: this.time, dur: 3.2 };
        this.skipAttract = true; // only once
        this.pointer.syntheticMove(0.16, 0.38, true);
        this.pointer.syntheticDown();
      } else if (idleFor > 30000) {
        this.ghost = { kind: 'swirl', start: this.time, dur: 3.6 };
        this.lastRealActivity = now; // repeat only after another 30s idle
        this.pointer.syntheticMove(0.5, 0.5, true);
        this.pointer.syntheticDown();
      }
      if (!this.ghost) return;
    }

    const g = this.ghost;
    const t = (this.time - g.start) / g.dur;
    if (t >= 1) {
      this.ghostStop();
      return;
    }
    const amp = this.reducedMotion ? 0.5 : 1;
    const ease = t * t * (3 - 2 * t);
    let nx = 0.5;
    let ny = 0.5;
    if (g.kind === 'scurve') {
      nx = 0.5 + (ease - 0.5) * 0.68 * amp;
      ny = 0.5 + Math.sin(ease * Math.PI * 2) * 0.16 * amp + (ease - 0.5) * 0.18 * amp;
    } else {
      const a = ease * Math.PI * 2;
      nx = 0.5 + Math.cos(a) * 0.2 * amp * Math.sin(Math.PI * Math.min(1, t * 1.15));
      ny = 0.5 + Math.sin(a * 1.5) * 0.16 * amp * Math.sin(Math.PI * Math.min(1, t * 1.15));
    }
    this.pointer.syntheticMove(nx, ny);
  }

  // -------------------------------------------------------------------------
  // Debug stats
  // -------------------------------------------------------------------------

  /**
   * Async luma/variance sampling: readPixels goes into a PIXEL_PACK buffer and
   * is harvested a later frame once its fence signals. A synchronous readback
   * here would stall the GPU every 5 frames (ANGLE logs "GPU stall due to
   * ReadPixels" driver warnings); stats may lag a few frames, which the
   * verify harness tolerates.
   */
  private sampleStats(): void {
    const gl = this.gl;

    if (this.statFence) {
      const status = gl.clientWaitSync(this.statFence, 0, 0);
      if (status !== gl.CONDITION_SATISFIED && status !== gl.ALREADY_SIGNALED) return; // not ready — retry next sample
      gl.deleteSync(this.statFence);
      this.statFence = null;
      const count = this.statSize * this.statSize;
      if (!this.statPixels || this.statPixels.length !== count * 4) {
        this.statPixels = new Uint8Array(count * 4);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statBuf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.statPixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const px = this.statPixels;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const l = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255;
        sum += l;
        sumSq += l * l;
      }
      const mean = sum / count;
      this.statLuma = mean;
      this.statVariance = Math.max(0, sumSq / count - mean * mean);
    }

    const w = this.ctx.width;
    const h = this.ctx.height;
    const size = Math.min(64, w, h);
    if (size < 2) return;
    const x0 = Math.max(0, (w - size) >> 1);
    const y0 = Math.max(0, (h - size) >> 1);
    this.statSize = size;
    if (!this.statBuf) this.statBuf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.statBuf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, size * size * 4, gl.STREAM_READ);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x0, y0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.statFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  // -------------------------------------------------------------------------
  // Context restore
  // -------------------------------------------------------------------------

  private handleContextRestored(): void {
    const gl = this.gl;
    invalidateGLCaches(gl);
    this.fadeTex = null;
    this.fadeSize = [0, 0];
    this.fadeStart = -1;
    this.ring = null;
    this.statBuf = null;
    this.statFence = null;
    // memory atlas: handles died with the context — drop them and forget the
    // history (documented as acceptable); it reallocates lazily on capture.
    this.memory.invalidate();
    this.ctx.memory = null;
    this.memNextAt = 0;
    this.memHoldUntil = 0;
    try { this.createOverlayResources(); } catch (err) {
      console.error('[lumina] failed to rebuild overlay resources after context restore:', err);
      return;
    }
    if (this.activeMode) {
      try { this.activeMode.destroy(gl); } catch { /* stale handles are fine to ignore */ }
      try {
        this.modeResizeAt = -1; // fresh init absorbs any pending deferred resize
        this.activeMode.init(this.ctx);
        const stored = this.paramState.get(this.activeMode.id);
        if (stored && this.activeMode.setParam) {
          for (const [k, v] of Object.entries(stored)) this.activeMode.setParam(k, v);
        }
      } catch (err) {
        console.error('[lumina] mode re-init after context restore failed:', err);
      }
      this.resetGLState();
    }
    this.start();
  }
}
