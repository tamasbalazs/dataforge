/**
 * Routing layer around the real host. While this app is a *guest* in a shared
 * session, kernel calls and `collab://` paths go to the session (and from
 * there to the host's machine); everything else stays local. Because panels
 * only talk to `host()`, the console, Environment panel, data viewer, plots,
 * Files panel and editor work for guests without knowing about sessions.
 */
import type { CompleteReply, FsEntry, Host, KernelEvent, KernelStarted, Lang, ProjectInfo } from './host';
import { isCollabPath } from './paths';

export interface GuestRouting {
  fsList(path: string, showHidden: boolean): Promise<FsEntry[]>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  writeBase64(path: string, data: string): Promise<void>;
  fsCreate(parent: string, name: string, dir: boolean): Promise<string>;
  fsRename(path: string, newName: string): Promise<string>;
  fsTrash(path: string): Promise<void>;
  projectInspect(root: string): Promise<ProjectInfo>;
  kernelStart(id: string, lang: Lang): Promise<KernelStarted>;
  kernelExecute(id: string, code: string, msgId: string): Promise<string>;
  kernelCall<T>(id: string, func: string, args: Record<string, unknown>): Promise<T>;
  kernelComplete(id: string, code: string, cursor: number): Promise<CompleteReply>;
  kernelInterrupt(id: string): Promise<void>;
}

let routing: GuestRouting | null = null;
const kernelListeners = new Set<(ev: KernelEvent) => void>();
const fsListeners = new Set<(paths: string[]) => void>();

export const setGuestRouting = (r: GuestRouting | null) => (routing = r);
export const isGuest = () => routing !== null;
export const emitGuestKernelEvent = (ev: KernelEvent) => kernelListeners.forEach((l) => l(ev));
export const emitGuestFsChanged = (paths: string[]) => fsListeners.forEach((l) => l(paths));

const NOT_SHARED = 'Not available in a shared session (only the host can do this)';
const ENDED = 'The shared session has ended';

export function wrapHost(base: Host): Host {
  const shared = <A extends unknown[], R>(path: (...a: A) => string | null | undefined, guest: (r: GuestRouting, ...a: A) => Promise<R>, local: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => {
      if (!isCollabPath(path(...a))) return local(...a);
      return routing ? guest(routing, ...a) : Promise.reject(new Error(ENDED));
    };
  const localOnly = <A extends unknown[], R>(path: (...a: A) => string | null | undefined, local: (...a: A) => Promise<R>) =>
    (...a: A): Promise<R> => (isCollabPath(path(...a)) ? Promise.reject(new Error(NOT_SHARED)) : local(...a));

  return {
    ...base,
    // Kernels: the host's kernels while a guest.
    kernelStart: (id, lang, interp, cwd, lib) => (routing ? routing.kernelStart(id, lang) : base.kernelStart(id, lang, interp, cwd, lib)),
    kernelExecute: (id, code, msgId) => (routing ? routing.kernelExecute(id, code, msgId) : base.kernelExecute(id, code, msgId)),
    kernelCall: <T>(id: string, func: string, args: Record<string, unknown> = {}) => (routing ? routing.kernelCall<T>(id, func, args) : base.kernelCall<T>(id, func, args)),
    kernelComplete: (id, code, cursor) => (routing ? routing.kernelComplete(id, code, cursor) : base.kernelComplete(id, code, cursor)),
    kernelInterrupt: (id) => (routing ? routing.kernelInterrupt(id) : base.kernelInterrupt(id)),
    // A guest never stops the host's kernel; its own local one (if any) goes down.
    kernelShutdown: (id) => (routing ? base.kernelShutdown(id).catch(() => undefined) : base.kernelShutdown(id)),
    kernelDebug: (id, req) => (routing ? Promise.reject(new Error(NOT_SHARED)) : base.kernelDebug(id, req)),
    onKernelEvent(cb) {
      const off = base.onKernelEvent((ev) => {
        if (!routing) cb(ev);
      });
      kernelListeners.add(cb);
      return () => {
        off();
        kernelListeners.delete(cb);
      };
    },
    onFsChanged(cb) {
      const off = base.onFsChanged(cb);
      fsListeners.add(cb);
      return () => {
        off();
        fsListeners.delete(cb);
      };
    },
    // Files of the shared project.
    fsList: shared((p) => p, (r, p, h) => r.fsList(p, h), base.fsList),
    readText: shared((p) => p, (r, p) => r.readText(p), base.readText),
    writeText: shared((p) => p, (r, p, c) => r.writeText(p, c), base.writeText),
    writeBase64: shared((p) => p, (r, p, d) => r.writeBase64(p, d), base.writeBase64),
    fsCreate: shared((p) => p, (r, p, n, d) => r.fsCreate(p, n, d), base.fsCreate),
    fsRename: shared((p) => p, (r, p, n) => r.fsRename(p, n), base.fsRename),
    fsTrash: shared((p) => p, (r, p) => r.fsTrash(p), base.fsTrash),
    projectInspect: shared((p) => p, (r, p) => r.projectInspect(p), base.projectInspect),
    projectWatch: (root) => (isCollabPath(root) ? base.projectWatch(null) : base.projectWatch(root)),
    gitExec: (root, args, stdin) =>
      isCollabPath(root) ? Promise.resolve({ code: 128, stdout: '', stderr: `fatal: ${NOT_SHARED}` }) : base.gitExec(root, args, stdin),
    // Local tools that need the files on this machine.
    fsReveal: localOnly((p) => p, base.fsReveal),
    fsOpenExternal: localOnly((p) => p, base.fsOpenExternal),
    ptyOpen: localOnly((_id, o) => o.cwd, base.ptyOpen),
    procRun: localOnly((_id, _s, cwd) => cwd, base.procRun),
    previewDir: localOnly((p) => p, base.previewDir),
    lspStart: localOnly((_id, _c, cwd) => cwd, base.lspStart),
    reproFiles: localOnly((p) => p, base.reproFiles),
    reproHash: localOnly((p) => p, base.reproHash),
    projectVenvSteps: localOnly((p) => p, base.projectVenvSteps),
    // Jobs run where the project lives; a guest's project lives on the host's machine.
    jobStart: localOnly((w) => w, base.jobStart),
    jobList: localOnly((w) => w, base.jobList),
    jobPoll: localOnly((w) => w, base.jobPoll),
    jobCancel: localOnly((w) => w, base.jobCancel),
    jobRemove: localOnly((w) => w, base.jobRemove),
    jobRead: localOnly((w) => w, base.jobRead),
  };
}
