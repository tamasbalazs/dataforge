/** Built-in commands: everything reachable from the palette and shortcuts. */
import { registerCommands, openPalette, type Command } from '../core/commands';
import { on } from '../core/bus';
import { getSettings, UI_SCALES, updateSettings, useSettings } from '../core/settings';
import { cycleTheme } from '../core/theme';
import { toast } from '../core/toast';
import { t } from '../core/i18n';
import { interruptKernel, LANG_LABEL, LANGS, restartKernel, useKernels } from '../kernels/kernels';
import { clearConsole, setActiveConsole, useConsole, VIEW_MIME } from '../panels/console/consoleStore';
import { closeDoc, newFile, openFile, runAllChunks, toggleBreakpointAtCursor, runDocument, runSelectionOrStatement, saveDoc } from '../panels/editor/editorService';
import { previewActiveDoc } from '../panels/preview/previewStore';
import { addDevFolder, installFromPackage, loadExtensions } from '../extensions/extensionHost';
import { exportCurrentTheme, importThemeFromFile } from '../themes/themeStore';
import { useThemeMode } from '../core/theme';
import { clearAllBreakpoints, motion, startDebugging, stopDebugging, useDebug } from '../debug/debugStore';
import { commit as gitCommit, fetchAll, initRepo, pull as gitPull, push as gitPush, stageAll, sync as gitSync, useGit } from '../git/gitStore';
import { newTerminal, useTerminals, focusTerminal } from '../panels/terminal/terminalStore';

/** Ctrl+`: show and focus the terminal, or go back to the editor when it has focus. */
function toggleTerminal() {
  const inTerminal = !!(document.activeElement as Element | null)?.closest?.('.xterm');
  if (inTerminal) {
    revealPanel('editor');
    return;
  }
  revealPanel('terminal', { focus: false });
  const id = useTerminals.getState().active;
  if (id) requestAnimationFrame(() => focusTerminal(id));
}
import { activeDoc } from '../panels/editor/editorStore';
import { clearPlots, showPlotById } from '../panels/plots/plotStore';
import { applyPreset, openDataViewer, revealPanel, saveCustomLayout, toggleMaximize } from '../workbench/layout';
import { panelModules } from '../workbench/panels';
import { useUi } from './uiStore';
import { openProject, openProjectDialog, projectName, recentProjects } from '../project/project';
import { inSession, useCollab } from '../collab/collabStore';
import { currentRemote, disconnect as remoteDisconnect, openRemoteFolder, profileLabel } from '../remote/remoteStore';

export function stepScale(dir: 1 | -1) {
  const cur = getSettings().uiScale;
  const idx = UI_SCALES.findIndex((s) => Math.abs(s - cur) < 0.001);
  const next = UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, (idx < 0 ? 2 : idx) + dir))];
  updateSettings({ uiScale: next });
}

export const chooseWorkdir = openProjectDialog;

