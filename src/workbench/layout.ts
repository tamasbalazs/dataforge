/** Workspace layout presets and persistence on top of dockview. */
import type { DockviewApi, SerializedDockview } from 'dockview-react';
import { getSettings, updateSettings, type LayoutPreset } from '../core/settings';
import { closeViewer, viewerId } from '../panels/data/dataStore';
import type { Lang } from '../core/host';
import { panelById } from './panels';
import i18n, { t } from '../core/i18n';

let api: DockviewApi | null = null;
let applying = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let keepViewers = false;

export const getDockApi = () => api;

function add(id: string, position?: Parameters<DockviewApi['addPanel']>[0]['position'], size?: { w?: number; h?: number }) {
  const mod = panelById(id)!;
  return api!.addPanel({
    id,
    component: id,
    tabComponent: 'tab',
    // Dockview uses the title as the tab's accessible name: translate it.
    title: t(mod.title),
    position,
    initialWidth: size?.w,
    initialHeight: size?.h,
  });
}

/** Panel arrangement for each preset (relative sizes depend on window size). */
export function buildPreset(preset: Exclude<LayoutPreset, 'custom'>) {
  if (!api) return;
  // Data viewers are not part of presets; keep them open across layout changes.
  const viewers = api.panels.filter((p) => p.id.startsWith('data:')).map((p) => p.params as { lang: Lang; name: string; title?: string });
  applying = true;
  try {
    keepViewers = true;
    api.clear();
    keepViewers = false;
    const W = api.width || window.innerWidth;
    const H = api.height || window.innerHeight;
    if (preset === 'analysis') {
      // RStudio-like four panes.
      add('editor');
      add('environment', { referencePanel: 'editor', direction: 'right' }, { w: Math.round(W * 0.38) });
      add('console', { referencePanel: 'editor', direction: 'below' }, { h: Math.round(H * 0.42) });
      add('plots', { referencePanel: 'environment', direction: 'below' }, { h: Math.round(H * 0.55) });
      add('files', { referencePanel: 'plots', direction: 'within' });
      add('packages', { referencePanel: 'plots', direction: 'within' });
      add('help', { referencePanel: 'plots', direction: 'within' });
      add('git', { referencePanel: 'environment', direction: 'within' }); // like RStudio's Environment | Git
      add('debug', { referencePanel: 'environment', direction: 'within' });
      add('terminal', { referencePanel: 'console', direction: 'within' });
      api.getPanel('console')?.api.setActive();
      api.getPanel('environment')?.api.setActive();
      api.getPanel('plots')?.api.setActive();
    } else if (preset === 'development') {
      // VS Code-like: big editor, side bar, bottom console.
      add('editor');
      add('environment', { referencePanel: 'editor', direction: 'right' }, { w: Math.round(W * 0.26) });
      add('plots', { referencePanel: 'environment', direction: 'within' });
      add('packages', { referencePanel: 'environment', direction: 'within' });
      add('help', { referencePanel: 'environment', direction: 'within' });
      add('files', { referencePanel: 'editor', direction: 'left' }, { w: Math.round(W * 0.17) });
      add('git', { referencePanel: 'files', direction: 'within' });
      add('debug', { referencePanel: 'files', direction: 'within' });
      add('console', { direction: 'below' }, { h: Math.round(H * 0.3) });
      add('terminal', { referencePanel: 'console', direction: 'within' });
      api.getPanel('console')?.api.setActive();
      api.getPanel('files')?.api.setActive();
      api.getPanel('environment')?.api.setActive();
    } else {
      add('editor');
    }
    for (const v of viewers) openDataViewer(v.lang, v.name, v.title);
    api.getPanel('editor')?.api.setActive();
  } finally {
    applying = false;
    keepViewers = false;
  }
  updateSettings({ layoutPreset: preset });
  saveLayoutSoon();
}

export function applyPreset(preset: LayoutPreset) {
  if (preset === 'custom') {
    const custom = getSettings().layouts.custom as SerializedDockview | undefined;
    if (custom && restore(custom)) updateSettings({ layoutPreset: 'custom' });
    return;
  }
  buildPreset(preset);
}

function restore(state: SerializedDockview): boolean {
  if (!api) return false;
  applying = true;
  try {
    api.fromJSON(state);
    return api.panels.length > 0;
  } catch (e) {
    console.warn('layout restore failed', e);
    return false;
  } finally {
    applying = false;
  }
}

/** Panels added per layout version; saved layouts get them once on upgrade. */
/** Panels introduced after a layout version, with the panel they join. */
const LAYOUT_ADDITIONS: Record<number, Array<[string, string[]]>> = {
  1: [
    ['files', ['plots', 'environment']],
    ['packages', ['plots', 'environment']],
    ['help', ['plots', 'environment']],
  ],
  2: [
    ['git', ['environment', 'files', 'plots']],
    ['terminal', ['console', 'plots', 'environment']],
  ],
  3: [['debug', ['environment', 'files', 'plots']]],
};
export const LAYOUT_VERSION = 3;

function upgradeLayout(from: number) {
  if (!api) return;
  for (let v = from + 1; v <= LAYOUT_VERSION; v++) {
    for (const [id, anchors] of LAYOUT_ADDITIONS[v] ?? []) {
      if (api.getPanel(id)) continue;
      const anchor = anchors.map((p) => api!.getPanel(p)).find(Boolean);
      const active = anchor?.group.activePanel;
      add(id, anchor ? { referencePanel: anchor.id, direction: 'within' } : undefined);
      active?.api.setActive(); // don't steal the visible tab
    }
  }
}

