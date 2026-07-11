/**
 * Boot: URL state → GL → engine → UI → initial mode → debug hook.
 */

import './ui/styles.css';
import { readState, writeState } from './core/urlstate';
import { initLang } from './core/i18n';
import { createGL } from './engine/gl';
import { Engine } from './engine/engine';
import { modes } from './modes';
import { mountShell } from './ui/shell';
import { DEFAULT_THEME_ID, getTheme } from './core/themes';

declare global {
  interface Window {
    __lumina?: {
      ready: Promise<void>;
      stats: () => { fps: number; frame: number; modeId: string; luma: number; variance: number };
      setMode: (id: string) => void;
      themeId: () => string;
      quality: () => number;
      params: (id?: string) => Record<string, number | string>;
    };
  }
}

function boot(): void {
  const state = readState();
  initLang(state.lang ?? null);

  const canvas = document.getElementById('stage') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('missing #stage canvas');
  const handle = createGL(canvas);
  if (!handle) return; // fallback message already rendered

  const debug = /(^|[#&])debug=1(&|$)/.test(location.hash);

  const engine = new Engine(handle, modes, {
    initialModeId: state.mode && modes.some((m) => m.id === state.mode) ? state.mode : 'fluid',
    initialThemeId: state.theme && getTheme(state.theme) ? state.theme : DEFAULT_THEME_ID,
    initialQuality: state.quality,
    skipAttract: state.hasParams,
    debug,
  });

  // seed deep-linked p.* params into the initial mode (typed via its ParamDefs)
  const initialMode = modes.find((m) => m.id === engine.activeModeId);
  if (initialMode?.params) {
    const seed: Record<string, number | string> = {};
    for (const [key, raw] of Object.entries(state.params)) {
      const def = initialMode.params.find((p) => p.key === key);
      if (!def) continue;
      if (def.type === 'range') {
        const v = parseFloat(raw);
        if (isFinite(v)) seed[key] = Math.min(def.max, Math.max(def.min, v));
      } else if (def.type === 'select') {
        if (def.options.some((o) => o.value === raw)) seed[key] = raw;
      } else {
        seed[key] = def.maxLength ? raw.slice(0, def.maxLength) : raw;
      }
    }
    if (Object.keys(seed).length > 0) engine.seedParams(initialMode.id, seed);
  }

  const ui = document.getElementById('ui');
  if (ui) mountShell(ui, engine);

  // keep the URL in sync (debounced inside urlstate)
  engine.on('modechange', (id) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(engine.getParamValues(id))) params[k] = String(v);
    writeState({ mode: id, params }, { replaceParams: true });
  });
  engine.on('themechange', (id) => writeState({ theme: id }));

  engine.start();

  if (debug) {
    window.__lumina = {
      ready: engine.ready,
      stats: () => engine.getStats(),
      setMode: (id: string) => engine.switchMode(id),
      themeId: () => engine.themeId,
      quality: () => engine.quality,
      params: (id?: string) => engine.getParamValues(id ?? engine.activeModeId),
    };
  }
}

boot();
