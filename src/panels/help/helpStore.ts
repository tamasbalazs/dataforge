/** Help pages with back/forward history, fetched from the kernels. */
import { create } from 'zustand';
import { emit } from '../../core/bus';
import type { Lang } from '../../core/host';
import { callHelper, startKernel } from '../../kernels/kernels';

export interface HelpRef {
  lang: Lang;
  topic: string;
  package?: string;
}

export interface RHelpPage {
  found: boolean;
  topic: string;
  package?: string;
  title?: string;
  html?: string;
  choices?: Array<{ topic: string; package: string }>;
}

export interface PyHelpPage {
  found: boolean;
  topic: string;
  name?: string;
  module?: string | null;
  kind?: string;
  signature?: string | null;
  doc?: string;
  members?: Array<{ name: string; kind: string; summary: string }>;
}

export interface SearchHit {
  topic: string;
  package: string;
  title: string;
}

interface HelpState {
  history: HelpRef[];
  index: number;
  page: RHelpPage | PyHelpPage | null;
  loading: boolean;
  error: string | null;
  results: { lang: Lang; query: string; hits: SearchHit[] } | null;
  searching: boolean;
}

export const useHelp = create<HelpState>(() => ({ history: [], index: -1, page: null, loading: false, error: null, results: null, searching: false }));

let seq = 0;

async function load(ref: HelpRef) {
  const id = ++seq;
  useHelp.setState({ loading: true, error: null, results: null });
  try {
    await startKernel(ref.lang);
    const page =
      ref.lang === 'r'
        ? await callHelper<RHelpPage>('r', 'help_html', ref.package ? { topic: ref.topic, package: ref.package } : { topic: ref.topic })
        : await callHelper<PyHelpPage>('python', 'help_doc', { topic: ref.topic });
    if (id === seq) useHelp.setState({ page, loading: false });
  } catch (e) {
    if (id === seq) useHelp.setState({ error: String(e), loading: false, page: null });
  }
}

/** Open a help page (adds to history) and reveal the Help panel. */
export function showHelp(lang: Lang, topic: string, pkg?: string) {
  const ref: HelpRef = { lang, topic, package: pkg };
  useHelp.setState((s) => {
    const history = [...s.history.slice(0, s.index + 1), ref].slice(-100);
    return { history, index: history.length - 1 };
  });
  emit('help:show', ref);
  void load(ref);
}

export function goBack() {
  const { index, history } = useHelp.getState();
  if (index <= 0) return;
  useHelp.setState({ index: index - 1 });
  void load(history[index - 1]);
}

export function goForward() {
  const { index, history } = useHelp.getState();
  if (index >= history.length - 1) return;
  useHelp.setState({ index: index + 1 });
  void load(history[index + 1]);
}

export async function searchHelp(lang: Lang, query: string) {
  const q = query.trim();
  if (!q) return;
  useHelp.setState({ searching: true, error: null });
  try {
    await startKernel(lang);
    const hits = (await callHelper<SearchHit[]>(lang, 'help_search', { query: q })) ?? [];
    useHelp.setState({ results: { lang, query: q, hits }, searching: false });
  } catch (e) {
    useHelp.setState({ error: String(e), searching: false });
  }
}

/**
 * Console shortcuts that should open help instead of running:
 * R `?mean`, `??regression`, `help(mean)`, `help("mean", package = "stats")`;
 * Python `help(len)`, `len?`, `np.mean??`.
 */
export function parseHelpRequest(lang: Lang, code: string): { topic: string; package?: string; search?: boolean } | null {
  const c = code.trim();
  if (lang === 'r') {
    let m = c.match(/^\?\?\s*["']?([^"'\s]+)["']?$/);
    if (m) return { topic: m[1], search: true };
    m = c.match(/^\?\s*["']?([\w.:]+)["']?$/);
    if (m) {
      const [pkg, topic] = m[1].includes('::') ? m[1].split(/:::?/) : [undefined, m[1]];
      return { topic, package: pkg };
    }
    m = c.match(/^help\(\s*["']?([\w.]+)["']?\s*(?:,\s*package\s*=\s*["']?([\w.]+)["']?\s*)?\)$/);
    if (m) return { topic: m[1], package: m[2] };
    return null;
  }
  let m = c.match(/^help\(\s*([A-Za-z_][\w.]*)\s*\)$/);
  if (m) return { topic: m[1] };
  m = c.match(/^([A-Za-z_][\w.]*)\?\??$/);
  if (m) return { topic: m[1] };
  m = c.match(/^\?\??([A-Za-z_][\w.]*)$/);
  if (m) return { topic: m[1] };
  return null;
}

/** Word under the cursor for F1 (R: `pkg::fn`, Python: dotted names). */
export function topicAt(line: string, column: number, lang: Lang): { topic: string; package?: string } | null {
  const re = lang === 'r' ? /[A-Za-z0-9_.]+(?:::?[A-Za-z0-9_.]+)?/g : /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*/g;
  for (const m of line.matchAll(re)) {
    const start = m.index! + 1;
    const end = start + m[0].length;
    if (column >= start && column <= end) {
      if (lang === 'r' && m[0].includes('::')) {
        const [pkg, topic] = m[0].split(/:::?/);
        return { topic, package: pkg };
      }
      return { topic: m[0] };
    }
  }
  return null;
}
