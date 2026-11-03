/**
 * Kernel service: owns kernel lifecycle and execution, translates host
 * events into bus events. Panels never talk to the host about kernels
 * directly; they use this API and listen on the bus.
 */
import { create } from 'zustand';
import { emit, type KernelStatus } from '../core/bus';
import { host, type Interpreter, type KernelEvent, type Lang } from '../core/host';
import { t } from '../core/i18n';
import { getSettings } from '../core/settings';
import { toast } from '../core/toast';
import { isRemotePath, kernelPath } from '../core/paths';
import { ensureConnected, remoteInterpreters } from '../remote/remoteStore';

export const LANGS: Lang[] = ['r', 'python'];
export const LANG_LABEL: Record<Lang, string> = { r: 'R', python: 'Python' };

export interface KernelState {
  lang: Lang;
  status: KernelStatus;
  version?: string;
  interpreter?: string;
  cwd?: string;
  error?: string;
  /** Start time of the oldest running execution. */
  busySince?: number;
  queued: number;
}

interface KernelsStore {
  kernels: Record<Lang, KernelState>;
  interpreters: Interpreter[];
  detecting: boolean;
  detected: boolean;
}

const initial = (lang: Lang): KernelState => ({ lang, status: 'off', queued: 0 });

export const useKernels = create<KernelsStore>(() => ({
  kernels: { r: initial('r'), python: initial('python') },
  interpreters: [],
  detecting: false,
  detected: false,
}));

function patchKernel(lang: Lang, patch: Partial<KernelState>) {
  useKernels.setState((s) => ({ kernels: { ...s.kernels, [lang]: { ...s.kernels[lang], ...patch } } }));
  if (patch.status) emit('kernel:status', { lang, status: patch.status });
}

interface Pending {
  lang: Lang;
  start: number;
  replied?: 'ok' | 'error' | 'aborted';
}

const pending = new Map<string, Pending>();
const ready: Partial<Record<Lang, Promise<boolean>>> = {};
/** Generation counter per language, so events from a killed kernel are ignored. */
const generation: Record<Lang, number> = { r: 0, python: 0 };

type BeforeExecuteHook = (lang: Lang) => Promise<void> | void;
const beforeExecute = new Set<BeforeExecuteHook>();
export function addBeforeExecuteHook(h: BeforeExecuteHook) {
  beforeExecute.add(h);
  return () => beforeExecute.delete(h);
}

function updateBusy(lang: Lang) {
  const mine = [...pending.values()].filter((p) => p.lang === lang);
  const st = useKernels.getState().kernels[lang].status;
  if (st !== 'idle' && st !== 'busy') return;
  if (mine.length) patchKernel(lang, { status: 'busy', busySince: Math.min(...mine.map((p) => p.start)), queued: mine.length });
  else patchKernel(lang, { status: 'idle', busySince: undefined, queued: 0 });
}

function finish(msgId: string, status: 'ok' | 'error' | 'aborted') {
  const p = pending.get(msgId);
  if (!p) return;
  pending.delete(msgId);
  emit('kernel:execution-done', { lang: p.lang, msgId, status, durationMs: performance.now() - p.start });
  updateBusy(p.lang);
}

function handleEvent(ev: KernelEvent) {
  const lang = ev.kernelId as Lang;
  if (!LANGS.includes(lang)) return;
  switch (ev.msgType) {
    case 'execute_reply': {
      const p = ev.parentId ? pending.get(ev.parentId) : undefined;
      if (p) p.replied = ev.content.status === 'ok' ? 'ok' : ev.content.status === 'aborted' ? 'aborted' : 'error';
      return;
    }
    case 'status': {
      const p = ev.parentId ? pending.get(ev.parentId) : undefined;
      if (p && ev.content.execution_state === 'idle') finish(ev.parentId!, p.replied ?? 'ok');
      return;
    }
    case 'dataforge:exited': {
      for (const [id, p] of pending) if (p.lang === lang) finish(id, 'aborted');
      patchKernel(lang, { status: 'dead', error: t('kernel.exited', { code: ev.content.code }) });
      delete ready[lang];
      toast({
        kind: 'error',
        title: t('kernel.diedTitle', { lang: LANG_LABEL[lang] }),
        action: { label: t('kernel.restart'), run: () => void restartKernel(lang) },
      });
      return;
    }
    case 'dataforge:log':
      emit('kernel:log', { lang, text: ev.content.text });
      return;
    case 'execute_input':
      return;
    default:
      emit('kernel:output', { lang, parentId: ev.parentId, msgType: ev.msgType, content: ev.content });
  }
}

