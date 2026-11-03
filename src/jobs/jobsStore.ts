/**
 * Background jobs of the current workspace. Jobs live on the machine of the
 * project (this computer or the SSH host) and outlive the app: the list is
 * read from there, so after a restart or a reconnect the running ones are
 * followed again automatically.
 */
import { create } from 'zustand';
import { host, type JobInfo } from '../core/host';
import { t } from '../core/i18n';
import { isCollabPath, isRemotePath, kernelPath, parseRemote } from '../core/paths';
import { useRemote } from '../remote/remoteStore';
import { getSettings, useSettings } from '../core/settings';
import { toast } from '../core/toast';
import { callHelper, chooseInterpreter, execute, startKernel } from '../kernels/kernels';
import { emptyProgress, eta, foldProgress, overallFraction, type StanProgress } from './progress';
import { importCode, saveDataCode, scriptJob, stanJobScript, type StanJobOptions } from './scripts';

const MAX_LOG = 1_000_000;

export interface JobView {
  info: JobInfo;
  log: string;
  offset: number;
  progress: StanProgress;
  /** (time, fraction) pairs for the ETA. */
  samples: Array<[number, number]>;
  /** The whole log has been read (finished jobs are read once, on demand). */
  complete: boolean;
}

interface JobsState {
  jobs: Record<string, JobView>;
  order: string[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  /** Following the running jobs failed (SSH host unreachable); they keep running there. */
  offline: boolean;
}

export const useJobs = create<JobsState>(() => ({ jobs: {}, order: [], selected: null, loading: false, error: null, offline: false }));

const workdir = () => getSettings().workdir;
const available = () => !isCollabPath(workdir());

const view = (info: JobInfo, old?: JobView): JobView =>
  old ? { ...old, info } : { info, log: '', offset: 0, progress: emptyProgress(), samples: [], complete: false };

/** Jobs that were running when last seen (so finishing while the app was closed is announced). */
const WATCH_KEY = 'dataforge.jobs.watching';
function watching(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}
function saveWatching(ids: Iterable<string>) {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* private mode */
  }
}

export async function refreshJobs() {
  if (!available()) {
    useJobs.setState({ jobs: {}, order: [], error: null });
    return;
  }
  useJobs.setState({ loading: true });
  try {
    const list = await host().jobList(workdir());
    useJobs.setState((s) => {
      const jobs: Record<string, JobView> = {};
      for (const j of list) jobs[j.id] = view(j, s.jobs[j.id]);
      return { jobs, order: list.map((j) => j.id), error: null, selected: s.selected && jobs[s.selected] ? s.selected : (list[0]?.id ?? null) };
    });
    // Finished while we were away (app closed, connection lost): announce once.
    const seen = watching();
    for (const j of list) if (j.status !== 'running' && seen.has(j.id)) void loadLog(j.id).then(() => announce(useJobs.getState().jobs[j.id]));
    for (const j of list) seen.delete(j.id);
    saveWatching([...seen, ...list.filter((j) => j.status === 'running').map((j) => j.id)]);
    const sel = useJobs.getState().selected;
    if (sel) void loadLog(sel).catch(() => undefined);
  } catch (e) {
    useJobs.setState({ error: String(e).replace(/^Error:\s*/, '') });
  } finally {
    useJobs.setState({ loading: false });
  }
}

/** Polls in flight, per job: a second caller waits for the same read. */
const inFlight = new Map<string, Promise<void>>();

