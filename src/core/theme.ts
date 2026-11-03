/** Resolves the theme preference (incl. "system") and keeps the DOM in sync. */
import { create } from 'zustand';
import { applyTheme, palettes, type Palette, type ThemeMode } from '../design/tokens';
import { findTheme, useThemes } from '../themes/themeStore';
import { useSettings, type ThemePreference } from './settings';

const media = () =>
  typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveTheme(pref: ThemePreference, systemDark = media()?.matches ?? true): ThemeMode {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

interface ThemeState {
  mode: ThemeMode;
  /** Palette overrides of the active custom theme. */
  overrides: Partial<Palette>;
  ansi?: string[];
  /** Active custom theme id (null = built-in). */
  themeId: string | null;
}

export const useThemeMode = create<ThemeState>(() => ({
  mode: resolveTheme(useSettings.getState().theme),
  overrides: {},
  themeId: null,
}));

export function installThemeSync(): () => void {
  const sync = () => {
    const s = useSettings.getState();
    const custom = findTheme(s.customTheme);
    const mode = custom?.type ?? resolveTheme(s.theme);
    const overrides = custom?.colors ?? {};
    applyTheme(mode, overrides);
    try {
      localStorage.setItem('dataforge.themeMode', mode);
      localStorage.setItem('dataforge.themeBg', overrides.surface0 ?? palettes[mode].surface0);
    } catch {
      /* storage unavailable */
    }
    const cur = useThemeMode.getState();
    const themeId = custom?.id ?? null;
    if (cur.mode !== mode || cur.themeId !== themeId || cur.overrides !== overrides) useThemeMode.setState({ mode, overrides, ansi: custom?.ansi, themeId });
  };
  sync();
  const unsub = useSettings.subscribe((s, prev) => (s.theme !== prev.theme || s.customTheme !== prev.customTheme) && sync());
  const unsubThemes = useThemes.subscribe(sync);
  const m = media();
  m?.addEventListener('change', sync);
  return () => {
    unsub();
    unsubThemes();
    m?.removeEventListener('change', sync);
  };
}

export function cycleTheme() {
  const order: ThemePreference[] = ['system', 'light', 'dark'];
  const cur = useSettings.getState().theme;
  useSettings.getState().set({ theme: order[(order.indexOf(cur) + 1) % order.length], customTheme: null });
}
