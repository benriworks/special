/**
 * '?' overlay — dark-glass scrim + centered card. The simulation keeps
 * running behind it. role=dialog, aria-modal, focus trap, Esc/X/scrim close.
 */

import type { Engine } from '../engine/engine';
import { getLang, onLangChange, pick, t } from '../core/i18n';
import { ICONS, modeIcon } from './icons';

export interface AboutHandle {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

const REPO_URL = 'https://github.com/benriworks/special';

export function createAbout(root: HTMLElement, engine: Engine): AboutHandle {
  const scrim = document.createElement('div');
  scrim.className = 'about-scrim';
  const card = document.createElement('div');
  card.className = 'about-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'LUMINA — このサイトについて / About');
  scrim.appendChild(card);
  root.appendChild(scrim);

  let openState = false;
  let prevFocus: HTMLElement | null = null;

  function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }

  function build(): void {
    const modeRows = engine.modes
      .map((m) => `
        <div class="about-mode">
          ${modeIcon(m.id)}
          <span class="mname">${esc(pick(m.name))}</span>
          <span class="mdesc">${esc(t(`modeDesc_${m.id}`))}</span>
        </div>`)
      .join('');

    const keyRow = (key: string, action: string) =>
      `<tr><td class="key">${esc(key)}</td><td>${esc(action)}</td></tr>`;

    card.innerHTML = `
      <button class="about-close" aria-label="${esc(t('close'))}">${ICONS.close}</button>
      <div class="about-wordmark">LUMINA</div>
      <div class="about-tagline">光の遊び場 — Playground of Light</div>
      <p>${esc(t('aboutIntro'))}</p>

      <h3>${esc(t('aboutMadeByTitle'))}</h3>
      <p>${esc(t('aboutMadeByBody'))}</p>
      <div class="credits">
        <span class="role">${esc(t('creditDirection'))}</span><span>${esc(t('creditDirectionBy'))}</span>
        <span class="role">${esc(t('creditGraphics'))}</span><span>${esc(t('creditGraphicsBy'))}</span>
        <span class="role">${esc(t('creditUx'))}</span><span>${esc(t('creditUxBy'))}</span>
        <span class="role">${esc(t('creditQa'))}</span><span>${esc(t('creditQaBy'))}</span>
      </div>

      <h3>${esc(t('aboutModesTitle'))}</h3>
      <div class="about-modes">${modeRows}</div>

      <h3>${esc(t('aboutControlsTitle'))}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${esc(t('keyLabel'))}</th><th>${esc(t('actionLabel'))}</th></tr></thead>
          <tbody>
            ${keyRow('1 – 5', t('ctrlModes'))}
            ${keyRow('Space', t('ctrlPulse'))}
            ${keyRow('F', t('ctrlFullscreen'))}
            ${keyRow('S', t('ctrlSave'))}
            ${keyRow('T', t('ctrlTheme'))}
            ${keyRow('L', t('ctrlLang'))}
            ${keyRow('H', t('ctrlHide'))}
            ${keyRow('?', t('ctrlAbout'))}
            ${keyRow(t('ctrlDrag'), t('ctrlDragDesc'))}
            ${keyRow(t('ctrlTwoFinger'), t('ctrlPulse'))}
          </tbody>
        </table>
      </div>

      <div class="about-footer">
        <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
        <span>${esc(t('aboutFooterLicense'))}</span>
        <span>${esc(t('aboutFooterRuns'))}</span>
      </div>
    `;
    card.querySelector('.about-close')?.addEventListener('click', close);
  }

  function focusables(): HTMLElement[] {
    return Array.from(card.querySelectorAll<HTMLElement>('button, a[href], input, [tabindex]:not([tabindex="-1"])'));
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!openState) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const els = focusables();
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !card.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !card.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }

  function open(): void {
    if (openState) return;
    openState = true;
    build();
    prevFocus = document.activeElement as HTMLElement | null;
    scrim.classList.add('open');
    document.addEventListener('keydown', onKeydown, true);
    (card.querySelector('.about-close') as HTMLElement | null)?.focus();
  }

  function close(): void {
    if (!openState) return;
    openState = false;
    scrim.classList.remove('open');
    document.removeEventListener('keydown', onKeydown, true);
    prevFocus?.focus?.();
    prevFocus = null;
  }

  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });

  onLangChange(() => {
    if (openState) build();
  });
  // keep language reactive even before first open
  void getLang();

  return {
    open,
    close,
    toggle: () => (openState ? close() : open()),
    isOpen: () => openState,
  };
}
