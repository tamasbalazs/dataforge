import { ArrowDown, ArrowUp, FilterX, RefreshCw, Search, Table2, X } from 'lucide-react';
import { formatNumber } from '../../core/format';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { LANG_LABEL } from '../../kernels/kernels';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Spinner } from '../../ui/Spinner';
import { formatDims } from '../environment/envStore';
import { DataGrid } from './DataGrid';
import { clearQuery, ensureRows, ensureViewer, viewerId, loadStats, refreshViewer, rowAt, setFilter, setSearch, setSort, toggleSort, useData, type Viewer } from './dataStore';
import { parseFilter } from './filter';

function ColumnMenu({ v, col, anchor, onClose }: { v: Viewer; col: number; anchor: DOMRect; onClose: () => void }) {
  const { t } = useTranslation();
  const info = v.info!.columns[col];
  const st = v.stats.get(col);
  const current = v.filters.find((f) => f.col === col);
  const [text, setText] = useState(current?.text ?? '');
  const [invalid, setInvalid] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: Math.min(anchor.bottom + 4, window.innerHeight - r.height - 8), left: Math.max(8, Math.min(anchor.left, window.innerWidth - r.width - 8)) });
    input.current?.focus();
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const apply = () => {
    if (!text.trim()) {
      setFilter(v.id, col, null);
      onClose();
      return;
    }
    const f = parseFilter(text, info.tone, col);
    if (!f) {
      setInvalid(true);
      return;
    }
    setFilter(v.id, col, f);
    onClose();
  };
  const sortBy = (desc: boolean | null) => {
    setSort(v.id, desc === null ? v.sort.filter((s) => s.col !== col) : [{ col, desc }]);
    onClose();
  };
  const hint = info.tone === 'numeric' ? t('data.hintNumeric') : info.tone === 'date' ? t('data.hintDate') : t('data.hintText');

  return createPortal(
    <div ref={ref} className="df-colmenu" role="dialog" aria-label={t('data.columnMenu', { name: info.name })} style={pos}>
      <div className="df-colmenu__head">
        <strong>{info.name}</strong>
        <span className={`df-type-badge df-type-badge--${info.tone}`}>{info.type}</span>
      </div>
      <div className="df-colmenu__row">
        <button className="df-colmenu__btn" onClick={() => sortBy(false)}>
          <ArrowUp size={13} /> {t('data.sortAsc')}
        </button>
        <button className="df-colmenu__btn" onClick={() => sortBy(true)}>
          <ArrowDown size={13} /> {t('data.sortDesc')}
        </button>
        {v.sort.some((s) => s.col === col) && (
          <button className="df-colmenu__btn" onClick={() => sortBy(null)}>
            <X size={13} /> {t('data.sortClear')}
          </button>
        )}
      </div>
      <label className="df-colmenu__label" htmlFor="df-colmenu-filter">
        {t('data.filter')}
      </label>
      <div className={`df-search df-colmenu__input ${invalid ? 'is-invalid' : ''}`}>
        <input
          id="df-colmenu-filter"
          ref={input}
          value={text}
          placeholder={t('data.filterPlaceholder')}
          spellCheck={false}
          aria-invalid={invalid}
          onChange={(e) => (setText(e.target.value), setInvalid(false))}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
        />
      </div>
      <div className="df-colmenu__hint">{invalid ? t('data.invalidFilter') : hint}</div>
      {st && st.na >= 0 && (
        <dl className="df-colmenu__stats">
          {st.min != null && (
            <>
              <dt>{t('data.min')}</dt>
              <dd>{st.min}</dd>
              <dt>{t('data.max')}</dt>
              <dd>{st.max}</dd>
            </>
          )}
          {st.mean != null && (
            <>
              <dt>{t('data.mean')}</dt>
              <dd>{st.mean}</dd>
            </>
          )}
          {st.unique != null && (
            <>
              <dt>{t('data.unique')}</dt>
              <dd>{formatNumber(st.unique)}</dd>
            </>
          )}
          <dt>{t('data.missingShort')}</dt>
          <dd>{formatNumber(st.na)}</dd>
        </dl>
      )}
      {st?.top && st.top.length > 0 && (
        <ul className="df-colmenu__top">
          {st.top.map((x) => (
            <li key={x.value}>
              <button
                onClick={() => {
                  setFilter(v.id, col, { col, op: 'eq', value: x.value, text: `= ${x.value}` });
                  onClose();
                }}
              >
                <span>{x.value}</span>
                <span className="df-colmenu__count">{formatNumber(x.count)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="df-colmenu__actions">
        {current && (
          <button className="df-colmenu__btn" onClick={() => (setFilter(v.id, col, null), onClose())}>
            <FilterX size={13} /> {t('data.removeFilter')}
          </button>
        )}
        <div className="df-panel-toolbar__spacer" />
        <button className="df-btn df-btn--primary df-btn--sm" onClick={apply}>
          {t('data.apply')}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function DataViewerPanel({ params }: { params?: { lang: 'r' | 'python'; name: string; title?: string } }) {
  const { t } = useTranslation();
  const { lang, name, title } = params!;
  const id = viewerId(lang, name);
  useEffect(() => void ensureViewer(lang, name, title), [lang, name, title]);
  const v = useData((s) => s.viewers[id]);
  const [query, setQuery] = useState(v?.search ?? '');
  const [menu, setMenu] = useState<{ col: number; anchor: DOMRect } | null>(null);
  const [range, setRange] = useState({ first: 0, last: 0 });

  useEffect(() => {
    const h = setTimeout(() => setSearch(id, query.trim()), 250);
    return () => clearTimeout(h);
  }, [id, query]);

  const onVisible = useCallback(
    (first: number, last: number, c0: number, c1: number) => {
      setRange({ first, last });
      ensureRows(id, first, last);
      const cols: number[] = [];
      for (let c = c0; c <= c1; c++) cols.push(c);
      void loadStats(id, cols);
    },
    [id],
  );

  if (!v)
    return (
      <div className="df-panel__loading">
        <Spinner size={16} />
      </div>
    );
  const varTitle = v.title.startsWith('@') ? t('data.snapshot') : v.title;

  if (v.error && !v.info) {
    return (
      <div className="df-data">
        <EmptyState icon={Table2} title={v.error === 'missing' ? t('data.goneTitle', { name: varTitle }) : t('data.errorTitle')}>
          {v.error === 'missing' ? t('data.goneBody') : v.error}
        </EmptyState>
      </div>
    );
  }

  const info = v.info;
  const filteredCols = new Set(v.filters.map((f) => f.col));
  const total = v.total ?? info?.rows ?? 0;
  const isFiltered = v.filters.length > 0 || !!v.search;

  return (
    <div className="df-data">
      <div className="df-panel-toolbar df-data__toolbar">
        <Table2 size={14} strokeWidth={1.75} className="df-data__icon" aria-hidden />
        <span className="df-data__title">{varTitle}</span>
        <span className={`df-lang-tag df-lang-tag--${lang}`}>{LANG_LABEL[lang]}</span>
        {info && (
          <span className="df-data__dims">
            {isFiltered && v.total != null ? (
              <>
                <strong>{formatNumber(v.total)}</strong> / {formatDims([info.rows, info.cols])}
              </>
            ) : (
              formatDims([info.rows, info.cols])
            )}
          </span>
        )}
        <div className="df-panel-toolbar__spacer" />
        <div className="df-search df-data__search">
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('data.search')} aria-label={t('data.search')} spellCheck={false} />
          {query && (
            <button className="df-data__clear-search" aria-label={t('data.clearSearch')} onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        {isFiltered || v.sort.length ? (
          <IconButton icon={FilterX} label={t('data.clearAll')} size="sm" onClick={() => (setQuery(''), clearQuery(id))} />
        ) : null}
        <IconButton icon={RefreshCw} label={t('data.refresh')} size="sm" onClick={() => refreshViewer(id)} />
      </div>
      {v.filters.length > 0 && (
        <div className="df-data__chips">
          {v.filters.map((f) => (
            <span key={f.col} className="df-chip">
              <span className="df-chip__col">{info?.columns[f.col]?.name}</span>
              <span className="df-chip__expr">{f.text}</span>
              <button aria-label={t('data.removeFilter')} onClick={() => setFilter(id, f.col, null)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="df-data__grid">
        {info ? (
          <DataGrid
            columns={info.columns}
            total={total}
            rows={info.rows}
            getRow={(i) => rowAt(v, i)}
            onVisible={onVisible}
            stats={v.stats}
            sort={v.sort}
            filteredCols={filteredCols}
            onSort={(c, multi) => toggleSort(id, c, multi)}
            onColumnMenu={(col, anchor) => setMenu({ col, anchor })}
            label={t('data.gridLabel', { name: varTitle })}
          />
        ) : (
          <div className="df-panel__loading">
            <Spinner size={16} />
          </div>
        )}
      </div>
      <div className="df-panel-footer df-data__footer">
        <span>{total > 0 ? t('data.rowsShown', { from: formatNumber(range.first + 1), to: formatNumber(Math.min(range.last + 1, total)), total: formatNumber(total) }) : ' '}</span>
        <span className="df-data__status" aria-live="polite">
          {v.loading ? <Spinner size={11} /> : v.lastQueryMs != null ? t('data.queryTime', { ms: v.lastQueryMs }) : null}
        </span>
      </div>
      {menu && info && <ColumnMenu v={v} col={menu.col} anchor={menu.anchor} onClose={() => setMenu(null)} />}
    </div>
  );
}
