import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import 'dockview-react/dist/styles/dockview.css';
import './design/global.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installAppCommands } from './app/appCommands';
import { useUi } from './app/uiStore';
import { installKeybindings } from './core/commands';
import { initHost } from './core/host';
import { initI18n } from './core/i18n';
import { getSettings, updateSettings, useSettings } from './core/settings';
import { installThemeSync } from './core/theme';
import { installKernelEvents, LANGS, startKernel } from './kernels/kernels';
import { installPanelModules, preloadPanels } from './workbench/panels';
import { initProject, openProject } from './project/project';

async function boot() {
  installThemeSync();
  initI18n();
  const host = await initHost();

  preloadPanels();
  const projectReady = initProject();
  installKernelEvents();
  installPanelModules();
  installAppCommands();
  installKeybindings();

  const applyZoom = () => void host.setZoom(getSettings().uiScale).catch(() => undefined);
  if (getSettings().uiScale !== 1) applyZoom();
  useSettings.subscribe((s, prev) => s.uiScale !== prev.uiScale && applyZoom());

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  // After the first commit: show the window, measure startup, start kernels.
  // (No requestAnimationFrame here: hidden windows don't get frames.)
  setTimeout(async () => {
    document.getElementById('boot')?.remove();
    await host.showWindow().catch(() => undefined);
    const info = await host.appInfo().catch(() => null);
    const ms = info?.uptimeMs ?? Math.round(performance.now());
    (window as any).__DATAFORGE_STARTUP_MS__ = ms;
    console.info(`[DataForge] interactive after ${ms} ms (${host.kind})`);
    if (info?.launchPath && info.launchPath !== getSettings().workdir) {
    updateSettings({ onboarded: true });
    await openProject(info.launchPath);
  } else if (getSettings().onboarded) {
    await projectReady;
    LANGS.forEach((l) => void startKernel(l));
  }
    else useUi.setState({ onboardingOpen: true });
  }, 0);
}

void boot();
