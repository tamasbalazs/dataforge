/**
 * Projects: a folder with its own working directory, environments (renv,
 * venv/uv) and open files. Switching projects restarts the kernels there.
 */
import { create } from 'zustand';
import { ask } from '../core/dialog';
import { host, type Interpreter, type Lang, type ProjectInfo } from '../core/host';
import { t } from '../core/i18n';
import { getSettings, updateSettings } from '../core/settings';
import { toast } from '../core/toast';
import { isRunning, LANGS, restartKernel, setInterpreterResolver, useKernels } from '../kernels/kernels';
import { restartLsp } from '../lsp/client';
import { closeDoc, openFile, saveDoc } from '../panels/editor/editorService';
import { useEditor } from '../panels/editor/editorStore';
import { isCollabPath, isRemotePath, parseRemote, rootLabel } from '../core/paths';
import { useCollab } from '../collab/collabStore';
import { ensureConnected, profileById, profileLabel } from '../remote/remoteStore';

export const useProject = create<{ info: ProjectInfo | null; inspecting: boolean }>(() => ({ info: null, inspecting: false }));

export const projectName = (root: string) => {
  if (isCollabPath(root)) return `${useCollab.getState().project ?? '…'} · ${t('collab.shared')}`;
  const r = parseRemote(root);
  return r ? rootLabel(root, profileLabel(profileById(r.id), r.id)) : (root.split(/[\\/]/).filter(Boolean).pop() ?? root);
};

/** Interpreter a project prefers: explicit choice, else a project venv with ipykernel. */
export function projectInterpreter(lang: Lang): Interpreter | undefined {
  const info = useProject.getState().info;
  if (!info || lang !== 'python') return undefined;
  const chosen = getSettings().projects[info.root]?.interpreters?.python;
  const venvs = info.python.venvs;
  return venvs.find((v) => v.path === chosen) ?? venvs.find((v) => v.hasKernel);
}

setInterpreterResolver(projectInterpreter);

export async function inspectProject(root = getSettings().workdir): Promise<ProjectInfo | null> {
  if (!root) {
    useProject.setState({ info: null });
    return null;
  }
  useProject.setState({ inspecting: true });
  try {
    if (isRemotePath(root) && !(await ensureConnected(root, { quiet: true }))) {
      reconnectToast(root);
      return null;
    }
    const info = await host().projectInspect(root);
    if (getSettings().workdir === root) useProject.setState({ info });
    return info;
  } catch (e) {
    toast({ kind: 'error', title: t('project.inspectFailed'), detail: String(e) });
    return null;
  } finally {
    useProject.setState({ inspecting: false });
  }
}

function reconnectToast(root: string) {
  const r = parseRemote(root)!;
  toast({
    kind: 'error',
    title: t('remote.projectOffline', { name: projectName(root) }),
    detail: profileById(r.id) ? undefined : t('remote.unknownProfile', { id: r.id }),
    action: profileById(r.id)
      ? {
          label: t('remote.reconnect'),
          run: () =>
            void ensureConnected(root).then(async (ok) => {
              if (!ok) return;
              await inspectProject(root);
              await Promise.all(LANGS.filter((l) => useKernels.getState().kernels[l].status !== 'off').map((l) => restartKernel(l)));
            }),
        }
      : undefined,
  });
}

/** Close all documents, offering to save unsaved changes. Returns false if cancelled. */
async function closeAllDocs(): Promise<boolean> {
  const dirty = useEditor.getState().docs.filter((d) => d.dirty);
  if (dirty.length) {
    const choice = await ask(t('project.unsavedTitle', { count: dirty.length }), t('project.unsavedBody'), [
      { id: 'save', label: t('project.saveAll'), variant: 'primary' },
      { id: 'discard', label: t('editor.discard'), variant: 'danger' },
      { id: 'cancel', label: t('common.cancel'), variant: 'ghost' },
    ]);
    if (choice === 'cancel' || choice === null) return false;
    if (choice === 'save') for (const d of dirty) if (!(await saveDoc(d.id))) return false;
    if (choice === 'discard') useEditor.setState((s) => ({ docs: s.docs.map((d) => ({ ...d, dirty: false })) }));
  }
  for (const d of [...useEditor.getState().docs]) {
    useEditor.setState((s) => ({ docs: s.docs.map((x) => (x.id === d.id ? { ...x, dirty: false } : x)) }));
    await closeDoc(d.id);
  }
  return true;
}

function rememberOpenFiles(root: string | null) {
  if (!root) return;
  const paths = useEditor.getState().docs.flatMap((d) => (d.path ? [d.path] : []));
  const projects = getSettings().projects;
  updateSettings({ projects: { ...projects, [root]: { ...projects[root], lastOpened: Date.now(), openFiles: paths } } });
}

export async function openProject(root: string | null) {
  const current = getSettings().workdir;
  if (root === current) return;
  rememberOpenFiles(current);
  if (!(await closeAllDocs())) return;
  const projects = getSettings().projects;
  updateSettings({
    workdir: root,
    projects: root ? { ...projects, [root]: { ...projects[root], lastOpened: Date.now() } } : projects,
  });
  useProject.setState({ info: null });
  void host().projectWatch(root).catch(() => undefined);
  await inspectProject(root);
  // Restart kernels and language servers in the new working directory.
  await Promise.all(LANGS.filter((l) => useKernels.getState().kernels[l].status !== 'unavailable').map((l) => restartKernel(l)));
  LANGS.forEach((l) => void restartLsp(l));
  for (const p of (root && getSettings().projects[root]?.openFiles) || []) await openFile(p).catch(() => undefined);
  if (root) toast({ kind: 'success', title: t('project.opened', { name: projectName(root) }) });
}

export async function openProjectDialog() {
  const dir = await host().openFolderDialog();
  if (dir) await openProject(dir);
}

export function recentProjects(limit = 8): string[] {
  const projects = getSettings().projects;
  return Object.keys(projects)
    .sort((a, b) => projects[b].lastOpened - projects[a].lastOpened)
    .filter((r) => r !== getSettings().workdir && !isCollabPath(r))
    .slice(0, limit);
}

export function forgetProject(root: string) {
  const { [root]: _, ...rest } = getSettings().projects;
  updateSettings({ projects: rest });
}

/** Use a specific interpreter for this project's Python and restart. */
export async function setProjectInterpreter(lang: Lang, path: string | null) {
  const root = getSettings().workdir;
  if (!root) return;
  const projects = getSettings().projects;
  const p = projects[root] ?? { lastOpened: Date.now() };
  updateSettings({ projects: { ...projects, [root]: { ...p, interpreters: { ...p.interpreters, [lang]: path } } } });
  if (isRunning(lang) || useKernels.getState().kernels[lang].status !== 'off') await restartKernel(lang);
}

/**
 * Startup: re-attach to the last project. Resolves once its environments are
 * known, so kernels start with the project's interpreter (e.g. .venv).
 */
export async function initProject(): Promise<void> {
  const root = getSettings().workdir;
  if (!root) return;
  void host().projectWatch(root).catch(() => undefined);
  await inspectProject(root);
}
