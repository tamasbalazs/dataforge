/**
 * Sampling progress from Stan output, as printed by cmdstanr, rstan and brms
 * (either backend):
 *   cmdstanr: "Chain 2 Iteration:  400 / 2000 [ 20%]  (Warmup)", "Chain 2 finished in 3.1 seconds."
 *   rstan:    "Chain 2: Iteration:  400 / 2000 [ 20%]  (Warmup)", "Chain 2:  Elapsed Time: …"
 * plus the usual warnings (divergences, max treedepth, R-hat/ESS) and errors.
 */

export type Phase = 'warmup' | 'sampling' | 'done';

export interface ChainProgress {
  chain: number;
  iter: number;
  total: number;
  phase: Phase;
  /** Seconds the chain took (when reported). */
  seconds?: number;
}

export interface StanProgress {
  chains: Record<number, ChainProgress>;
  /** Number of chains announced (cmdstanr: "Running MCMC with 4 chains"). */
  expectedChains: number | null;
  divergences: number | null;
  treedepthHits: number | null;
  /** Other notable warnings (R-hat, ESS, E-BFMI …), deduplicated. */
  warnings: string[];
  errors: string[];
  /** Incomplete last line kept for the next chunk. */
  rest: string;
  /** "Error in f(x) :" waiting for its message on the next line. */
  pendingError?: string;
}

export const emptyProgress = (): StanProgress => ({ chains: {}, expectedChains: null, divergences: null, treedepthHits: null, warnings: [], errors: [], rest: '' });

const ITER = /Chain\s+(\d+):?\s+Iteration:\s*(\d+)\s*\/\s*(\d+)\s*\[\s*\d+%\]\s*\((Warmup|Sampling)\)/;
const FINISHED = /Chain\s+(\d+)\s+finished in\s+([\d.]+)\s+seconds?/;
const RSTAN_ELAPSED = /Chain\s+(\d+):\s+([\d.]+)\s+seconds\s+\(Total\)/;
const RUNNING = /Running MCMC with (\d+) (?:sequential|parallel)? ?chains?/;
const CMDSTAN_DIV = /(\d+) of \d+ \([\d.]+%\) transitions ended with a divergence/;
const RSTAN_DIV = /There were (\d+) divergent transitions after warmup/;
const CMDSTAN_TD = /(\d+) of \d+ \([\d.]+%\) transitions hit the maximum treedepth/;
const RSTAN_TD = /There were (\d+) transitions after warmup that exceeded the maximum treedepth/;
const WARN = /(R-hat|Rhat|Bulk Effective Samples Size|Tail Effective Samples Size|E-BFMI|ESS) .*(too low|too high|is NA|indicat)/i;
const ERROR = /^(Error|Fehler|Hiba)\b.*|^\s*Chain \d+ (finished unexpectedly|.*error)/i;

/** Fold a new chunk of output into the progress (pure; returns a new object). */
export function foldProgress(prev: StanProgress, chunk: string): StanProgress {
  const p: StanProgress = { ...prev, chains: { ...prev.chains }, warnings: [...prev.warnings], errors: [...prev.errors] };
  const text = prev.rest + chunk.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  p.rest = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (p.pendingError) {
      // R prints "Error in f(x) :" and the cause on the next line.
      const full = `${p.pendingError} ${line}`;
      p.pendingError = undefined;
      if (!p.errors.includes(full) && p.errors.length < 20) p.errors.push(full);
      continue;
    }
    if (/^Error in .*:\s*$/.test(line)) {
      p.pendingError = line;
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = ITER.exec(line))) {
      const chain = Number(m[1]);
      const iter = Number(m[2]);
      const total = Number(m[3]);
      const old = p.chains[chain];
      if (old?.phase !== 'done') p.chains[chain] = { chain, iter, total, phase: m[4] === 'Warmup' ? 'warmup' : 'sampling', seconds: old?.seconds };
      if (iter >= total) p.chains[chain] = { ...p.chains[chain], phase: 'done' };
    } else if ((m = FINISHED.exec(line)) || (m = RSTAN_ELAPSED.exec(line))) {
      const chain = Number(m[1]);
      const old = p.chains[chain] ?? { chain, iter: 0, total: 0, phase: 'done' as Phase };
      p.chains[chain] = { ...old, iter: old.total || old.iter, phase: 'done', seconds: Number(m[2]) };
    } else if ((m = RUNNING.exec(line))) {
      p.expectedChains = Number(m[1]);
    } else if ((m = CMDSTAN_DIV.exec(line)) || (m = RSTAN_DIV.exec(line))) {
      // Totals over all chains; cmdstanr repeats them (sample(), diagnostic_summary()).
      p.divergences = Number(m[1]);
    } else if ((m = CMDSTAN_TD.exec(line)) || (m = RSTAN_TD.exec(line))) {
      p.treedepthHits = Number(m[1]);
    } else if (WARN.test(line)) {
      if (!p.warnings.includes(line)) p.warnings.push(line);
    } else if (ERROR.test(line)) {
      if (!p.errors.includes(line) && p.errors.length < 20) p.errors.push(line);
    }
  }
  return p;
}

/** Overall fraction done (0..1) over all expected chains, or null without chain output. */
export function overallFraction(p: StanProgress): number | null {
  const chains = Object.values(p.chains);
  if (!chains.length) return null;
  const n = Math.max(p.expectedChains ?? 0, chains.length);
  const total = chains[0].total || 1;
  const done = chains.reduce((s, c) => s + (c.phase === 'done' ? c.total || total : c.iter), 0);
  return Math.min(1, done / (n * total));
}

/**
 * Remaining time from the observed rate: samples are (time ms, fraction).
 * Returns seconds, or null until there is enough to estimate.
 */
export function eta(samples: Array<[number, number]>): number | null {
  if (samples.length < 2) return null;
  const [t0, f0] = samples[0];
  const [t1, f1] = samples[samples.length - 1];
  if (f1 <= f0 || t1 <= t0 || f1 >= 1) return f1 >= 1 ? 0 : null;
  const rate = (f1 - f0) / ((t1 - t0) / 1000);
  return (1 - f1) / rate;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}
