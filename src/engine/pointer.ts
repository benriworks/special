/**
 * Unified mouse/touch/pen input via Pointer Events (+ getCoalescedEvents).
 *
 * Maintains a single PointerState in GL orientation: device pixels, origin
 * BOTTOM-LEFT (Y pre-flipped), scaled to the drawing buffer.
 *
 * Also exposes a synthetic-input API: the engine can drive a "ghost pointer"
 * through the SAME PointerState, so modes cannot tell a demo gesture from a
 * real one.
 *
 * pressFrames semantics: 0 while up; 1 on the first frame after press, then
 * incrementing every frame the pointer stays down.
 */

import type { PointerState } from './types';

export interface PointerCallbacks {
  /** Fired on any real pointerdown (used to cancel the ghost + set the touched flag). */
  onRealPointerDown?: () => void;
  /** Fired on any real pointer activity (move/down/up) — idle tracking. */
  onRealActivity?: () => void;
  /** Fired when a two-finger tap is detected → pulse. */
  onPulse?: () => void;
}

interface TrackedTouch {
  id: number;
  x: number; y: number;       // current, device px, GL origin
  px: number; py: number;     // previous frame
  startX: number; startY: number;
  startTime: number;
  moved: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class PointerInput {
  readonly state: PointerState = {
    x: 0, y: 0, dx: 0, dy: 0, nx: 0.5, ny: 0.5,
    down: false, pressFrames: 0, touches: [],
  };

  private bufW = 1;
  private bufH = 1;
  private rect: DOMRect;

  // primary pointer target position (device px, GL origin)
  private curX = 0;
  private curY = 0;
  private prevX = 0;
  private prevY = 0;
  private realDown = false;
  private synthDown = false;
  private everMoved = false;

  private touchMap = new Map<number, TrackedTouch>();
  private twoFingerStart = -1;

  private disposers: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private cbs: PointerCallbacks = {}) {
    canvas.style.touchAction = 'none';
    this.rect = canvas.getBoundingClientRect();

    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type as string, fn as EventListener, opts));
    };

    on(canvas, 'pointerdown', (e: PointerEvent) => this.handleDown(e));
    on(window, 'pointermove', (e: PointerEvent) => this.handleMove(e));
    on(window, 'pointerup', (e: PointerEvent) => this.handleUp(e));
    on(window, 'pointercancel', (e: PointerEvent) => this.handleUp(e));
    on(window, 'resize', () => this.refreshRect());
    on(window, 'scroll', () => this.refreshRect(), { passive: true });
  }

  /** Engine calls this whenever the drawing buffer is (re)sized. */
  setBufferSize(w: number, h: number): void {
    this.bufW = Math.max(1, w);
    this.bufH = Math.max(1, h);
    this.refreshRect();
  }

  private refreshRect(): void {
    this.rect = this.canvas.getBoundingClientRect();
  }

  private toGL(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.rect;
    const sx = this.bufW / Math.max(1, r.width);
    const sy = this.bufH / Math.max(1, r.height);
    return {
      x: (clientX - r.left) * sx,
      y: this.bufH - (clientY - r.top) * sy, // flip to bottom-left origin
    };
  }

  private handleDown(e: PointerEvent): void {
    this.refreshRect();
    const p = this.toGL(e.clientX, e.clientY);

    if (e.pointerType === 'touch') {
      const t: TrackedTouch = {
        id: e.pointerId, x: p.x, y: p.y, px: p.x, py: p.y,
        startX: p.x, startY: p.y, startTime: performance.now(), moved: 0,
      };
      this.touchMap.set(e.pointerId, t);
      if (this.touchMap.size === 2) this.twoFingerStart = performance.now();
      if (this.touchMap.size > 2) this.twoFingerStart = -1;
    }

    if (e.isPrimary || e.pointerType !== 'touch') {
      this.curX = p.x;
      this.curY = p.y;
      // avoid a giant teleport delta on the press frame (esp. touch)
      if (e.pointerType === 'touch' || !this.everMoved) {
        this.prevX = p.x;
        this.prevY = p.y;
      }
      this.realDown = true;
      this.synthDown = false; // real input always wins
    }
    this.everMoved = true;
    this.cbs.onRealPointerDown?.();
    this.cbs.onRealActivity?.();
  }

  private handleMove(e: PointerEvent): void {
    const events = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length > 0
      ? e.getCoalescedEvents()
      : [e];
    let p = this.toGL(e.clientX, e.clientY);
    for (const ev of events) p = this.toGL(ev.clientX, ev.clientY);

    if (e.pointerType === 'touch') {
      const t = this.touchMap.get(e.pointerId);
      if (t) {
        t.moved += Math.hypot(p.x - t.x, p.y - t.y);
        t.x = p.x;
        t.y = p.y;
      }
      if (!e.isPrimary) {
        this.cbs.onRealActivity?.();
        return;
      }
    }

    if (!this.everMoved) {
      this.prevX = p.x;
      this.prevY = p.y;
      this.everMoved = true;
    }
    this.curX = p.x;
    this.curY = p.y;
    this.cbs.onRealActivity?.();
  }

  private handleUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      const t = this.touchMap.get(e.pointerId);
      this.touchMap.delete(e.pointerId);
      // two-finger tap → pulse: both fingers released quickly with little travel
      if (t && this.twoFingerStart > 0 && this.touchMap.size <= 1) {
        const elapsed = performance.now() - this.twoFingerStart;
        const still = t.moved < 14 * Math.max(1, this.bufW / Math.max(1, this.rect.width));
        if (elapsed < 350 && still && this.touchMap.size === 1) {
          const other = [...this.touchMap.values()][0];
          if (other && other.moved < 14 * Math.max(1, this.bufW / Math.max(1, this.rect.width))) {
            this.cbs.onPulse?.();
            this.twoFingerStart = -1;
          }
        }
      }
      if (this.touchMap.size === 0) this.twoFingerStart = -1;
      if (this.touchMap.size === 0 && e.isPrimary) this.realDown = false;
      if (e.isPrimary) this.realDown = false;
    } else {
      this.realDown = false;
    }
    this.cbs.onRealActivity?.();
  }

  // -------------------------------------------------------------------------
  // Synthetic (ghost) input — drives the SAME state as real input.
  // -------------------------------------------------------------------------

  /** Move the ghost pointer to normalized [0,1] coords (GL origin). `jump` avoids a delta spike. */
  syntheticMove(nx: number, ny: number, jump = false): void {
    this.curX = clamp01(nx) * this.bufW;
    this.curY = clamp01(ny) * this.bufH;
    if (jump) {
      this.prevX = this.curX;
      this.prevY = this.curY;
    }
    this.everMoved = true;
  }

  syntheticDown(): void {
    if (!this.realDown) this.synthDown = true;
  }

  syntheticUp(): void {
    this.synthDown = false;
  }

  // -------------------------------------------------------------------------
  // Per-frame update — engine calls once at the top of each frame.
  // -------------------------------------------------------------------------

  beginFrame(): void {
    const s = this.state;
    s.dx = this.curX - this.prevX;
    s.dy = this.curY - this.prevY;
    s.x = this.curX;
    s.y = this.curY;
    s.nx = clamp01(this.bufW > 0 ? this.curX / this.bufW : 0.5);
    s.ny = clamp01(this.bufH > 0 ? this.curY / this.bufH : 0.5);
    this.prevX = this.curX;
    this.prevY = this.curY;

    const down = this.realDown || this.synthDown;
    s.pressFrames = down ? s.pressFrames + 1 : 0;
    s.down = down;

    s.touches.length = 0;
    for (const t of this.touchMap.values()) {
      s.touches.push({ id: t.id, x: t.x, y: t.y, dx: t.x - t.px, dy: t.y - t.py });
      t.px = t.x;
      t.py = t.y;
    }
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
