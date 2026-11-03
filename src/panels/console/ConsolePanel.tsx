import { BarChart3, Table2, Check, ChevronRight, CircleSlash, Eraser, RotateCcw, Square, TerminalSquare, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emit } from '../../core/bus';
import { openDataViewer } from '../../workbench/layout';
import type { Lang } from '../../core/host';
import { useSettings } from '../../core/settings';
import { useThemeMode } from '../../core/theme';
import { execute, interruptKernel, LANG_LABEL, LANGS, restartKernel, startKernel, useKernels } from '../../kernels/kernels';
import { IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { chordLabel } from '../../ui/Kbd';
import { Segmented } from '../../ui/Segmented';
import { Spinner } from '../../ui/Spinner';
import { bindKey, loadMonaco, themeName, type Monaco } from '../editor/monacoSetup';
import type * as M from '../editor/monaco';
import { applyControls, parseAnsi } from './ansi';
import { clearConsole, pushHistory, setActiveConsole, useConsole, type ConsoleEntry } from './consoleStore';
import { parseHelpRequest, searchHelp, showHelp, topicAt } from '../help/helpStore';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

function Ansi({ text: raw }: { text: string }) {
  const text = useMemo(() => applyControls(raw), [raw]);
  const segs = useMemo(() => parseAnsi(text), [text]);
  if (segs.length === 1 && Object.keys(segs[0]).length === 1) return <>{text}</>;
  return (
    <>
      {segs.map((s, i) => (
        <span
          key={i}
          className={[s.fg && `ansi-fg-${s.fg}`, s.bg && `ansi-bg-${s.bg}`, s.bold && 'ansi-bold', s.dim && 'ansi-dim', s.italic && 'ansi-italic', s.underline && 'ansi-underline']
            .filter(Boolean)
            .join(' ')}
        >
          {s.text}
        </span>
      ))}
    </>
  );
}

function CodeEcho({ code, lang }: { code: string; lang: Lang }) {
  const [html, setHtml] = useState<string | null>(null);
  const mode = useThemeMode((s) => s.mode);
  // Token classes index the theme's colour table: re-colorize when the theme changes.
  const overrides = useThemeMode((s) => s.overrides);
  useEffect(() => {
    let alive = true;
    void loadMonaco()
      .then((m) => m.editor.colorize(code, lang, { tabSize: 2 }))
      .then((h) => alive && setHtml(h));
    return () => {
      alive = false;
    };
  }, [code, lang, mode, overrides]);
  return html ? <code className="df-console__code" dangerouslySetInnerHTML={{ __html: html }} /> : <code className="df-console__code">{code}</code>;
}

function RunStatus({ entry }: { entry: ConsoleEntry }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => performance.now());
  const start = entry.startedAt ?? now;
  useEffect(() => {
    if (entry.status !== 'running') return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [entry.status]);
  if (entry.status === 'running') {
    const elapsed = now - start;
    return (
      <span className="df-run-status is-running" role="status" aria-label={t('console.running')}>
        <Spinner size={12} />
        {elapsed > 800 && <span>{formatDuration(elapsed)}</span>}
      </span>
    );
  }
  const Icon = entry.status === 'ok' ? Check : entry.status === 'aborted' ? CircleSlash : X;
  return (
    <span className={`df-run-status is-${entry.status}`} title={t(`console.status.${entry.status}`)}>
      <Icon size={12} strokeWidth={2.25} aria-hidden />
      {entry.durationMs != null && <span>{formatDuration(entry.durationMs)}</span>}
    </span>
  );
}

const Entry = memo(function Entry({ entry, lang }: { entry: ConsoleEntry; lang: Lang }) {
  const { t } = useTranslation();
  const version = useKernels((s) => s.kernels[lang].version);
  switch (entry.kind) {
    case 'input':
      return (
        <div className={`df-console__entry df-console__input is-${entry.status}`}>
          <ChevronRight className="df-console__prompt" size={14} strokeWidth={2.25} aria-hidden />
          <CodeEcho code={entry.text} lang={lang} />
          {entry.by && <span className="df-console__by" title={entry.by}>{entry.by}</span>}
          <RunStatus entry={entry} />
        </div>
      );
    case 'plot':
      return (
        <div className="df-console__entry">
          <button className="df-console__plot-chip" onClick={() => emit('plots:show', { id: entry.plotId! })}>
            <BarChart3 size={13} strokeWidth={1.75} aria-hidden />
            {t('console.plotChip', { n: entry.text })}
          </button>
        </div>
      );
    case 'view':
      return (
        <div className="df-console__entry">
          <button className="df-console__plot-chip" onClick={() => openDataViewer(lang, entry.plotId!, entry.text)}>
            <Table2 size={13} strokeWidth={1.75} aria-hidden />
            {t('console.viewChip', { name: entry.text })}
          </button>
        </div>
      );
    case 'info':
      return (
        <div className="df-console__entry df-console__info">
          {t('console.ready', { lang: LANG_LABEL[lang], version: version ?? '' })}
        </div>
      );
    default:
      return (
        <pre className={`df-console__entry df-console__out df-console__out--${entry.kind}`}>
          <Ansi text={entry.text} />
        </pre>
      );
  }
});

function ConsoleInput({ lang, focusRef }: { lang: Lang; focusRef: { current: (() => void) | null } }) {
  const { t } = useTranslation();
  const hostEl = useRef<HTMLDivElement>(null);
  const editorRef = useRef<M.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const histIdx = useRef<number | null>(null);
  const draft = useRef('');
  const mode = useThemeMode((s) => s.mode);
  const fontSize = useSettings((s) => s.editorFontSize);

  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((m) => {
      if (disposed || !hostEl.current) return;
      monacoRef.current = m;
      const model = m.editor.createModel('', lang);
      const ed = m.editor.create(hostEl.current, {
        model,
        theme: themeName(useThemeMode.getState().mode),
        fontFamily: `'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace`,
        fontSize: useSettings.getState().editorFontSize,
        lineHeight: 1.6,
        fontLigatures: true,
        lineNumbers: 'off',
        glyphMargin: false,
        folding: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { vertical: 'auto', horizontal: 'hidden', useShadows: false, verticalScrollbarSize: 8 },
        wordWrap: 'on',
        lineDecorationsWidth: 0,
        lineNumbersMinChars: 0,
        padding: { top: 6, bottom: 6 },
        fixedOverflowWidgets: true,
        automaticLayout: true,
        ariaLabel: t('console.inputLabel', { lang: LANG_LABEL[lang] }),
        placeholder: t('console.placeholder', { lang: LANG_LABEL[lang] }),
      });
      editorRef.current = ed;
      focusRef.current = () => ed.focus();
      const KM = m.KeyMod;
      const KC = m.KeyCode;

      const resize = () => {
        const lh = ed.getOption(m.editor.EditorOption.lineHeight);
        const h = Math.min(Math.max(1, model.getLineCount()) * lh + 12, 220);
        if (hostEl.current) hostEl.current.style.height = `${h}px`;
        ed.layout();
      };
      model.onDidChangeContent(resize);
      resize();

      const submit = () => {
        const code = model.getValue();
        if (!code.trim()) return;
        model.setValue('');
        histIdx.current = null;
        // `?topic`, `help(x)`, `x?` open the Help panel instead of printing.
        const help = parseHelpRequest(lang, code);
        if (help) {
          pushHistory(lang, code);
          if (help.search) void searchHelp(lang, help.topic);
          else showHelp(lang, help.topic, help.package);
          return;
        }
        void execute(lang, code);
      };
      const recall = (dir: -1 | 1) => {
        const hist = useConsole.getState().history[lang];
        if (!hist.length) return false;
        if (histIdx.current == null) {
          if (dir === 1) return false;
          draft.current = model.getValue();
          histIdx.current = hist.length;
        }
        const next = histIdx.current + dir;
        if (next < 0) return true;
        if (next >= hist.length) {
          histIdx.current = null;
          model.setValue(draft.current);
        } else {
          histIdx.current = next;
          model.setValue(hist[next]);
        }
        const last = model.getLineCount();
        ed.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
        return true;
      };

      const noSuggest = '!suggestWidgetVisible';
      bindKey(ed, 'console.submit', KC.Enter, submit, noSuggest);
      bindKey(ed, 'console.help', KC.F1, () => {
        const pos = ed.getPosition();
        const hit = pos && topicAt(model.getLineContent(pos.lineNumber), pos.column, lang);
        if (hit) showHelp(lang, hit.topic, hit.package);
      });
      bindKey(ed, 'console.submitCtrl', KM.CtrlCmd | KC.Enter, submit);
      bindKey(ed, 'console.newline', KM.Shift | KC.Enter, () => ed.trigger('keyboard', 'type', { text: '\n' }));
      bindKey(ed, 'console.historyUp', KC.UpArrow, () => {
        if (ed.getPosition()?.lineNumber === 1 && recall(-1)) return;
        ed.trigger('keyboard', 'cursorUp', null);
      }, noSuggest);
      bindKey(ed, 'console.historyDown', KC.DownArrow, () => {
        if (ed.getPosition()?.lineNumber === model.getLineCount() && recall(1)) return;
        ed.trigger('keyboard', 'cursorDown', null);
      }, noSuggest);
      bindKey(ed, 'console.clear', KM.CtrlCmd | KC.KeyL, () => clearConsole(lang));
      bindKey(ed, 'console.clearInput', KC.Escape, () => model.setValue(''), noSuggest);
    });
    return () => {
      disposed = true;
      const ed = editorRef.current;
      ed?.getModel()?.dispose();
      ed?.dispose();
      editorRef.current = null;
    };
  }, [lang, t]);

  useEffect(() => monacoRef.current?.editor.setTheme(themeName(mode)), [mode]);
  useEffect(() => editorRef.current?.updateOptions({ fontSize }), [fontSize]);

  return (
    <div className="df-console__prompt-row" onClick={() => editorRef.current?.focus()}>
      <ChevronRight className="df-console__prompt is-live" size={14} strokeWidth={2.25} aria-hidden />
      <div ref={hostEl} className="df-console__input-editor" data-console-input={lang} />
    </div>
  );
}

