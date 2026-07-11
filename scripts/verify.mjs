#!/usr/bin/env node
/**
 * LUMINA acceptance harness — the gate for every phase.
 *
 *   node scripts/verify.mjs [--base http://localhost:4173/special/]
 *                           [--mode <id>] [--out verify-out] [--viewport 390x844]
 *
 * Per mode: load #m=<id>&debug=1, await __lumina.ready, collect console
 * errors + pageerrors (any = FAIL), idle screenshot, simulated drag arc,
 * interact screenshot, stats() sanity (variance alive, fps >= 15).
 * Full run additionally cycles all modes 3x and asserts a clean console.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const MODES = ['fluid', 'galaxy', 'flock', 'rd', 'moji'];
const VARIANCE_MIN = 1e-6;
const FPS_FAIL = 15;
const FPS_WARN = 20;

const CHROMIUM_ARGS = [
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--disable-gpu-sandbox',
];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function argValue(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
}
const base = argValue('--base', 'http://localhost:4173/special/');
const onlyMode = argValue('--mode', null);
const outDir = resolve(argValue('--out', 'verify-out'));
const vpRaw = argValue('--viewport', '390x844');
const [vw, vh] = vpRaw.split('x').map((n) => parseInt(n, 10));
if (!vw || !vh) {
  console.error(`invalid --viewport "${vpRaw}" (expected e.g. 390x844)`);
  process.exit(2);
}
const viewport = { width: vw, height: vh };

mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
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

function attachCollectors(page, errors) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
}

async function openMode(browser, modeId) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  attachCollectors(page, errors);
  await page.goto(`${base}#m=${modeId}&debug=1`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => !!window.__lumina, undefined, { timeout: 20000 });
  await page.evaluate(() => window.__lumina.ready);
  return { context, page, errors };
}

async function dragArc(page) {
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = viewport.width * (0.2 + 0.6 * t);
    const y = cy - Math.sin(t * Math.PI) * viewport.height * 0.22;
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

// ---------------------------------------------------------------------------
// per-mode test
// ---------------------------------------------------------------------------
async function testMode(browser, modeId) {
  const result = { mode: modeId, status: 'PASS', fps: 0, luma: 0, variance: 0, notes: [] };
  let context = null;
  try {
    const opened = await openMode(browser, modeId);
    context = opened.context;
    const { page, errors } = opened;

    await waitFrames(page, 60);
    await page.screenshot({ path: `${outDir}/${modeId}-idle.png` });

    await dragArc(page);
    await waitFrames(page, 30);
    await page.screenshot({ path: `${outDir}/${modeId}-interact.png` });

    const stats = await page.evaluate(() => window.__lumina.stats());
    result.fps = stats.fps;
    result.luma = stats.luma;
    result.variance = stats.variance;

    if (stats.modeId !== modeId) {
      result.status = 'FAIL';
      result.notes.push(`active mode is "${stats.modeId}", expected "${modeId}"`);
    }
    if (!(stats.variance > VARIANCE_MIN)) {
      result.status = 'FAIL';
      result.notes.push(`flat canvas (variance ${stats.variance.toExponential(2)} <= ${VARIANCE_MIN})`);
    }
    if (stats.fps < FPS_FAIL) {
      result.status = 'FAIL';
      result.notes.push(`fps ${stats.fps.toFixed(1)} < ${FPS_FAIL}`);
    } else if (stats.fps < FPS_WARN) {
      result.notes.push(`warn: fps ${stats.fps.toFixed(1)} < ${FPS_WARN}`);
    }
    if (errors.length > 0) {
      result.status = 'FAIL';
      result.notes.push(...errors.slice(0, 5));
    }
  } catch (err) {
    result.status = 'FAIL';
    result.notes.push(String(err && err.message ? err.message : err));
  } finally {
    if (context) await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// full-run mode cycling: all 5 modes, 3 rounds, console must stay clean
// ---------------------------------------------------------------------------
async function testCycling(browser) {
  const result = { mode: 'cycle x3', status: 'PASS', fps: 0, luma: 0, variance: 0, notes: [] };
  let context = null;
  try {
    const opened = await openMode(browser, MODES[0]);
    context = opened.context;
    const { page, errors } = opened;
    await waitFrames(page, 30);

    for (let round = 0; round < 3; round++) {
      for (const id of MODES) {
        await page.evaluate((m) => window.__lumina.setMode(m), id);
        await waitFrames(page, 25);
      }
    }
    const stats = await page.evaluate(() => window.__lumina.stats());
    result.fps = stats.fps;
    result.luma = stats.luma;
    result.variance = stats.variance;
    if (!(stats.variance > VARIANCE_MIN)) {
      result.status = 'FAIL';
      result.notes.push(`flat canvas after cycling (variance ${stats.variance.toExponential(2)})`);
    }
    if (errors.length > 0) {
      result.status = 'FAIL';
      result.notes.push(...errors.slice(0, 8));
    }
  } catch (err) {
    result.status = 'FAIL';
    result.notes.push(String(err && err.message ? err.message : err));
  } finally {
    if (context) await context.close();
  }
  return result;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const results = [];

try {
  const targets = onlyMode ? [onlyMode] : MODES;
  for (const id of targets) {
    process.stdout.write(`· testing ${id} ...\n`);
    results.push(await testMode(browser, id));
  }
  if (!onlyMode) {
    process.stdout.write('· cycling all modes 3x ...\n');
    results.push(await testCycling(browser));
  }
} finally {
  await browser.close();
}

// table
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(pad('MODE', 12) + pad('STATUS', 8) + pad('FPS', 8) + pad('LUMA', 8) + pad('VARIANCE', 12) + 'NOTES');
console.log('-'.repeat(76));
for (const r of results) {
  console.log(
    pad(r.mode, 12) +
      pad(r.status, 8) +
      pad(r.fps ? r.fps.toFixed(1) : '-', 8) +
      pad(r.luma ? r.luma.toFixed(3) : '-', 8) +
      pad(r.variance ? r.variance.toExponential(2) : '-', 12) +
      (r.notes.length ? r.notes.join(' | ') : ''),
  );
}
console.log('');

const failed = results.filter((r) => r.status !== 'PASS');
if (failed.length > 0) {
  console.error(`FAIL — ${failed.length}/${results.length} checks failed`);
  process.exit(1);
}
console.log(`PASS — ${results.length}/${results.length} checks green (screenshots in ${outDir})`);
