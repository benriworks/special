/**
 * LUMINA — THE CONTRACT.
 *
 * This file is FROZEN. Every visual mode is implemented strictly against these
 * interfaces; the engine guarantees the semantics documented here.
 */

export interface PointerState {
  x: number; y: number;        // device px, origin BOTTOM-LEFT (GL convention, engine pre-flips)
  dx: number; dy: number;      // delta since last frame, device px
  nx: number; ny: number;      // normalized [0,1], same origin
  down: boolean;
  pressFrames: number;         // frames since press; 0 when up
  touches: { id: number; x: number; y: number; dx: number; dy: number }[];
}

export interface Theme {
  id: string;
  name: { ja: string; en: string };
  colors: [number, number, number][];   // 4-6 palette colors, LINEAR RGB 0..1, ordered dark→bright
  background: [number, number, number]; // linear RGB
  accent: [number, number, number];     // the UI/pulse accent, linear RGB
}

export interface AudioLevels { level: number; low: number; mid: number; high: number; }

export interface ModeContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  width: number; height: number; dpr: number; // drawing-buffer size, dpr-scaled (dpr capped at 2)
  time: number; dt: number; frame: number;    // dt clamped ≤ 1/20
  pointer: PointerState;
  theme: Theme;
  themeMix: { from: Theme; t: number } | null; // non-null during 800ms theme crossfade; modes SHOULD lerp palettes
  quality: number;                             // 1.0 | 0.7 | 0.45 — multiply sim res & particle counts at init
  audio: AudioLevels | null;
  pulse: boolean;                              // true for exactly one frame when user triggers pulse (Space / two-finger tap)
  /**
   * Session-memory atlas: past frames captured while other modes ran. null
   * until first capture (and again after context loss — history does not
   * survive restore; it refills lazily).
   *
   * Layout: one RGB8 texture of cols×rows square slots, row-major (slot i at
   * column i%cols, row floor(i/cols), bottom-left GL origin). `used` slots
   * (0..used-1) are valid; slots fill in order, then ring-overwrite the
   * oldest. `stamp` counts total captures, monotonically — slot i currently
   * holds the capture whose stamp s is the largest s < stamp with
   * s % (cols*rows) === i, so per-slot relative age ("older/newer" shading)
   * is derivable from `stamp` alone.
   *
   * Capture rules (engine-enforced): a centered square of the canvas is
   * snapshotted roughly every 5s of active play (pointer/pulse activity in
   * the last 8s — pure idle never overwrites memories, EXCEPT to seed a
   * completely empty atlas) plus once per mode switch (the "goodbye frame",
   * same activity rule); never while the tab is hidden, never the crossfade
   * blend itself, never mid-reseed after a quality re-init, and never while
   * the tesseract mode itself runs. Object identity is stable between
   * captures (the engine mutates one held object). Modes ignoring this field
   * are unaffected.
   */
  memory?: { texture: WebGLTexture; cols: number; rows: number; used: number; stamp: number } | null;
}

export type ParamDef =
  | { key: string; label: { ja: string; en: string }; type: 'range'; min: number; max: number; step: number; default: number }
  | { key: string; label: { ja: string; en: string }; type: 'select'; options: { value: string; label: { ja: string; en: string } }[]; default: string }
  | { key: string; label: { ja: string; en: string }; type: 'text'; default: string; placeholder?: { ja: string; en: string }; maxLength?: number };

export interface Mode {
  readonly id: string;
  readonly name: { ja: string; en: string };
  readonly params?: ParamDef[];
  init(ctx: ModeContext): void;      // allocate GL resources; MUST pre-warm so frame 1 already shows living motion
  resize(ctx: ModeContext): void;
  frame(ctx: ModeContext): void;     // one sim step + draw to DEFAULT framebuffer (engine has set viewport)
  setParam?(key: string, value: number | string): void;
  destroy(gl: WebGL2RenderingContext): void; // free EVERYTHING from init
}
