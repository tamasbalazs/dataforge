/** Console transcript per language, fed from kernel bus events. */
import { create } from 'zustand';
import { on } from '../../core/bus';
import type { Lang } from '../../core/host';

export type EntryKind = 'input' | 'stdout' | 'stderr' | 'result' | 'error' | 'plot' | 'view' | 'info';

export interface ConsoleEntry {
  id: number;
  kind: EntryKind;
  text: string;
  parentId?: string | null;
  plotId?: string;
  status?: 'running' | 'ok' | 'error' | 'aborted';
  durationMs?: number;
  startedAt?: number;
  /** Shared sessions: who ran it (absent for this user's own code). */
  by?: string;
}

export const MAX_ENTRIES = 3000;
export const VIEW_MIME = 'application/vnd.dataforge.view+json';
const MAX_TEXT = 200_000;
const HISTORY_KEY = (l: Lang) => `dataforge.history.${l}`;

interface ConsoleState {
  entries: Record<Lang, ConsoleEntry[]>;
  history: Record<Lang, string[]>;
  active: Lang;
}

function loadHistory(lang: Lang): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY(lang)) ?? '[]');
  } catch {
    return [];
  }
}

export const useConsole = create<ConsoleState>(() => ({
  entries: { r: [], python: [] },
  history: { r: loadHistory('r'), python: loadHistory('python') },
  active: 'r',
}));

let nextId = 1;

export function appendEntry(lang: Lang, e: Omit<ConsoleEntry, 'id'>) {
  useConsole.setState((s) => {
    const list = s.entries[lang];
    const last = list[list.length - 1];
    // Merge consecutive stream chunks of the same request into one entry.
    if (last && (e.kind === 'stdout' || e.kind === 'stderr') && last.kind === e.kind && last.parentId === e.parentId) {
      const merged = { ...last, text: (last.text + e.text).slice(-MAX_TEXT) };
      return { entries: { ...s.entries, [lang]: [...list.slice(0, -1), merged] } };
    }
    const next = [...list, { ...e, id: nextId++ }];
    return { entries: { ...s.entries, [lang]: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next } };
  });
}

function patchInput(lang: Lang, parentId: string, patch: Partial<ConsoleEntry>) {
  useConsole.setState((s) => ({
    entries: {
      ...s.entries,
      [lang]: s.entries[lang].map((e) => (e.kind === 'input' && e.parentId === parentId ? { ...e, ...patch } : e)),
    },
  }));
}

export function clearConsole(lang: Lang) {
  useConsole.setState((s) => ({ entries: { ...s.entries, [lang]: [] } }));
}

export function setActiveConsole(lang: Lang) {
  useConsole.setState({ active: lang });
}

export function pushHistory(lang: Lang, code: string) {
  const trimmed = code.trim();
  if (!trimmed) return;
  useConsole.setState((s) => {
    const h = [...s.history[lang].filter((x) => x !== trimmed), trimmed].slice(-500);
    try {
      localStorage.setItem(HISTORY_KEY(lang), JSON.stringify(h));
    } catch {
      /* ignore */
    }
    return { history: { ...s.history, [lang]: h } };
  });
}

function textOf(data: Record<string, any> | undefined): string {
  if (!data) return '';
  const plain = data['text/plain'];
  return Array.isArray(plain) ? plain.join('') : (plain ?? '');
}

/** Wire the store to the bus. Returns an unsubscribe function. */
export function installConsoleListeners(): () => void {
  const offs = [
    on('kernel:execution-start', ({ lang, msgId, code, echo, by }) => {
      if (echo) {
        appendEntry(lang, { kind: 'input', text: code, parentId: msgId, status: 'running', startedAt: performance.now(), by });
        if (!by) pushHistory(lang, code);
      }
      useConsole.setState({ active: lang });
    }),
    on('kernel:execution-done', ({ lang, msgId, status, durationMs }) => {
      patchInput(lang, msgId, { status, durationMs });
    }),
    on('kernel:output', ({ lang, parentId, msgType, content }) => {
      switch (msgType) {
        case 'stream':
          appendEntry(lang, { kind: content.name === 'stderr' ? 'stderr' : 'stdout', text: content.text, parentId });
          break;
        case 'execute_result':
          appendEntry(lang, { kind: 'result', text: textOf(content.data), parentId });
          break;
        case 'display_data':
        case 'update_display_data': {
          const data = content.data ?? {};
          const view = data[VIEW_MIME];
          if (view) {
            const v = typeof view === 'string' ? JSON.parse(view) : view;
            appendEntry(lang, { kind: 'view', text: v.title ?? v.name, plotId: v.name, parentId });
            break;
          }
          const isImage = Object.keys(data).some((k) => k.startsWith('image/'));
          if (!isImage) {
            const txt = textOf(data);
            if (txt) appendEntry(lang, { kind: 'result', text: txt, parentId });
          }
          break;
        }
        case 'error':
          appendEntry(lang, {
            kind: 'error',
            text: (content.traceback?.length ? content.traceback.join('\n') : `${content.ename}: ${content.evalue}`) as string,
            parentId,
          });
          break;
      }
    }),
    on('plots:added', ({ lang, id, parentId, index }) => {
      appendEntry(lang, { kind: 'plot', text: String(index), plotId: id, parentId });
    }),
    on('kernel:ready', ({ lang }) => {
      appendEntry(lang, { kind: 'info', text: 'ready' });
    }),
  ];
  return () => offs.forEach((o) => o());
}
