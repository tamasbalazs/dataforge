/**
 * Debugger: breakpoints, session state and two adapters behind one interface.
 *  - Python: real DAP (debugpy) through the Jupyter debug protocol of the kernel.
 *  - R: the DataForge helper pauses inside the kernel and talks to the host's
 *    debug hub (DAP-shaped commands: variables, evaluate, next, …).
 * Both debug inside the console's session, so the variables are the ones the
 * Environment panel shows.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { emit, on } from '../core/bus';
import { host, type Lang } from '../core/host';
import { t } from '../core/i18n';
import { isNonLocalPath, kernelPath, workspacePath } from '../core/paths';
import { getSettings } from '../core/settings';
import { toast } from '../core/toast';
import { callHelper, execute, interruptKernel, isRunning, LANG_LABEL, startKernel } from '../kernels/kernels';

export interface Frame {
  id: number;
  name: string;
  line: number;
  path: string | null;
}

export interface DVar {
  name: string;
  value: string;
  type?: string;
  ref: number;
}

export type DebugState = 'idle' | 'running' | 'paused';

// ---------------------------------------------------------------------------
// Breakpoints (persisted, by absolute path)

interface BreakpointState {
  byPath: Record<string, number[]>;
}

export const useBreakpoints = create<BreakpointState>()(persist(() => ({ byPath: {} as Record<string, number[]> }), { name: 'dataforge.breakpoints', version: 1 }));

export const debugLangFor = (path: string | null | undefined): Lang | null =>
  !path ? null : /\.r$/i.test(path) ? 'r' : /\.py$/i.test(path) ? 'python' : null;

export function setBreakpoints(path: string, lines: number[]) {
  const uniq = [...new Set(lines)].filter((l) => l > 0).sort((a, b) => a - b);
  useBreakpoints.setState((s) => {
    const byPath = { ...s.byPath };
    if (uniq.length) byPath[path] = uniq;
    else delete byPath[path];
    return { byPath };
  });
  void syncBreakpoints(path);
}

export function toggleBreakpoint(path: string, line: number) {
  const cur = useBreakpoints.getState().byPath[path] ?? [];
  setBreakpoints(path, cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line]);
}

export const clearAllBreakpoints = () => {
  const paths = Object.keys(useBreakpoints.getState().byPath);
  useBreakpoints.setState({ byPath: {} });
  paths.forEach((p) => void syncBreakpoints(p));
};

// ---------------------------------------------------------------------------
// Session state

interface DebugStore {
  lang: Lang | null;
  state: DebugState;
  frames: Frame[];
  frameId: number | null;
  variables: DVar[];
  children: Record<number, DVar[]>;
  watches: string[];
  watchValues: Record<string, string>;
  log: Array<{ expr: string; result: string; ok: boolean }>;
  /** Execution id of the debug run (finishes the session). */
  runId: string | null;
}

export const useDebug = create<DebugStore>()(
  persist(
    (): DebugStore => ({ lang: null, state: 'idle', frames: [], frameId: null, variables: [], children: {}, watches: [], watchValues: {}, log: [], runId: null }),
    { name: 'dataforge.debug', version: 1, partialize: (s) => ({ watches: s.watches }) },
  ),
);

// ---------------------------------------------------------------------------
// Adapters

interface Adapter {
  ready(): Promise<boolean>;
  sync(path: string, lines: number[]): Promise<void>;
  runCode(path: string): string;
  motion(cmd: 'continue' | 'next' | 'stepIn' | 'stepOut'): Promise<void>;
  terminate(): Promise<void>;
  variables(frameId: number | null, ref?: number): Promise<DVar[]>;
  evaluate(expr: string, frameId: number | null): Promise<{ result: string; ok: boolean; ref: number }>;
}

/** Paths in code sent to a kernel: as the kernel's machine sees them. */
const jsonStr = (s: string) => JSON.stringify(kernelPath(s).replace(/\\/g, '/'));
const toKernel = (p: string) => kernelPath(p);
const fromKernel = (p: string | null | undefined) => (p ? workspacePath(p, getSettings().workdir) : null);

