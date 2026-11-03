import { Users } from 'lucide-react';
import { formatChord } from '../core/commands';
import { ChevronDown, Code2, Focus, FolderClosed, FolderOpen, FolderX, LayoutGrid, Monitor, Moon, Search, Settings, ShieldCheck, Sun } from 'lucide-react';
import { host } from '../core/host';
import { openProject, openProjectDialog, projectName, recentProjects } from '../project/project';
import { Menu, type MenuItem } from '../ui/Menu';
import { useTranslation } from 'react-i18next';
import { openPalette } from '../core/commands';
import { useSettings, type LayoutPreset } from '../core/settings';
import { cycleTheme } from '../core/theme';
import { IconButton } from '../ui/Button';
import { Kbd } from '../ui/Kbd';
import { Segmented } from '../ui/Segmented';
import { applyPreset, revealPanel } from '../workbench/layout';
import { useUi } from './uiStore';

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="df-logo-acc" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#5B6CFF" />
          <stop offset="1" stopColor="#8B9BFF" />
        </linearGradient>
        <linearGradient id="df-logo-spark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFC56B" />
          <stop offset="1" stopColor="#FF8A4C" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill="#161925" />
      <rect x="268" y="532" width="104" height="220" rx="36" fill="url(#df-logo-acc)" opacity="0.55" />
      <rect x="420" y="412" width="104" height="340" rx="36" fill="url(#df-logo-acc)" opacity="0.8" />
      <rect x="572" y="300" width="104" height="452" rx="36" fill="url(#df-logo-acc)" />
      <path d="M752 228 L776 290 L838 314 L776 338 L752 400 L728 338 L666 314 L728 290 Z" fill="url(#df-logo-spark)" />
    </svg>
  );
}

export function TitleBar() {
  const { t } = useTranslation();
  const preset = useSettings((s) => s.layoutPreset);
  const theme = useSettings((s) => s.theme);
  const workdir = useSettings((s) => s.workdir);
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  useSettings((s) => s.projects); // re-render the recent list when it changes
  const recent = recentProjects(6);
  const items: MenuItem[] = [
    { id: 'open', label: t('project.open'), icon: FolderOpen, shortcut: 'Mod+Alt+O', onSelect: () => void openProjectDialog() },
    ...(recent.length ? [{ type: 'separator' as const, id: 's1' }, { type: 'label' as const, id: 'l1', label: t('project.recent') }] : []),
    ...recent.map((root) => ({ id: root, label: projectName(root), icon: FolderClosed, onSelect: () => void openProject(root) })),
    ...(workdir
      ? [
          { type: 'separator' as const, id: 's2' },
          { id: 'repro', label: t('commands.reproOpen'), icon: ShieldCheck, shortcut: 'Mod+Alt+E', onSelect: () => revealPanel('repro') },
          { id: 'reveal', label: t('files.reveal'), icon: FolderOpen, onSelect: () => void host().fsReveal(workdir) },
          { id: 'close', label: t('project.close'), icon: FolderX, onSelect: () => void openProject(null) },
        ]
      : []),
  ];

  return (
    <header className="df-titlebar">
      <div className="df-titlebar__brand">
        <Logo />
        <span className="df-titlebar__name">DataForge</span>
        <span className="df-titlebar__sep">/</span>
        <Menu
          items={items}
          trigger={(p) => (
            <button {...p} className="df-titlebar__project" title={workdir ?? t('project.none')}>
              <span>{workdir ? projectName(workdir) : t('project.none')}</span>
              <ChevronDown size={12} strokeWidth={2} aria-hidden />
            </button>
          )}
        />
      </div>
      <button className="df-titlebar__search" onClick={openPalette}>
        <Search size={14} strokeWidth={1.75} aria-hidden />
        <span>{t('titlebar.search')}</span>
        <Kbd chord="Mod+Shift+P" />
      </button>
      <div className="df-titlebar__actions">
        <Segmented<LayoutPreset>
          size="sm"
          label={t('layout.label')}
          value={preset === 'custom' ? 'analysis' : preset}
          onChange={applyPreset}
          options={[
            { value: 'analysis', label: t('layout.analysisLong'), icon: LayoutGrid, iconOnly: true },
            { value: 'development', label: t('layout.developmentLong'), icon: Code2, iconOnly: true },
            { value: 'focus', label: t('layout.focusLong'), icon: Focus, iconOnly: true },
          ]}
        />
        <IconButton icon={Users} label={t('commands.collabPanel')} shortcut={formatChord('Mod+Alt+L').join('+')} onClick={() => revealPanel('collab')} />
        <IconButton icon={ThemeIcon} label={t('titlebar.theme', { mode: t(`theme.${theme}`) })} onClick={cycleTheme} />
        <IconButton icon={Settings} label={t('commands.settings')} onClick={() => useUi.setState({ settingsOpen: true })} />
      </div>
    </header>
  );
}
