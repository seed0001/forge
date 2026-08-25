import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/newsreader';
import '@fontsource-variable/caveat';
import '@fontsource/dancing-script/400.css';
import '@fontsource/dancing-script/700.css';
import '@fontsource/unifrakturmaguntia/400.css';
import '@fontsource/vt323/400.css';

export interface FontChoice {
  id: string;
  label: string;
  note: string;
  stack: string;
  /**
   * Optical size multiplier. Faces differ wildly in x-height — Caveat at 13px
   * reads far smaller than Geist at 13px — so each carries its own correction
   * rather than every face inheriting one size that only suits the default.
   */
  scale: number;
  /** Extra line-height for scripts with tall ascenders and deep descenders. */
  leading?: number;
  /** Sample rendered in the picker, in the face itself. */
  sample: string;
}

export const FONTS: FontChoice[] = [
  {
    id: 'geist',
    label: 'Geist',
    note: 'Clean, modern, built for tooling',
    stack: '"Geist Variable", system-ui, sans-serif',
    scale: 1,
    sample: 'The quick brown fox',
  },
  {
    id: 'grotesk',
    label: 'Space Grotesk',
    note: 'Technical with character',
    stack: '"Space Grotesk Variable", system-ui, sans-serif',
    scale: 1,
    sample: 'The quick brown fox',
  },
  {
    id: 'newsreader',
    label: 'Newsreader',
    note: 'Editorial serif, easy on long reads',
    stack: '"Newsreader Variable", Georgia, serif',
    scale: 1.06,
    leading: 1.72,
    sample: 'The quick brown fox',
  },
  {
    id: 'caveat',
    label: 'Caveat',
    note: 'Handwritten marker',
    stack: '"Caveat Variable", cursive',
    scale: 1.42,
    leading: 1.5,
    sample: 'The quick brown fox',
  },
  {
    id: 'dancing',
    label: 'Dancing Script',
    note: 'Flowing cursive',
    stack: '"Dancing Script", cursive',
    scale: 1.34,
    leading: 1.62,
    sample: 'The quick brown fox',
  },
  {
    id: 'blackletter',
    label: 'UnifrakturMaguntia',
    note: 'Old English blackletter',
    stack: '"UnifrakturMaguntia", "Times New Roman", serif',
    scale: 1.26,
    leading: 1.62,
    sample: 'The quick brown fox',
  },
  {
    id: 'vt323',
    label: 'VT323',
    note: 'Retro CRT terminal',
    stack: '"VT323", monospace',
    scale: 1.34,
    leading: 1.45,
    sample: 'The quick brown fox',
  },
];

const STORAGE_KEY = 'forge.font';

export function loadFontId(): string {
  const saved = localStorage.getItem(STORAGE_KEY);
  return FONTS.some((f) => f.id === saved) ? (saved as string) : 'geist';
}

/**
 * Applies the chosen face to UI and prose only. Code keeps its monospace face
 * in every theme: alignment and character disambiguation are correctness
 * concerns in an editor, not stylistic ones.
 */
export function applyFont(id: string) {
  const font = FONTS.find((f) => f.id === id) ?? FONTS[0];
  const root = document.documentElement;
  root.style.setProperty('--font-ui', font.stack);
  root.style.setProperty('--font-scale', String(font.scale));
  root.style.setProperty('--leading', String(font.leading ?? 1.5));
  localStorage.setItem(STORAGE_KEY, font.id);
}