// Python: DAP over the Jupyter debug protocol --------------------------------
let pySeq = 0;
let pyInit: Promise<boolean> | null = null;
let pyTmpPrefix = '';
let pyThread: number | null = null;

async function dap<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await host().kernelDebug<any>('python', { type: 'request', seq: ++pySeq, command, arguments: args });
  if (res?.success === false) throw new Error(res.message || `${command} failed`);
  return res?.body as T;
}

const python: Adapter = {
  ready() {
    pyInit ??= (async () => {
      if (!(await startKernel('python'))) return false;
      try {
        await dap('initialize', { clientID: 'dataforge', clientName: 'DataForge', adapterID: 'python', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true, supportsVariableType: true, locale: 'en' });
        await dap('attach', {});
        const info = await dap<any>('debugInfo', {});
        pyTmpPrefix = info?.tmpFilePrefix ?? '';
        for (const [path, lines] of Object.entries(useBreakpoints.getState().byPath)) {
          if (debugLangFor(path) === 'python') await dap('setBreakpoints', { source: { path: toKernel(path) }, breakpoints: lines.map((line) => ({ line })), sourceModified: false });
        }
        await dap('configurationDone', {});
        return true;
      } catch (e) {
        pyInit = null;
        toast({ kind: 'error', title: t('debug.pyUnavailable'), detail: String(e) });
        return false;
      }
    })();
    return pyInit;
  },
  async sync(path, lines) {
    if (!pyInit || !(await pyInit)) return; // sent on first start
    await dap('setBreakpoints', { source: { path: toKernel(path) }, breakpoints: lines.map((line) => ({ line })), sourceModified: false });
  },
  runCode: (path) => `debugfile(${jsonStr(path)})`,
  async motion(cmd) {
    if (pyThread == null) return;
    await dap(cmd, { threadId: pyThread });
  },
  async terminate() {
    await interruptKernel('python');
    if (pyThread != null) await dap('continue', { threadId: pyThread }).catch(() => undefined);
  },
  async variables(frameId, ref) {
    let vref = ref;
    if (!vref) {
      if (frameId == null) return [];
      const scopes = await dap<any>('scopes', { frameId });
      vref = scopes?.scopes?.[0]?.variablesReference;
      if (!vref) return [];
    }
    const body = await dap<any>('variables', { variablesReference: vref });
    return (body?.variables ?? []).map((v: any) => ({ name: v.name, value: v.value, type: v.type, ref: v.variablesReference ?? 0 }));
  },
  async evaluate(expr, frameId) {
    try {
      const body = await dap<any>('evaluate', { expression: expr, frameId: frameId ?? undefined, context: 'repl' });
      return { result: body?.result ?? '', ok: true, ref: body?.variablesReference ?? 0 };
    } catch (e) {
      return { result: String(e).replace(/^Error:\s*/, ''), ok: false, ref: 0 };
    }
  },
};

async function pyStopped(threadId: number) {
  pyThread = threadId;
  const body = await dap<any>('stackTrace', { threadId });
  const frames: Frame[] = (body?.stackFrames ?? [])
    .filter((f: any) => !(pyTmpPrefix && f.source?.path?.startsWith(pyTmpPrefix)))
    .map((f: any) => ({ id: f.id, name: f.name, line: f.line, path: fromKernel(f.source?.path) }));
  await paused('python', frames);
}

