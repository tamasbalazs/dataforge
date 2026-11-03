import { Columns2, FileCode2, Rows2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '../../core/settings';
import { useThemeMode } from '../../core/theme';
import { fileAt, useGit } from '../../git/gitStore';
import { IconButton } from '../../ui/Button';
import { Spinner } from '../../ui/Spinner';
import type { DiffSpec } from '../../workbench/layout';
import { languageForPath } from '../editor/editorStore';
import { loadMonaco, themeName } from '../editor/monacoSetup';
import type * as M from '../editor/monaco';

/** Read-only side-by-side (or inline) diff of one file between two revisions. */
export function DiffPanel({ params }: { params?: DiffSpec }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<M.editor.IStandaloneDiffEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [sideBySide, setSideBySide] = useState(true);
  const [stats, setStats] = useState<{ added: number; removed: number } | null>(null);
  const mode = useThemeMode((s) => s.mode);
  const fontSize = useSettings((s) => s.editorFontSize);
  const statusVersion = useGit((s) => s.status);

  useEffect(() => {
    let disposed = false;
    let created: M.editor.IStandaloneDiffEditor | null = null;
    void loadMonaco().then((m) => {
      if (disposed || !host.current) return;
      created = m.editor.createDiffEditor(host.current, {
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        theme: themeName(useThemeMode.getState().mode),
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: useSettings.getState().editorFontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderOverviewRuler: true,
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
        ariaLabel: t('git.diffAria', { name: params?.path ?? '' }),
      });
      created.onDidUpdateDiff(() => {
        const changes = created?.getLineChanges() ?? [];
        let added = 0;
        let removed = 0;
        for (const c of changes) {
          if (c.modifiedEndLineNumber >= c.modifiedStartLineNumber && c.modifiedEndLineNumber > 0) added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
          if (c.originalEndLineNumber >= c.originalStartLineNumber && c.originalEndLineNumber > 0) removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
        }
        setStats({ added, removed });
      });
      setEditor(created);
    });
    return () => {
      disposed = true;
      const model = created?.getModel();
      created?.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)load contents; worktree/index sides follow the repository as it changes.
  const live = params && (params.right === 'worktree' || params.right === ':' || params.left === ':');
  useEffect(() => {
    if (!editor || !params) return;
    let cancelled = false;
    void (async () => {
      const m = await loadMonaco();
      const [a, b] = await Promise.all([fileAt(params.left, params.path), fileAt(params.right, params.path)]);
      if (cancelled) return;
      const lang = languageForPath(params.path);
      const old = editor.getModel();
      editor.setModel({ original: m.editor.createModel(a, lang), modified: m.editor.createModel(b, lang) });
      old?.original.dispose();
      old?.modified.dispose();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [editor, params?.path, params?.left, params?.right, live ? statusVersion : null]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => editor?.updateOptions({ renderSideBySide: sideBySide }), [editor, sideBySide]);
  useEffect(() => editor?.updateOptions({ fontSize }), [editor, fontSize]);
  useEffect(() => {
    if (editor) void loadMonaco().then((m) => m.editor.setTheme(themeName(mode)));
  }, [editor, mode]);

  if (!params) return null;
  const label = (rev: string) =>
    rev === 'worktree' ? t('git.rev.worktree') : rev === ':' ? t('git.rev.index') : rev === 'HEAD' ? 'HEAD' : rev === 'empty' ? '∅' : rev.slice(0, 7);

  return (
    <div className="df-diff">
      <div className="df-panel-toolbar">
        <FileCode2 size={14} strokeWidth={1.75} aria-hidden className="df-diff__icon" />
        <span className="df-diff__path" title={params.path}>
          {params.path}
        </span>
        <span className="df-diff__revs">
          {label(params.left)} → {label(params.right)}
        </span>
        {stats && (
          <span className="df-diff__stats" aria-label={t('git.diffStats', stats)}>
            <span className="is-add">+{stats.added}</span> <span className="is-del">−{stats.removed}</span>
          </span>
        )}
        {loading && <Spinner size={12} />}
        <span className="df-panel-toolbar__spacer" />
        <IconButton
          icon={sideBySide ? Rows2 : Columns2}
          size="sm"
          label={sideBySide ? t('git.inlineView') : t('git.sideBySide')}
          onClick={() => setSideBySide((v) => !v)}
        />
      </div>
      <div ref={host} className="df-diff__editor" />
    </div>
  );
}
