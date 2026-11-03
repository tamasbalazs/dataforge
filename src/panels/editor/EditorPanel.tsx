import { Cpu, FileCode2, FilePlus2, FolderOpen, Play, PlaySquare, Sparkles, X } from 'lucide-react';

const isLiterateDoc = (d: { path: string | null }) => !!d.path && /\.(qmd|rmd|md)$/i.test(d.path);
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emit } from '../../core/bus';
import { useSettings } from '../../core/settings';
import { useThemeMode } from '../../core/theme';
import { LANG_LABEL, useKernels } from '../../kernels/kernels';
import { Button, IconButton } from '../../ui/Button';
import { EmptyState } from '../../ui/EmptyState';
import { chordLabel, Kbd } from '../../ui/Kbd';
import { Spinner } from '../../ui/Spinner';
import { attachEditor, closeDoc, installChunkLens, installConflictSupport, installDebugSupport, toggleBreakpointAtCursor, EXAMPLES, newFile, openFile, runDocument, runSelectionOrStatement, saveDoc, showDoc } from './editorService';
import { kernelLangFor, setActiveDoc, useEditor, type Doc } from './editorStore';
import { showHelp, topicAt } from '../help/helpStore';
import { StanToolbar } from '../../stan/StanToolbar';
import { bindKey, loadMonaco, themeName, type Monaco } from './monacoSetup';
import type * as M from './monaco';

function LangGlyph({ language }: { language: string }) {
  const label = language === 'r' ? 'R' : language === 'python' ? 'Py' : language === 'markdown' ? 'Md' : language === 'stan' ? 'St' : '··';
  return <span className={`df-lang-glyph df-lang-glyph--${language}`}>{label}</span>;
}

function Tabs({ docs, activeId }: { docs: Doc[]; activeId: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="df-editor__tabs" role="tablist" aria-label={t('editor.openFiles')}>
      {docs.map((d) => (
        <div
          key={d.id}
          role="tab"
          aria-selected={d.id === activeId}
          tabIndex={d.id === activeId ? 0 : -1}
          className={`df-editor__tab ${d.id === activeId ? 'is-active' : ''}`}
          onClick={() => setActiveDoc(d.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setActiveDoc(d.id);
            if (e.key === 'Delete') void closeDoc(d.id);
          }}
          aria-keyshortcuts="Delete"
          onAuxClick={(e) => e.button === 1 && void closeDoc(d.id)}
          title={d.path ?? d.name}
        >
          <LangGlyph language={d.language} />
          <span className="df-editor__tab-name">{d.name}</span>
          {d.dirty && <span className="df-sr-only">{t('editor.unsavedMark')}</span>}
          {/* Mouse target; keyboard users close the focused tab with Delete. */}
          <span
            className={`df-editor__tab-close ${d.dirty ? 'is-dirty' : ''}`}
            aria-hidden
            title={t('editor.close', { name: d.name })}
            onClick={(e) => {
              e.stopPropagation();
              void closeDoc(d.id);
            }}
          >
            <span className="df-editor__dirty-dot" />
            <X size={13} strokeWidth={2} />
          </span>
        </div>
      ))}
    </div>
  );
}

function RunToolbar({ doc }: { doc: Doc }) {
  const { t } = useTranslation();
  const lang = kernelLangFor(doc.language);
  const kernel = useKernels((s) => (lang ? s.kernels[lang] : null));
  if (!lang) return null;
  return (
    <div className="df-editor__toolbar">
      <span className={`df-editor__target ${kernel?.status === 'busy' ? 'is-busy' : ''}`}>
        {kernel?.status === 'busy' || kernel?.status === 'starting' ? <Spinner size={12} /> : <span className={`df-dot df-dot--${kernel?.status}`} />}
        {LANG_LABEL[lang]}
      </span>
      <IconButton icon={Play} label={t('editor.runLine')} shortcut={chordLabel("Mod+Enter")} size="sm" tone="accent" onClick={() => void runSelectionOrStatement()} />
      <IconButton icon={PlaySquare} label={t('editor.runFile')} shortcut={chordLabel("Mod+Shift+Enter")} size="sm" onClick={() => void runDocument()} />
      {lang === 'r' && !isLiterateDoc(doc) && (
        <IconButton icon={Cpu} label={t('jobs.runScriptShort')} size="sm" onClick={() => void import('../../jobs/jobDialog').then((m) => m.openJobDialog({ scriptPath: doc.path }))} />
      )}
    </div>
  );
}