// R: helper + host debug hub --------------------------------------------------
const r: Adapter = {
  async ready() {
    if (isNonLocalPath(getSettings().workdir)) {
      // The R debugger talks to DataForge over a local HTTP bridge.
      toast({ kind: 'info', title: t('remote.rDebugUnavailable') });
      return false;
    }
    return startKernel('r');
  },
  async sync(path, lines) {
    if (!isRunning('r')) return;
    const s = useDebug.getState();
    if (s.lang === 'r' && s.state === 'paused') await host().rDebug({ command: 'setBreakpoints', path, lines }, true);
    else await callHelper('r', 'dbg_set_breakpoints', { path, lines });
  },
  runCode: (path) => `debugSource(${jsonStr(path)})`,
  async motion(cmd) {
    await host().rDebug({ command: cmd }, false);
  },
  async terminate() {
    await host().rDebug({ command: 'terminate' }, false);
  },
  async variables(frameId, ref) {
    const list = await host().rDebug<any[]>(ref ? { command: 'variables', ref } : { command: 'variables', frameId }, true);
    return (Array.isArray(list) ? list : []).map((v) => ({ name: v.name, value: v.value, type: v.type, ref: v.variablesReference ?? 0 }));
  },
  async evaluate(expr, frameId) {
    const res = await host().rDebug<any>({ command: 'evaluate', expression: expr, frameId }, true);
    return { result: res?.result ?? '', ok: res?.ok !== false, ref: res?.variablesReference ?? 0 };
  },
};

const adapters: Record<Lang, Adapter> = { python, r };
const adapter = () => {
  const lang = useDebug.getState().lang;
  return lang ? adapters[lang] : null;
};

async function syncBreakpoints(path: string) {
  const lang = debugLangFor(path);
  if (!lang) return;
  const lines = useBreakpoints.getState().byPath[path] ?? [];
  try {
    await adapters[lang].sync(path, lines);
  } catch (e) {
    console.warn('breakpoint sync failed', e);
  }
}

// ---------------------------------------------------------------------------
// Session control

let revealHook: ((path: string, line: number) => void) | null = null;
/** The editor registers how to show the paused location (keeps this module UI-free). */
export const setRevealHook = (h: typeof revealHook) => (revealHook = h);

async function paused(lang: Lang, frames: Frame[]) {
  const frameId = frames[0]?.id ?? null;
  useDebug.setState({ lang, state: 'paused', frames, frameId, variables: [], children: {} });
  emit('debug:paused', { lang });
  void import('../workbench/layout').then((m) => m.revealPanel('debug', { focus: false }));
  const top = frames[0];
  if (top?.path) revealHook?.(top.path, top.line);
  await Promise.all([loadVariables(), refreshWatches()]);
}

export async function selectFrame(id: number) {
  useDebug.setState({ frameId: id, variables: [], children: {} });
  const f = useDebug.getState().frames.find((x) => x.id === id);
  if (f?.path) revealHook?.(f.path, f.line);
  await Promise.all([loadVariables(), refreshWatches()]);
}

async function loadVariables() {
  const a = adapter();
  if (!a) return;
  try {
    useDebug.setState({ variables: await a.variables(useDebug.getState().frameId) });
  } catch (e) {
    console.warn('variables failed', e);
  }
}

export async function expandVariable(ref: number) {
  const a = adapter();
  if (!a || !ref || useDebug.getState().children[ref]) return;
  const vars = await a.variables(null, ref).catch(() => []);
  useDebug.setState((s) => ({ children: { ...s.children, [ref]: vars } }));
}

async function refreshWatches() {
  const a = adapter();
  const { watches, frameId } = useDebug.getState();
  if (!a || !watches.length) return;
  const values: Record<string, string> = {};
  for (const w of watches) values[w] = (await a.evaluate(w, frameId).catch((e) => ({ result: String(e) }))).result;
  useDebug.setState({ watchValues: values });
}

export function addWatch(expr: string) {
  const e = expr.trim();
  if (!e) return;
  useDebug.setState((s) => ({ watches: s.watches.includes(e) ? s.watches : [...s.watches, e] }));
  if (useDebug.getState().state === 'paused') void refreshWatches();
}

export const removeWatch = (expr: string) => useDebug.setState((s) => ({ watches: s.watches.filter((w) => w !== expr) }));

export async function evaluateInFrame(expr: string) {
  const a = adapter();
  if (!a || useDebug.getState().state !== 'paused' || !expr.trim()) return;
  const res = await a.evaluate(expr, useDebug.getState().frameId);
  useDebug.setState((s) => ({ log: [...s.log, { expr, result: res.result, ok: res.ok }].slice(-200) }));
  void loadVariables(); // the expression may have changed something
}

