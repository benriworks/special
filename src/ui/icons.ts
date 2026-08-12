/**
 * Inline SVG icons (20px, stroke = currentColor) for mode tabs & UI buttons.
 */

const wrap = (inner: string): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const MODE_ICONS: Record<string, string> = {
  fluid: wrap('<path d="M3 8c3-3 6 3 9 0s6 3 9 0"/><path d="M3 13c3-3 6 3 9 0s6 3 9 0"/><path d="M3 18c3-3 6 3 9 0s6 3 9 0"/>'),
  galaxy: wrap('<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><path d="M12 12c0-4 3.5-6.5 7-5.5"/><path d="M12 12c4 0 6.5 3.5 5.5 7"/><path d="M12 12c0 4-3.5 6.5-7 5.5"/><path d="M12 12c-4 0-6.5-3.5-5.5-7"/>'),
  flock: wrap('<path d="M5 15l2.6-4.6L10 15z"/><path d="M12 9l2.6-4.6L17 9z"/><path d="M13 19l2.6-4.6L18 19z"/>'),
  rd: wrap('<circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="9"/>'),
  moji: wrap('<path d="M5 7h14"/><path d="M12 4v6c0 5-2.5 8-6.5 9.5"/><path d="M9 10c1.5 5.5 5 8.5 9.5 9.5"/>'),
  hanabi: wrap('<circle cx="12" cy="10" r="1.3" fill="currentColor" stroke="none"/><path d="M12 3v3.5"/><path d="M12 13.5v3"/><path d="M5.9 6.5l2.5 2"/><path d="M18.1 6.5l-2.5 2"/><path d="M5 12h3.5"/><path d="M15.5 12H19"/><path d="M6.8 16l1.9-2.4"/><path d="M17.2 16l-1.9-2.4"/><path d="M12 19.5v1.5"/>'),
};

export function modeIcon(id: string): string {
  return MODE_ICONS[id] ?? wrap('<circle cx="12" cy="12" r="7"/>');
}

export const ICONS = {
  save: wrap('<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
  share: wrap('<path d="M9.5 13.5l5-3"/><circle cx="6.5" cy="15" r="2.6"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M12 20.5h7"/>'),
  fullscreen: wrap('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  more: wrap('<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
  help: wrap('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5A2.5 2.5 0 1 1 12 12.5v1.2"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>'),
  close: wrap('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
};
