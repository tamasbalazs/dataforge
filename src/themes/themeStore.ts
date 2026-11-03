/**
 * Installed custom themes (imported files, VS Code themes, extension themes)
 * and the active one. core/theme.ts applies it everywhere.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { host } from '../core/host';
import { t } from '../core/i18n';
import { getSettings, updateSettings } from '../core/settings';
import { toast } from '../core/toast';
import { parseThemeFile, serializeTheme, slug, type CustomTheme } from './themeModel';

interface ThemesState {
  /** Themes the user imported (persisted). */
  themes: CustomTheme[];
  /** Themes contributed by enabled extensions (runtime only). */
  extensionThemes: CustomTheme[];
}

export const useThemes = create<ThemesState>()(
  persist(() => ({ themes: [] as CustomTheme[], extensionThemes: [] as CustomTheme[] }), {
    name: 'dataforge.themes',
    version: 1,
    partialize: (s) => ({ themes: s.themes }),
  }),
);

export const allThemes = (s: ThemesState = useThemes.getState()) => [...s.themes, ...s.extensionThemes];
export const findTheme = (id: string | null | undefined) => (id ? allThemes().find((x) => x.id === id) : undefined);

export function activateTheme(id: string | null) {
  updateSettings({ customTheme: id });
}

export function addTheme(theme: CustomTheme): CustomTheme {
  const taken = new Set(allThemes().map((x) => x.id));
  let id = theme.id;
  for (let i = 2; taken.has(id) && !useThemes.getState().themes.some((x) => x.id === id && x.name === theme.name); i++) id = `${theme.id}-${i}`;
  const t2 = { ...theme, id };
  useThemes.setState((s) => ({ themes: [...s.themes.filter((x) => x.id !== id), t2] }));
  return t2;
}

export function removeTheme(id: string) {
  useThemes.setState((s) => ({ themes: s.themes.filter((x) => x.id !== id) }));
  if (getSettings().customTheme === id) activateTheme(null);
}

/** Import a DataForge or VS Code theme file and switch to it. */
export async function importThemeFromFile(path?: string) {
  const p = path ?? (await host().openFileDialog([{ name: 'Theme', extensions: ['json'] }]));
  if (!p) return null;
  try {
    const theme = addTheme(parseThemeFile(await host().readText(p), p.split(/[\\/]/).pop()));
    activateTheme(theme.id);
    toast({
      kind: 'success',
      title: t('themes.imported', { name: theme.name }),
      detail: theme.adjusted?.length ? t('themes.adjusted', { count: theme.adjusted.length }) : undefined,
    });
    return theme;
  } catch (e) {
    toast({ kind: 'error', title: t('themes.importFailed'), detail: String(e) });
    return null;
  }
}

/** Save the active theme (built-in or custom) as a shareable DataForge theme file. */
export async function exportCurrentTheme(mode: 'light' | 'dark') {
  const active = findTheme(getSettings().customTheme);
  const name = active?.name ?? (mode === 'dark' ? 'DataForge Dark' : 'DataForge Light');
  const dest = await host().saveFileDialog(`${slug(name)}.dftheme.json`, [{ name: 'DataForge theme', extensions: ['json'] }]);
  if (!dest) return;
  await host().writeText(dest, serializeTheme(name, active?.type ?? mode, active?.colors ?? {}, active?.ansi, active?.author));
  toast({ kind: 'success', title: t('themes.exported', { name }) });
}

export function setExtensionThemes(extensionId: string, themes: CustomTheme[]) {
  useThemes.setState((s) => ({ extensionThemes: [...s.extensionThemes.filter((x) => x.extensionId !== extensionId), ...themes] }));
}
