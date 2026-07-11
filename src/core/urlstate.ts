/**
 * URL hash state: `#m=<mode>&t=<theme>&l=<ja|en>&q=<quality>&p.<key>=<val>`
 * Read once on boot; written debounced (500ms) via history.replaceState.
 * Round-trip safe (component-encoded values).
 */

export interface UrlState {
  mode?: string;
  theme?: string;
  lang?: 'ja' | 'en';
  quality?: number;
  params: Record<string, string>;
  /** true when the boot URL carried any hash params (deep link → skip attract demo). */
  hasParams: boolean;
}

function parseHash(hash: string): UrlState {
  const state: UrlState = { params: {}, hasParams: false };
  const raw = hash.replace(/^#/, '');
  if (!raw) return state;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = decodeURIComponent(pair.slice(0, eq));
    const val = decodeURIComponent(pair.slice(eq + 1));
    state.hasParams = true;
    if (key === 'm') state.mode = val;
    else if (key === 't') state.theme = val;
    else if (key === 'l' && (val === 'ja' || val === 'en')) state.lang = val;
    else if (key === 'q') {
      const q = parseFloat(val);
      if (isFinite(q) && q > 0 && q <= 1) state.quality = q;
    } else if (key.startsWith('p.')) state.params[key.slice(2)] = val;
  }
  return state;
}

// Internal mirror of what we last wrote / read.
let current: UrlState = parseHash(location.hash);

/** Read the boot-time (or last-synced) state. */
export function readState(): UrlState {
  return {
    ...current,
    params: { ...current.params },
  };
}

function serialize(s: UrlState): string {
  const parts: string[] = [];
  if (s.mode) parts.push(`m=${encodeURIComponent(s.mode)}`);
  if (s.theme) parts.push(`t=${encodeURIComponent(s.theme)}`);
  if (s.lang) parts.push(`l=${s.lang}`);
  if (s.quality !== undefined) parts.push(`q=${encodeURIComponent(String(s.quality))}`);
  for (const [k, v] of Object.entries(s.params)) {
    parts.push(`p.${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `#${parts.join('&')}` : '';
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  writeTimer = null;
  const hash = serialize(current);
  const url = location.pathname + location.search + hash;
  try {
    history.replaceState(null, '', url);
  } catch { /* ignore (about:blank etc.) */ }
}

export interface WriteOptions {
  /** Replace the whole p.* set instead of merging. Use on mode switch. */
  replaceParams?: boolean;
}

/**
 * Merge a patch into the hash state; the URL updates after a 500ms debounce.
 * Pass `params: { key: null }`-style deletions via `undefined` values.
 */
export function writeState(
  patch: Partial<Omit<UrlState, 'params' | 'hasParams'>> & { params?: Record<string, string | undefined> },
  opts: WriteOptions = {},
): void {
  if (patch.mode !== undefined) current.mode = patch.mode;
  if (patch.theme !== undefined) current.theme = patch.theme;
  if (patch.lang !== undefined) current.lang = patch.lang;
  if (patch.quality !== undefined) current.quality = patch.quality;
  if (patch.params) {
    if (opts.replaceParams) current.params = {};
    for (const [k, v] of Object.entries(patch.params)) {
      if (v === undefined) delete current.params[k];
      else current.params[k] = v;
    }
  } else if (opts.replaceParams) {
    current.params = {};
  }
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 500);
}

/** Force any pending debounced write into the URL now (e.g. before sharing). */
export function flushState(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    flush();
  }
}
