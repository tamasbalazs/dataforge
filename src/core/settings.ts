/** User preferences, persisted locally. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lang, RemoteProfile } from './host';

export type ThemePreference = 'light' | 'dark' | 'system';
export type Locale = 'hu' | 'en';
export type LayoutPreset = 'analysis' | 'development' | 'focus' | 'custom';

export interface Settings {
  theme: ThemePreference;
  /** Active custom theme id (null = built-in light/dark). */
  customTheme: string | null;
  locale: Locale;
  uiScale: number;
  editorFontSize: number;
  fontLigatures: boolean;
  /** Selected interpreter path per language (null = auto). */
  interpreters: Partial<Record<Lang, string | null>>;
  workdir: string | null;
  layoutPreset: LayoutPreset;
  /** Serialized dockview layouts. `current` is restored on startup. */
  layouts: { current?: unknown; custom?: unknown };
  /** Bumped when new panels ship, so saved layouts can be upgraded once. */
  layoutVersion: number;
  onboarded: boolean;
  /** Per-project state, keyed by project root. */
  projects: Record<string, ProjectSettings>;
  /** Saved SSH hosts (no secrets: keys stay in ~/.ssh / the agent). */
  remoteProfiles: RemoteProfile[];
}

export interface ProjectSettings {
  lastOpened: number;
  /** Interpreter chosen for this project (overrides the global choice). */
  interpreters?: Partial<Record<Lang, string | null>>;
  /** Files open when the project was last closed. */
  openFiles?: string[];
}

export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

export function detectLocale(langs: readonly string[] = typeof navigator !== 'undefined' ? navigator.languages : []): Locale {
  return langs.some((l) => l.toLowerCase().startsWith('hu')) ? 'hu' : 'en';
}

export const defaultSettings = (): Settings => ({
  theme: 'system',
  customTheme: null,
  locale: detectLocale(),
  uiScale: 1,
  editorFontSize: 13,
  fontLigatures: true,
  interpreters: {},
  workdir: null,
  layoutPreset: 'analysis',
  layouts: {},
  layoutVersion: 0,
  onboarded: false,
  projects: {},
  remoteProfiles: [],
});

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      ...defaultSettings(),
      set: (patch) => set(patch),
    }),
    {
      name: 'dataforge.settings',
      version: 1,
      partialize: ({ set: _set, ...rest }) => rest,
    },
  ),
);

export const getSettings = () => useSettings.getState();
export const updateSettings = (patch: Partial<Settings>) => useSettings.getState().set(patch);
