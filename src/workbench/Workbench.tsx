import { DockviewReact, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type DockviewTheme } from 'dockview-react';
import { LayoutGrid, Maximize2, Minimize2, PictureInPicture2, X } from 'lucide-react';
import { Component, Suspense, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import { applyPreset, closePanel, initLayout } from './layout';
import { panelById, panelModules } from './panels';

const theme: DockviewTheme = {
  name: 'dataforge',
  className: 'dockview-theme-dataforge',
  gap: 6,
  dndOverlayMounting: 'absolute',
  dndPanelOverlay: 'group',
};

class PanelBoundary extends Component<{ children: ReactNode; title: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('panel crashed', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="df-panel-error" role="alert">
          <strong>{this.props.title}</strong>
          <pre>{String(this.state.error.stack ?? this.state.error)}</pre>
          <Button size="sm" onClick={() => this.setState({ error: null })}>
            Reload panel
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

const moduleOf = (id: string, params?: { module?: string }) => panelById(params?.module ?? id);

function PanelHost(props: IDockviewPanelProps) {
  const { t } = useTranslation();
  const mod = moduleOf(props.api.id, props.params)!;
  const Comp = mod.component;
  return (
    <div className="df-panel" data-panel={props.api.id}>
      <PanelBoundary title={t(mod.title)}>
        <Suspense
          fallback={
            <div className="df-panel__loading">
              <Spinner size={16} />
            </div>
          }
        >
          <Comp params={props.params} />
        </Suspense>
      </PanelBoundary>
    </div>
  );
}

function Tab(props: IDockviewPanelHeaderProps) {
  const { t } = useTranslation();
  const mod = moduleOf(props.api.id, props.params);
  const Icon = mod?.icon;
  const title = props.params?.title ?? (mod ? t(mod.title) : props.api.title);
  return (
    <div className="df-tab" data-panel-id={props.api.id} onAuxClick={(e) => e.button === 1 && props.api.close()}>
      {Icon && <Icon size={13} strokeWidth={1.9} aria-hidden />}
      <span className="df-tab__title">{title}</span>
      {/* Mouse target; keyboard users close the focused tab with Delete. */}
      <span
        className="df-tab__close"
        aria-hidden
        title={t('workbench.closePanel', { name: title })}
        onClick={(e) => {
          e.stopPropagation();
          props.api.close();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <X size={12} strokeWidth={2} />
      </span>
    </div>
  );
}

function HeaderActions(props: IDockviewHeaderActionsProps) {
  const { t } = useTranslation();
  const maximized = props.api.isMaximized();
  const floating = props.api.location.type === 'floating';
  return (
    <div className="df-group-actions">
      {!floating && (
        <button
          className="df-group-action"
          aria-label={t('workbench.float')}
          data-tooltip={t('workbench.float')}
          onClick={() => props.activePanel && props.containerApi.addFloatingGroup(props.activePanel, { width: 520, height: 380 })}
        >
          <PictureInPicture2 size={13} strokeWidth={1.8} />
        </button>
      )}
      <button
        className="df-group-action"
        aria-label={maximized ? t('workbench.restore') : t('workbench.maximize')}
        data-tooltip={maximized ? t('workbench.restore') : t('workbench.maximize')}
        onClick={() => (maximized ? props.api.exitMaximized() : props.api.maximize())}
      >
        {maximized ? <Minimize2 size={13} strokeWidth={1.8} /> : <Maximize2 size={13} strokeWidth={1.8} />}
      </button>
    </div>
  );
}

function Watermark() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={LayoutGrid}
      title={t('workbench.emptyTitle')}
      actions={
        <div className="df-empty__row">
          <Button onClick={() => applyPreset('analysis')}>{t('layout.analysis')}</Button>
          <Button onClick={() => applyPreset('development')}>{t('layout.development')}</Button>
          <Button onClick={() => applyPreset('focus')}>{t('layout.focus')}</Button>
        </div>
      }
    >
      {t('workbench.emptyBody')}
    </EmptyState>
  );
}

export function Workbench() {
  const components = useMemo(() => Object.fromEntries(panelModules.map((m) => [m.id, PanelHost])), []);
  // Delete on a focused panel tab closes it (the tab's close icon is mouse-only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      const tab = (e.target as HTMLElement | null)?.closest?.('.dv-tab');
      const id = tab?.querySelector<HTMLElement>('[data-panel-id]')?.dataset.panelId;
      if (!id) return;
      e.preventDefault();
      closePanel(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="df-workbench">
      <DockviewReact
        theme={theme}
        components={components}
        tabComponents={{ tab: Tab }}
        defaultTabComponent={Tab}
        rightHeaderActionsComponent={HeaderActions}
        watermarkComponent={Watermark}
        onReady={(e: DockviewReadyEvent) => initLayout(e.api)}
        disableFloatingGroups={false}
      />
    </div>
  );
}
