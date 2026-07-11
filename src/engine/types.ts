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
