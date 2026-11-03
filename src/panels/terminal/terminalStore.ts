/**
 * Terminal sessions. Each xterm instance lives outside React (in a detached
 * container element) so scrollback survives tab switches and layout changes;
 * the panel just re-parents the active session's element.
 */
import type { ITheme, Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { create } from 'zustand';
import { host } from '../../core/host';
import { t } from '../../core/i18n';
import { getSettings } from '../../core/settings';
import { useThemeMode } from '../../core/theme';
import { chooseInterpreter } from '../../kernels/kernels';

export interface TermSession {
  id: string;
  title: string;
  /** Exit code once the shell has ended. */
  exited: number | null;
}

interface TerminalState {
  sessions: TermSession[];
  active: string | null;
}

export const useTerminals = create<TerminalState>(() => ({ sessions: [], active: null }));

interface Live {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  started: boolean;
}

const live = new Map<string, Live>();
let seq = 0;
let unlisten: (() => void) | null = null;

const ANSI_DARK = ['#2A2F3A', '#F27474', '#5BD38C', '#E9C46A', '#6EA8FE', '#C792EA', '#56C8D8', '#C9CED8', '#5D6575', '#FF8F8F', '#7FE3A6', '#F4D58D', '#91BEFF', '#D7A9F2', '#7FDBE7', '#F2F4F8'];
const ANSI_LIGHT = ['#1F2430', '#C93636', '#1A7F45', '#8A6100', '#2457C5', '#8241B8', '#0E7C8C', '#5D6575', '#6B7280', '#B42323', '#146C3A', '#6F4E00', '#1C47A6', '#6D2FA3', '#0A6875', '#1F2430'];

/** xterm colours from the design tokens (CSS variables) plus a tuned ANSI palette. */
export function terminalTheme(mode: 'light' | 'dark', css: (v: string) => string, ansi?: string[]): ITheme {
  const a = ansi?.length === 16 ? ansi : mode === 'dark' ? ANSI_DARK : ANSI_LIGHT;
  const [black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite] = a;
  return {
    background: css('--surface-1'),
    foreground: css('--text-primary'),
    cursor: css('--accent'),
    cursorAccent: css('--surface-1'),
    selectionBackground: mode === 'dark' ? '#3A4A6A' : '#C9D8F5',
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack: bBlack, brightRed: bRed, brightGreen: bGreen, brightYellow: bYellow,
    brightBlue: bBlue, brightMagenta: bMagenta, brightCyan: bCyan, brightWhite: bWhite,
  };
}

const cssVar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#000';

export function applyTerminalTheme() {
  const { mode, ansi } = useThemeMode.getState();
  for (const l of live.values()) l.term.options.theme = terminalTheme(mode, cssVar, ansi);
}

export function applyTerminalFont(size: number) {
  for (const l of live.values()) {
    l.term.options.fontSize = size;
    try {
      l.fit.fit();
    } catch {
      /* not visible */
    }
  }
}

/** Environment for project shells: the project's virtualenv first on PATH. */
export function projectEnv(python: string | undefined, workdir: string | null, pathSep = ':'): Record<string, string> {
  if (!python || !workdir || !python.startsWith(workdir)) return {};
  const bin = python.replace(/[\\/][^\\/]+$/, '');
  const venv = bin.replace(/[\\/](bin|Scripts)$/, '');
  return { VIRTUAL_ENV: venv, DATAFORGE_PATH_PREPEND: bin + pathSep };
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ensureListener() {
  unlisten ??= host().onPtyEvent((ev) => {
    const l = live.get(ev.id);
    if (!l) return;
    if (ev.data) l.term.write(decode(ev.data));
    if (ev.exit != null) {
      l.started = false;
      l.term.write(`\r\n\x1b[2m${t('terminal.exited', { code: ev.exit })}\x1b[0m\r\n`);
      useTerminals.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === ev.id ? { ...x, exited: ev.exit } : x)) }));
    }
  });
}

