/**
 * Floating capsule bar + wordmark + keyboard + auto-hide + coach line +
 * cursor glow / touch ripples. Vanilla DOM, achromatic dark-glass chrome.
 */

import type { Engine } from '../engine/engine';
import { getLang, onLangChange, pick, setLang, t } from '../core/i18n';
import { linearToCss, themes } from '../core/themes';
import { flushState, writeState } from '../core/urlstate';
import { savePNG } from '../core/exporter';
import { ICONS, modeIcon } from './icons';
import { mountControls } from './controls';
import { createAbout } from './about';

const TOUCHED_KEY = 'lumina.touched';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.appendChild(e);
  return e;
}

function isFirstVisit(): boolean {
  try { return localStorage.getItem(TOUCHED_KEY) !== '1'; } catch { return false; }
}

function isEditableTarget(target: EventTarget | null): boolean {
  const n = target as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT' || n.isContentEditable;
}

export function mountShell(root: HTMLElement, engine: Engine): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  const firstVisit = isFirstVisit();

  const about = createAbout(root, engine);
  const controls = mountControls(root, engine);

  // ---- wordmark ------------------------------------------------------------
  const wordmark = el('div', 'wordmark', root);
  wordmark.textContent = 'LUMINA';

  // ---- capsule bar ----------------------------------------------------------
  const barWrap = el('div', 'bar-wrap', root);
  const bar = el('div', 'bar', barWrap);
  const tabsEl = el('div', 'tabs', bar);
  const pill = el('div', 'tab-pill', tabsEl);

  const tabBtns = new Map<string, HTMLButtonElement>();
  for (const mode of engine.modes) {
    const b = el('button', 'tab', tabsEl);
    b.dataset.mode = mode.id;
    b.innerHTML = modeIcon(mode.id);
    const label = el('span', 'label', b);
    label.textContent = pick(mode.name);
    b.addEventListener('click', () => {
      if (swipeGuard) return;
      if (engine.activeModeId === mode.id) controls.toggleFor(mode.id);
      else engine.switchMode(mode.id);
    });
    tabBtns.set(mode.id, b);
  }

  el('div', 'bar-divider', bar);

  const swatch = el('button', 'swatch', bar);

  const desktopActions = el('div', 'desktop-actions', bar);
  const mkBtn = (parent: HTMLElement, html: string, cls = 'bar-btn'): HTMLButtonElement => {
    const b = el('button', cls, parent);
    b.innerHTML = html;
    return b;
  };
  const saveBtn = mkBtn(desktopActions, ICONS.save);
  const shareBtn = mkBtn(desktopActions, ICONS.share);
  const fsBtn = mkBtn(desktopActions, ICONS.fullscreen);
  const langBtn = mkBtn(desktopActions, '<span class="txt">JA·EN</span>');
  const helpBtn = mkBtn(desktopActions, ICONS.help);

  const overflowBtn = mkBtn(bar, ICONS.more, 'bar-btn overflow-btn');

  const handle = el('button', 'bar-handle', root);
  handle.setAttribute('aria-label', 'show toolbar');

  // ---- popovers --------------------------------------------------------------
  let openPopover: HTMLElement | null = null;

  const themePopover = el('div', 'popover', root);
  const morePopover = el('div', 'popover', root);

  function closePopovers(): void {
    themePopover.classList.remove('open');
    morePopover.classList.remove('open');
    openPopover = null;
  }

  function openPopoverAt(pop: HTMLElement, anchor: HTMLElement): void {
    closePopovers();
    const r = anchor.getBoundingClientRect();
    pop.classList.add('open');
    pop.style.bottom = `${window.innerHeight - r.top + 10}px`;
    const w = pop.offsetWidth;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    pop.style.left = `${left}px`;
    openPopover = pop;
  }

  function buildThemePopover(): void {
    themePopover.innerHTML = '';
    for (const th of themes) {
      const item = el('button', 'popover-item', themePopover);
      if (th.id === engine.themeId) item.classList.add('active');
      const dot = el('span', 'dot', item);
      dot.style.background = `linear-gradient(135deg, ${linearToCss(th.background)} 30%, ${linearToCss(th.accent)} 100%)`;
      const name = el('span', '', item);
      name.textContent = `${th.name.ja} ${th.name.en}`;
      item.addEventListener('click', () => {
        engine.setTheme(th.id);
        closePopovers();
      });
    }
  }

  function buildMorePopover(): void {
    morePopover.innerHTML = '';
    const add = (icon: string, label: string, kbd: string, fn: () => void): HTMLButtonElement => {
      const item = el('button', 'popover-item', morePopover);
      item.innerHTML = icon;
      const s = el('span', '', item);
      s.textContent = label;
      const k = el('span', 'kbd', item);
      k.textContent = kbd;
      item.addEventListener('click', () => {
        closePopovers();
        fn();
      });
      return item;
    };
    add(ICONS.save, t('save'), 'S', doSave);
    add(ICONS.share, t('share'), '', doShare);
    if (fullscreenSupported()) add(ICONS.fullscreen, t('fullscreen'), 'F', toggleFullscreen);
    add('<span class="txt" style="width:20px;text-align:center;font-size:10px">JA</span>', t('language'), 'L', toggleLang);
    add(ICONS.help, t('aboutBtn'), '?', () => about.toggle());
  }

  // ---- actions ----------------------------------------------------------------
  function doSave(): void {
    savePNG(engine).catch((err) => console.warn('[lumina] save failed:', err));
  }

  let copiedChipAt = 0;
  function doShare(): void {
    flushState();
    const url = location.href;
    const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
    if (isMobile && typeof navigator.share === 'function') {
      navigator.share({ title: document.title, url }).catch(() => copyLink(url));
    } else {
      copyLink(url);
    }
  }
  function copyLink(url: string): void {
    const done = () => {
      const now = Date.now();
      if (now - copiedChipAt > 500) {
        copiedChipAt = now;
        showChip(t('linkCopied'));
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => { /* denied */ });
  }

  function fullscreenSupported(): boolean {
    return typeof document.documentElement.requestFullscreen === 'function';
  }
  function toggleFullscreen(): void {
    if (!fullscreenSupported()) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }

  function toggleLang(): void {
    const next = getLang() === 'ja' ? 'en' : 'ja';
    setLang(next);
    writeState({ lang: next });
    showChip(next === 'ja' ? '日本語' : 'English');
  }

  // ---- shortcut echo chip -------------------------------------------------------
  let chipEl: HTMLElement | null = null;
  function showChip(text: string): void {
    chipEl?.remove();
    chipEl = el('div', 'echo-chip', root);
    chipEl.textContent = text;
    const mine = chipEl;
    setTimeout(() => { if (chipEl === mine) { mine.remove(); chipEl = null; } else mine.remove(); }, 950);
  }

  // ---- sliding accent pill --------------------------------------------------------
  function updatePill(): void {
    const active = tabBtns.get(engine.activeModeId);
    if (!active) return;
    pill.style.width = `${active.offsetWidth}px`;
    pill.style.transform = `translate(${active.offsetLeft}px, -50%)`;
    for (const [id, b] of tabBtns) b.classList.toggle('active', id === engine.activeModeId);
  }

  function updateSwatch(): void {
    const th = themes.find((x) => x.id === engine.themeId) ?? themes[0];
    swatch.style.background = `linear-gradient(135deg, ${linearToCss(th.background)} 25%, ${linearToCss(th.accent)} 100%)`;
    swatch.title = `${t('theme')} — ${th.name.ja} ${th.name.en}`;
  }

  // ---- swatch interactions ---------------------------------------------------------
  let suppressSwatchClick = false;
  let longPressTimer = 0;
  let hoverTimer = 0;
  swatch.addEventListener('click', () => {
    if (suppressSwatchClick) { suppressSwatchClick = false; return; }
    if (openPopover === themePopover) { closePopovers(); return; }
    engine.cycleTheme();
    const th = themes.find((x) => x.id === engine.themeId);
    if (th) showChip(`${th.name.ja} ${th.name.en}`);
  });
  swatch.addEventListener('pointerdown', () => {
    window.clearTimeout(longPressTimer);
    longPressTimer = window.setTimeout(() => {
      suppressSwatchClick = true;
      buildThemePopover();
      openPopoverAt(themePopover, swatch);
    }, 500);
  });
  swatch.addEventListener('pointerup', () => window.clearTimeout(longPressTimer));
  swatch.addEventListener('pointerleave', () => window.clearTimeout(longPressTimer));
  if (finePointer) {
    swatch.addEventListener('mouseenter', () => {
      window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        buildThemePopover();
        openPopoverAt(themePopover, swatch);
      }, 450);
    });
    swatch.addEventListener('mouseleave', () => {
      window.clearTimeout(hoverTimer);
      window.setTimeout(() => {
        if (openPopover === themePopover && !themePopover.matches(':hover') && !swatch.matches(':hover')) closePopovers();
      }, 350);
    });
    themePopover.addEventListener('mouseleave', () => {
      window.setTimeout(() => {
        if (openPopover === themePopover && !themePopover.matches(':hover') && !swatch.matches(':hover')) closePopovers();
      }, 350);
    });
  }

  overflowBtn.addEventListener('click', () => {
    if (openPopover === morePopover) closePopovers();
    else {
      buildMorePopover();
      openPopoverAt(morePopover, overflowBtn);
    }
  });

  window.addEventListener('pointerdown', (e) => {
    if (!openPopover) return;
    const n = e.target as Node;
    if (!openPopover.contains(n) && !swatch.contains(n) && !overflowBtn.contains(n)) closePopovers();
  });

  saveBtn.addEventListener('click', doSave);
  shareBtn.addEventListener('click', doShare);
  fsBtn.addEventListener('click', toggleFullscreen);
  langBtn.addEventListener('click', toggleLang);
  helpBtn.addEventListener('click', () => about.toggle());
  if (!fullscreenSupported()) fsBtn.style.display = 'none';

  // ---- capsule swipe cycles modes ------------------------------------------------
  let swipeGuard = false;
  let swipeStart: { x: number; y: number } | null = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') swipeStart = { x: e.clientX, y: e.clientY };
  });
  bar.addEventListener('pointerup', (e) => {
    if (!swipeStart) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 40 && Math.abs(dy) < 36) {
      const ids = engine.modes.map((m) => m.id);
      const i = ids.indexOf(engine.activeModeId);
      const next = ids[(i + (dx < 0 ? 1 : -1) + ids.length) % ids.length];
      engine.switchMode(next);
      swipeGuard = true;
      setTimeout(() => { swipeGuard = false; }, 150);
    }
  });

  // ---- keyboard --------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (isEditableTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    engine.noteActivity();
    activityAt = performance.now();
    interacted = true;

    const modeIds = engine.modes.map((m) => m.id);
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= modeIds.length) {
      const mode = engine.modes[num - 1];
      engine.switchMode(mode.id);
      showChip(`${mode.name.ja} ${mode.name.en}`);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        engine.requestPulse();
        break;
      case 'f': case 'F':
        toggleFullscreen();
        break;
      case 's': case 'S':
        doSave();
        break;
      case 't': case 'T': {
        engine.cycleTheme();
        const th = themes.find((x) => x.id === engine.themeId);
        if (th) showChip(`${th.name.ja} ${th.name.en}`);
        break;
      }
      case 'l': case 'L':
        toggleLang();
        break;
      case 'h': case 'H':
        pinnedHidden = !pinnedHidden;
        if (pinnedHidden) hideBar();
        else revealBar();
        break;
      case '?':
        about.toggle();
        break;
      case 'Escape':
        closePopovers();
        break;
    }
  });

  // ---- auto-hide -----------------------------------------------------------------
  let interacted = false;
  let hidden = false;
  let pinnedHidden = false;
  let activityAt = performance.now();

  function hideBar(): void {
    if (hidden) return;
    hidden = true;
    barWrap.classList.add('hidden');
    handle.classList.add('visible');
    controls.close();
    closePopovers();
  }
  function revealBar(): void {
    if (pinnedHidden) return;
    if (!hidden) return;
    hidden = false;
    barWrap.classList.remove('hidden');
    handle.classList.remove('visible');
    activityAt = performance.now();
    requestAnimationFrame(updatePill);
  }

  handle.addEventListener('click', () => {
    pinnedHidden = false;
    revealBar();
  });

  window.addEventListener('pointerdown', (e) => {
    interacted = true;
    activityAt = performance.now();
    if (e.pointerType !== 'touch' && !pinnedHidden) revealBar();
  });
  window.addEventListener('pointermove', (e) => {
    activityAt = performance.now();
    if (e.pointerType === 'mouse' && !pinnedHidden) revealBar();
  });
  window.addEventListener('wheel', () => { activityAt = performance.now(); }, { passive: true });

  window.setInterval(() => {
    if (!interacted || hidden) return;
    if (openPopover || about.isOpen() || controls.isOpen()) return;
    if (bar.matches(':hover') || handle.matches(':hover')) return;
    // keyboard focus pins the bar; transient mouse-click focus does not
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.matches(':focus-visible')
      && (barWrap.contains(focused) || controls.el.contains(focused))) return;
    if (isEditableTarget(focused)) return;
    if (performance.now() - activityAt > 4000) hideBar();
  }, 500);

  // ---- coach line + first-visit shimmer ---------------------------------------------
  if (firstVisit) {
    const coach = el('div', 'coach', root);
    coach.textContent = t('coach');
    setTimeout(() => coach.classList.add('show'), 1500);
    const dismiss = () => {
      coach.classList.add('hide');
      setTimeout(() => coach.remove(), 700);
      window.removeEventListener('pointerdown', dismiss);
    };
    window.addEventListener('pointerdown', dismiss);

    if (!reducedMotion) {
      setTimeout(() => {
        tabsEl.classList.add('shimmer');
        setTimeout(() => tabsEl.classList.remove('shimmer'), 1800);
      }, 4000);
    }
  }

  // ---- cursor glow (desktop) & touch ripple ------------------------------------------
  if (finePointer) {
    const glow = el('div', 'cursor-glow', root);
    let gx = -100; let gy = -100; let tx = -100; let ty = -100;
    let visible = false;
    let down = false;
    let lastT = performance.now();
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      tx = e.clientX;
      ty = e.clientY;
      const overUI = (e.target as HTMLElement | null)?.closest?.('#ui, .bar-wrap, .popover, .controls, .about-scrim, .bar-handle') != null
        || (e.target as HTMLElement | null)?.tagName !== 'CANVAS';
      visible = !overUI;
    });
    window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') down = true; });
    window.addEventListener('pointerup', () => { down = false; });
    window.addEventListener('pointerleave', () => { visible = false; });
    document.addEventListener('mouseleave', () => { visible = false; });
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      const k = 1 - Math.exp(-dt / 0.06); // ~60ms lag
      gx += (tx - gx) * k;
      gy += (ty - gy) * k;
      glow.style.transform = `translate(${gx}px, ${gy}px) scale(${down ? 1.6 : 1})`;
      glow.style.opacity = visible ? '1' : '0';
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    if ((e.target as HTMLElement | null)?.tagName !== 'CANVAS') return;
    const r = el('div', 'touch-ripple', root);
    r.style.left = `${e.clientX}px`;
    r.style.top = `${e.clientY}px`;
    setTimeout(() => r.remove(), 650);
  });

  // ---- engine subscriptions -----------------------------------------------------------
  engine.on('modechange', () => {
    controls.close();
    requestAnimationFrame(updatePill);
  });
  engine.on('themechange', () => {
    updateSwatch();
    if (openPopover === themePopover) buildThemePopover();
  });

  onLangChange(() => {
    for (const mode of engine.modes) {
      const b = tabBtns.get(mode.id);
      const label = b?.querySelector('.label');
      if (label) label.textContent = pick(mode.name);
    }
    refreshTitles();
    requestAnimationFrame(updatePill);
  });

  function refreshTitles(): void {
    saveBtn.title = `${t('save')} (S)`;
    shareBtn.title = t('share');
    fsBtn.title = `${t('fullscreen')} (F)`;
    langBtn.title = `${t('language')} (L)`;
    helpBtn.title = `${t('aboutBtn')} (?)`;
    swatch.setAttribute('aria-label', t('theme'));
    overflowBtn.title = t('more');
  }

  window.addEventListener('resize', () => requestAnimationFrame(updatePill));

  refreshTitles();
  updateSwatch();
  requestAnimationFrame(updatePill);
  if ('fonts' in document) {
    void document.fonts.ready.then(() => updatePill());
  }
}