/** F5: start debugging the given file (or continue when paused). */
export async function startDebugging(path: string | null) {
  const s = useDebug.getState();
  if (s.state === 'paused') return motion('continue');
  if (s.state === 'running') return;
  const lang = debugLangFor(path);
  if (!path || !lang) {
    toast({ kind: 'info', title: t('debug.notDebuggable') });
    return;
  }
  const a = adapters[lang];
  if (!(await a.ready())) return;
  await syncBreakpoints(path);
  if (!(useBreakpoints.getState().byPath[path] ?? []).length) toast({ kind: 'info', title: t('debug.noBreakpoints') });
  useDebug.setState({ lang, state: 'running', frames: [], frameId: null, variables: [], children: {}, log: [] });
  const id = await execute(lang, a.runCode(path));
  useDebug.setState({ runId: id });
}

export async function motion(cmd: 'continue' | 'next' | 'stepIn' | 'stepOut') {
  const a = adapter();
  if (!a || useDebug.getState().state !== 'paused') return;
  useDebug.setState({ state: 'running' });
  try {
    await a.motion(cmd);
  } catch (e) {
    toast({ kind: 'error', title: t('debug.commandFailed'), detail: String(e) });
  }
}

export async function stopDebugging() {
  const a = adapter();
  const s = useDebug.getState();
  if (!a || s.state === 'idle') return;
  try {
    if (s.state === 'paused') await a.terminate();
    else if (s.lang) await interruptKernel(s.lang);
  } finally {
    end();
  }
}

function end() {
  useDebug.setState({ state: 'idle', frames: [], frameId: null, variables: [], children: {}, runId: null });
  emit('debug:ended', {});
}

export function installDebugListeners(): () => void {
  const offs = [
    host().onKernelEvent((ev) => {
      if (ev.kernelId !== 'python' || ev.msgType !== 'debug_event') return;
      const c = ev.content;
      if (c.event === 'stopped') void pyStopped(c.body?.threadId);
      else if (c.event === 'continued') useDebug.setState((s) => (s.lang === 'python' && s.state === 'paused' ? { state: 'running' } : {}));
    }),
    host().onRDebugEvent((e) => {
      if (e.event === 'stopped') {
        const frames: Frame[] = (e.frames ?? []).map((f: any) => ({ id: f.id, name: f.name, line: f.line, path: f.path ?? null }));
        void paused('r', frames);
      } else if (e.event === 'continued') {
        useDebug.setState((s) => (s.lang === 'r' && s.state === 'paused' ? { state: 'running' } : {}));
      } else if (e.event === 'terminated' && useDebug.getState().lang === 'r') {
        end();
      }
    }),
    on('kernel:execution-done', ({ lang, msgId }) => {
      const s = useDebug.getState();
      // The debug run (or a console call that hit a breakpoint) has finished.
      if (s.lang === lang && s.state === 'running' && (s.runId === null || msgId === s.runId)) end();
    }),
    on('kernel:status', ({ lang, status }) => {
      if (lang === 'python' && (status === 'starting' || status === 'dead')) {
        pyInit = null;
        pyThread = null;
      }
      if ((status === 'dead' || status === 'starting') && useDebug.getState().lang === lang) end();
    }),
    on('kernel:ready', ({ lang }) => {
      // A fresh R session gets the breakpoints right away (they also fire for
      // functions called from the console).
      if (lang === 'r') for (const p of Object.keys(useBreakpoints.getState().byPath)) if (debugLangFor(p) === 'r') void syncBreakpoints(p);
    }),
  ];
  return () => offs.forEach((o) => o());
}

export const debugStatusText = (s: Pick<DebugStore, 'lang' | 'state' | 'frames'>) =>
  s.state === 'idle' || !s.lang
    ? ''
    : s.state === 'running'
      ? t('debug.running', { lang: LANG_LABEL[s.lang] })
      : t('debug.pausedAt', { name: s.frames[0]?.name === '<script>' ? t('debug.script') : (s.frames[0]?.name ?? '?'), line: s.frames[0]?.line ?? '?' });
