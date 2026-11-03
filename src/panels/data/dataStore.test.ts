import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: any[] = [];
vi.mock('../../kernels/kernels', () => ({
  callHelper: vi.fn(async (_lang: string, func: string, args: any) => {
    calls.push({ func, args });
    if (func === 'data_info') return { rows: 1000, cols: 2, class: 'data.frame', columns: [{ name: 'x', type: 'int', tone: 'numeric' }, { name: 'g', type: 'chr', tone: 'text' }] };
    if (func === 'data_page') {
      const n = Math.max(0, Math.min(args.limit, 1000 - args.offset));
      const rows = Array.from({ length: n }, (_, i) => args.offset + i + 1);
      return { total: 1000, rows, columns: [rows.map(String), rows.map((r) => (r % 2 ? 'a' : null))] };
    }
    return true;
  }),
}));

import { BLOCK, evict, ensureRows, ensureViewer, rowAt, setSearch, toggleSort, useData, type Block } from './dataStore';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('data viewer store', () => {
  beforeEach(() => {
    calls.length = 0;
    useData.setState({ viewers: {} });
  });

  it('loads info then the first block, and serves rows by index', async () => {
    const v = ensureViewer('r', 'df');
    await flush();
    await flush();
    const cur = useData.getState().viewers[v.id];
    expect(cur.info?.cols).toBe(2);
    expect(cur.total).toBe(1000);
    expect(rowAt(cur, 5)).toEqual({ row: 6, values: ['6', null] });
    expect(rowAt(cur, 500)).toBeNull();
  });

  it('fetches missing blocks in contiguous runs only once', async () => {
    const v = ensureViewer('r', 'df');
    await flush();
    await flush();
    calls.length = 0;
    ensureRows(v.id, 450, 480);
    ensureRows(v.id, 450, 480);
    await flush();
    const pages = calls.filter((c) => c.func === 'data_page');
    expect(pages).toHaveLength(1);
    expect(pages[0].args.offset).toBe(3 * BLOCK);
    expect(pages[0].args.limit).toBe(3 * BLOCK);
  });

  it('resets rows when the query changes', async () => {
    const v = ensureViewer('r', 'df');
    await flush();
    await flush();
    toggleSort(v.id, 0, false);
    expect(useData.getState().viewers[v.id].sort).toEqual([{ col: 0, desc: false }]);
    toggleSort(v.id, 0, false);
    expect(useData.getState().viewers[v.id].sort).toEqual([{ col: 0, desc: true }]);
    toggleSort(v.id, 0, false);
    expect(useData.getState().viewers[v.id].sort).toEqual([]);
    setSearch(v.id, 'abc');
    await new Promise((r) => setTimeout(r, 150));
    const last = calls.filter((c) => c.func === 'data_page').pop();
    expect(last.args.search).toBe('abc');
  });

  it('never sends stale queries when the query changes rapidly', async () => {
    const v = ensureViewer('r', 'df');
    await flush();
    await flush();
    calls.length = 0;
    for (let i = 0; i < 5; i++) toggleSort(v.id, 0, false);
    await new Promise((r) => setTimeout(r, 150));
    const pages = calls.filter((c) => c.func === 'data_page');
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) expect(p.args.sort).toEqual([{ col: 0, desc: true }]);
  });

  it('evicts the blocks farthest from the viewport', () => {
    const blocks = new Map<number, Block>();
    for (let i = 0; i < 100; i++) blocks.set(i, { rows: [], columns: [] });
    evict(blocks, 0);
    expect(blocks.size).toBe(80);
    expect(blocks.has(0)).toBe(true);
    expect(blocks.has(99)).toBe(false);
  });
});
