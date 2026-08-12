/**
 * #kiosk=1 — exhibition mode. Two duties:
 *
 *   1. Screen Wake Lock: requested immediately (works when the page already
 *      has user activation / an installed-app context allows it), otherwise
 *      retried on the first user interaction; re-acquired when the tab
 *      becomes visible again and whenever the OS releases it. Feature-
 *      detected — a silent no-op where unsupported (auto-cycle still works).
 *
 *   2. Auto-cycle: after CYCLE_S seconds of ZERO user input, switch to the
 *      next mode in registry order. Any pointer / key / wheel activity resets
 *      the timer — a visitor mid-play is never yanked to another mode.
 *
 * The idle attract loop (engine ghost pointer) is deliberately untouched:
 * its synthetic input never dispatches DOM events, so it cannot reset the
 * cycle timer either.
 */

import type { Engine } from '../engine/engine';

const CYCLE_S = 90;
const TICK_MS = 1000;

export interface KioskOptions {
  /** Cycle-interval override in seconds (test-only; main.ts gates it behind debug=1). */
  intervalS?: number;
}

// Minimal structural types — independent of lib.dom's WakeLock availability.
interface WakeLockSentinelLike {
  readonly released: boolean;
  addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export function initKiosk(engine: Engine, opts: KioskOptions = {}): void {
  const cycleMs = (opts.intervalS && opts.intervalS > 0 ? opts.intervalS : CYCLE_S) * 1000;

  // ---- screen wake lock -----------------------------------------------------
  const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  let sentinel: WakeLockSentinelLike | null = null;
  let acquiring = false;

  function acquireWakeLock(): void {
    if (!wakeLock || acquiring || document.hidden) return;
    if (sentinel && !sentinel.released) return; // already held
    acquiring = true;
    wakeLock.request('screen').then(
      (s) => {
        acquiring = false;
        sentinel = s;
        // The UA may release it at any time (tab hidden, battery saver…) —
        // grab it again as soon as we are visible.
        s.addEventListener('release', () => {
          if (!document.hidden) acquireWakeLock();
        });
      },
      () => {
        acquiring = false; // NotAllowedError before a gesture etc. — retried on next input
      },
    );
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) acquireWakeLock();
  });

  // ---- auto-cycle after total inactivity ------------------------------------
  let lastInputAt = performance.now();

  const onInput = (): void => {
    lastInputAt = performance.now();
    acquireWakeLock(); // cheap no-op once held — doubles as the "first gesture" retry
  };
  // capture phase: UI handlers that stop propagation must still reset the timer
  window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
  window.addEventListener('pointermove', onInput, { capture: true, passive: true });
  window.addEventListener('keydown', onInput, true);
  window.addEventListener('wheel', onInput, { capture: true, passive: true });

  window.setInterval(() => {
    if (document.hidden) {
      lastInputAt = performance.now(); // never cycle (or pile up) in a background tab
      return;
    }
    if (performance.now() - lastInputAt < cycleMs) return;
    lastInputAt = performance.now();
    const ids = engine.modes.map((m) => m.id);
    const i = ids.indexOf(engine.activeModeId);
    engine.switchMode(ids[(i + 1) % ids.length]);
  }, TICK_MS);

  acquireWakeLock(); // "immediately if allowed" — rejects silently before a gesture on some UAs
}
