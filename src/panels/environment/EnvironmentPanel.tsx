import { FileCode2 } from 'lucide-react';
import { openStanCode, STAN_CLASSES } from '../../stan/stanActions';
import { ArrowLeftRight, Braces, Brush, ChevronRight, Database, FunctionSquare, Hash, Layers, RefreshCw, Search, Table2, Variable as VariableIcon } from 'lucide-react';
import { openDataViewer } from '../../workbench/layout';
import { otherLang, sendToOther } from '../../bridge/bridge';
import { useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../../core/dialog';
import type { Lang } from '../../core/host';
import { LANG_LABEL, LANGS, useKernels } from '../../kernels/kernels';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { useConsole } from '../console/consoleStore';
import { clearEnv, formatBytes, formatDims, refreshEnv, useEnv, type Variable, type VarKind } from './envStore';

const KIND_ORDER: VarKind[] = ['data', 'value', 'list', 'function', 'environment'];
const KIND_ICON: Record<VarKind, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  data: Database,
  value: Hash,
  list: Braces,
  function: FunctionSquare,
  environment: Layers,
};

/** Colour class for a variable's type badge (numeric, text, logical, …). */
export function typeTone(v: Pick<Variable, 'type' | 'kind'>): string {
  const ty = v.type.toLowerCase();
  if (v.kind === 'data') return 'data';
  if (v.kind === 'function') return 'function';
  if (/^(numeric|integer|double|int|float|complex|int64|float64|number)/.test(ty)) return 'numeric';
  if (/^(character|str|string)/.test(ty)) return 'text';
  if (/^(logical|bool)/.test(ty)) return 'logical';
  if (/^(factor|category)/.test(ty)) return 'factor';
  if (/(date|time|posix)/.test(ty)) return 'date';
  return 'list';
}

function VarRow({ v, changed, lang }: { v: Variable; changed: boolean; lang: Lang }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const tone = typeTone(v);
  const viewable = v.kind === 'data';
  const transferable = v.kind === 'data' || v.kind === 'value' || v.kind === 'list';
  return (
    <li className={`df-env__row ${changed ? 'is-changed' : ''} ${open ? 'is-open' : ''}`}>
      <div className="df-env__actions">
        {transferable && (
          <button
            className="df-env__act df-env__act--bridge"
            aria-label={t('bridge.sendTo', { lang: LANG_LABEL[otherLang(lang)] })}
            data-tooltip={t('bridge.sendTo', { lang: LANG_LABEL[otherLang(lang)] })}
            onClick={() => void sendToOther(lang, v.name)}
          >
            <ArrowLeftRight size={13} strokeWidth={1.8} />
          </button>
        )}
        {lang === 'r' && STAN_CLASSES.test(v.type) && (
          <button className="df-env__act" aria-label={t('stan.openCode', { name: v.name })} data-tooltip={t('stan.openCode', { name: v.name })} onClick={() => void openStanCode(v.name)}>
            <FileCode2 size={13} strokeWidth={1.8} />
          </button>
        )}
        {viewable && (
          <button className="df-env__act" aria-label={t('data.open', { name: v.name })} data-tooltip={t('data.open', { name: v.name })} onClick={() => openDataViewer(lang, v.name)}>
            <Table2 size={13} strokeWidth={1.8} />
          </button>
        )}
      </div>
      <button
        className="df-env__row-main"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => viewable && openDataViewer(lang, v.name)}
      >
        <ChevronRight className="df-env__chev" size={12} strokeWidth={2} aria-hidden />
        <span className="df-env__name">{v.name}</span>
        <span className={`df-type-badge df-type-badge--${tone}`}>{v.type}</span>
        <span className="df-env__dims">{formatDims(v.dims)}</span>
        <span className="df-env__size">{formatBytes(v.size)}</span>
      </button>
      <div className="df-env__preview" title={v.preview}>
        {v.preview}
      </div>
    </li>
  );
}

export function EnvironmentPanel() {
  const { t } = useTranslation();
  const consoleLang = useConsole((s) => s.active);
  const [pinned, setPinned] = useState<Lang | null>(null);
  const lang = pinned ?? consoleLang;
  const vars = useEnv((s) => s.vars[lang]);
  const loading = useEnv((s) => s.loading[lang]);
  const changed = useEnv((s) => s.changed[lang]);
  const status = useKernels((s) => s.kernels[lang].status);
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? vars.filter((v) => v.name.toLowerCase().includes(q) || v.type.toLowerCase().includes(q)) : vars;
    return KIND_ORDER.map((k) => ({ kind: k, items: filtered.filter((v) => v.kind === k) })).filter((g) => g.items.length);
  }, [vars, query]);

  const total = useMemo(() => vars.reduce((acc, v) => acc + (v.size ?? 0), 0), [vars]);
  const running = status === 'idle' || status === 'busy';

  const onClear = async () => {
    const ok = await ask(t('env.clearTitle', { lang: LANG_LABEL[lang] }), t('env.clearBody'), [
      { id: 'clear', label: t('env.clear'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (ok === 'clear') await clearEnv(lang);
  };

  return (
    <div className="df-env">
      <div className="df-panel-toolbar">
        <Segmented
          size="sm"
          label={t('env.language')}
          value={lang}
          onChange={(l) => setPinned(l)}
          options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] }))}
        />
        <div className="df-panel-toolbar__spacer" />
        {loading && <Spinner size={12} label={t('common.loading')} />}
        <IconButton icon={RefreshCw} label={t('env.refresh')} size="sm" disabled={!running} onClick={() => void refreshEnv(lang)} />
        <IconButton icon={Brush} label={t('env.clear')} size="sm" disabled={!running || !vars.length} onClick={() => void onClear()} />
      </div>
      {vars.length > 0 && (
        <div className="df-search">
          <Search size={13} strokeWidth={1.75} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('env.search')} aria-label={t('env.search')} spellCheck={false} />
        </div>
      )}
      <div className="df-env__scroll">
        {vars.length === 0 ? (
          <EmptyState icon={VariableIcon} title={t('env.emptyTitle')}>
            {status === 'unavailable' ? t('env.noKernel', { lang: LANG_LABEL[lang] }) : t('env.emptyBody', { lang: LANG_LABEL[lang] })}
          </EmptyState>
        ) : groups.length === 0 ? (
          <div className="df-env__nomatch">{t('env.noMatch', { query })}</div>
        ) : (
          groups.map((g) => {
            const Icon = KIND_ICON[g.kind];
            return (
              <section key={g.kind} className="df-env__group" aria-label={t(`env.kind.${g.kind}`)}>
                <h3 className="df-env__group-title">
                  <Icon size={12} strokeWidth={2} />
                  {t(`env.kind.${g.kind}`)}
                  <span className="df-env__count">{g.items.length}</span>
                </h3>
                <ul>
                  {g.items.map((v) => (
                    <VarRow key={v.name} v={v} lang={lang} changed={changed.includes(v.name)} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
      {vars.length > 0 && (
        <div className="df-panel-footer">
          {t('env.summary', { count: vars.length, size: formatBytes(total) })}
        </div>
      )}
    </div>
  );
}
