#!/usr/bin/env node
/**
 * LUMINA OGP capture — renders og.png candidates at exactly 1200×630.
 *
 *   node scripts/make-og.mjs [--base http://localhost:4173/special/]
 *                            [--out <dir>]
 *
 * Per candidate: seed `lumina.touched=1` (suppresses coach line + ghost demo),
 * load #m=<mode>&t=aurora&debug=1, await __lumina.ready, let the scene form,
 * press 'h' to hide the bar (wordmark stays — that's the brand), perform one
 * drag arc to raise a stream, capture mid-bloom.
 *
 * Emits three candidates into --out; pick the winner and copy it to
 * public/og.png.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];

const argv = process.argv.slice(2);
function argValue(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const base = argValue('--base', 'http://localhost:4173/special/');
const outDir = resolve(argValue('--out', 'og-out'));
mkdirSync(outDir, { recursive: true });

const viewport = { width: 1200, height: 630 };

async function waitFrames(page, n) {
  await page.evaluate(
    (count) =>
      new Promise((res) => {
        let i = 0;
        const step = () => (++i >= count ? res(null) : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** One elegant sweeping arc through the scene's lower third, rising past center. */
async function dragArc(page) {
  const w = viewport.width;
  const h = viewport.height;
  await page.mouse.move(w * 0.22, h * 0.62);
  await page.mouse.down();
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = w * (0.22 + 0.56 * t);
    const y = h * 0.62 - Math.sin(t * Math.PI) * h * 0.3;
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/**
 * Capture one candidate.
 * @param shots [{ name, framesAfterDrag }] — captured in order from one session.
 */
async function capture(browser, mode, formFrames, shots) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('lumina.touched', '1');
    } catch {
      /* ignore */
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`pageerror(${mode}): ${err.message}`));
  await page.goto(`${base}#m=${mode}&t=aurora&debug=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForFunction(() => !!window.__lumina, undefined, { timeout: 20000 });
  await page.evaluate(() => window.__lumina.ready);

  await waitFrames(page, formFrames); // let the scene form
  await page.keyboard.press('h'); // hide the bar; wordmark stays
  await waitFrames(page, 5);
  await dragArc(page);

  let elapsed = 0;
  for (const { name, framesAfterDrag } of shots) {
    await waitFrames(page, framesAfterDrag - elapsed);
    elapsed = framesAfterDrag;
    const path = `${outDir}/${name}`;
    await page.screenshot({ path });
    console.log(`· ${path} (${mode}, +${framesAfterDrag} frames after drag)`);
  }
  await context.close();
}

const browser = await chromium.launch({ args: CHROMIUM_ARGS });
try {
  // galaxy: disc forms over ~90 frames; two wait offsets around mid-bloom
  await capture(browser, 'galaxy', 90, [
    { name: 'og-galaxy-a.png', framesAfterDrag: 20 },
    { name: 'og-galaxy-b.png', framesAfterDrag: 45 },
  ]);
  // fluid alternative
  await capture(browser, 'fluid', 90, [{ name: 'og-fluid.png', framesAfterDrag: 20 }]);
} finally {
  await browser.close();
}
console.log(`done — candidates in ${outDir}; copy the winner to public/og.png`);