export function ConsolePanel() {
  const { t } = useTranslation();
  const active = useConsole((s) => s.active);
  const entries = useConsole((s) => s.entries[active]);
  const kernels = useKernels((s) => s.kernels);
  const kernel = kernels[active];
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const focusInput = useRef<(() => void) | null>(null);

  // Clicking anywhere in the transcript focuses the prompt (unless selecting text).
  const onTranscriptClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, .monaco-editor')) return;
    if (window.getSelection()?.toString()) return;
    focusInput.current?.();
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, active]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const status = kernel.status;
  return (
    <div className="df-console">
      <div className="df-panel-toolbar">
        <Segmented
          size="sm"
          label={t('console.language')}
          value={active}
          onChange={(l) => {
            setActiveConsole(l);
            if (kernels[l].status === 'off') void startKernel(l);
          }}
          options={LANGS.map((l) => ({ value: l, label: LANG_LABEL[l] }))}
        />
        <span className={`df-kernel-pill is-${status}`} role="status" aria-live="polite">
          {status === 'starting' || status === 'busy' ? <Spinner size={11} /> : <span className={`df-dot df-dot--${status}`} />}
          {t(`kernel.status.${status}`)}
          {kernel.version && status !== 'unavailable' && <span className="df-kernel-pill__ver">{kernel.version}</span>}
        </span>
        <div className="df-panel-toolbar__spacer" />
        {status === 'busy' && <IconButton icon={Square} label={t('kernel.interrupt')} size="sm" tone="danger" onClick={() => void interruptKernel(active)} />}
        <IconButton icon={RotateCcw} label={t('kernel.restart')} size="sm" onClick={() => void restartKernel(active)} />
        <IconButton icon={Eraser} label={t('console.clear')} shortcut={chordLabel('Mod+L')} size="sm" onClick={() => clearConsole(active)} />
      </div>
      <div className="df-console__scroll" ref={scroller} onScroll={onScroll} onClick={onTranscriptClick} role="log" aria-label={t('console.output', { lang: LANG_LABEL[active] })}>
        {entries.length === 0 && (status === 'unavailable' || status === 'error') ? (
          <EmptyState icon={TerminalSquare} title={t('console.unavailableTitle', { lang: LANG_LABEL[active] })}>
            {kernel.error}
          </EmptyState>
        ) : (
          entries.map((e) => <Entry key={e.id} entry={e} lang={active} />)
        )}
        {status === 'starting' && (
          <div className="df-console__entry df-console__info">
            <Spinner size={12} /> {t('console.starting', { lang: LANG_LABEL[active] })}
          </div>
        )}
        <ConsoleInput key={active} lang={active} focusRef={focusInput} />
      </div>
    </div>
  );
}
