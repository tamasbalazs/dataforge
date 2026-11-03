/**
 * R scripts for background jobs. Jobs run in a fresh `Rscript` process (not in
 * the console), on the machine of the project; results are written into the
 * job folder ($DATAFORGE_JOB_DIR) and loaded into the console on request.
 */

export const rStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const isRName = (s: string) => /^[A-Za-z.][A-Za-z0-9._]*$/.test(s) && !/^\.\d/.test(s);

export interface StanJobOptions {
  backend: 'cmdstanr' | 'rstan';
  /** Path of the .stan file on the job's machine. */
  stanFile: string;
  /** RDS file holding the data list (saved from the console), or null for no data. */
  dataFile: string | null;
  chains: number;
  parallelChains: number;
  iterWarmup: number;
  iterSampling: number;
  seed: number | null;
  adaptDelta: number;
  maxTreedepth: number;
  refresh: number;
}

export const defaultStanOptions = (stanFile: string): StanJobOptions => ({
  backend: 'cmdstanr',
  stanFile,
  dataFile: null,
  chains: 4,
  parallelChains: 4,
  iterWarmup: 1000,
  iterSampling: 1000,
  seed: 1234,
  adaptDelta: 0.8,
  maxTreedepth: 10,
  refresh: 100,
});

/** Problems with the options (empty = fine). Keys are i18n keys. */
export function validateStanOptions(o: StanJobOptions): string[] {
  const bad: string[] = [];
  const int = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;
  if (!int(o.chains, 1, 128)) bad.push('jobs.err.chains');
  if (!int(o.parallelChains, 1, 128)) bad.push('jobs.err.parallel');
  if (!int(o.iterWarmup, 0, 10_000_000) || !int(o.iterSampling, 1, 10_000_000)) bad.push('jobs.err.iter');
  if (o.seed != null && !int(o.seed, 0, 2_147_483_647)) bad.push('jobs.err.seed');
  if (!(o.adaptDelta > 0 && o.adaptDelta < 1)) bad.push('jobs.err.adaptDelta');
  if (!int(o.maxTreedepth, 1, 30)) bad.push('jobs.err.treedepth');
  if (!int(o.refresh, 1, 1_000_000)) bad.push('jobs.err.refresh');
  return bad;
}

/**
 * Above this many draws per variable the summary (R-hat/ESS over every draw)
 * would take minutes after sampling; it is left to the console instead.
 */
export const SUMMARY_MAX_DRAWS = 1_000_000;

/** The result of a Stan job: fit.rds in the job folder. */
export const STAN_RESULT = 'fit.rds';
/** The result of an R script job: the global environment as a named list. */
export const SCRIPT_RESULT = 'result.rds';

export function stanJobScript(o: StanJobOptions): string {
  const head = [
    `# DataForge background job – Stan sampling with ${o.backend}`,
    'job_dir <- Sys.getenv("DATAFORGE_JOB_DIR")',
    o.dataFile ? `stan_data <- readRDS(${rStr(o.dataFile)})` : 'stan_data <- list()',
  ];
  const seed = o.seed == null ? '' : `, seed = ${o.seed}`;
  const big = o.chains * o.iterSampling > SUMMARY_MAX_DRAWS;
  const skipped = `cat("\\nDataForge: summary skipped (${o.chains * o.iterSampling} draws per variable); load the fit and summarise it in the console.\\n")`;
  if (o.backend === 'cmdstanr') {
    return [
      ...head,
      'library(cmdstanr)',
      `cat("DataForge: compiling", ${rStr(o.stanFile)}, "\\n")`,
      `mod <- cmdstan_model(${rStr(o.stanFile)})`,
      'dir.create(file.path(job_dir, "draws"), showWarnings = FALSE)',
      `fit <- mod$sample(data = stan_data, chains = ${o.chains}, parallel_chains = ${o.parallelChains}, iter_warmup = ${o.iterWarmup}, iter_sampling = ${o.iterSampling}${seed}, adapt_delta = ${o.adaptDelta}, max_treedepth = ${o.maxTreedepth}, refresh = ${o.refresh}, output_dir = file.path(job_dir, "draws"))`,
      `fit$save_object(file.path(job_dir, ${rStr(STAN_RESULT)}))`,
      'cat("\\nDataForge: diagnostics\\n"); print(fit$diagnostic_summary())',
      big ? skipped : 'cat("\\nDataForge: summary\\n"); print(fit$summary(), n = 50)',
      '',
    ].join('\n');
  }
  return [
    ...head,
    'library(rstan)',
    'rstan_options(auto_write = TRUE)',
    `cat("DataForge: compiling", ${rStr(o.stanFile)}, "\\n")`,
    `fit <- stan(file = ${rStr(o.stanFile)}, data = stan_data, chains = ${o.chains}, cores = ${o.parallelChains}, warmup = ${o.iterWarmup}, iter = ${o.iterWarmup + o.iterSampling}${seed}, refresh = ${o.refresh}, control = list(adapt_delta = ${o.adaptDelta}, max_treedepth = ${o.maxTreedepth}))`,
    `saveRDS(fit, file.path(job_dir, ${rStr(STAN_RESULT)}))`,
    'cat("\\nDataForge: diagnostics\\n"); rstan::check_hmc_diagnostics(fit)',
    big ? skipped : 'cat("\\nDataForge: summary\\n"); print(fit)',
    '',
  ].join('\n');
}

/**
 * Run an R script as a job (brms and anything else). With `keep`, every object
 * the script creates is saved so it can be loaded into the console afterwards.
 */
export function scriptJob(scriptPath: string, keep: boolean): string {
  return [
    '# DataForge background job – R script',
    'job_dir <- Sys.getenv("DATAFORGE_JOB_DIR")',
    `source(${rStr(scriptPath)}, echo = TRUE, max.deparse.length = Inf, spaced = TRUE)`,
    ...(keep
      ? [
          '.df_keep <- setdiff(ls(globalenv()), "job_dir")',
          `saveRDS(mget(.df_keep, envir = globalenv()), file.path(job_dir, ${rStr(SCRIPT_RESULT)}))`,
          'cat("\\nDataForge: saved", length(.df_keep), "object(s)\\n")',
        ]
      : []),
    '',
  ].join('\n');
}

/** R code (for the console) that loads a finished job's results. */
export function importCode(kind: string, dir: string, varName = 'fit'): string {
  const file = (n: string) => `file.path(${rStr(dir)}, ${rStr(n)})`;
  if (kind === 'stan') {
    const v = isRName(varName) ? varName : 'fit';
    return `${v} <- readRDS(${file(STAN_RESULT)})`;
  }
  return `invisible(list2env(readRDS(${file(SCRIPT_RESULT)}), envir = globalenv()))`;
}

/** Console code that saves the data list for a job (on the job's machine). */
export function saveDataCode(objectName: string, path: string): string | null {
  if (!isRName(objectName)) return null;
  return `local({ dir.create(dirname(${rStr(path)}), recursive = TRUE, showWarnings = FALSE); saveRDS(${objectName}, ${rStr(path)}) })`;
}
