/**
 * Data viewer state. Rows are fetched lazily in blocks from the kernel; only
 * a bounded number of blocks is kept, so memory stays flat for any data size.
 */
import { create } from 'zustand';
import { on } from '../../core/bus';
import type { Lang } from '../../core/host';
import { callHelper } from '../../kernels/kernels';
import { useEnv } from '../environment/envStore';
import { toWire, type ColumnFilter } from './filter';

export const BLOCK = 100;
export const MAX_BLOCKS = 80;

export interface ColumnInfo {
  name: string;
  type: string;
  tone: string;
}

export interface ColumnStats {
  col: number;
  na: number;
  hist?: number[];
  min?: string;
  max?: string;
  mean?: string;
  unique?: number;
  top?: Array<{ value: string; count: number }>;
}

export interface SortKey {
  col: number;
  desc: boolean;
}

export interface Block {
  rows: number[];
  /** Column-major values (strings or null for missing). */
  columns: Array<Array<string | null>>;
}

export interface Viewer {
  id: string;
  lang: Lang;
  name: string;
  title: string;
  rev: number;
  info: { rows: number; cols: number; columns: ColumnInfo[]; class: string } | null;
  total: number | null;
  sort: SortKey[];
  search: string;
  filters: ColumnFilter[];
  /** Incremented on every query change; stale responses are dropped. */
  generation: number;
  blocks: Map<number, Block>;
  stats: Map<number, ColumnStats>;
  loading: boolean;
  error: string | null;
  lastQueryMs: number | null;
}

export const useData = create<{ viewers: Record<string, Viewer> }>(() => ({ viewers: {} }));

export const viewerId = (lang: Lang, name: string) => `data:${lang}:${name}`;

const get = (id: string) => useData.getState().viewers[id];
const set = (id: string, patch: Partial<Viewer>) =>
  useData.setState((s) => (s.viewers[id] ? { viewers: { ...s.viewers, [id]: { ...s.viewers[id], ...patch } } } : s));

const inflight = new Map<string, Set<number>>();

export function ensureViewer(lang: Lang, name: string, title?: string): Viewer {
  const id = viewerId(lang, name);
  const existing = get(id);
  if (existing) return existing;
  const v: Viewer = {
    id,
    lang,
    name,
    title: title ?? name,
    rev: 1,
    info: null,
    total: null,
    sort: [],
    search: '',
    filters: [],
    generation: 0,
    blocks: new Map(),
    stats: new Map(),
    loading: false,
    error: null,
    lastQueryMs: null,
  };
  useData.setState((s) => ({ viewers: { ...s.viewers, [id]: v } }));
  void loadInfo(id);
  return v;
}

export async function loadInfo(id: string) {
  const v = get(id);
  if (!v) return;
  set(id, { loading: true, error: null });
  try {
    const info = await callHelper<Viewer['info']>(v.lang, 'data_info', { name: v.name, rev: v.rev });
    if (!info) throw new Error('kernel not running');
    set(id, { info, loading: false });
    resetRows(id, 0);
  } catch (e) {
    set(id, { error: String(e), loading: false, info: null });
  }
}

const resetTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Drop loaded rows after a query change. The fetch is debounced so rapid
 * changes (repeated sort clicks, typing) don't queue stale queries in the
 * kernel, which runs them one at a time.
 */
function resetRows(id: string, delay = 120) {
  const v = get(id);
  if (!v) return;
  inflight.delete(id);
  const generation = v.generation + 1;
  set(id, { blocks: new Map(), total: null, generation, loading: true });
  clearTimeout(resetTimers.get(id));
  resetTimers.set(
    id,
    setTimeout(() => {
      resetTimers.delete(id);
      if (get(id)?.generation !== generation) return;
      const [first, last] = visible.get(id) ?? [0, 0];
      void fetchBlocks(id, Math.floor(first / BLOCK), Math.floor(last / BLOCK));
    }, delay),
  );
}

/** Make sure rows [first, last] (filtered order) are loaded. */
/** Last visible range per viewer, reloaded after query changes. */
const visible = new Map<string, [number, number]>();

export function ensureRows(id: string, first: number, last: number) {
  visible.set(id, [first, last]);
  const v = get(id);
  if (!v || !v.info || resetTimers.has(id)) return;
  const b0 = Math.max(0, Math.floor(first / BLOCK) - 1);
  const b1 = Math.floor(last / BLOCK) + 1;
  void fetchBlocks(id, b0, b1);
}

async function fetchBlocks(id: string, b0: number, b1: number) {
  const v = get(id);
  if (!v || !v.info) return;
  const maxBlock = v.total == null ? b1 : Math.max(0, Math.ceil(v.total / BLOCK) - 1);
  const busy = inflight.get(id) ?? new Set<number>();
  inflight.set(id, busy);
  const missing: number[] = [];
  for (let b = b0; b <= Math.min(b1, maxBlock); b++) if (!v.blocks.has(b) && !busy.has(b)) missing.push(b);
  if (!missing.length) return;
  // One request per contiguous run of missing blocks.
  const runs: number[][] = [];
  for (const b of missing) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === b - 1 && last.length < 10) last.push(b);
    else runs.push([b]);
  }
  const gen = v.generation;
  await Promise.all(
    runs.map(async (run) => {
      run.forEach((b) => busy.add(b));
      set(id, { loading: true });
      const t0 = performance.now();
      try {
        const page = await callHelper<{ total: number; rows: number[]; columns: Array<Array<string | null>> }>(v.lang, 'data_page', {
          name: v.name,
          rev: v.rev,
          offset: run[0] * BLOCK,
          limit: run.length * BLOCK,
          sort: v.sort,
          search: v.search,
          filters: v.filters.map(toWire),
        });
        const cur = get(id);
        if (!cur || cur.generation !== gen || !page) return;
        const blocks = new Map(cur.blocks);
        run.forEach((b, i) => {
          const from = i * BLOCK;
          const to = from + BLOCK;
          blocks.set(b, { rows: page.rows.slice(from, to), columns: page.columns.map((c) => c.slice(from, to)) });
        });
        evict(blocks, run[0]);
        const firstLoad = cur.total === null;
        set(id, { blocks, total: page.total, error: null, lastQueryMs: Math.round(performance.now() - t0) });
        // The total may have shrunk/grown; make sure the visible window is covered.
        if (firstLoad) {
          const [a, b] = visible.get(id) ?? [0, 0];
          const lastRow = Math.max(0, page.total - 1);
          ensureRows(id, Math.min(a, lastRow), Math.min(b, lastRow));
        }
      } catch (e) {
        if (get(id)?.generation === gen) set(id, { error: String(e) });
      } finally {
        run.forEach((b) => busy.delete(b));
        if (busy.size === 0) set(id, { loading: false });
      }
    }),
  );
}