export function initLayout(dock: DockviewApi) {
  api = dock;
  const s = getSettings();
  const saved = s.layouts.current as SerializedDockview | undefined;
  if (saved && restore(saved)) {
    if ((s.layoutVersion ?? 0) < LAYOUT_VERSION) upgradeLayout(s.layoutVersion ?? 0);
  } else buildPreset(s.layoutPreset === 'custom' ? 'analysis' : s.layoutPreset);
  updateSettings({ layoutVersion: LAYOUT_VERSION });
  retitlePanels();
  i18n.on('languageChanged', retitlePanels);
  dock.onDidRemovePanel((p) => {
    if (p.id.startsWith('data:') && !keepViewers) closeViewer(p.id);
  });
  dock.onDidLayoutChange(() => {
    if (!applying) saveLayoutSoon();
  });
}

/** Tab titles (= accessible names) in the current language, also for restored layouts. */
function retitlePanels() {
  for (const p of api?.panels ?? []) {
    const mod = panelById(p.id);
    if (mod && !mod.dynamic) p.api.setTitle(t(mod.title));
  }
}

function saveLayoutSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!api) return;
    updateSettings({ layouts: { ...getSettings().layouts, current: api.toJSON() } });
  }, 400);
}

export function saveCustomLayout() {
  if (!api) return;
  updateSettings({ layouts: { ...getSettings().layouts, custom: api.toJSON() }, layoutPreset: 'custom' });
}

/** Close a panel by id (keyboard: Delete on its tab). */
export function closePanel(id: string) {
  api?.getPanel(id)?.api.close();
}

/** Reveal a panel (re-adding it if it was closed) and focus it. */
export function revealPanel(id: string, opts: { focus?: boolean } = {}) {
  if (!api) return;
  let panel = api.getPanel(id);
  if (!panel && id === 'repro' && api.getPanel('editor')) {
    // A report needs room: a tab next to the documents.
    panel = add(id, { referencePanel: 'editor', direction: 'within' });
  }
  if (!panel && id === 'preview' && api.getPanel('editor')) {
    // Like RStudio's Viewer: the rendered document sits beside its source.
    panel = add(id, { referencePanel: 'editor', direction: 'right' });
  }
  if (!panel) {
    // Side panels go next to their usual neighbours.
    const preferred =
      id === 'terminal' ? ['console'] : ['files', 'packages', 'help', 'plots', 'git'].includes(id) ? ['files', 'plots', 'environment', 'packages', 'help'] : ['environment'];
    const anchor = preferred.map((p) => api!.getPanel(p)).find(Boolean) ?? api.activePanel ?? api.panels[0];
    panel = add(id, anchor ? { referencePanel: anchor.id, direction: anchor.id === 'editor' ? 'right' : 'within' } : undefined);
  }
  panel.api.setActive();
  // The editor focuses Monaco itself when its document changes; focusing the
  // first tab here would let a following Enter switch documents.
  if (id === 'editor' || opts.focus === false) return;
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
    const focusable =
      el?.querySelector<HTMLElement>('[data-console-input] textarea, .df-grid, .df-search input') ??
      el?.querySelector<HTMLElement>('textarea, [tabindex="0"], button, input');
    focusable?.focus();
  });
}

/** Open (or focus) a data viewer tab next to the editor. */
export function openDataViewer(lang: Lang, name: string, title?: string) {
  if (!api) return;
  const id = viewerId(lang, name);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const anchor = api.getPanel('editor') ?? api.activePanel;
  api.addPanel({
    id,
    component: 'data',
    tabComponent: 'tab',
    title: title ?? name,
    params: { module: 'data', lang, name, title: title ?? name },
    position: anchor ? { referencePanel: anchor.id, direction: 'within' } : undefined,
  });
}

export interface DiffSpec {
  /** Path relative to the repository root. */
  path: string;
  /** Revisions: 'HEAD', ':' (index), 'worktree', 'empty' or a commit hash. */
  left: string;
  right: string;
  title: string;
}

/** Open (or focus) a diff tab next to the editor. */
export function openDiff(spec: DiffSpec) {
  if (!api) return;
  const id = `diff:${spec.left}:${spec.right}:${spec.path}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const anchor = api.getPanel('editor') ?? api.activePanel;
  api.addPanel({
    id,
    component: 'diff',
    tabComponent: 'tab',
    title: spec.title,
    params: { module: 'diff', ...spec },
    position: anchor ? { referencePanel: anchor.id, direction: 'within' } : undefined,
  });
}

/** Open (or focus) a panel contributed by an extension, beside the editor. */
export function openExtensionPanel(extId: string, panelId: string, title: string) {
  if (!api) return;
  const id = `ext:${extId}:${panelId}`;
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const editor = api.getPanel('editor');
  api.addPanel({
    id,
    component: 'extpanel',
    tabComponent: 'tab',
    title,
    params: { module: 'extpanel', extId, panelId, title },
    position: editor ? { referencePanel: editor.id, direction: 'right' } : undefined,
  });
}

export function closeExtensionPanels(extId: string) {
  for (const p of api?.panels.filter((x) => x.id.startsWith(`ext:${extId}:`)) ?? []) p.api.close();
}

export function toggleMaximize() {
  const panel = api?.activePanel;
  if (!panel) return;
  if (panel.api.isMaximized()) panel.api.exitMaximized();
  else panel.api.maximize();
}
