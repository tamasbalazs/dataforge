import { ArrowLeft, ArrowRight, BookOpen, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Lang } from '../../core/host';
import { useThemeMode } from '../../core/theme';
import { LANG_LABEL, LANGS } from '../../kernels/kernels';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { Kbd } from '../../ui/Kbd';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { useConsole } from '../console/consoleStore';
import { docBlocks } from './docFormat';
import { goBack, goForward, searchHelp, showHelp, useHelp, type PyHelpPage, type RHelpPage } from './helpStore';
import { openExternalUrl } from './openUrl';

/** Stylesheet for R help, built from the live design tokens. */
function helpCss(): string {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return `
  :root { color-scheme: ${document.documentElement.dataset.theme ?? 'dark'}; }
  body { margin: 0; padding: 14px 20px 40px; background: ${v('--surface-1')}; color: ${v('--text-primary')};
         font: 13px/1.6 ${v('--font-ui')}; -webkit-font-smoothing: antialiased; }
  h2 { font-size: 18px; font-weight: 600; letter-spacing: -0.01em; margin: 6px 0 12px; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: ${v('--text-muted')}; margin: 22px 0 6px; font-weight: 600; }
  a { color: ${v('--accent-text')}; text-decoration: none; } a:hover { text-decoration: underline; }
  code, pre, kbd, samp { font-family: ${v('--font-mono')}; font-size: 12px; }
  code { background: ${v('--surface-3')}; padding: 1px 4px; border-radius: 4px; }
  pre { background: ${v('--surface-2')}; border: 1px solid ${v('--border-subtle')}; padding: 10px 12px; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; } td { padding: 4px 8px 4px 0; vertical-align: top; border-top: 1px solid ${v('--border-subtle')}; }
  td:first-child { white-space: nowrap; font-family: ${v('--font-mono')}; font-size: 12px; color: ${v('--syn-function')}; }
  hr { border: 0; border-top: 1px solid ${v('--border-subtle')}; }
  img { max-width: 100%; }
  table[summary^="R docs"], table:first-of-type[width] { display: none; }
  ::selection { background: ${v('--accent-soft')}; }`;
}

