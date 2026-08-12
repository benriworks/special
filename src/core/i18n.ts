/**
 * Shell i18n (ja/en). Mode names live inside modes — only chrome strings here.
 * Language priority: URL hash (l=) > localStorage > navigator.language.
 */

export type Lang = 'ja' | 'en';

const LS_KEY = 'lumina.lang';

const STRINGS: Record<string, { ja: string; en: string }> = {
  coach: { ja: 'なぞってみて — Drag anywhere', en: 'なぞってみて — Drag anywhere' },
  save: { ja: '保存', en: 'Save' },
  share: { ja: '共有', en: 'Share' },
  fullscreen: { ja: '全画面', en: 'Fullscreen' },
  theme: { ja: 'テーマ', en: 'Theme' },
  language: { ja: '言語', en: 'Language' },
  aboutBtn: { ja: 'このサイトについて', en: 'About' },
  more: { ja: 'その他', en: 'More' },
  linkCopied: { ja: 'リンクをコピーしました', en: 'Link copied' },
  mic: { ja: 'マイクで反応', en: 'React to sound' },
  micChipOn: { ja: 'マイク ON', en: 'Mic on' },
  micChipOff: { ja: 'マイク OFF', en: 'Mic off' },
  micDenied: {
    ja: 'マイクが使えません — ブラウザの許可を確認してください',
    en: 'Microphone unavailable — check browser permission',
  },
  pulse: { ja: 'パルス', en: 'Pulse' },
  hideBar: { ja: 'バーを隠す', en: 'Hide bar' },
  showBar: { ja: 'バーを表示', en: 'Show toolbar' },

  aboutTagline: { ja: '光の遊び場', en: 'Playground of Light' },
  aboutIntro: {
    ja: '流体、銀河、群れ、模様、文字、そして花火——6つのGPUシミュレーションが、あなたのデバイスの中だけでリアルタイムに光ります。サーバーなし、アップロードなし、追跡なし。ただ触れて、光をかき混ぜてください。',
    en: 'Fluid, galaxy, flock, pattern, letters, fireworks — six GPU simulations glowing in real time, entirely on your device. No servers, no uploads, no tracking. Just reach in and stir the light.',
  },
  aboutPrivacyMic: {
    ja: 'マイクの音は端末内で解析されるだけ。録音も送信もされません。',
    en: 'Microphone audio is analysed on your device only — never recorded, never uploaded.',
  },
  aboutMadeByTitle: { ja: 'AIチームがつくりました', en: 'Built by a team of AIs' },
  aboutMadeByBody: {
    ja: 'デザイン会議が世界観を描き、基盤エンジニアがエンジンを組み、6体のエージェントがそれぞれのモードを並行して実装。意地悪なレビュアーが粗を探し、自動検証ハーネスが全モードに緑のランプを灯すまで作り直す——その全体を、Claudeが指揮しました。',
    en: 'A design panel sketched the vision, a foundation engineer built the engine, and six agents grew one mode each in parallel. Adversarial reviewers hunted for flaws, and nothing shipped until an automated verify harness turned every mode green — the whole ensemble orchestrated by Claude.',
  },
  creditDirection: { ja: '監督', en: 'Direction' },
  creditDirectionBy: { ja: 'Claude（オーケストレーター）', en: 'Claude (orchestrator)' },
  creditGraphics: { ja: 'グラフィックス', en: 'Graphics' },
  creditGraphicsBy: { ja: 'モード担当エージェント ×6', en: 'Six mode engineer agents' },
  creditUx: { ja: 'UX', en: 'UX' },
  creditUxBy: { ja: 'デザイン会議エージェント', en: 'Design panel agents' },
  creditQa: { ja: 'QA', en: 'QA' },
  creditQaBy: { ja: '敵対的レビュアー＋検証ハーネス', en: 'Adversarial reviewers + verify harness' },

  aboutModesTitle: { ja: 'モード', en: 'Modes' },
  aboutControlsTitle: { ja: '操作', en: 'Controls' },
  ctrlModes: { ja: 'モード切替', en: 'Switch modes' },
  ctrlPulse: { ja: 'パルス', en: 'Pulse' },
  ctrlFullscreen: { ja: '全画面', en: 'Fullscreen' },
  ctrlSave: { ja: 'PNG保存', en: 'Save PNG' },
  ctrlTheme: { ja: 'テーマ切替', en: 'Cycle theme' },
  ctrlLang: { ja: '言語切替', en: 'Toggle language' },
  ctrlMic: { ja: 'マイクで反応 ON/OFF', en: 'Toggle sound reactivity' },
  ctrlHide: { ja: 'バーを隠す', en: 'Hide bar' },
  ctrlAbout: { ja: 'この画面', en: 'This overlay' },
  ctrlDrag: { ja: 'ドラッグ', en: 'Drag' },
  ctrlDragDesc: { ja: '光をかき混ぜる', en: 'Stir the light' },
  ctrlTwoFinger: { ja: '2本指タップ', en: 'Two-finger tap' },
  keyLabel: { ja: 'キー', en: 'Key' },
  actionLabel: { ja: '動作', en: 'Action' },

  modeDesc_fluid: { ja: 'ひと撫でで渦を巻く、光のインク', en: 'Ink of light that swirls at your touch' },
  modeDesc_galaxy: { ja: 'てのひらの重力で、銀河をたわめる', en: 'A galaxy that bends to your gravity' },
  modeDesc_flock: { ja: '光の群れが、ひとつの心で泳ぐ', en: 'A murmuration of light with a single mind' },
  modeDesc_rd: { ja: 'ひとつの数式から、生きた模様が育つ', en: 'Living patterns grown from one equation' },
  modeDesc_moji: { ja: '言葉が光にほどけ、また言葉にもどる', en: 'Words dissolve into light, then find their shape again' },
  modeDesc_hanabi: { ja: '夜空に咲いて、散る光', en: 'Light that blooms and falls' },

  aboutFooterRuns: { ja: 'ブラウザ内で100%動作', en: 'runs 100% in your browser' },
  aboutFooterLicense: { ja: 'MITライセンス', en: 'MIT License' },
  close: { ja: '閉じる', en: 'Close' },

  webglFallback: {
    ja: 'このデバイスでは LUMINA を表示できません。WebGL2 と浮動小数点レンダリングに対応したブラウザ（最新の Chrome / Edge / Firefox / Safari）でお試しください。',
    en: 'LUMINA cannot run on this device. Please try a browser with WebGL2 and float-render support (recent Chrome / Edge / Firefox / Safari).',
  },
};

let current: Lang = 'ja';
const listeners = new Set<(lang: Lang) => void>();

function detect(): Lang {
  try {
    const stored = localStorage.getItem(LS_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
  } catch { /* private mode */ }
  const nav = (navigator.language || 'en').toLowerCase();
  return nav.startsWith('ja') ? 'ja' : 'en';
}

/** Boot-time init. `fromUrl` (l= hash param) has highest priority. */
export function initLang(fromUrl?: string | null): void {
  current = fromUrl === 'ja' || fromUrl === 'en' ? fromUrl : detect();
  document.documentElement.lang = current;
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem(LS_KEY, lang); } catch { /* ignore */ }
  for (const fn of listeners) fn(lang);
}

/** Subscribe to language changes (UI re-render). Returns an unsubscribe fn. */
export function onLangChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate a shell string. Optional `lang` override (e.g. bilingual fallback screens). */
export function t(key: string, lang?: Lang): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[lang ?? current];
}

/** Pick from a bilingual label object ({ja, en}) using the current language. */
export function pick(label: { ja: string; en: string }, lang?: Lang): string {
  return label[lang ?? current];
}
