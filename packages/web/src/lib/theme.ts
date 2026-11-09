// Dark ist Standard, Light über prefers-color-scheme oder ausdrücklich per data-theme (NEW_DESIGN.md 11.5).
import { persisted } from './storage.js';

export type Theme = 'system' | 'dark' | 'light';
export const THEME_KEY = 'ccg.theme';

const parse = (raw: string): Theme | null => (raw === 'dark' || raw === 'light' || raw === 'system' ? raw : null);

export const theme = persisted<Theme>(THEME_KEY, 'system', parse, (v) => v);

export function applyTheme(t: Theme, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}