function RPage({ page }: { page: RHelpPage }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const mode = useThemeMode((s) => s.mode);
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${helpCss()}</style></head><body>${page.html ?? ''}</body></html>`;

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onLoad = () => {
      const d = el.contentDocument;
      if (!d) return;
      // Scripts never run (sandbox); links are handled here.
      d.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        const href = a.getAttribute('href') ?? '';
        e.preventDefault();
        if (href.startsWith('#')) {
          d.getElementById(href.slice(1))?.scrollIntoView();
          return;
        }
        const m = href.match(/(?:\.\.\/)*([\w.]+)\/(?:html|help)\/([^/?#]+?)(?:\.html)?$/);
        if (m && m[2] !== '00Index') {
          showHelp('r', decodeURIComponent(m[2]), m[1]);
          return;
        }
        const local = href.match(/^([^/?#]+?)\.html$/);
        if (local) {
          showHelp('r', decodeURIComponent(local[1]), page.package);
          return;
        }
        if (/^https?:\/\//.test(href)) void openExternalUrl(href);
      });
    };
    el.addEventListener('load', onLoad);
    return () => el.removeEventListener('load', onLoad);
  }, [page]);

  return <iframe key={mode} ref={frame} className="df-help__frame" title={page.title ?? page.topic} sandbox="allow-same-origin" srcDoc={doc} />;
}

function PyPage({ page }: { page: PyHelpPage }) {
  const { t } = useTranslation();
  const blocks = docBlocks(page.doc ?? '');
  return (
    <article className="df-help__py">
      <header>
        <span className="df-help__kind">{page.kind}</span>
        <h2>{page.name}</h2>
        {page.module && page.module !== page.name && <span className="df-help__module">{page.module}</span>}
      </header>
      {page.signature && (
        <pre className="df-help__sig">
          <code>
            {page.name}
            {page.signature}
          </code>
        </pre>
      )}
      {blocks.map((b, i) => (b.type === 'heading' ? <h3 key={i}>{b.text}</h3> : <pre key={i} className="df-help__doc">{b.text}</pre>))}
      {!blocks.length && <p className="df-help__muted">{t('help.noDoc')}</p>}
      {!!page.members?.length && (
        <>
          <h3>{t('help.members')}</h3>
          <ul className="df-help__members">
            {page.members.map((m) => (
              <li key={m.name}>
                <button onClick={() => showHelp('python', `${page.topic}.${m.name}`)}>
                  <code>{m.name}</code>
                  <span className="df-help__mkind">{m.kind}</span>
                  <span className="df-help__msum">{m.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}

export function HelpPanel() {
  const { t } = useTranslation();
  const s = useHelp();
  const consoleLang = useConsole((c) => c.active);
  const current = s.history[s.index];
  const [lang, setLang] = useState<Lang>(current?.lang ?? consoleLang);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (current) setLang(current.lang);
  }, [current]);

  const submit = () => {
    const q = query.trim();
    if (!q) return;
    void searchHelp(lang, q);
  };

  const page = s.page;
  return (
    <div className="df-help">
      <div className="df-panel-toolbar">
        <IconButton icon={ArrowLeft} size="sm" label={t('help.back')} disabled={s.index <= 0} onClick={goBack} />
        <IconButton icon={ArrowRight} size="sm" label={t('help.forward')} disabled={s.index >= s.history.length - 1} onClick={goForward} />
        <Segmented size="sm" label={t('help.language')} value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] }))} />
        <div className="df-search df-help__search">
          <Search size={13} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={t('help.search', { lang: LANG_LABEL[lang] })}
            aria-label={t('help.search', { lang: LANG_LABEL[lang] })}
            spellCheck={false}
          />
        </div>
        {(s.loading || s.searching) && <Spinner size={12} label={t('common.loading')} />}
      </div>
      <div className="df-help__body">
        {s.results ? (
          <div className="df-help__results">
            <div className="df-help__results-head">{t('help.results', { count: s.results.hits.length, query: s.results.query })}</div>
            {s.results.hits.length === 0 && <p className="df-help__muted">{t('help.noResults')}</p>}
            <ul>
              {s.results.hits.map((h) => (
                <li key={`${h.package}:${h.topic}`}>
                  <button onClick={() => showHelp(s.results!.lang, h.topic, s.results!.lang === 'r' ? h.package : undefined)}>
                    <code>{h.topic}</code>
                    <span className="df-help__pkg">{h.package}</span>
                    {h.title && <span className="df-help__msum">{h.title}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : s.error ? (
          <EmptyState icon={BookOpen} title={t('help.errorTitle')}>
            {s.error}
          </EmptyState>
        ) : page && !page.found ? (
          <EmptyState icon={BookOpen} title={t('help.notFound', { topic: page.topic })}>
            {t('help.notFoundBody')}
          </EmptyState>
        ) : page && 'choices' in page && page.choices ? (
          <div className="df-help__results">
            <div className="df-help__results-head">{t('help.choose', { topic: page.topic })}</div>
            <ul>
              {page.choices.map((c) => (
                <li key={`${c.package}:${c.topic}`}>
                  <button onClick={() => showHelp('r', c.topic, c.package)}>
                    <code>{c.topic}</code>
                    <span className="df-help__pkg">{c.package}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : page && current?.lang === 'r' ? (
          <RPage page={page as RHelpPage} />
        ) : page ? (
          <PyPage page={page as PyHelpPage} />
        ) : (
          <EmptyState icon={BookOpen} title={t('help.emptyTitle')}>
            <span>{t('help.emptyBody')}</span>
            <span className="df-help__hint">
              <Kbd chord="F1" /> {t('help.f1')}
            </span>
          </EmptyState>
        )}
      </div>
    </div>
  );
}