/** Keep at most MAX_BLOCKS blocks, dropping those farthest from `center`. */
export function evict(blocks: Map<number, Block>, center: number) {
  if (blocks.size <= MAX_BLOCKS) return;
  const keys = [...blocks.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
  for (const k of keys.slice(0, blocks.size - MAX_BLOCKS)) blocks.delete(k);
}

export function rowAt(v: Viewer, i: number): { row: number; values: Array<string | null> } | null {
  const block = v.blocks.get(Math.floor(i / BLOCK));
  if (!block) return null;
  const j = i % BLOCK;
  if (j >= block.rows.length) return null;
  return { row: block.rows[j], values: block.columns.map((c) => c[j]) };
}

// --- query changes ------------------------------------------------------------

export function toggleSort(id: string, col: number, multi: boolean) {
  const v = get(id);
  if (!v) return;
  const cur = v.sort.find((s) => s.col === col);
  let next: SortKey[];
  if (!cur) next = multi ? [...v.sort, { col, desc: false }] : [{ col, desc: false }];
  else if (!cur.desc) next = v.sort.map((s) => (s.col === col ? { col, desc: true } : s));
  else next = v.sort.filter((s) => s.col !== col);
  if (!multi && cur) next = next.filter((s) => s.col === col);
  setSort(id, next);
}

export function setSort(id: string, sort: SortKey[]) {
  set(id, { sort });
  resetRows(id);
}

export function setSearch(id: string, search: string) {
  if (get(id)?.search === search) return;
  set(id, { search });
  resetRows(id);
}

export function setFilter(id: string, col: number, f: ColumnFilter | null) {
  const v = get(id);
  if (!v) return;
  const filters = v.filters.filter((x) => x.col !== col);
  if (f) filters.push(f);
  set(id, { filters });
  resetRows(id);
}

export function clearQuery(id: string) {
  set(id, { filters: [], search: '', sort: [] });
  resetRows(id);
}

export function refreshViewer(id: string) {
  const v = get(id);
  if (!v) return;
  set(id, { rev: v.rev + 1, stats: new Map() });
  void loadInfo(id);
}

export async function loadStats(id: string, cols: number[]) {
  const v = get(id);
  if (!v || !v.info) return;
  const want = cols.filter((c) => !v.stats.has(c) && c < v.info!.cols);
  if (!want.length) return;
  // Mark as pending to avoid duplicate requests.
  const pending = new Map(v.stats);
  want.forEach((c) => pending.set(c, { col: c, na: -1 }));
  set(id, { stats: pending });
  try {
    const res = await callHelper<ColumnStats[]>(v.lang, 'data_stats', { name: v.name, rev: v.rev, cols: want });
    const cur = get(id);
    if (!cur || cur.rev !== v.rev || !res) return;
    const stats = new Map(cur.stats);
    res.forEach((s) => stats.set(s.col, s));
    set(id, { stats });
  } catch {
    const cur = get(id);
    if (!cur) return;
    const stats = new Map(cur.stats);
    want.forEach((c) => stats.delete(c));
    set(id, { stats });
  }
}

export function closeViewer(id: string) {
  const v = get(id);
  if (!v) return;
  clearTimeout(resetTimers.get(id));
  resetTimers.delete(id);
  visible.delete(id);
  void callHelper(v.lang, 'data_release', { name: v.name }).catch(() => undefined);
  inflight.delete(id);
  useData.setState((s) => {
    const { [id]: _, ...rest } = s.viewers;
    return { viewers: rest };
  });
}

/** Refresh viewers whose variable changed (named variables only, not View() snapshots). */
export function installDataListeners(): () => void {
  const offEnv = useEnv.subscribe((s, prev) => {
    for (const lang of ['r', 'python'] as Lang[]) {
      if (s.changed[lang] === prev.changed[lang] && s.vars[lang] === prev.vars[lang]) continue;
      for (const v of Object.values(useData.getState().viewers)) {
        if (v.lang !== lang || v.name.startsWith('@')) continue;
        const exists = s.vars[lang].some((x) => x.name === v.name);
        if (!exists && s.vars[lang] !== prev.vars[lang] && v.info) set(v.id, { error: 'missing', info: null });
        else if (s.changed[lang].includes(v.name)) refreshViewer(v.id);
      }
    }
  });
  const offStatus = on('kernel:ready', ({ lang }) => {
    for (const v of Object.values(useData.getState().viewers)) if (v.lang === lang && !v.name.startsWith('@')) refreshViewer(v.id);
  });
  return () => {
    offEnv();
    offStatus();
  };
}
