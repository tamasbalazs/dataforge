/**
 * Virtualised data grid: only visible rows and columns are in the DOM.
 * Heights beyond the browser's scroll limit are compressed, so millions of
 * rows scroll smoothly. Fully keyboard accessible (role="grid").
 */
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../core/format';
import type { ColumnInfo, ColumnStats, SortKey } from './dataStore';

export const ROW_H = 28;
export const HEADER_H = 58;
const MAX_SCROLL = 8_000_000;
const MIN_COL = 56;

export interface GridProps {
  columns: ColumnInfo[];
  total: number;
  getRow: (i: number) => { row: number; values: Array<string | null> } | null;
  onVisible: (first: number, last: number, firstCol: number, lastCol: number) => void;
  stats: Map<number, ColumnStats>;
  sort: SortKey[];
  filteredCols: Set<number>;
  onSort: (col: number, multi: boolean) => void;
  onColumnMenu: (col: number, anchor: DOMRect) => void;
  label: string;
  /** Unfiltered row count (column statistics are computed over all rows). */
  rows: number;
}

export function defaultWidth(c: ColumnInfo): number {
  const base = c.tone === 'text' ? 160 : c.tone === 'date' ? 170 : c.tone === 'logical' ? 84 : 110;
  return Math.max(base, Math.min(260, c.name.length * 8 + 56));
}

/** Map scrollTop to the first visible row, compressing very tall content. */
export function scrollGeometry(total: number, viewport: number, scrollTop: number) {
  const full = total * ROW_H;
  const height = Math.min(full, MAX_SCROLL);
  const scale = full > MAX_SCROLL ? (full - viewport) / Math.max(1, height - viewport) : 1;
  const virtualTop = scrollTop * scale;
  const first = Math.max(0, Math.floor(virtualTop / ROW_H));
  const offset = first * ROW_H - virtualTop; // where row `first` starts, relative to the viewport top
  return { height, first, offset, scale };
}

function Histogram({ stats, tone, width, rows }: { stats?: ColumnStats; tone: string; width: number; rows: number }) {
  const { t } = useTranslation();
  if (!stats || stats.na < 0) return <div className="df-grid__hist is-loading" />;
  const w = Math.max(24, width - 20);
  const h = 18;
  if (stats.hist?.length) {
    const max = Math.max(...stats.hist, 1);
    const bw = w / stats.hist.length;
    return (
      <svg className="df-grid__hist" width={w} height={h} role="img" aria-label={t('data.histogram', { min: stats.min, max: stats.max })}>
        <title>{`${stats.min} … ${stats.max}${stats.mean ? ` · x̄ ${stats.mean}` : ''}`}</title>
        {stats.hist.map((c, i) => {
          const bh = c === 0 ? 0 : Math.max(1.5, (c / max) * h);
          return <rect key={i} x={i * bw + 0.5} y={h - bh} width={Math.max(1, bw - 1)} height={bh} rx={1} className={`df-tone--${tone}`} />;
        })}
      </svg>
    );
  }
  if (stats.top?.length) {
    const denom = Math.max(1, rows - stats.na);
    const shown = stats.top.slice(0, 4);
    let x = 0;
    return (
      <svg className="df-grid__hist" width={w} height={h} role="img" aria-label={t('data.topValues', { n: stats.unique })}>
        <title>{`${stats.unique} ${t('data.unique')}: ${shown.map((s) => `${s.value} (${s.count})`).join(', ')}`}</title>
        {shown.map((s, i) => {
          const bw = (s.count / denom) * w;
          const r = <rect key={i} x={x} y={5} width={Math.max(1, bw - 1.5)} height={8} rx={2} className={`df-tone--${tone}`} opacity={1 - i * 0.2} />;
          x += bw;
          return r;
        })}
      </svg>
    );
  }
  return <div className="df-grid__hist" />;
}

const Cell = memo(function Cell({ value, tone, width, left, selected, id }: { value: string | null | undefined; tone: string; width: number; left: number; selected: boolean; id?: string }) {
  return (
    <div
      role="gridcell"
      id={id}
      aria-selected={selected || undefined}
      className={`df-grid__cell df-grid__cell--${tone} ${value === null ? 'is-na' : ''} ${selected ? 'is-selected' : ''}`}
      style={{ width, transform: `translateX(${left}px)` }}
    >
      {value === undefined ? <span className="df-grid__skeleton" /> : value === null ? 'NA' : value}
    </div>
  );
});

