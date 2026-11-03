import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { CollabEvent, Host, KernelEvent, LspEvent, ProcEvent, PtyEvent } from './host';

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (cancelled) u();
    else unlisten = u;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

export function createTauriHost(): Host {
  // Remote folders have no watcher: changes made through the UI are announced here.
  const synthetic = new Set<(paths: string[]) => void>();
  const touched = <T>(paths: string[], p: Promise<T>) =>
    p.then((v) => {
      const remote = paths.filter((x) => x.startsWith('ssh://'));
      if (remote.length) synthetic.forEach((cb) => cb(typeof v === 'string' && v.startsWith('ssh://') ? [...remote, v] : remote));
      return v;
    });
  return {
    kind: 'tauri',
    appInfo: () => invoke('app_info'),
    detectInterpreters: (refresh) => invoke('detect_interpreters', { refresh }),
    kernelStart: (id, lang, interpreter, cwd, kernelLib) => invoke('kernel_start', { id, lang, interpreter, cwd: cwd ?? null, kernelLib: kernelLib ?? null }),
    kernelExecute: (id, code, msgId) => invoke('kernel_execute', { id, code, msgId }),
    kernelCall: (id, func, args = {}) => invoke('kernel_call', { id, func, args }),
    kernelComplete: (id, code, cursor) => invoke('kernel_complete', { id, code, cursor }),
    kernelInterrupt: (id) => invoke('kernel_interrupt', { id }),
    kernelShutdown: (id) => invoke('kernel_shutdown', { id }),
    onKernelEvent: (cb) => subscribe<KernelEvent>('kernel-event', cb),
    lspDetect: (lang, interpreter) => invoke('lsp_detect', { lang, interpreter }),
    lspStart: (id, command, cwd) => invoke('lsp_start', { id, command, cwd: cwd ?? null }),
    lspSend: (id, payload) => invoke('lsp_send', { id, payload }),
    lspStop: (id) => invoke('lsp_stop', { id }),
    onLspEvent: (cb) => subscribe<LspEvent>('lsp-event', cb),
    fsList: (path, showHidden) => invoke('fs_list', { path, showHidden }),
    fsCreate: (parent, name, dir) => touched([`${parent}/${name}`], invoke('fs_create', { parent, name, dir })),
    fsRename: (path, newName) => touched([path], invoke('fs_rename', { path, newName })),
    fsTrash: (path) => touched([path], invoke('fs_trash', { path })),
    fsReveal: (path) => invoke('fs_reveal', { path }),
    fsOpenExternal: (path) => invoke('fs_open_external', { path }),
    projectInspect: (root) => invoke('project_inspect', { root }),
    projectWatch: (root) => invoke('project_watch', { root }),
    onFsChanged: (cb) => {
      synthetic.add(cb);
      const off = subscribe<string[]>('fs-changed', cb);
      return () => {
        synthetic.delete(cb);
        off();
      };
    },
    procRun: (id, steps, cwd) => invoke('proc_run', { id, steps, cwd: cwd ?? null }),
    procKill: (id) => invoke('proc_kill', { id }),
    onProcEvent: (cb) => subscribe<ProcEvent>('proc-event', cb),
    projectVenvSteps: (root, python) => invoke('project_venv_steps', { root, python }),
    findProgram: (name) => invoke('find_program', { name }),
    previewDir: (source) => invoke('preview_dir', { source }),
    ptyOpen: (id, o) => invoke('pty_open', { id, shell: o.shell ?? null, cwd: o.cwd ?? null, env: o.env ?? null, cols: o.cols, rows: o.rows }),
    ptyWrite: (id, data) => invoke('pty_write', { id, data }),
    ptyResize: (id, cols, rows) => invoke('pty_resize', { id, cols, rows }),
    ptyKill: (id) => invoke('pty_kill', { id }),
    onPtyEvent: (cb) => subscribe<PtyEvent>('pty-event', cb),
    reproFiles: (root) => invoke('repro_files', { root }),
    reproHash: (root, paths) => invoke('repro_hash', { root, paths }),
    reproWrite: (dest, entries) => invoke('repro_write', { dest, entries: entries.map((e) => ({ name: e.name, source: e.source ?? null, text: e.text ?? null, executable: !!e.executable })) }),
    extDir: () => invoke('ext_dir'),
    extInstall: (pkg) => invoke('ext_install', { package: pkg }),
    extUninstall: (id) => invoke('ext_uninstall', { id }),
    kernelDebug: (id, request) => invoke('kernel_debug', { id, request }),
    rDebug: (command, wait) => invoke('r_debug', { command, wait }),
    onRDebugEvent: (cb) => subscribe<any>('r-debug-event', cb),
    gitExec: (root, args, stdin) => invoke('git_exec', { root, args, stdin: stdin ?? null }),
    openUrl: (url) => invoke('open_url', { url }),
    readText: (path) => invoke('fs_read_text', { path }),
    writeText: (path, content) => touched([path], invoke('fs_write_text', { path, content })),
    writeBase64: (path, data) => touched([path], invoke('fs_write_base64', { path, data })),
    remoteConnect: (profile) =>
      invoke('remote_connect', {
        profile: { id: profile.id, name: profile.name, host: profile.host.trim(), user: profile.user?.trim() || null, port: profile.port || null, identityFile: profile.identityFile?.trim() || null },
      }),
    remoteDisconnect: (id) => invoke('remote_disconnect', { id }),
    jobStart: (workdir, spec) => invoke('job_start', { workdir: workdir ?? null, spec: { ...spec, env: spec.env ?? {}, meta: spec.meta ?? null } }),
    jobList: (workdir) => invoke('job_list', { workdir: workdir ?? null }),
    jobPoll: (workdir, id, offset) => invoke('job_poll', { workdir: workdir ?? null, id, offset }),
    jobCancel: (workdir, id) => invoke('job_cancel', { workdir: workdir ?? null, id }),
    jobRemove: (workdir, id) => invoke('job_remove', { workdir: workdir ?? null, id }),
    jobRead: (workdir, id, name) => invoke('job_read', { workdir: workdir ?? null, id, name }),
    collabHostStart: (lan, port) => invoke('collab_host_start', { lan, port: port ?? null }),
    collabHostStop: () => invoke('collab_host_stop'),
    collabConnect: (id, address, token) => invoke('collab_connect', { id, address, token }),
    collabSend: (id, data) => invoke('collab_send', { id, data }),
    collabClose: (id) => invoke('collab_close', { id }),
    onCollabEvent: (cb) => subscribe<CollabEvent>('collab-event', cb),
    async openFileDialog(filters) {
      const r = await open({ multiple: false, directory: false, filters });
      return typeof r === 'string' ? r : null;
    },
    async openFolderDialog() {
      const r = await open({ multiple: false, directory: true });
      return typeof r === 'string' ? r : null;
    },
    async saveFileDialog(defaultPath, filters) {
      return (await save({ defaultPath, filters })) ?? null;
    },
    async setZoom(factor) {
      await getCurrentWebview().setZoom(factor);
    },
    async showWindow() {
      const w = getCurrentWindow();
      // Match the native window background to the theme (no light flash).
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-0').trim();
      if (bg) await w.setBackgroundColor(bg).catch(() => undefined);
      await w.show();
      await w.setFocus();
    },
  };
}