export function installAppCommands(): () => void {
  const hasDoc = () => activeDoc() !== null;
  const cmds: Command[] = [
    { id: 'palette.open', title: 'commands.palette', category: 'categories.general', keybinding: 'Mod+Shift+P', run: openPalette },
    // Files
    { id: 'file.newR', title: 'commands.newR', category: 'categories.file', keybinding: 'Mod+Alt+N', run: () => (newFile('r'), revealPanel('editor')) },
    { id: 'file.newPython', title: 'commands.newPython', category: 'categories.file', keybinding: 'Mod+Alt+Shift+N', run: () => (newFile('python'), revealPanel('editor')) },
    { id: 'file.newStan', title: 'commands.newStan', category: 'categories.file', run: () => void import('../stan/language').then((m) => (newFile('stan', m.STAN_TEMPLATE), revealPanel('editor'))) },
    { id: 'stan.format', title: 'commands.stanFormat', category: 'categories.stan', run: () => void import('../stan/stanActions').then((m) => m.formatStan()), when: () => activeDoc()?.language === 'stan' },
    { id: 'stan.dataTemplate', title: 'commands.stanDataTemplate', category: 'categories.stan', run: () => void import('../stan/stanActions').then((m) => m.copyDataTemplate()), when: () => activeDoc()?.language === 'stan' },
    { id: 'stan.compile', title: 'commands.stanCompile', category: 'categories.stan', run: () => void import('../stan/stanActions').then((m) => m.compileWithCmdstanr()), when: () => activeDoc()?.language === 'stan' },
    { id: 'jobs.panel', title: 'commands.jobsPanel', category: 'categories.stan', keybinding: 'Mod+Alt+J', run: () => revealPanel('jobs') },
    {
      id: 'jobs.run',
      title: 'commands.jobsRun',
      category: 'categories.stan',
      run: () => void import('../jobs/jobDialog').then((m) => m.openJobDialog(activeDoc()?.language === 'stan' ? { stanFile: activeDoc()?.path } : { scriptPath: activeDoc()?.path })),
      when: () => ['r', 'stan'].includes(activeDoc()?.language ?? ''),
    },
    { id: 'stan.pedantic', title: 'commands.stanPedantic', category: 'categories.stan', run: () => void import('../stan/stanActions').then((m) => m.togglePedantic()) },
    { id: 'file.open', title: 'commands.open', category: 'categories.file', keybinding: 'Mod+O', run: () => openFile().then(() => revealPanel('editor')) },
    { id: 'file.save', title: 'commands.save', category: 'categories.file', keybinding: 'Mod+S', run: () => void saveDoc(), when: hasDoc },
    { id: 'file.saveAs', title: 'commands.saveAs', category: 'categories.file', keybinding: 'Mod+Shift+S', run: () => void saveDoc(undefined, true), when: hasDoc },
    { id: 'file.close', title: 'commands.close', category: 'categories.file', keybinding: 'Mod+W', run: () => void closeDoc(), when: hasDoc },
    { id: 'project.open', title: 'project.open', category: 'categories.project', keybinding: 'Mod+Alt+O', run: openProjectDialog },
    { id: 'remote.connect', title: 'commands.remoteConnect', category: 'categories.project', keybinding: 'Mod+Alt+K', run: () => useUi.setState({ remoteOpen: true }) },
    {
      id: 'remote.disconnect',
      title: 'commands.remoteDisconnect',
      category: 'categories.project',
      run: () => {
        const r = currentRemote();
        if (r) void remoteDisconnect(r.id);
      },
      when: () => currentRemote()?.conn?.status === 'connected',
    },
    { id: 'collab.share', title: 'commands.collabShare', category: 'categories.collab', keybinding: 'Mod+Alt+L', run: () => useUi.setState({ collabDialog: 'host' }), when: () => !inSession() },
    { id: 'collab.join', title: 'commands.collabJoin', category: 'categories.collab', run: () => useUi.setState({ collabDialog: 'join' }), when: () => !inSession() },
    { id: 'collab.panel', title: 'commands.collabPanel', category: 'categories.collab', run: () => revealPanel('collab') },
    {
      id: 'collab.copyInvite',
      title: 'commands.collabCopyInvite',
      category: 'categories.collab',
      run: () => {
        const inv = useCollab.getState().invitation;
        if (inv) void navigator.clipboard.writeText(inv).then(() => toast({ kind: 'success', title: t('collab.inviteCopied') }));
      },
      when: () => !!useCollab.getState().invitation,
    },
    { id: 'collab.end', title: 'commands.collabEnd', category: 'categories.collab', run: () => void import('../collab/collab').then((m) => m.endSession()), when: inSession },
    { id: 'project.close', title: 'project.close', category: 'categories.project', run: () => void openProject(null), when: () => !!getSettings().workdir },
    { id: 'terminal.toggle', title: 'commands.terminalToggle', category: 'categories.view', keybinding: 'Mod+`', run: toggleTerminal },
    { id: 'terminal.new', title: 'commands.terminalNew', category: 'categories.view', keybinding: 'Mod+Shift+`', run: () => (newTerminal(), revealPanel('terminal')) },
    { id: 'git.focus', title: 'commands.gitFocus', category: 'categories.git', keybinding: 'Mod+Shift+G', run: () => revealPanel('git') },
    { id: 'git.commit', title: 'commands.gitCommit', category: 'categories.git', run: () => void gitCommit(), when: () => !!useGit.getState().root },
    { id: 'git.sync', title: 'commands.gitSync', category: 'categories.git', run: () => void gitSync(), when: () => !!useGit.getState().root },
    { id: 'git.pull', title: 'commands.gitPull', category: 'categories.git', run: () => void gitPull(), when: () => !!useGit.getState().status?.upstream },
    { id: 'git.push', title: 'commands.gitPush', category: 'categories.git', run: () => void gitPush(), when: () => !!useGit.getState().status?.upstream },
    { id: 'git.fetch', title: 'commands.gitFetch', category: 'categories.git', run: () => void fetchAll(), when: () => !!useGit.getState().root },
    { id: 'git.stageAll', title: 'commands.gitStageAll', category: 'categories.git', run: () => void stageAll(), when: () => !!useGit.getState().root },
    { id: 'git.init', title: 'commands.gitInit', category: 'categories.git', run: () => void initRepo(), when: () => !!getSettings().workdir && !useGit.getState().root },
    { id: 'debug.start', title: 'commands.debugStart', category: 'categories.debug', keybinding: 'F5', run: () => void startDebugging(activeDoc()?.path ?? null) },
    { id: 'debug.stop', title: 'commands.debugStop', category: 'categories.debug', keybinding: 'Shift+F5', run: () => void stopDebugging(), when: () => useDebug.getState().state !== 'idle' },
    { id: 'debug.next', title: 'commands.debugNext', category: 'categories.debug', keybinding: 'F10', run: () => void motion('next'), when: () => useDebug.getState().state === 'paused' },
    { id: 'debug.stepIn', title: 'commands.debugStepIn', category: 'categories.debug', keybinding: 'F11', run: () => void motion('stepIn'), when: () => useDebug.getState().state === 'paused' },
    { id: 'debug.stepOut', title: 'commands.debugStepOut', category: 'categories.debug', keybinding: 'Shift+F11', run: () => void motion('stepOut'), when: () => useDebug.getState().state === 'paused' },
    { id: 'debug.toggleBreakpoint', title: 'commands.debugToggleBreakpoint', category: 'categories.debug', run: () => void toggleBreakpointAtCursor(), when: hasDoc },
    { id: 'debug.clearBreakpoints', title: 'commands.debugClearBreakpoints', category: 'categories.debug', run: clearAllBreakpoints },
    { id: 'debug.focus', title: 'commands.debugFocus', category: 'categories.debug', run: () => revealPanel('debug') },
    { id: 'repro.open', title: 'commands.reproOpen', category: 'categories.project', keybinding: 'Mod+Alt+E', run: () => revealPanel('repro'), when: () => !!getSettings().workdir },
    { id: 'extensions.open', title: 'commands.extensionsOpen', category: 'categories.general', keybinding: 'Mod+Shift+X', run: () => revealPanel('extensions') },
    { id: 'extensions.install', title: 'commands.extensionsInstall', category: 'categories.general', run: () => void installFromPackage() },
    { id: 'extensions.loadDev', title: 'commands.extensionsLoadDev', category: 'categories.general', run: () => void addDevFolder() },
    { id: 'extensions.reload', title: 'commands.extensionsReload', category: 'categories.general', run: () => void loadExtensions() },
    { id: 'themes.import', title: 'commands.themesImport', category: 'categories.appearance', run: () => void importThemeFromFile() },
    { id: 'themes.export', title: 'commands.themesExport', category: 'categories.appearance', run: () => void exportCurrentTheme(useThemeMode.getState().mode) },
    { id: 'help.focus', title: 'commands.searchHelp', category: 'categories.view', run: () => revealPanel('help') },
    // Run
    { id: 'run.line', title: 'commands.runLine', category: 'categories.run', run: () => void runSelectionOrStatement(), when: hasDoc },
    { id: 'run.file', title: 'commands.runFile', category: 'categories.run', run: () => void runDocument(), when: hasDoc },
    { id: 'run.allChunks', title: 'commands.runAllChunks', category: 'categories.run', keybinding: 'Mod+Alt+R', run: () => void runAllChunks(), when: hasDoc },
    { id: 'preview.render', title: 'commands.previewRender', category: 'categories.run', keybinding: 'Mod+Shift+K', run: () => void previewActiveDoc() },
    ...LANGS.flatMap<Command>((l) => [
      { id: `kernel.restart.${l}`, title: 'commands.restartKernel', category: 'categories.kernel', run: () => void restartKernel(l), titleArgs: () => ({ lang: LANG_LABEL[l] }) },
      {
        id: `kernel.interrupt.${l}`,
        title: 'commands.interruptKernel',
        category: 'categories.kernel',
        run: () => void interruptKernel(l),
        when: () => useKernels.getState().kernels[l].status === 'busy',
        titleArgs: () => ({ lang: LANG_LABEL[l] }),
      },
      { id: `console.focus.${l}`, title: 'commands.focusConsole', category: 'categories.kernel', run: () => (setActiveConsole(l), revealPanel('console')), titleArgs: () => ({ lang: LANG_LABEL[l] }) },
    ]),
    {
      id: 'kernel.interrupt.active',
      title: 'commands.interruptActive',
      category: 'categories.kernel',
      keybinding: 'Mod+Alt+C',
      run: () => void interruptKernel(useConsole.getState().active),
    },
    { id: 'console.clear', title: 'commands.clearConsole', category: 'categories.kernel', run: () => clearConsole(useConsole.getState().active) },
    { id: 'plots.clear', title: 'commands.clearPlots', category: 'categories.view', run: clearPlots },
    // View
    { id: 'layout.analysis', title: 'layout.analysisLong', category: 'categories.layout', keybinding: 'Mod+Alt+1', run: () => applyPreset('analysis') },
    { id: 'layout.development', title: 'layout.developmentLong', category: 'categories.layout', keybinding: 'Mod+Alt+2', run: () => applyPreset('development') },
    { id: 'layout.focus', title: 'layout.focusLong', category: 'categories.layout', keybinding: 'Mod+Alt+3', run: () => applyPreset('focus') },
    { id: 'layout.saveCustom', title: 'layout.saveCustom', category: 'categories.layout', run: () => (saveCustomLayout(), toast({ kind: 'success', title: t('layout.saved') })) },
    { id: 'layout.custom', title: 'layout.restoreCustom', category: 'categories.layout', run: () => applyPreset('custom'), when: () => !!getSettings().layouts.custom },
    { id: 'layout.maximize', title: 'commands.maximize', category: 'categories.layout', keybinding: 'Mod+Shift+M', run: toggleMaximize },
    ...panelModules.filter((p) => !p.dynamic).map<Command>((p) => ({
      id: `panel.focus.${p.id}`,
      title: 'commands.showPanel',
      category: 'categories.view',
      keybinding: p.keybinding,
      run: () => revealPanel(p.id),
      titleArgs: () => ({ panel: t(p.title) }),
    })),
    { id: 'theme.cycle', title: 'commands.cycleTheme', category: 'categories.appearance', keybinding: 'Mod+Alt+T', run: cycleTheme },
    { id: 'theme.light', title: 'commands.themeLight', category: 'categories.appearance', run: () => updateSettings({ theme: 'light' }) },
    { id: 'theme.dark', title: 'commands.themeDark', category: 'categories.appearance', run: () => updateSettings({ theme: 'dark' }) },
    { id: 'theme.system', title: 'commands.themeSystem', category: 'categories.appearance', run: () => updateSettings({ theme: 'system' }) },
    { id: 'ui.zoomIn', title: 'commands.zoomIn', category: 'categories.appearance', keybinding: 'Mod+=', run: () => stepScale(1) },
    { id: 'ui.zoomOut', title: 'commands.zoomOut', category: 'categories.appearance', keybinding: 'Mod+-', run: () => stepScale(-1) },
    { id: 'ui.zoomReset', title: 'commands.zoomReset', category: 'categories.appearance', keybinding: 'Mod+0', run: () => updateSettings({ uiScale: 1 }) },
    { id: 'editor.fontUp', title: 'commands.fontUp', category: 'categories.appearance', run: () => updateSettings({ editorFontSize: Math.min(28, getSettings().editorFontSize + 1) }) },
    { id: 'editor.fontDown', title: 'commands.fontDown', category: 'categories.appearance', run: () => updateSettings({ editorFontSize: Math.max(9, getSettings().editorFontSize - 1) }) },
    { id: 'locale.hu', title: 'commands.localeHu', category: 'categories.appearance', run: () => updateSettings({ locale: 'hu' }) },
    { id: 'locale.en', title: 'commands.localeEn', category: 'categories.appearance', run: () => updateSettings({ locale: 'en' }) },
    { id: 'settings.open', title: 'commands.settings', category: 'categories.general', keybinding: 'Mod+,', run: () => useUi.setState({ settingsOpen: true }) },
    { id: 'onboarding.open', title: 'commands.onboarding', category: 'categories.general', run: () => useUi.setState({ onboardingOpen: true }) },
  ];
  const off = registerCommands(cmds);
  const offView = on('kernel:output', ({ lang, msgType, content }) => {
    const raw = msgType === 'display_data' ? content.data?.[VIEW_MIME] : undefined;
    if (!raw) return;
    try {
      const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
      openDataViewer(lang, v.name, v.title);
    } catch {
      /* malformed payload */
    }
  });
  // Recent projects as palette commands, kept in sync with settings.
  let offRecent = () => {};
  const syncRecent = () => {
    offRecent();
    offRecent = registerCommands(
      recentProjects(6).map<Command>((root) => ({
        id: `project.recent.${root}`,
        title: 'project.openRecent',
        category: 'categories.project',
        titleArgs: () => ({ name: projectName(root), path: root }),
        run: () => void openProject(root),
      })),
    );
  };
  syncRecent();
  // Saved SSH hosts: "Open folder on <host>" commands.
  let offHosts = () => {};
  const syncHosts = () => {
    offHosts();
    offHosts = registerCommands(
      (getSettings().remoteProfiles ?? []).map<Command>((p) => ({
        id: `remote.open.${p.id}`,
        title: 'commands.remoteOpenHost',
        category: 'categories.project',
        titleArgs: () => ({ name: profileLabel(p) }),
        run: () => void openRemoteFolder(p.id),
      })),
    );
  };
  syncHosts();
  const offSettings = useSettings.subscribe((st, prev) => {
    if (st.projects !== prev.projects || st.workdir !== prev.workdir) syncRecent();
    if (st.remoteProfiles !== prev.remoteProfiles) syncHosts();
  });
  // Show help without stealing focus from where the request came from.
  const offHelp = on('help:show', () => revealPanel('help', { focus: false }));
  const offPlots = on('plots:show', ({ id }) => {
    showPlotById(id);
    revealPanel('plots');
  });
  return () => {
    off();
    offRecent();
    offHosts();
    offSettings();
    offHelp();
    offPlots();
    offView();
  };
}
