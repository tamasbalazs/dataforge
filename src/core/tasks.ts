/**
 * Background tasks (create venv, uv sync, …): a progress toast while running,
 * success/error feedback, and the full log on demand.
 */
import { create } from 'zustand';
import { host, type ProcStep } from './host';
import { t } from './i18n';
import { dismissToast, toast } from './toast';

export interface Task {
  id: string;
  title: string;
  lines: Array<{ kind: 'stdout' | 'stderr'; text: string }>;
  status: 'running' | 'ok' | 'error';
  code: number | null;
}

export const useTasks = create<{ tasks: Record<string, Task>; logOpen: string | null }>(() => ({ tasks: {}, logOpen: null }));

const MAX_LINES = 2000;
let installed = false;
const waiters = new Map<string, (code: number | null) => void>();

function install() {
  if (installed) return;
  installed = true;
  host().onProcEvent((ev) => {
    const task = useTasks.getState().tasks[ev.id];
    if (!task) return;
    if (ev.kind === 'exit') {
      const status = ev.code === 0 ? 'ok' : 'error';
      useTasks.setState((s) => ({ tasks: { ...s.tasks, [ev.id]: { ...task, status, code: ev.code } } }));
      waiters.get(ev.id)?.(ev.code);
      waiters.delete(ev.id);
      return;
    }
    const lines = [...task.lines, { kind: ev.kind, text: ev.text }].slice(-MAX_LINES);
    useTasks.setState((s) => ({ tasks: { ...s.tasks, [ev.id]: { ...task, lines } } }));
  });
}

export const openTaskLog = (id: string) => useTasks.setState({ logOpen: id });

/** Run a sequence of programs; resolves with the exit code (0 = success). */
export async function runTask(title: string, steps: ProcStep[], cwd?: string | null): Promise<number | null> {
  install();
  const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  useTasks.setState((s) => ({ tasks: { ...s.tasks, [id]: { id, title, lines: [], status: 'running', code: null } } }));
  const progress = toast({ kind: 'progress', title, action: { label: t('tasks.showLog'), run: () => openTaskLog(id) } });
  const done = new Promise<number | null>((resolve) => waiters.set(id, resolve));
  try {
    await host().procRun(id, steps, cwd);
  } catch (e) {
    waiters.delete(id);
    dismissToast(progress);
    toast({ kind: 'error', title: t('tasks.failed', { title }), detail: String(e) });
    return -1;
  }
  const code = await done;
  dismissToast(progress);
  if (code === 0) toast({ kind: 'success', title: t('tasks.done', { title }) });
  else {
    const last = useTasks.getState().tasks[id]?.lines.filter((l) => l.kind === 'stderr').pop()?.text;
    toast({ kind: 'error', title: t('tasks.failed', { title }), detail: last, action: { label: t('tasks.showLog'), run: () => openTaskLog(id) } });
  }
  return code;
}
