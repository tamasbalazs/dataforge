import { isCollabPath } from '../../core/paths';
import { useCollab } from '../../collab/collabStore';
import {
  ChevronRight,
  ChevronsDownUp,
  Copy,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileCode2,
  Sigma,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Image,
  Pencil,
  RefreshCw,
  Settings2,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ask } from '../../core/dialog';
import { host, type FsEntry, type Lang } from '../../core/host';
import { formatNumber } from '../../core/format';
import { toast } from '../../core/toast';
import { execute, LANG_LABEL } from '../../kernels/kernels';
import { openProjectDialog } from '../../project/project';
import { Button, IconButton } from '../../ui/Button';
import { ContextMenu } from '../../ui/ContextMenu';
import { EmptyState } from '../../ui/EmptyState';
import type { MenuItem } from '../../ui/Menu';
import { Spinner } from '../../ui/Spinner';
import { useConsole } from '../console/consoleStore';
import { openFile } from '../editor/editorService';
import { canImport, fileKind, importCode, isEditable } from './fileTypes';
import { collapseAll, loadDir, refreshAll, toggleDir, toggleHidden, useFiles, visibleRows } from './filesStore';
import { revealPanel } from '../../workbench/layout';

const ICONS = { r: FileCode2, python: FileCode2, stan: Sigma, markdown: FileText, data: Database, image: Image, pdf: FileText, config: Settings2, text: FileText, other: File };

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

async function importInto(lang: Lang, path: string) {
  const code = importCode(lang, path, useFiles.getState().root);
  if (!code) return;
  revealPanel('console');
  await execute(lang, code);
}

/** Default action for a file: edit text, import data, otherwise the system app. */
async function openEntry(e: FsEntry) {
  if (e.isDir) return toggleDir(e.path);
  if (isEditable(e.name)) {
    await openFile(e.path);
    revealPanel('editor');
    return;
  }
  if (fileKind(e.name) === 'data') {
    const lang = useConsole.getState().active;
    if (canImport(lang, e.name)) return importInto(lang, e.path);
    const other: Lang = lang === 'r' ? 'python' : 'r';
    if (canImport(other, e.name)) return importInto(other, e.path);
  }
  await host().fsOpenExternal(e.path).catch((err) => toast({ kind: 'error', title: String(err) }));
}