let unlisten: (() => void) | null = null;
export function installKernelEvents() {
  unlisten?.();
  unlisten = host().onKernelEvent(handleEvent);
}

export async function detectInterpreters(refresh = false): Promise<Interpreter[]> {
  useKernels.setState({ detecting: true });
  try {
    const list = await host().detectInterpreters(refresh);
    useKernels.setState({ interpreters: list, detected: true });
    return list;
  } finally {
    useKernels.setState({ detecting: false });
  }
}

type InterpreterResolver = (lang: Lang) => Interpreter | undefined;
let resolver: InterpreterResolver | null = null;
/** Projects can supply their own interpreter (e.g. a project .venv). */
export function setInterpreterResolver(r: InterpreterResolver | null) {
  resolver = r;
}

/** A workspace whose kernels live elsewhere (a shared session's host). */
export interface WorkspaceKernels {
  interpreter(lang: Lang): Interpreter | undefined;
}
let workspaceKernels: WorkspaceKernels | null = null;
export const setWorkspaceKernels = (w: WorkspaceKernels | null) => (workspaceKernels = w);

export function chooseInterpreter(lang: Lang, list = useKernels.getState().interpreters): Interpreter | undefined {
  if (workspaceKernels) return workspaceKernels.interpreter(lang);
  const fromProject = resolver?.(lang);
  if (fromProject?.hasKernel) return fromProject;
  const remote = remoteInterpreters();
  if (remote) {
    // A remote project only uses interpreters of its host.
    const root = getSettings().workdir!;
    const chosen = getSettings().projects[root]?.interpreters?.[lang];
    const ofLang = remote.filter((i) => i.lang === lang);
    return ofLang.find((i) => i.path === chosen && i.hasKernel) ?? ofLang.find((i) => i.hasKernel);
  }
  const wanted = getSettings().interpreters[lang];
  const ofLang = list.filter((i) => i.lang === lang);
  return ofLang.find((i) => i.path === wanted && i.hasKernel) ?? ofLang.find((i) => i.hasKernel);
}

export function startKernel(lang: Lang): Promise<boolean> {
  const existing = ready[lang];
  const st = useKernels.getState().kernels[lang].status;
  if (existing && (st === 'starting' || st === 'idle' || st === 'busy')) return existing;
  const p = (async () => {
    const gen = ++generation[lang];
    const root = getSettings().workdir;
    if (workspaceKernels) {
      /* the session's host provides the kernels */
    } else if (isRemotePath(root)) {
      if (!(await ensureConnected(root, { quiet: true }))) {
        patchKernel(lang, { status: 'unavailable', error: t('remote.kernelNotConnected') });
        return false;
      }
    } else if (!useKernels.getState().detected) await detectInterpreters(false);
    const interp = chooseInterpreter(lang);
    if (!interp) {
      patchKernel(lang, { status: 'unavailable', error: t(isRemotePath(root) ? 'remote.noInterpreter' : 'kernel.noInterpreter', { lang: LANG_LABEL[lang] }) });
      return false;
    }
    patchKernel(lang, { status: 'starting', interpreter: interp.path, version: interp.version, error: undefined });
    try {
      const res = await host().kernelStart(lang, lang, interp.path, getSettings().workdir, interp.kernelLib);
      if (gen !== generation[lang]) return false;
      patchKernel(lang, { status: 'idle', version: res.info?.version ?? interp.version, cwd: res.info?.cwd });
      emit('kernel:ready', { lang });
      return true;
    } catch (e) {
      if (gen !== generation[lang]) return false;
      patchKernel(lang, { status: 'error', error: String(e) });
      toast({ kind: 'error', title: t('kernel.startFailed', { lang: LANG_LABEL[lang] }), detail: String(e) });
      return false;
    }
  })();
  ready[lang] = p;
  return p;
}

