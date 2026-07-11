/**
 * Theme palettes. Authored as sRGB hex, stored as LINEAR RGB 0..1 per the
 * contract (modes render in linear light; post.ts converts back to sRGB).
 */

import type { Theme } from '../engine/types';

/** sRGB hex ('#rrggbb') → linear RGB triplet 0..1. */
export function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const s = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const lin = s.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return [lin[0], lin[1], lin[2]];
}

/** Linear RGB 0..1 → sRGB 0..255 component. */
function linearToSrgb255(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/** Linear RGB triplet → CSS color string (for --ui-accent etc.). */
export function linearToCss(rgb: [number, number, number]): string {
  return `rgb(${linearToSrgb255(rgb[0])},${linearToSrgb255(rgb[1])},${linearToSrgb255(rgb[2])})`;
}

function makeTheme(
  id: string,
  name: { ja: string; en: string },
  bg: string,
  colors: string[],
  accent: string,
): Theme {
  return {
    id,
    name,
    background: hexToLinear(bg),
    colors: colors.map(hexToLinear),
    accent: hexToLinear(accent),
  };
}

export const themes: Theme[] = [
  makeTheme('aurora', { ja: 'オーロラ', en: 'Aurora' }, '#050b14',
    ['#16337a', '#0f7fae', '#19d3c5', '#66ffc2', '#8a63ff', '#e8fbff'], '#66ffc2'),
  makeTheme('ember', { ja: '焔', en: 'Ember' }, '#140805',
    ['#4a0e1e', '#a3122e', '#ff3b1f', '#ff7a1a', '#ffb347', '#fff1c1'], '#ff7a1a'),
  makeTheme('sakura', { ja: '桜', en: 'Sakura' }, '#140a12',
    ['#6b2545', '#c2447c', '#ff7fb2', '#ffc1d9', '#8be8ad', '#fff4f8'], '#ff7fb2'),
  makeTheme('abyss', { ja: '深海', en: 'Abyss' }, '#02060d',
    ['#0a2a66', '#0f5bd0', '#18a4f0', '#2fe1ff', '#7dffe0', '#e6fbff'], '#2fe1ff'),
  makeTheme('sumi', { ja: '墨', en: 'Sumi' }, '#0b0c10',
    ['#33383f', '#767e88', '#ff4633', '#c9cfd6', '#f6f5f0'], '#ff4633'),
];

export const DEFAULT_THEME_ID = 'aurora';

export function getTheme(id: string): Theme | undefined {
  return themes.find((t) => t.id === id);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/**
 * Blend two themes in linear RGB — use this inside modes while ctx.themeMix
 * is non-null:  `const th = ctx.themeMix ? mixThemes(ctx.themeMix.from, ctx.theme, ctx.themeMix.t) : ctx.theme;`
 * Palette lengths may differ (4-6); indices clamp to the shorter palette.
 */
export function mixThemes(from: Theme, to: Theme, t: number): Theme {
  const colors = to.colors.map((c, i) => {
    const f = from.colors[Math.min(i, from.colors.length - 1)];
    return lerp3(f, c, t);
  });
  return {
    id: to.id,
    name: to.name,
    colors,
    background: lerp3(from.background, to.background, t),
    accent: lerp3(from.accent, to.accent, t),
  };
}