export function DataGrid(p: GridProps) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 400 });
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [widths, setWidths] = useState<number[]>(() => p.columns.map(defaultWidth));
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);

  useEffect(() => setWidths(p.columns.map(defaultWidth)), [p.columns]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowNumWidth = Math.max(48, String(p.total).length * 8 + 24);
  const lefts = useMemo(() => {
    const out: number[] = [];
    let x = 0;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return { out, total: x };
  }, [widths]);

  const viewportH = Math.max(0, size.h - HEADER_H);
  const geo = scrollGeometry(p.total, viewportH, scroll.top);
  const visibleCount = Math.ceil(viewportH / ROW_H) + 2;
  const firstRow = geo.first;
  const lastRow = Math.min(p.total - 1, firstRow + visibleCount);

  const dataLeft = scroll.left;
  let firstCol = 0;
  while (firstCol < widths.length - 1 && lefts.out[firstCol] + widths[firstCol] < dataLeft) firstCol++;
  let lastCol = firstCol;
  while (lastCol < widths.length - 1 && lefts.out[lastCol + 1] < dataLeft + size.w - rowNumWidth) lastCol++;

  useEffect(() => {
    if (p.total > 0 || p.columns.length) p.onVisible(firstRow, Math.max(firstRow, lastRow), firstCol, lastCol);
  }, [firstRow, lastRow, firstCol, lastCol, p.total]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = scroller.current;
    if (el) setScroll({ top: el.scrollTop, left: el.scrollLeft });
  };

  // Keep the selected cell in view.
  const reveal = useCallback(
    (r: number, c: number) => {
      const el = scroller.current;
      if (!el) return;
      const { first, offset } = scrollGeometry(p.total, viewportH, el.scrollTop);
      const y = (r - first) * ROW_H + offset;
      if (y < 0 || y + ROW_H > viewportH) {
        const full = p.total * ROW_H;
        const scale = full > MAX_SCROLL ? (full - viewportH) / Math.max(1, Math.min(full, MAX_SCROLL) - viewportH) : 1;
        const target = y < 0 ? r * ROW_H : r * ROW_H - viewportH + ROW_H;
        el.scrollTop = target / scale;
      }
      const x = lefts.out[c];
      const w = widths[c];
      const visW = el.clientWidth - rowNumWidth;
      if (x < el.scrollLeft) el.scrollLeft = x;
      else if (x + w > el.scrollLeft + visW) el.scrollLeft = x + w - visW;
    },
    [p.total, viewportH, lefts, widths, rowNumWidth],
  );

  const onKey = (e: KeyboardEvent) => {
    if (!p.total || !p.columns.length) return;
    const cur = sel ?? { r: 0, c: 0 };
    const page = Math.max(1, Math.floor(viewportH / ROW_H) - 1);
    let { r, c } = cur;
    switch (e.key) {
      case 'ArrowDown': r++; break;
      case 'ArrowUp': r--; break;
      case 'ArrowRight': c++; break;
      case 'ArrowLeft': c--; break;
      case 'PageDown': r += page; break;
      case 'PageUp': r -= page; break;
      case 'Home': if (e.ctrlKey || e.metaKey) r = 0; else c = 0; break;
      case 'End': if (e.ctrlKey || e.metaKey) r = p.total - 1; else c = p.columns.length - 1; break;
      case 'c':
        if (e.ctrlKey || e.metaKey) {
          const v = p.getRow(cur.r)?.values[cur.c];
          if (v !== undefined) void navigator.clipboard?.writeText(v ?? 'NA');
          e.preventDefault();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    r = Math.max(0, Math.min(p.total - 1, r));
    c = Math.max(0, Math.min(p.columns.length - 1, c));
    setSel({ r, c });
    reveal(r, c);
  };

  // Column resizing
  const startResize = (col: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[col];
    const move = (ev: PointerEvent) => setWidths((ws) => ws.map((w, i) => (i === col ? Math.max(MIN_COL, w0 + ev.clientX - x0) : w)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const autosize = (col: number) => {
    let max = p.columns[col].name.length * 8 + 56;
    for (let r = firstRow; r <= lastRow; r++) {
      const v = p.getRow(r)?.values[col];
      if (v) max = Math.max(max, v.length * 7.6 + 24);
    }
    setWidths((ws) => ws.map((w, i) => (i === col ? Math.min(600, Math.max(MIN_COL, Math.round(max))) : w)));
  };

  const sortOf = (c: number) => {
    const i = p.sort.findIndex((s) => s.col === c);
    return i < 0 ? null : { ...p.sort[i], order: i + 1 };
  };

  const rows = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const data = p.getRow(r);
    const y = (r - firstRow) * ROW_H + geo.offset;
    const cells = [];
    for (let c = firstCol; c <= lastCol; c++) {
      const selected = !!sel && sel.r === r && sel.c === c;
      cells.push(
        <Cell
          key={c}
          id={selected ? 'df-grid-active' : undefined}
          value={data ? data.values[c] : undefined}
          tone={p.columns[c].tone}
          width={widths[c]}
          left={lefts.out[c] - dataLeft}
          selected={selected}
        />,
      );
    }
    rows.push(
      <div
        key={r}
        role="row"
        aria-rowindex={r + 2}
        className={`df-grid__row ${r % 2 ? 'is-odd' : ''} ${sel?.r === r ? 'is-current' : ''}`}
        style={{ transform: `translateY(${y}px)` }}
        onMouseDown={(e) => {
          const target = (e.target as HTMLElement).closest('[role=gridcell]');
          if (!target) return;
          const idx = [...target.parentElement!.children].indexOf(target) - 1;
          if (idx >= 0) setSel({ r, c: firstCol + idx });
        }}
      >
        <div className="df-grid__rownum" style={{ width: rowNumWidth }}>
          {data ? formatNumber(data.row) : ''}
        </div>
        {cells}
      </div>,
    );
  }

  const headers = [];
  for (let c = firstCol; c <= lastCol; c++) {
    const col = p.columns[c];
    const s = sortOf(c);
    const st = p.stats.get(c);
    headers.push(
      <div
        key={c}
        role="columnheader"
        aria-colindex={c + 2}
        aria-sort={s ? (s.desc ? 'descending' : 'ascending') : 'none'}
        className={`df-grid__head ${s ? 'is-sorted' : ''} ${p.filteredCols.has(c) ? 'is-filtered' : ''}`}
        style={{ width: widths[c], transform: `translateX(${lefts.out[c] - dataLeft}px)` }}
      >
        <button className="df-grid__head-main" onClick={(e) => p.onSort(c, e.shiftKey)} title={t('data.sortHint')}>
          <span className="df-grid__head-name">{col.name}</span>
          {s && (
            <span className="df-grid__sort" aria-hidden>
              {s.desc ? <ArrowDown size={11} strokeWidth={2.5} /> : <ArrowUp size={11} strokeWidth={2.5} />}
              {p.sort.length > 1 && <sup>{s.order}</sup>}
            </span>
          )}
        </button>
        <div className="df-grid__head-meta">
          <span className={`df-type-badge df-type-badge--${col.tone === 'text' ? 'text' : col.tone}`}>{col.type}</span>
          {st && st.na > 0 && (
            <span className="df-grid__na" title={t('data.missing', { n: formatNumber(st.na) })}>
              NA {((st.na / Math.max(1, p.rows)) * 100).toFixed(st.na / Math.max(1, p.rows) < 0.01 ? 1 : 0)}%
            </span>
          )}
          <button
            className="df-grid__menu-btn"
            aria-label={t('data.columnMenu', { name: col.name })}
            onClick={(e) => p.onColumnMenu(c, (e.currentTarget as HTMLElement).closest('.df-grid__head')!.getBoundingClientRect())}
          >
            <ChevronDown size={12} strokeWidth={2} />
          </button>
        </div>
        <Histogram stats={st} tone={col.tone} width={widths[c]} rows={p.rows} />
        <div className="df-grid__resize" onPointerDown={(e) => startResize(c, e)} onDoubleClick={() => autosize(c)} aria-hidden />
      </div>,
    );
  }

  return (
    <div
      className="df-grid"
      style={{ ['--rownum-w' as string]: `${rowNumWidth}px` }}
      role="grid"
      aria-label={p.label}
      aria-rowcount={p.total + 1}
      aria-colcount={p.columns.length + 1}
      aria-activedescendant={sel ? 'df-grid-active' : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      onFocus={() => !sel && p.total > 0 && setSel({ r: firstRow, c: firstCol })}
    >
      <div className="df-grid__scroll" ref={scroller} onScroll={onScroll}>
        <div style={{ height: geo.height + HEADER_H, width: lefts.total + rowNumWidth, position: 'relative' }}>
          <div className="df-grid__viewport" style={{ width: size.w, height: size.h }}>
            <div className="df-grid__header" role="row" aria-rowindex={1} style={{ height: HEADER_H }}>
              <div className="df-grid__corner" style={{ width: rowNumWidth }} />
              {headers}
            </div>
            <div className="df-grid__body" style={{ top: HEADER_H }}>
              {rows}
            </div>
            {p.total === 0 && <div className="df-grid__empty">{t('data.noRows')}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
