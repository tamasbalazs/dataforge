/**
 * Panel modules. Every panel is a self-contained module: a lazily loaded
 * component plus an `install` hook that wires its store to the bus.
 * Extensions will register panels through the same contract.
 */
import type { LucideIcon } from 'lucide-react';
import { BarChart3, BookOpen, Bug, Puzzle, Users, Cpu, ShieldCheck, Code2, Eye, FileDiff, FolderTree, GitBranch, Package, SquareTerminal, Table2, TerminalSquare, Variable } from 'lucide-react';
import { installGitListeners } from '../git/gitStore';
import { installDebugListeners } from '../debug/debugStore';
import { installExtensions } from '../extensions/bindings';
import { installTerminalListeners } from '../panels/terminal/terminalStore';
import { installPreviewListeners } from '../panels/preview/previewStore';
import { installFilesListeners } from '../panels/files/filesStore';
import { installPackageListeners } from '../panels/packages/packagesStore';
import { installDataListeners } from '../panels/data/dataStore';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { installConsoleListeners } from '../panels/console/consoleStore';
import { installEnvListeners } from '../panels/environment/envStore';
import { installPlotListeners } from '../panels/plots/plotStore';

const loadEditorPanel = () => import('../panels/editor/EditorPanel').then((m) => ({ default: m.EditorPanel }));
const loadConsolePanel = () => import('../panels/console/ConsolePanel').then((m) => ({ default: m.ConsolePanel }));
const loadEnvironmentPanel = () => import('../panels/environment/EnvironmentPanel').then((m) => ({ default: m.EnvironmentPanel }));
const loadPlotsPanel = () => import('../panels/plots/PlotsPanel').then((m) => ({ default: m.PlotsPanel }));
const loadFilesPanel = () => import('../panels/files/FilesPanel').then((m) => ({ default: m.FilesPanel }));
const loadPackagesPanel = () => import('../panels/packages/PackagesPanel').then((m) => ({ default: m.PackagesPanel }));
const loadHelpPanel = () => import('../panels/help/HelpPanel').then((m) => ({ default: m.HelpPanel }));
const loadPreviewPanel = () => import('../panels/preview/PreviewPanel').then((m) => ({ default: m.PreviewPanel }));
const loadGitPanel = () => import('../panels/git/GitPanel').then((m) => ({ default: m.GitPanel }));
const loadDiffPanel = () => import('../panels/git/DiffPanel').then((m) => ({ default: m.DiffPanel }));
const loadTerminalPanel = () => import('../panels/terminal/TerminalPanel').then((m) => ({ default: m.TerminalPanel }));
const loadDebugPanel = () => import('../panels/debug/DebugPanel').then((m) => ({ default: m.DebugPanel }));
const loadReproPanel = () => import('../panels/repro/ReproPanel').then((m) => ({ default: m.ReproPanel }));
const loadExtensionsPanel = () => import('../panels/extensions/ExtensionsPanel').then((m) => ({ default: m.ExtensionsPanel }));
const loadExtPanelView = () => import('../panels/extensions/ExtensionPanelView').then((m) => ({ default: m.ExtensionPanelView }));
const loadJobsPanel = () => import('../panels/jobs/JobsPanel').then((m) => ({ default: m.JobsPanel }));
const loadCollabPanel = () => import('../panels/collab/CollabPanel').then((m) => ({ default: m.CollabPanel }));
const loadDataPanel = () => import('../panels/data/DataViewerPanel').then((m) => ({ default: m.DataViewerPanel }));

/** Start fetching panel code right away; lazy() then resolves without a wait. */
export function preloadPanels() {
  void Promise.all([loadEditorPanel(), loadConsolePanel(), loadEnvironmentPanel(), loadPlotsPanel(), loadDataPanel(), loadFilesPanel(), loadPackagesPanel(), loadHelpPanel(), loadGitPanel()]).catch(() => undefined);
}

export interface PanelModule {
  id: string;
  /** i18n key */
  title: string;
  icon: LucideIcon;
  component: LazyExoticComponent<ComponentType<{ params?: any }>>;
  /** Dynamic panels (one per instance, e.g. data viewers) are not part of layout presets. */
  dynamic?: boolean;
  install?: () => () => void;
  /** Shortcut to focus/reveal the panel. */
  keybinding?: string;
}