/** Read new log text of one job and update its progress. */
function pollJob(id: string): Promise<void> {
  const running = inFlight.get(id);
  if (running) return running;
  const p = pollOnce(id).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

async function pollOnce(id: string): Promise<void> {
  const cur = useJobs.getState().jobs[id];
  if (!cur) return;
  const from = cur.offset;
  const p = await host().jobPoll(workdir(), id, from);
  const was = cur.info.status;
  useJobs.setState((s) => {
    const v = s.jobs[id];
    // Gone, or read from another offset meanwhile (workspace switch): never fold text twice.
    if (!v || v.offset !== from) return {};
    const progress = p.data ? foldProgress(v.progress, p.data) : v.progress;
    const frac = overallFraction(progress);
    const samples = frac != null && p.info.status === 'running' ? [...v.samples, [Date.now(), frac] as [number, number]].slice(-30) : v.samples;
    let log = v.log + p.data;
    if (log.length > MAX_LOG) log = log.slice(log.length - MAX_LOG);
    return { jobs: { ...s.jobs, [id]: { ...v, info: p.info, log, offset: p.nextOffset, progress, samples, complete: p.nextOffset >= p.info.logSize && p.info.status !== 'running' } } };
  });
  if (was === 'running' && p.info.status !== 'running') {
    announce(useJobs.getState().jobs[id]);
    const w = watching();
    w.delete(id);
    saveWatching(w);
  }
}

function announce(v: JobView | undefined) {
  if (!v) return;
  const { info, progress } = v;
  const action = { label: t('jobs.show'), run: () => (selectJob(info.id), void import('../workbench/layout').then((m) => m.revealPanel('jobs'))) };
  if (info.status === 'done') {
    const diag = progress.divergences ? ` · ${t('jobs.divergences', { count: progress.divergences })}` : '';
    toast({
      kind: progress.divergences ? 'info' : 'success',
      title: t('jobs.finished', { name: info.name }) + diag,
      action: info.meta?.result ? { label: t('jobs.import'), run: () => void importResults(info.id) } : action,
    });
  } else if (info.status === 'failed') {
    toast({ kind: 'error', title: t('jobs.failedToast', { name: info.name, code: info.exitCode ?? '?' }), detail: progress.errors[0], action });
  }
}

/** Load the full log of a finished job (once, when it is selected). */
async function loadLog(id: string) {
  for (let i = 0; i < 12; i++) {
    const v = useJobs.getState().jobs[id];
    if (!v || v.complete) return;
    const before = v.offset;
    await pollJob(id);
    if (useJobs.getState().jobs[id]?.offset === before) return;
  }
}

export function selectJob(id: string | null) {
  useJobs.setState({ selected: id });
  if (id) void loadLog(id).catch(() => undefined);
}

// --- polling ----------------------------------------------------------------
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, isRemotePath(workdir()) ? 2000 : 1000);
}
async function tick() {
  if (busy) return schedule();
  busy = true;
  try {
    const running = Object.values(useJobs.getState().jobs).filter((v) => v.info.status === 'running');
    let reached = false;
    let failed = false;
    for (const v of running)
      await pollJob(v.info.id).then(
        () => (reached = true),
        () => (failed = true),
      );
    const offline = failed && !reached;
    if (offline !== useJobs.getState().offline) useJobs.setState({ offline });
  } finally {
    busy = false;
    schedule();
  }
}

export function installJobsListeners(): () => void {
  void refreshJobs();
  schedule();
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.workdir !== prev.workdir) {
      useJobs.setState({ jobs: {}, order: [], selected: null, error: null, offline: false });
      void refreshJobs();
    }
  });
  const onFocus = () => void refreshJobs();
  window.addEventListener('focus', onFocus);
  // Reconnecting to the SSH host of a remote project: follow its jobs again.
  const offRemote = useRemote.subscribe((st, prev) => {
    const id = parseRemote(workdir())?.id;
    if (id && st.connections[id]?.status === 'connected' && prev.connections[id]?.status !== 'connected') void refreshJobs();
  });
  return () => {
    offRemote();
    offSettings();
    window.removeEventListener('focus', onFocus);
    if (timer) clearTimeout(timer);
  };
}

// --- starting, cancelling, importing ------------------------------------------
/** Rscript next to the chosen R interpreter (on the project's machine). */
function rscript(): string {
  const r = chooseInterpreter('r')?.path;
  if (!r) return 'Rscript';
  return r.replace(/R(\.exe)?$/, 'Rscript$1');
}

