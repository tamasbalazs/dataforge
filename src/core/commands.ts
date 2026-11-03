/**
 * Command registry: every user action is a command, so it is reachable from
 * the command palette, a keybinding and (later) extensions.
 */
import { create } from 'zustand';

export interface Command {
  id: string;
  /** i18n key of the title. */
  title: string;
  /** Interpolation values for the title (evaluated at render time). */
  titleArgs?: () => Record<string, string>;
  /** i18n key of the category shown in the palette. */
  category?: string;
  keybinding?: string;
  icon?: string;
  run: () => void | Promise<void>;
  /** Hidden from the palette when it returns false. */
  when?: () => boolean;
  /** Title and category are plain text, not i18n keys (extension commands). */
  literal?: boolean;
}

interface CommandState {
  commands: Record<string, Command>;
  recent: string[];
  paletteOpen: boolean;
}

export const useCommands = create<CommandState>(() => ({ commands: {}, recent: [], paletteOpen: false }));

export function registerCommand(cmd: Command): () => void {
  useCommands.setState((s) => ({ commands: { ...s.commands, [cmd.id]: cmd } }));
  return () =>
    useCommands.setState((s) => {
      const { [cmd.id]: _, ...rest } = s.commands;
      return { commands: rest };
    });
}

export function registerCommands(cmds: Command[]): () => void {
  const disposers = cmds.map(registerCommand);
  return () => disposers.forEach((d) => d());
}

export async function runCommand(id: string) {
  const cmd = useCommands.getState().commands[id];
  if (!cmd) return;
  useCommands.setState((s) => ({ recent: [id, ...s.recent.filter((r) => r !== id)].slice(0, 8) }));
  await cmd.run();
}

export const openPalette = () => useCommands.setState({ paletteOpen: true });
export const closePalette = () => useCommands.setState({ paletteOpen: false });

// ---------------------------------------------------------------------------
// Keybindings

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalise a KeyboardEvent to e.g. "Mod+Shift+P" (Mod = Cmd on macOS, Ctrl elsewhere). */
export function eventToChord(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac = isMac): string {
  const parts: string[] = [];
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (mac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.code?.startsWith('Key') ? e.code.slice(3) : e.code?.startsWith('Digit') ? e.code.slice(5) : e.key;
  if (e.code === 'Backquote') key = '`'; // physical key, whatever the layout prints
  if (key === ' ') key = 'Space';
  if (key === 'Equal' || key === '+') key = '=';
  if (key === 'Minus') key = '-';
  if (key === 'Comma') key = ',';
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** Human-readable keybinding for the current platform. */
export function formatChord(chord: string, mac = isMac): string[] {
  return chord.split('+').map((p) => {
    if (p === 'Mod') return mac ? '⌘' : 'Ctrl';
    if (p === 'Shift') return mac ? '⇧' : 'Shift';
    if (p === 'Alt') return mac ? '⌥' : 'Alt';
    if (p === 'Ctrl') return mac ? '⌃' : 'Ctrl';
    if (p === 'Enter') return mac ? '↩' : 'Enter';
    return p;
  });
}

export function findCommandForChord(chord: string): Command | undefined {
  return Object.values(useCommands.getState().commands).find(
    (c) => c.keybinding === chord && (c.when ? c.when() : true),
  );
}

/**
 * Inside the terminal the shell owns plain Ctrl/⌘ chords (Ctrl+C, Ctrl+R, Ctrl+W …);
 * only navigation-style chords still reach the app.
 */
export function terminalAllows(chord: string): boolean {
  return chord === 'Mod+`' || chord.startsWith('Mod+Shift+') || chord.startsWith('Mod+Alt+') || /^Alt\+(Shift\+)?\w+$/.test(chord) || /^F\d+$/.test(chord);
}

/** Global keydown handler (capture phase) for app-level shortcuts. */
export function installKeybindings(target: Window = window): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey) && !/^F\d+$/.test(e.key)) return;
    const chord = eventToChord(e);
    if ((e.target as Element | null)?.closest?.('.xterm') && !terminalAllows(chord)) return;
    const cmd = findCommandForChord(chord);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    void runCommand(cmd.id);
  };
  target.addEventListener('keydown', onKey, true);
  return () => target.removeEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------------------
// Fuzzy matching for the palette

export interface FuzzyResult {
  score: number;
  /** Indices of matched characters in the haystack (for highlighting). */
  positions: number[];
}

/** Subsequence match with bonuses for word starts and consecutive runs. */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    const wordStart = idx === 0 || /[\s:/_.\-]/.test(t[idx - 1]);
    score += 1 + (wordStart ? 6 : 0) + (idx === prev + 1 ? 4 : 0) - Math.min(idx - ti, 5) * 0.2;
    positions.push(idx);
    prev = idx;
    ti = idx + 1;
  }
  if (t.startsWith(q)) score += 10;
  return { score: score - text.length * 0.01, positions };
}
