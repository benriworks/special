/**
 * PNG export: captureFrame → share sheet (mobile, when file-share capable)
 * or download. Confirmation is purely visual: a 120ms white flash plus a
 * polaroid thumbnail flying to the corner — no toast text.
 */

import type { Engine } from '../engine/engine';

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function flash(): void {
  if (reducedMotion()) return;
  const el = document.createElement('div');
  el.className = 'lumina-flash';
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('out'));
  setTimeout(() => el.remove(), 300);
}

function polaroid(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const wrap = document.createElement('div');
  wrap.className = 'lumina-polaroid';
  if (reducedMotion()) wrap.classList.add('reduced');
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  wrap.appendChild(img);
  document.body.appendChild(wrap);
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('fly')));
  setTimeout(() => {
    wrap.remove();
    URL.revokeObjectURL(url);
  }, 1400);
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function savePNG(engine: Engine): Promise<void> {
  const blob = await engine.captureFrame();
  const filename = `lumina-${engine.activeModeId}-${timestamp()}.png`;

  flash();
  polaroid(blob);

  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
  if (isMobile && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch {
        // user cancelled or share failed — fall back to download
      }
    }
  }
  download(blob, filename);
}
