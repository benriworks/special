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
  drift: wrap('<circle cx="16.5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15.5" r="0.8" fill="currentColor" stroke="none"/><path d="M13.2 8.3L8.5 5.7"/><path d="M6.2 12.5l-3-1.7"/><path d="M12.3 17l-3.8-2.1"/><path d="M20.5 18.5l-2.7-1.5"/>'),
  gravity: wrap('<circle cx="12" cy="12" r="4.5"/><path d="M3.5 14.5C4.5 9 8 5.5 12 5.5s7.5 3.5 8.5 9"/><path d="M18.5 17.5c.9-.9 1.6-1.9 2-3"/>'),
  tesseract: wrap('<rect x="4" y="4" width="16" height="16"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M4 4l5.5 5.5"/><path d="M20 4l-5.5 5.5"/><path d="M4 20l5.5-5.5"/><path d="M20 20l-5.5-5.5"/>'),
  premiere: wrap('<rect x="4" y="3.5" width="16" height="9" rx="1"/><path d="M8.5 12.5L12 19l3.5-6.5"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>'),
  hearth: wrap('<path d="M12 3.5c2.4 2.3 4 4.4 4 6.7a4 4 0 0 1-8 0c0-2.3 1.6-4.4 4-6.7z"/><path d="M12 8.5c.9 1 1.5 1.9 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.9.6-1.8 1.5-2.8z"/><path d="M5.5 15.5l13 4.5"/><path d="M18.5 15.5l-13 4.5"/>'),
};

export function modeIcon(id: string): string {
  return MODE_ICONS[id] ?? wrap('<circle cx="12" cy="12" r="7"/>');
}

export const ICONS = {
  mic: wrap('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.8v.4a6 6 0 0 0 12 0v-.4"/><path d="M12 18.2v2.3"/>'),
  save: wrap('<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>'),
  share: wrap('<path d="M9.5 13.5l5-3"/><circle cx="6.5" cy="15" r="2.6"/><circle cx="17.5" cy="8.5" r="2.6"/><path d="M12 20.5h7"/>'),
  fullscreen: wrap('<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/>'),
  more: wrap('<circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/>'),
  help: wrap('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5A2.5 2.5 0 1 1 12 12.5v1.2"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>'),
  close: wrap('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
};
