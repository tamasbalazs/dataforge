/** Open documents. Text lives in Monaco models; this store tracks metadata. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lang } from '../../core/host';

export interface Doc {
  id: string;
  /** Absolute path, or null for untitled documents. */
  path: string | null;
  name: string;
  language: string;
  dirty: boolean;
  /** Content of untitled docs, persisted so a restart does not lose work. */
  draft?: string;
}

interface EditorState {
  docs: Doc[];
  activeId: string | null;
  untitledCounter: number;
}

export const useEditor = create<EditorState>()(
  persist(() => ({ docs: [] as Doc[], activeId: null as string | null, untitledCounter: 0 }), {
    name: 'dataforge.editor',
    version: 1,
    partialize: (s) => ({
      docs: s.docs.map((d) => ({ ...d, dirty: d.path ? false : d.dirty })),
      activeId: s.activeId,
      untitledCounter: s.untitledCounter,
    }),
  }),
);

export const LANGUAGE_BY_EXT: Record<string, string> = {
  r: 'r',
  rprofile: 'r',
  py: 'python',
  pyw: 'python',
  md: 'markdown',
  qmd: 'markdown',
  rmd: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  sql: 'sql',
  ini: 'ini',
  toml: 'ini',
  json: 'json',
  txt: 'plaintext',
  csv: 'plaintext',
  stan: 'stan',
  stanfunctions: 'stan',
};

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function languageForPath(path: string): string {
  const ext = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return LANGUAGE_BY_EXT[ext] ?? 'plaintext';
}

/** Kernel language that runs code from an editor language, if any. */
export function kernelLangFor(language: string): Lang | null {
  return language === 'r' ? 'r' : language === 'python' ? 'python' : null;
}

let seq = 0;
const newId = () => `doc-${Date.now().toString(36)}-${++seq}`;

export function newUntitled(language: 'r' | 'python' | 'stan', draft = ''): Doc {
  const n = useEditor.getState().untitledCounter + 1;
  const doc: Doc = {
    id: newId(),
    path: null,
    name: `Untitled-${n}.${language === 'r' ? 'R' : language === 'stan' ? 'stan' : 'py'}`,
    language,
    dirty: draft.length > 0,
    draft,
  };
  useEditor.setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id, untitledCounter: n }));
  return doc;
}

export function addFileDoc(path: string): { doc: Doc; existed: boolean } {
  const existing = useEditor.getState().docs.find((d) => d.path === path);
  if (existing) {
    useEditor.setState({ activeId: existing.id });
    return { doc: existing, existed: true };
  }
  const doc: Doc = { id: newId(), path, name: basename(path), language: languageForPath(path), dirty: false };
  useEditor.setState((s) => ({ docs: [...s.docs, doc], activeId: doc.id }));
  return { doc, existed: false };
}

export function patchDoc(id: string, patch: Partial<Doc>) {
  useEditor.setState((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

export function closeDocState(id: string) {
  useEditor.setState((s) => {
    const idx = s.docs.findIndex((d) => d.id === id);
    const docs = s.docs.filter((d) => d.id !== id);
    const activeId = s.activeId === id ? (docs[Math.min(idx, docs.length - 1)]?.id ?? null) : s.activeId;
    return { docs, activeId };
  });
}

export function setActiveDoc(id: string) {
  useEditor.setState({ activeId: id });
}

export const activeDoc = () => {
  const s = useEditor.getState();
  return s.docs.find((d) => d.id === s.activeId) ?? null;
};