function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="df-files__rename"
      value={v}
      spellCheck={false}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v.trim() && v !== initial ? v.trim() : null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v.trim() && v !== initial ? v.trim() : null);
        if (e.key === 'Escape') onDone(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

export function FilesPanel() {
  const { t } = useTranslation();
  const s = useFiles();
  const rows = useMemo(() => visibleRows(s), [s.root, s.children, s.expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null);
  const tree = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tree.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [s.selected]);

  if (!s.root) {
    return (
      <div className="df-files">
        <EmptyState
          icon={FolderOpen}
          title={t('files.noProjectTitle')}
          actions={
            <Button icon={FolderOpen} variant="primary" onClick={() => void openProjectDialog()}>
              {t('project.open')}
            </Button>
          }
        >
          {t('files.noProjectBody')}
        </EmptyState>
      </div>
    );
  }

  const select = (p: string | null) => useFiles.setState({ selected: p });
  const selectedEntry = rows.find((r) => r.entry.path === s.selected)?.entry ?? null;
  const targetDir = (e: FsEntry | null) => (e ? (e.isDir ? e.path : e.path.replace(/[\\/][^\\/]+$/, '')) : s.root!);

  const startCreate = (dir: boolean, from: FsEntry | null = selectedEntry) => {
    const parent = targetDir(from);
    if (parent !== s.root) void toggleDir(parent, true);
    useFiles.setState({ creating: { parent, dir } });
  };
  const finishCreate = async (name: string | null) => {
    const c = useFiles.getState().creating;
    useFiles.setState({ creating: null });
    if (!c || !name) return;
    try {
      const p = await host().fsCreate(c.parent, name, c.dir);
      await loadDir(c.parent);
      select(p);
      if (!c.dir && isEditable(name)) {
        await openFile(p);
        revealPanel('editor');
      }
    } catch (e) {
      toast({ kind: 'error', title: t('files.createFailed'), detail: String(e) });
    }
  };
  const finishRename = async (entry: FsEntry, name: string | null) => {
    useFiles.setState({ renaming: null });
    if (!name) return;
    try {
      const p = await host().fsRename(entry.path, name);
      await loadDir(entry.path.replace(/[\\/][^\\/]+$/, ''));
      select(p);
    } catch (e) {
      toast({ kind: 'error', title: t('files.renameFailed'), detail: String(e) });
    }
  };
  const remove = async (entry: FsEntry) => {
    const ok = await ask(t('files.deleteTitle', { name: entry.name }), t('files.deleteBody'), [
      { id: 'delete', label: t('files.moveToTrash'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (ok !== 'delete') return;
    try {
      await host().fsTrash(entry.path);
      await loadDir(entry.path.replace(/[\\/][^\\/]+$/, ''));
    } catch (e) {
      toast({ kind: 'error', title: t('files.deleteFailed'), detail: String(e) });
    }
  };

  const itemsFor = (e: FsEntry | null): MenuItem[] => {
    const items: MenuItem[] = [];
    if (e && !e.isDir) {
      items.push({ id: 'open', label: t('files.open'), icon: FileText, onSelect: () => void openEntry(e) });
      for (const lang of ['r', 'python'] as Lang[]) {
        if (fileKind(e.name) === 'data' && canImport(lang, e.name)) {
          items.push({ id: `imp-${lang}`, label: t('files.importInto', { lang: LANG_LABEL[lang] }), icon: Database, onSelect: () => void importInto(lang, e.path) });
        }
      }
      items.push({ id: 'ext', label: t('files.openExternal'), icon: ExternalLink, onSelect: () => void host().fsOpenExternal(e.path) });
      items.push({ type: 'separator', id: 's0' });
    }
    items.push(
      { id: 'newfile', label: t('files.newFile'), icon: FilePlus2, onSelect: () => startCreate(false, e) },
      { id: 'newdir', label: t('files.newFolder'), icon: FolderPlus, onSelect: () => startCreate(true, e) },
    );
    if (e) {
      items.push(
        { type: 'separator', id: 's1' },
        { id: 'rename', label: t('files.rename'), icon: Pencil, shortcut: 'F2', onSelect: () => useFiles.setState({ renaming: e.path }) },
        { id: 'copy', label: t('files.copyPath'), icon: Copy, onSelect: () => void navigator.clipboard.writeText(e.path) },
        { id: 'reveal', label: t('files.reveal'), icon: FolderOpen, onSelect: () => void host().fsReveal(e.path) },
        { type: 'separator', id: 's2' },
        { id: 'delete', label: t('files.moveToTrash'), icon: Trash2, danger: true, shortcut: 'Delete', onSelect: () => void remove(e) },
      );
    }
    return items;
  };

  const onKey = (ev: KeyboardEvent) => {
    if (s.renaming || s.creating) return;
    const idx = rows.findIndex((r) => r.entry.path === s.selected);
    const cur = rows[idx]?.entry;
    switch (ev.key) {
      case 'ArrowDown':
        select(rows[Math.min(rows.length - 1, idx + 1)]?.entry.path ?? null);
        break;
      case 'ArrowUp':
        select(rows[Math.max(0, idx - 1)]?.entry.path ?? null);
        break;
      case 'ArrowRight':
        if (cur?.isDir) {
          if (!s.expanded[cur.path]) void toggleDir(cur.path, true);
          else select(rows[idx + 1]?.entry.path ?? cur.path);
        }
        break;
      case 'ArrowLeft':
        if (cur?.isDir && s.expanded[cur.path]) void toggleDir(cur.path, false);
        else {
          const parent = cur?.path.replace(/[\\/][^\\/]+$/, '');
          if (parent && parent !== s.root) select(parent);
        }
        break;
      case 'Enter':
        if (cur) void openEntry(cur);
        break;
      case 'F2':
        if (cur) useFiles.setState({ renaming: cur.path });
        break;
      case 'Delete':
        if (cur) void remove(cur);
        break;
      case 'ContextMenu':
      case 'F10': {
        if (ev.key === 'F10' && !ev.shiftKey) return;
        const el = tree.current?.querySelector('[aria-selected="true"]')?.getBoundingClientRect();
        setMenu({ x: el ? el.left + 24 : 40, y: el ? el.bottom : 40, entry: cur ?? null });
        break;
      }
      default:
        return;
    }
    ev.preventDefault();
  };

  const onContext = (ev: MouseEvent, e: FsEntry | null) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (e) select(e.path);
    setMenu({ x: ev.clientX, y: ev.clientY, entry: e });
  };

  const creatingRow = (parent: string, depth: number) =>
    s.creating?.parent === parent ? (
      <div className="df-files__row is-creating" style={{ paddingLeft: 10 + depth * 14 }}>
        <span className="df-files__chev" />
        {s.creating.dir ? <Folder size={14} className="df-files__icon is-dir" /> : <File size={14} className="df-files__icon" />}
        <NameInput initial="" onDone={(n) => void finishCreate(n)} />
      </div>
    ) : null;

  return (
    <div className="df-files">
      <div className="df-panel-toolbar">
        <span className="df-files__root" title={s.root}>
          {isCollabPath(s.root) ? (useCollab.getState().project ?? '') : s.root.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <div className="df-panel-toolbar__spacer" />
        <IconButton icon={FilePlus2} size="sm" label={t('files.newFile')} onClick={() => startCreate(false)} />
        <IconButton icon={FolderPlus} size="sm" label={t('files.newFolder')} onClick={() => startCreate(true)} />
        <IconButton icon={s.showHidden ? EyeOff : Eye} size="sm" label={s.showHidden ? t('files.hideHidden') : t('files.showHidden')} onClick={toggleHidden} active={s.showHidden} />
        <IconButton icon={ChevronsDownUp} size="sm" label={t('files.collapseAll')} onClick={collapseAll} />
        <IconButton icon={RefreshCw} size="sm" label={t('files.refresh')} onClick={() => void refreshAll()} />
      </div>
      <div
        className="df-files__tree"
        role="tree"
        aria-label={t('files.treeLabel')}
        tabIndex={0}
        ref={tree}
        onKeyDown={onKey}
        onFocus={() => !s.selected && rows[0] && select(rows[0].entry.path)}
        onContextMenu={(e) => onContext(e, null)}
      >
        {s.error && <div className="df-files__error">{s.error}</div>}
        {creatingRow(s.root, 0)}
        {rows.map(({ entry: e, depth }) => {
          const kind = fileKind(e.name);
          const Icon = e.isDir ? (s.expanded[e.path] ? FolderOpen : Folder) : ICONS[kind];
          const selected = s.selected === e.path;
          return (
            <div key={e.path} role="none">
              <div
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={e.isDir ? !!s.expanded[e.path] : undefined}
                aria-selected={selected}
                className={`df-files__row ${selected ? 'is-selected' : ''} ${e.hidden ? 'is-hidden' : ''}`}
                style={{ paddingLeft: 10 + depth * 14 }}
                title={e.isDir ? e.name : `${e.name} · ${formatSize(e.size)}${e.modified ? ` · ${new Date(e.modified).toLocaleString()}` : ''}`}
                onClick={() => {
                  select(e.path);
                  if (e.isDir) void toggleDir(e.path);
                }}
                onDoubleClick={() => !e.isDir && void openEntry(e)}
                onContextMenu={(ev) => onContext(ev, e)}
              >
                <span className="df-files__chev">
                  {e.isDir && (s.loading[e.path] ? <Spinner size={10} /> : <ChevronRight size={12} className={s.expanded[e.path] ? 'is-open' : ''} />)}
                </span>
                <Icon size={14} strokeWidth={1.75} className={`df-files__icon is-${e.isDir ? 'dir' : kind}`} aria-hidden />
                {s.renaming === e.path ? (
                  <NameInput initial={e.name} onDone={(n) => void finishRename(e, n)} />
                ) : (
                  <span className="df-files__name">{e.name}</span>
                )}
                {!e.isDir && <span className="df-files__size">{formatSize(e.size)}</span>}
              </div>
              {e.isDir && s.expanded[e.path] && creatingRow(e.path, depth + 1)}
            </div>
          );
        })}
        {rows.length === 0 && !s.loading[s.root] && !s.creating && <div className="df-files__empty">{t('files.emptyFolder')}</div>}
      </div>
      <div className="df-panel-footer">{t('files.summary', { count: rows.filter((r) => !r.entry.isDir).length, n: formatNumber(rows.filter((r) => !r.entry.isDir).length) })}</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={itemsFor(menu.entry)} onClose={() => setMenu(null)} label={t('files.menuLabel')} />}
    </div>
  );
}