async function createLive(id: string): Promise<Live> {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ]);
  await import('@xterm/xterm/css/xterm.css');
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Menlo, monospace",
    fontSize: getSettings().editorFontSize,
    lineHeight: 1.2,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
    theme: terminalTheme(useThemeMode.getState().mode, cssVar, useThemeMode.getState().ansi),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, url) => void host().openUrl(url)));
  const el = document.createElement('div');
  el.className = 'df-term__screen';
  term.open(el);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard?.writeText(sel);
      return false;
    }
    if (mod && e.shiftKey && e.code === 'KeyV') {
      void navigator.clipboard?.readText().then((txt) => txt && term.paste(txt));
      return false;
    }
    return true;
  });
  term.onData((d) => {
    const l = live.get(id);
    if (l && !l.started) {
      // Any key after the shell exited starts a fresh one.
      if (d === '\r') void start(id);
      return;
    }
    void host().ptyWrite(id, d).catch(() => undefined);
  });
  term.onResize(({ cols, rows }) => {
    if (live.get(id)?.started) void host().ptyResize(id, cols, rows).catch(() => undefined);
  });
  term.onTitleChange((title) => {
    if (title) useTerminals.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x)) }));
  });
  const l: Live = { term, fit, el, started: false };
  live.set(id, l);
  return l;
}

async function start(id: string) {
  const l = live.get(id);
  if (!l) return;
  ensureListener();
  const workdir = getSettings().workdir;
  const env = projectEnv(chooseInterpreter('python')?.path, workdir, navigator.platform.startsWith('Win') ? ';' : ':');
  try {
    l.fit.fit();
  } catch {
    /* hidden */
  }
  l.started = true;
  useTerminals.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, exited: null } : x)) }));
  try {
    const shell = await host().ptyOpen(id, { cwd: workdir, env, cols: l.term.cols, rows: l.term.rows });
    const name = shell.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? 'shell';
    useTerminals.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === id && x.title.startsWith('…') ? { ...x, title: name } : x)) }));
  } catch (e) {
    l.started = false;
    l.term.write(`\x1b[31m${t('terminal.failed')}: ${String(e)}\x1b[0m\r\n`);
  }
}

/** Open a new terminal session and make it active. */
export function newTerminal(): string {
  const id = `term-${++seq}`;
  useTerminals.setState((s) => ({ sessions: [...s.sessions, { id, title: '…', exited: null }], active: id }));
  return id;
}

/** Mount a session's screen into a container (creating and starting it on first use). */
export async function mountTerminal(id: string, container: HTMLElement) {
  const l = live.get(id) ?? (await createLive(id));
  if (l.el.parentElement !== container) {
    container.replaceChildren(l.el);
  }
  try {
    l.fit.fit();
  } catch {
    /* zero size */
  }
  if (!l.started && useTerminals.getState().sessions.find((s) => s.id === id)?.exited == null) await start(id);
  l.term.focus();
}

export function fitTerminal(id: string) {
  const l = live.get(id);
  try {
    l?.fit.fit();
  } catch {
    /* hidden */
  }
}

export function focusTerminal(id: string) {
  live.get(id)?.term.focus();
}

export function closeTerminal(id: string) {
  void host().ptyKill(id).catch(() => undefined);
  live.get(id)?.term.dispose();
  live.delete(id);
  useTerminals.setState((s) => {
    const sessions = s.sessions.filter((x) => x.id !== id);
    const idx = s.sessions.findIndex((x) => x.id === id);
    const active = s.active === id ? (sessions[Math.min(idx, sessions.length - 1)]?.id ?? null) : s.active;
    return { sessions, active };
  });
}

/** Type text into the active terminal (e.g. "run in terminal"). */
export function sendToTerminal(text: string) {
  const id = useTerminals.getState().active;
  if (id && live.get(id)?.started) void host().ptyWrite(id, text);
}

export function installTerminalListeners(): () => void {
  const offTheme = useThemeMode.subscribe(() => requestAnimationFrame(applyTerminalTheme));
  return () => {
    offTheme();
    for (const id of [...live.keys()]) closeTerminal(id);
  };
}
