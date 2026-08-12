/**
 * Microphone input → per-frame AudioLevels for the engine.
 *
 * getUserMedia (raw signal: echo cancellation / noise suppression / AGC all
 * off) → AudioContext → AnalyserNode (fftSize 1024, smoothing 0.55) sampled
 * once per frame into a REUSED Uint8Array. Bands are averaged over bin
 * ranges derived from the real AudioContext sample rate (low ≈20–250Hz,
 * mid ≈250–2000Hz, high ≈2000–8000Hz) plus an overall level, then
 * normalized 0..1 by a slow adaptive gain: a rolling maximum with ~6s
 * half-life and a floor so quiet exhibition rooms still register expression
 * but silence is never boosted into noise. sample() mutates and returns ONE
 * AudioLevels object — zero per-frame allocation.
 *
 * Page-hidden handling: visibilitychange suspends/resumes the AudioContext
 * (battery for exhibitions). stop() releases mic tracks + closes the context.
 */

import type { AudioLevels } from '../engine/types';

const FFT_SIZE = 1024;
const SMOOTHING = 0.55;
const NORM_HALF_LIFE_S = 6;   // rolling-max decay half-life
const NORM_FLOOR = 0.06;      // min gain reference — silence stays silence
const NORM_DT_CAP = 0.25;     // decay step cap (tab-switch gaps must not nuke it)

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0); // NaN → 0

export class AudioInput {
  private stream: MediaStream | null = null;
  private ac: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;

  /** THE levels object — mutated in place, returned by every sample(). */
  private levels: AudioLevels = { level: 0, low: 0, mid: 0, high: 0 };

  // band bin ranges [start, end) — computed from the real sample rate
  private binA = 1;   // ≈20Hz (skips DC)
  private binB = 6;   // ≈250Hz
  private binC = 43;  // ≈2000Hz
  private binD = 171; // ≈8000Hz

  private norm = NORM_FLOOR; // rolling max of the raw peak
  private lastMs = -1;

  private gen = 0; // bumped by stop(); invalidates an in-flight start()
  private starting: Promise<void> | null = null;

  get running(): boolean { return this.analyser !== null; }

  /**
   * Request the mic and wire the analyser. Rejects with the original
   * getUserMedia error on permission denial (caller decides UI). Idempotent
   * while running; concurrent calls share one in-flight promise.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStart().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const myGen = this.gen;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (this.gen !== myGen) { // stop() raced the permission prompt
      for (const t of stream.getTracks()) t.stop();
      throw new Error('audio input stopped during start');
    }
    const ac = new AudioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;
    const source = ac.createMediaStreamSource(stream);
    source.connect(analyser); // analyser only — mic is never routed to output

    const binHz = ac.sampleRate / FFT_SIZE;
    const n = analyser.frequencyBinCount;
    this.binA = Math.min(n - 4, Math.max(1, Math.round(20 / binHz)));
    this.binB = Math.min(n - 3, Math.max(this.binA + 1, Math.round(250 / binHz)));
    this.binC = Math.min(n - 2, Math.max(this.binB + 1, Math.round(2000 / binHz)));
    this.binD = Math.min(n, Math.max(this.binC + 1, Math.round(8000 / binHz)));
    if (!this.bins || this.bins.length !== n) this.bins = new Uint8Array(n);

    this.stream = stream;
    this.ac = ac;
    this.source = source;
    this.analyser = analyser;
    this.norm = NORM_FLOOR;
    this.lastMs = -1;
    document.addEventListener('visibilitychange', this.onVisibility);
    // Autoplay policy may hold the context suspended; resume() can stay
    // pending until a gesture, so fire-and-forget (levels read 0 meanwhile).
    if (ac.state !== 'running' && !document.hidden) {
      ac.resume().catch(() => { /* levels stay 0 until it may run */ });
    }
  }

  /** Stop mic tracks, close the AudioContext, null everything out. */
  stop(): void {
    this.gen++;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    try { this.source?.disconnect(); } catch { /* already gone */ }
    if (this.ac && this.ac.state !== 'closed') this.ac.close().catch(() => { /* ignore */ });
    this.stream = null;
    this.ac = null;
    this.source = null;
    this.analyser = null;
    this.lastMs = -1;
    this.norm = NORM_FLOOR;
    const lv = this.levels;
    lv.level = lv.low = lv.mid = lv.high = 0;
  }

  /** Per-frame read. Returns THE SAME mutated AudioLevels object every call. */
  sample(): AudioLevels {
    const lv = this.levels;
    const an = this.analyser;
    const bins = this.bins;
    if (!an || !bins) {
      lv.level = lv.low = lv.mid = lv.high = 0;
      return lv;
    }
    an.getByteFrequencyData(bins);

    let sLow = 0;
    let sMid = 0;
    let sHigh = 0;
    for (let i = this.binA; i < this.binB; i++) sLow += bins[i];
    for (let i = this.binB; i < this.binC; i++) sMid += bins[i];
    for (let i = this.binC; i < this.binD; i++) sHigh += bins[i];
    const low = sLow / ((this.binB - this.binA) * 255);
    const mid = sMid / ((this.binC - this.binB) * 255);
    const high = sHigh / ((this.binD - this.binC) * 255);
    const level = (sLow + sMid + sHigh) / ((this.binD - this.binA) * 255);

    // slow adaptive gain: rolling max (~6s half-life) with a silence floor
    const now = performance.now();
    const dt = this.lastMs < 0 ? 0 : Math.min(NORM_DT_CAP, (now - this.lastMs) / 1000);
    this.lastMs = now;
    const decayed = this.norm * Math.pow(2, -dt / NORM_HALF_LIFE_S);
    const peak = Math.max(level, low, mid, high);
    this.norm = Math.max(NORM_FLOOR, decayed, peak);
    const g = 1 / this.norm;

    lv.level = clamp01(level * g);
    lv.low = clamp01(low * g);
    lv.mid = clamp01(mid * g);
    lv.high = clamp01(high * g);
    return lv;
  }

  private onVisibility = (): void => {
    const ac = this.ac;
    if (!ac) return;
    if (document.hidden) {
      if (ac.state === 'running') ac.suspend().catch(() => { /* ignore */ });
    } else if (ac.state === 'suspended') {
      ac.resume().catch(() => { /* ignore */ });
    }
  };
}

/**
 * Tiny reusable rising-edge beat detector: fires once when a band level
 * spikes above its own slow EMA (ratio + absolute margin), with a
 * refractory gap against double triggers. Call update() once per frame
 * with a normalized band (typically `low`); costs nothing, allocates
 * nothing. When audio is off simply don't call it.
 */
export class BeatDetector {
  private ema = 0;
  private wasAbove = false;
  private lastAt = -1e3;

  constructor(
    private readonly ratio = 1.4,   // spike threshold vs own EMA
    private readonly margin = 0.06, // absolute floor — silence never beats
    private readonly minGap = 0.2,  // refractory seconds
  ) {}

  update(v: number, time: number, dt: number): boolean {
    if (!(v >= 0)) v = 0; // NaN-proof
    this.ema += (v - this.ema) * (1 - Math.exp(-Math.max(0, dt) / 0.8));
    const above = v > this.ema * this.ratio + this.margin;
    const beat = above && !this.wasAbove && time - this.lastAt >= this.minGap;
    this.wasAbove = above;
    if (beat) this.lastAt = time;
    return beat;
  }
}