async function startJob(name: string, kind: string, script: string, meta: Record<string, unknown>): Promise<JobInfo | null> {
  if (!available()) {
    toast({ kind: 'error', title: t('jobs.notInSession') });
    return null;
  }
  try {
    const info = await host().jobStart(workdir(), {
      name,
      kind,
      program: rscript(),
      args: ['-e', 'source(file.path(Sys.getenv("DATAFORGE_JOB_DIR"), "job.R"), echo = FALSE)'],
      cwd: workdir() ?? '',
      files: { 'job.R': script },
      meta,
    });
    useJobs.setState((s) => ({ jobs: { ...s.jobs, [info.id]: view(info) }, order: [info.id, ...s.order.filter((x) => x !== info.id)], selected: info.id }));
    saveWatching([...watching(), info.id]);
    schedule();
    return info;
  } catch (e) {
    toast({ kind: 'error', title: t('jobs.startFailed'), detail: String(e).replace(/^Error:\s*/, '') });
    return null;
  }
}

export interface StanJobRequest {
  name: string;
  options: StanJobOptions;
  /** Console object holding the data list, or null. */
  dataObject: string | null;
  /** Variable to load the fit into. */
  resultName: string;
}

export async function startStanJob(req: StanJobRequest): Promise<JobInfo | null> {
  let dataFile: string | null = null;
  if (req.dataObject) {
    // The console saves the data on the same machine where the job runs.
    if (!(await startKernel('r'))) return null;
    dataFile = `~/.dataforge/job-inputs/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.rds`;
    const code = saveDataCode(req.dataObject, dataFile);
    if (!code) {
      toast({ kind: 'error', title: t('jobs.err.dataObject') });
      return null;
    }
    const out = await callHelper<string>('r', 'ext_eval', { code: `${code}; cat("ok")` }).catch((e) => String(e));
    if (!out?.includes('ok')) {
      toast({ kind: 'error', title: t('jobs.dataSaveFailed', { name: req.dataObject }), detail: out ?? '' });
      return null;
    }
  }
  const options = { ...req.options, stanFile: kernelPath(req.options.stanFile), dataFile };
  return startJob(req.name, 'stan', stanJobScript(options), {
    result: 'fit.rds',
    resultName: req.resultName,
    stan: { backend: options.backend, chains: options.chains, file: options.stanFile, data: req.dataObject },
  });
}

export async function startScriptJob(path: string, keep: boolean): Promise<JobInfo | null> {
  const name = path.split(/[\\/]/).pop() ?? path;
  return startJob(name, 'r-script', scriptJob(kernelPath(path), keep), { result: keep ? 'result.rds' : null, script: path });
}

export async function cancelJob(id: string) {
  try {
    await host().jobCancel(workdir(), id);
    await pollJob(id);
  } catch (e) {
    toast({ kind: 'error', title: t('jobs.cancelFailed'), detail: String(e) });
  }
}

export async function removeJob(id: string) {
  try {
    await host().jobRemove(workdir(), id);
    useJobs.setState((s) => {
      const { [id]: _gone, ...jobs } = s.jobs;
      return { jobs, order: s.order.filter((x) => x !== id), selected: s.selected === id ? null : s.selected };
    });
  } catch (e) {
    toast({ kind: 'error', title: t('jobs.removeFailed'), detail: String(e).replace(/^Error:\s*/, '') });
  }
}

/** Load a finished job's results into the R console. */
export async function importResults(id: string) {
  const v = useJobs.getState().jobs[id];
  if (!v || !v.info.meta?.result) return;
  if (!(await startKernel('r'))) return;
  const code = importCode(v.info.kind, v.info.dir, v.info.meta?.resultName ?? 'fit');
  void import('../workbench/layout').then((m) => m.revealPanel('console', { focus: false }));
  await execute('r', code);
}

/** Running jobs and their combined progress (status bar). */
export function runningSummary(s: JobsState): { count: number; fraction: number | null; eta: number | null } {
  const running = Object.values(s.jobs).filter((v) => v.info.status === 'running');
  const fr = running.map((v) => overallFraction(v.progress)).filter((x): x is number => x != null);
  const etas = running.map((v) => eta(v.samples)).filter((x): x is number => x != null);
  return { count: running.length, fraction: fr.length ? fr.reduce((a, b) => a + b, 0) / fr.length : null, eta: etas.length ? Math.max(...etas) : null };
}
