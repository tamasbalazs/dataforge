import { CommandPalette } from './CommandPalette';
import { Onboarding } from './Onboarding';
import { DialogHost, TaskLog, Toasts } from './Overlays';
import { SettingsDialog } from './SettingsDialog';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import { Workbench } from '../workbench/Workbench';
import { lazy, Suspense } from 'react';
import { useUi } from './uiStore';

// Loaded on first use (keeps startup lean).
const RemoteDialog = lazy(() => import('../remote/RemoteDialog').then((m) => ({ default: m.RemoteDialog })));

const JobDialog = lazy(() => import('../jobs/jobDialog').then((m) => ({ default: m.JobDialog })));

function LazyJobDialog() {
  const open = useUi((s) => s.jobDialog);
  return open ? (
    <Suspense fallback={null}>
      <JobDialog />
    </Suspense>
  ) : null;
}

const CollabDialog = lazy(() => import('../collab/CollabDialog').then((m) => ({ default: m.CollabDialog })));

function LazyCollabDialog() {
  const open = useUi((s) => s.collabDialog);
  return open ? (
    <Suspense fallback={null}>
      <CollabDialog />
    </Suspense>
  ) : null;
}

function LazyRemoteDialog() {
  const open = useUi((s) => s.remoteOpen);
  return open ? (
    <Suspense fallback={null}>
      <RemoteDialog />
    </Suspense>
  ) : null;
}

export function App() {
  return (
    <div className="df-app">
      <TitleBar />
      <main className="df-main">
        <Workbench />
      </main>
      <StatusBar />
      <CommandPalette />
      <SettingsDialog />
      <LazyRemoteDialog />
      <LazyCollabDialog />
      <LazyJobDialog />
      <Onboarding />
      <TaskLog />
      <DialogHost />
      <Toasts />
    </div>
  );
}