export const panelModules: PanelModule[] = [
  {
    id: 'editor',
    title: 'panels.editor',
    icon: Code2,
    component: lazy(() => loadEditorPanel()),
    keybinding: 'Alt+1',
  },
  {
    id: 'console',
    title: 'panels.console',
    icon: TerminalSquare,
    component: lazy(() => loadConsolePanel()),
    install: installConsoleListeners,
    keybinding: 'Alt+2',
  },
  {
    id: 'environment',
    title: 'panels.environment',
    icon: Variable,
    component: lazy(() => loadEnvironmentPanel()),
    install: installEnvListeners,
    keybinding: 'Alt+3',
  },
  {
    id: 'plots',
    title: 'panels.plots',
    icon: BarChart3,
    component: lazy(() => loadPlotsPanel()),
    install: installPlotListeners,
    keybinding: 'Alt+4',
  },
  {
    id: 'files',
    title: 'panels.files',
    icon: FolderTree,
    component: lazy(() => loadFilesPanel()),
    install: installFilesListeners,
    keybinding: 'Alt+5',
  },
  {
    id: 'packages',
    title: 'panels.packages',
    icon: Package,
    component: lazy(() => loadPackagesPanel()),
    install: installPackageListeners,
    keybinding: 'Alt+6',
  },
  {
    id: 'help',
    title: 'panels.help',
    icon: BookOpen,
    component: lazy(() => loadHelpPanel()),
    keybinding: 'Alt+7',
  },
  {
    id: 'data',
    title: 'panels.data',
    icon: Table2,
    component: lazy(() => loadDataPanel()),
    install: installDataListeners,
    dynamic: true,
  },
  {
    id: 'preview',
    title: 'panels.preview',
    icon: Eye,
    component: lazy(() => loadPreviewPanel()),
    install: installPreviewListeners,
  },
  {
    id: 'git',
    title: 'panels.git',
    icon: GitBranch,
    component: lazy(() => loadGitPanel()),
    install: installGitListeners,
    keybinding: 'Alt+8',
  },
  {
    id: 'terminal',
    title: 'panels.terminal',
    icon: SquareTerminal,
    component: lazy(() => loadTerminalPanel()),
    install: installTerminalListeners,
    keybinding: 'Alt+9',
  },
  {
    id: 'diff',
    title: 'panels.diff',
    icon: FileDiff,
    component: lazy(() => loadDiffPanel()),
    dynamic: true,
  },
  {
    id: 'debug',
    title: 'panels.debug',
    icon: Bug,
    component: lazy(() => loadDebugPanel()),
    install: installDebugListeners,
    keybinding: 'Alt+0',
  },
  {
    id: 'repro',
    title: 'panels.repro',
    icon: ShieldCheck,
    component: lazy(() => loadReproPanel()),
  },
  {
    id: 'extensions',
    title: 'panels.extensions',
    icon: Puzzle,
    component: lazy(() => loadExtensionsPanel()),
    install: installExtensions,
  },
  {
    id: 'jobs',
    title: 'panels.jobs',
    icon: Cpu,
    component: lazy(() => loadJobsPanel()),
    install: () => {
      // Lazy: the store (and its polling) loads with the first panel install.
      let off: (() => void) | null = null;
      let gone = false;
      void import('../jobs/jobsStore').then((m) => {
        if (!gone) off = m.installJobsListeners();
      });
      return () => {
        gone = true;
        off?.();
      };
    },
  },
  {
    id: 'collab',
    title: 'panels.collab',
    icon: Users,
    component: lazy(() => loadCollabPanel()),
  },
  {
    id: 'extpanel',
    title: 'panels.extensionPanel',
    icon: Puzzle,
    component: lazy(() => loadExtPanelView()),
    dynamic: true,
  },
];

export const panelById = (id: string) => panelModules.find((p) => p.id === id);

export function installPanelModules(): () => void {
  const offs = panelModules.map((p) => p.install?.() ?? (() => {}));
  return () => offs.forEach((o) => o());
}