export async function restartKernel(lang: Lang) {
  for (const [id, p] of pending) if (p.lang === lang) finish(id, 'aborted');
  generation[lang]++;
  delete ready[lang];
  patchKernel(lang, { status: 'starting' });
  try {
    await host().kernelShutdown(lang);
  } catch {
    /* already gone */
  }
  patchKernel(lang, { status: 'off' });
  return startKernel(lang);
}

export async function interruptKernel(lang: Lang) {
  await host().kernelInterrupt(lang);
}

const newMsgId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

export interface ExecuteOptions {
  /** Echo the code in the console (false for silent helper-ish runs). */
  echo?: boolean;
  /** Use this request id (a shared session's guest chose it). */
  msgId?: string;
  /** Who asked for it (shown in the console in shared sessions). */
  by?: string;
}

const sendQueue: Record<Lang, Promise<unknown>> = { r: Promise.resolve(), python: Promise.resolve() };

/** Execute user code. Requests are sent strictly in call order per language. */
export function execute(lang: Lang, code: string, opts: ExecuteOptions = {}): Promise<string | null> {
  const next = sendQueue[lang].then(() => sendExecute(lang, code, opts));
  sendQueue[lang] = next.catch(() => undefined);
  return next;
}

async function sendExecute(lang: Lang, code: string, opts: ExecuteOptions): Promise<string | null> {
  const ok = await startKernel(lang);
  if (!ok) {
    toast({ kind: 'error', title: useKernels.getState().kernels[lang].error ?? t('kernel.unavailable') });
    return null;
  }
  for (const h of beforeExecute) {
    try {
      await h(lang);
    } catch (e) {
      console.warn('beforeExecute hook failed', e);
    }
  }
  // The id is chosen here so that output racing ahead of the invoke() reply
  // is already attributable.
  const msgId = opts.msgId ?? newMsgId();
  pending.set(msgId, { lang, start: performance.now() });
  emit('kernel:execution-start', { lang, msgId, code, echo: opts.echo ?? true, by: opts.by });
  updateBusy(lang);
  try {
    await host().kernelExecute(lang, code, msgId);
  } catch (e) {
    emit('kernel:output', { lang, parentId: msgId, msgType: 'error', content: { ename: 'DataForge', evalue: String(e), traceback: [String(e)] } });
    finish(msgId, 'error');
  }
  return msgId;
}

/**
 * An execution started by someone else in a shared session (shown in the
 * console like a local one; its output arrives as ordinary kernel events).
 */
export function trackExternalExecution(lang: Lang, msgId: string, code: string, by: string) {
  if (pending.has(msgId)) return;
  pending.set(msgId, { lang, start: performance.now() });
  emit('kernel:execution-start', { lang, msgId, code, echo: true, by });
  updateBusy(lang);
}

/** Call a helper function in a running kernel; returns null if the kernel is not ready. */
export async function callHelper<T>(lang: Lang, func: string, args: Record<string, unknown> = {}): Promise<T | null> {
  const st = useKernels.getState().kernels[lang].status;
  if (st !== 'idle' && st !== 'busy') return null;
  return host().kernelCall<T>(lang, func, args);
}

export function isRunning(lang: Lang) {
  const st = useKernels.getState().kernels[lang].status;
  return st === 'idle' || st === 'busy';
}

export async function setWorkdir(path: string) {
  await Promise.all(LANGS.filter(isRunning).map((l) => callHelper<string>(l, 'setwd', { path: kernelPath(path) }).then((cwd) => cwd && patchKernel(l, { cwd }))));
}

/** Test helper. */
export function __resetKernels() {
  pending.clear();
  for (const l of LANGS) {
    delete ready[l];
    generation[l] = 0;
  }
  useKernels.setState({ kernels: { r: initial('r'), python: initial('python') }, interpreters: [], detected: false, detecting: false });
}
