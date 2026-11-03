/** Lazy file tree of the project folder, kept in sync by the host watcher. */
import { create } from 'zustand';
import { host, type FsEntry } from '../../core/host';
import { getSettings, useSettings } from '../../core/settings';
import { isNonLocalPath } from '../../core/paths';

const REMOTE_POLL_MS = 8000;

interface FilesState {
  root: string | null;
  children: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  error: string | null;
  selected: string | null;
  renaming: string | null;
  /** Parent folder where a new entry is being named, plus its kind. */
  creating: { parent: string; dir: boolean } | null;
  showHidden: boolean;
}

export const useFiles = create<FilesState>(() => ({
  root: null,
  children: {},
  expanded: {},
  loading: {},
  error: null,
  selected: null,
  renaming: null,
  creating: null,
  showHidden: false,
}));

const parentOf = (p: string) => p.replace(/[\\/][^\\/]+$/, '');
const EXPANDED_KEY = (root: string) => `dataforge.files.expanded:${root}`;

export async function loadDir(dir: string) {
  useFiles.setState((s) => ({ loading: { ...s.loading, [dir]: true } }));
  try {
    const list = await host().fsList(dir, useFiles.getState().showHidden);
    useFiles.setState((s) => ({ children: { ...s.children, [dir]: list }, error: dir === s.root ? null : s.error }));
  } catch (e) {
    if (dir === useFiles.getState().root) useFiles.setState({ error: String(e) });
  } finally {
    useFiles.setState((s) => ({ loading: { ...s.loading, [dir]: false } }));
  }
}

function persistExpanded() {
  const { root, expanded } = useFiles.getState();
  if (!root) return;
  try {
    localStorage.setItem(EXPANDED_KEY(root), JSON.stringify(Object.keys(expanded).filter((k) => expanded[k])));
  } catch {
    /* ignore */
  }
}

export async function setRoot(root: string | null) {
  let expanded: Record<string, boolean> = {};
  if (root) {
    try {
      for (const p of JSON.parse(localStorage.getItem(EXPANDED_KEY(root)) ?? '[]')) expanded[p] = true;
    } catch {
      expanded = {};
    }
  }
  useFiles.setState({ root, children: {}, expanded, selected: null, renaming: null, creating: null, error: null });
  if (!root) return;
  await loadDir(root);
  await Promise.all(Object.keys(expanded).map((d) => loadDir(d)));
}

export async function toggleDir(dir: string, open?: boolean) {
  const next = open ?? !useFiles.getState().expanded[dir];
  useFiles.setState((s) => ({ expanded: { ...s.expanded, [dir]: next } }));
  persistExpanded();
  if (next && !useFiles.getState().children[dir]) await loadDir(dir);
}

export function collapseAll() {
  useFiles.setState({ expanded: {} });
  persistExpanded();
}

export async function refreshAll() {
  const { root, expanded } = useFiles.getState();
  if (!root) return;
  await Promise.all([root, ...Object.keys(expanded).filter((k) => expanded[k])].map(loadDir));
}

export function toggleHidden() {
  useFiles.setState((s) => ({ showHidden: !s.showHidden }));
  void refreshAll();
}

/** Refresh the folders that contain changed paths. */
export function onPathsChanged(paths: string[]) {
  const { children } = useFiles.getState();
  const dirs = new Set(paths.map(parentOf).filter((d) => d in children));
  for (const p of paths) if (p in children) dirs.add(p);
  dirs.forEach((d) => void loadDir(d));
}

/** Flattened visible rows for rendering and keyboard navigation. */
export function visibleRows(s: Pick<FilesState, 'root' | 'children' | 'expanded'>) {
  const out: Array<{ entry: FsEntry; depth: number }> = [];
  const walk = (dir: string, depth: number) => {
    for (const e of s.children[dir] ?? []) {
      out.push({ entry: e, depth });
      if (e.isDir && s.expanded[e.path]) walk(e.path, depth + 1);
    }
  };
  if (s.root) walk(s.root, 0);
  return out;
}

export function installFilesListeners(): () => void {
  void setRoot(getSettings().workdir);
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.workdir !== prev.workdir) void setRoot(s.workdir);
  });
  const offFs = host().onFsChanged(onPathsChanged);
  // Remote folders have no watcher: refresh on focus and every few seconds
  // while the window is in use (one cheap call per open folder).
  const remoteRefresh = () => {
    if (isNonLocalPath(useFiles.getState().root) && document.visibilityState === 'visible' && document.hasFocus()) void refreshAll();
  };
  window.addEventListener('focus', remoteRefresh);
  const poll = setInterval(remoteRefresh, REMOTE_POLL_MS);
  return () => {
    offSettings();
    offFs();
    window.removeEventListener('focus', remoteRefresh);
    clearInterval(poll);
  };
}
