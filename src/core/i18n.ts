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
  pulse: { ja: 'パルス', en: 'Pulse' },
  hideBar: { ja: 'バーを隠す', en: 'Hide bar' },

  aboutTagline: { ja: '光の遊び場', en: 'Playground of Light' },
  aboutIntro: {
    ja: '5つのGPUシミュレーション、サーバーはゼロ。すべてあなたのデバイス上でリアルタイムに動きます。何もアップロードされず、何も追跡されません。',
    en: 'Five GPU simulations, zero servers — everything runs live on your device; nothing uploaded, nothing tracked.',
  },
  aboutMadeByTitle: { ja: 'AIチームがつくりました', en: 'Made by a team of AIs' },
  aboutMadeByBody: {
    ja: 'このサイトは、Claudeがオーケストレーションする複数のAIエージェントによって、設計・実装・レビューまで一貫して作られました。各ビジュアルモードは専属のエージェントが実装し、別のエージェントが批評と検証を行っています。',
    en: 'This site was designed, built and reviewed end-to-end by multiple AI agents orchestrated by Claude. Each visual mode was implemented by a dedicated agent, with other agents critiquing and verifying the result.',
  },
  creditDirection: { ja: '監督', en: 'Direction' },
  creditDirectionBy: { ja: 'オーケストレーター', en: 'Orchestrator agent' },
  creditGraphics: { ja: 'グラフィックス', en: 'Graphics' },
  creditGraphicsBy: { ja: 'モード実装エージェント', en: 'Mode engineer agents' },
  creditUx: { ja: 'UX', en: 'UX' },
  creditUxBy: { ja: 'デザインパネル・エージェント', en: 'Design panel agents' },
  creditQa: { ja: 'QA', en: 'QA' },
  creditQaBy: { ja: '敵対的レビュー・エージェント', en: 'Adversarial review agents' },

  aboutModesTitle: { ja: 'モード', en: 'Modes' },
  aboutControlsTitle: { ja: '操作', en: 'Controls' },
  ctrlModes: { ja: 'モード切替', en: 'Switch modes' },
  ctrlPulse: { ja: 'パルス', en: 'Pulse' },
  ctrlFullscreen: { ja: '全画面', en: 'Fullscreen' },
  ctrlSave: { ja: 'PNG保存', en: 'Save PNG' },
  ctrlTheme: { ja: 'テーマ切替', en: 'Cycle theme' },
  ctrlLang: { ja: '言語切替', en: 'Toggle language' },
  ctrlHide: { ja: 'バーを隠す', en: 'Hide bar' },
  ctrlAbout: { ja: 'この画面', en: 'This overlay' },
  ctrlDrag: { ja: 'ドラッグ', en: 'Drag' },
  ctrlDragDesc: { ja: '光をかき混ぜる', en: 'Stir the light' },
  ctrlTwoFinger: { ja: '2本指タップ', en: 'Two-finger tap' },
  keyLabel: { ja: 'キー', en: 'Key' },
  actionLabel: { ja: '動作', en: 'Action' },

  // placeholder one-liners for the About mode list — a later agent polishes copy
  modeDesc_fluid: { ja: '指でかき混ぜる光の流体', en: 'Swirl a fluid of light with your fingers' },
  modeDesc_galaxy: { ja: '腕の中で渦巻く銀河', en: 'A galaxy spiraling in your hands' },
  modeDesc_flock: { ja: '光の群れが指を追う', en: 'A flock of light that follows you' },
  modeDesc_rd: { ja: '生命のように育つ模様', en: 'Patterns that grow like living things' },
  modeDesc_moji: { ja: '文字がほどけて光になる', en: 'Characters dissolving into light' },

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