export function EditorPanel() {
  const { t } = useTranslation();
  const docs = useEditor((s) => s.docs);
  const activeId = useEditor((s) => s.activeId);
  const active = docs.find((d) => d.id === activeId) ?? null;
  const mode = useThemeMode((s) => s.mode);
  const fontSize = useSettings((s) => s.editorFontSize);
  const ligatures = useSettings((s) => s.fontLigatures);
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<M.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const hasDocs = docs.length > 0;

  // Create the editor lazily, once there is something to show.
  useEffect(() => {
    if (!hasDocs || editor) return;
    let disposed = false;
    let created: M.editor.IStandaloneCodeEditor | null = null;
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      monacoRef.current = m;
      created = m.editor.create(host.current, {
        model: null,
        theme: themeName(useThemeMode.getState().mode),
        fontFamily: `'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace`,
        fontSize: useSettings.getState().editorFontSize,
        lineHeight: 1.6,
        fontLigatures: useSettings.getState().fontLigatures,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'all',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 12, bottom: 12 },
        bracketPairColorization: { enabled: false },
        guides: { indentation: true, bracketPairs: false },
        stickyScroll: { enabled: false },
        lineNumbersMinChars: 3,
        glyphMargin: true,
        folding: true,
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        fixedOverflowWidgets: true,
        ariaLabel: t('editor.ariaLabel'),
        tabFocusMode: false,
      });
      const KM = m.KeyMod;
      const KC = m.KeyCode;
      bindKey(created, 'editor.runStatement', KM.CtrlCmd | KC.Enter, () => void runSelectionOrStatement());
      bindKey(created, 'editor.runFile', KM.CtrlCmd | KM.Shift | KC.Enter, () => void runDocument());
      bindKey(created, 'editor.save', KM.CtrlCmd | KC.KeyS, () => void saveDoc());
      bindKey(created, 'editor.toggleBreakpoint', KC.F9, () => void toggleBreakpointAtCursor());
      bindKey(created, 'editor.help', KC.F1, () => {
        const model = created!.getModel();
        const pos = created!.getPosition();
        const lang = model ? kernelLangFor(model.getLanguageId()) : null;
        const hit = lang && pos && model ? topicAt(model.getLineContent(pos.lineNumber), pos.column, lang) : null;
        if (lang && hit) showHelp(lang, hit.topic, hit.package);
      });
      created.onDidChangeCursorPosition((e) =>
        emit('editor:cursor', { line: e.position.lineNumber, column: e.position.column, language: created!.getModel()?.getLanguageId() ?? '' }),
      );
      attachEditor(created, m);
      installChunkLens(m);
      installConflictSupport(m, created);
      installDebugSupport(m, created);
      setEditor(created);
    });
    return () => {
      disposed = true;
    };
  }, [hasDocs, editor, t]);

  // Dispose on unmount.
  useEffect(
    () => () => {
      attachEditor(null, null);
    },
    [],
  );
  useEffect(() => {
    if (!hasDocs && editor) {
      editor.dispose();
      attachEditor(null, null);
      setEditor(null);
      emit('editor:cursor', null);
    }
  }, [hasDocs, editor]);

  useEffect(() => {
    if (editor && active) void showDoc(active);
  }, [editor, active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    monacoRef.current?.editor.setTheme(themeName(mode));
  }, [mode, editor]);

  useEffect(() => {
    editor?.updateOptions({ fontSize, fontLigatures: ligatures });
  }, [editor, fontSize, ligatures]);

  return (
    <div className="df-editor">
      {hasDocs ? (
        <>
          <div className="df-editor__header">
            <Tabs docs={docs} activeId={activeId} />
            {active && (active.language === 'stan' ? <StanToolbar doc={active} /> : <RunToolbar doc={active} />)}
          </div>
          <div className="df-editor__body">
            <div ref={host} className="df-editor__monaco" />
            {!editor && (
              <div className="df-editor__loading">
                <Spinner size={16} />
              </div>
            )}
          </div>
        </>
      ) : (
        <EmptyState
          icon={FileCode2}
          title={t('editor.emptyTitle')}
          actions={
            <>
              <div className="df-empty__row">
                <Button icon={FilePlus2} onClick={() => newFile('r')}>
                  {t('editor.newR')}
                </Button>
                <Button icon={FilePlus2} onClick={() => newFile('python')}>
                  {t('editor.newPython')}
                </Button>
                <Button icon={FolderOpen} variant="ghost" onClick={() => void openFile()}>
                  {t('editor.open')}
                </Button>
              </div>
              <div className="df-empty__row">
                <Button icon={Sparkles} variant="ghost" size="sm" onClick={() => newFile('r', EXAMPLES.r)}>
                  {t('editor.exampleR')}
                </Button>
                <Button icon={Sparkles} variant="ghost" size="sm" onClick={() => newFile('python', EXAMPLES.python)}>
                  {t('editor.examplePython')}
                </Button>
              </div>
              <dl className="df-shortcut-list">
                <dt>{t('editor.runLine')}</dt>
                <dd>
                  <Kbd chord="Mod+Enter" />
                </dd>
                <dt>{t('commands.palette')}</dt>
                <dd>
                  <Kbd chord="Mod+Shift+P" />
                </dd>
                <dt>{t('editor.newR')}</dt>
                <dd>
                  <Kbd chord="Mod+Alt+N" />
                </dd>
              </dl>
            </>
          }
        >
          {t('editor.emptyBody')}
        </EmptyState>
      )}
    </div>
  );
}
