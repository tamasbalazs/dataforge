import { describe, expect, it } from 'vitest';
import { emptyProgress, eta, foldProgress, formatDuration, overallFraction } from './progress';
import { defaultStanOptions, importCode, saveDataCode, scriptJob, stanJobScript, validateStanOptions } from './scripts';

const CMDSTANR = `Running MCMC with 2 parallel chains...

Chain 1 Iteration:    1 / 2000 [  0%]  (Warmup)
Chain 2 Iteration:    1 / 2000 [  0%]  (Warmup)
Chain 1 Iteration:  500 / 2000 [ 25%]  (Warmup)
Chain 2 Iteration: 1001 / 2000 [ 50%]  (Sampling)
Chain 2 Iteration: 2000 / 2000 [100%]  (Sampling)
Chain 2 finished in 3.4 seconds.
`;

const RSTAN = `SAMPLING FOR MODEL 'anon_model' NOW (CHAIN 1).
Chain 1: Iteration:   1 / 600 [  0%]  (Warmup)
Chain 2: Iteration: 150 / 600 [ 25%]  (Warmup)
Chain 2: Iteration: 301 / 600 [ 50%]  (Sampling)
Chain 1:  Elapsed Time: 0.004 seconds (Warm-up)
Chain 1:                0.003 seconds (Sampling)
Chain 1:                0.007 seconds (Total)
Warning messages:
1: There were 12 divergent transitions after warmup. See
2: Examine the pairs() plot to diagnose sampling problems
`;

describe('Stan sampling progress', () => {
  it('reads cmdstanr output, also when lines arrive in pieces', () => {
    let p = emptyProgress();
    // Split in the middle of a line, as log polling does.
    const cut = CMDSTANR.indexOf('[ 25%]');
    p = foldProgress(p, CMDSTANR.slice(0, cut));
    expect(p.chains[1]?.iter).toBe(1);
    p = foldProgress(p, CMDSTANR.slice(cut));
    expect(p.expectedChains).toBe(2);
    expect(p.chains[1]).toMatchObject({ iter: 500, total: 2000, phase: 'warmup' });
    expect(p.chains[2]).toMatchObject({ phase: 'done', seconds: 3.4 });
    expect(overallFraction(p)).toBeCloseTo((500 + 2000) / 4000);
  });

  it('reads rstan output, divergences and errors', () => {
    const p = foldProgress(emptyProgress(), RSTAN + 'Error in eval(ei, envir) : object "y" not found\n');
    expect(p.chains[1]).toMatchObject({ phase: 'done', seconds: 0.007 });
    expect(p.chains[2]).toMatchObject({ iter: 301, phase: 'sampling' });
    expect(p.divergences).toBe(12);
    expect(p.errors).toEqual(['Error in eval(ei, envir) : object "y" not found']);
    const two = foldProgress(emptyProgress(), "Error in validate_cmdstan_args(self) :\n  Assertion on 'self$output_dir' failed: Directory does not exist.\n");
    expect(two.errors).toEqual(["Error in validate_cmdstan_args(self) : Assertion on 'self$output_dir' failed: Directory does not exist."]);
    const c = foldProgress(emptyProgress(), 'Warning: 7 of 4000 (0.0%) transitions ended with a divergence.\n3 of 4000 (0.0%) transitions hit the maximum treedepth limit of 10.\n');
    expect(c.divergences).toBe(7);
    expect(c.treedepthHits).toBe(3);
    // cmdstanr prints the total again in diagnostic_summary(): not added up.
    const twice = foldProgress(c, 'Warning: 7 of 4000 (0.0%) transitions ended with a divergence.\n');
    expect(twice.divergences).toBe(7);
  });

  it('estimates the remaining time', () => {
    expect(eta([[0, 0.1]])).toBeNull();
    expect(eta([[0, 0.1], [10_000, 0.2]])).toBeCloseTo(80);
    expect(eta([[0, 0.5], [1000, 1]])).toBe(0);
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(3725)).toBe('1 h 2 min');
  });
});

describe('job scripts', () => {
  it('cmdstanr and rstan sampling scripts', () => {
    const o = { ...defaultStanOptions('/p/model "1".stan'), dataFile: '~/.dataforge/job-inputs/x.rds' };
    const cmd = stanJobScript(o);
    expect(cmd).toContain('mod <- cmdstan_model("/p/model \\"1\\".stan")');
    expect(cmd).toContain('stan_data <- readRDS("~/.dataforge/job-inputs/x.rds")');
    expect(cmd).toContain('chains = 4, parallel_chains = 4, iter_warmup = 1000, iter_sampling = 1000, seed = 1234, adapt_delta = 0.8');
    expect(cmd).toContain('fit$save_object(file.path(job_dir, "fit.rds"))');
    expect(cmd.indexOf('dir.create(file.path(job_dir, "draws")')).toBeLessThan(cmd.indexOf('mod$sample('));
    const rs = stanJobScript({ ...o, backend: 'rstan', seed: null, iterWarmup: 500, iterSampling: 700 });
    expect(rs).toContain('warmup = 500, iter = 1200, refresh = 100');
    expect(rs).not.toContain('seed');
    expect(rs).toContain('saveRDS(fit, file.path(job_dir, "fit.rds"))');
    // Huge fits: the summary over every draw is left to the console.
    const big = stanJobScript({ ...o, chains: 4, iterSampling: 3_000_000 });
    expect(big).not.toContain('fit$summary()');
    expect(big).toContain('summary skipped (12000000 draws per variable)');
    expect(big).toContain('fit$save_object(');
  });

  it('validates options', () => {
    const o = defaultStanOptions('/m.stan');
    expect(validateStanOptions(o)).toEqual([]);
    expect(validateStanOptions({ ...o, chains: 0, adaptDelta: 1, seed: -1 })).toEqual(['jobs.err.chains', 'jobs.err.seed', 'jobs.err.adaptDelta']);
  });

  it('script jobs, imports and data hand-over', () => {
    const s = scriptJob('/p/fit brms.R', true);
    expect(s).toContain('source("/p/fit brms.R", echo = TRUE');
    expect(s).toContain('saveRDS(mget(.df_keep, envir = globalenv()), file.path(job_dir, "result.rds"))');
    expect(scriptJob('/p/a.R', false)).not.toContain('saveRDS');
    expect(importCode('stan', '/h/.dataforge/jobs/1', 'fit_hier')).toBe('fit_hier <- readRDS(file.path("/h/.dataforge/jobs/1", "fit.rds"))');
    expect(importCode('stan', '/d', 'bad name; system("x")')).toBe('fit <- readRDS(file.path("/d", "fit.rds"))');
    expect(importCode('r-script', '/d')).toBe('invisible(list2env(readRDS(file.path("/d", "result.rds")), envir = globalenv()))');
    expect(saveDataCode('stan_data', '~/.dataforge/job-inputs/a.rds')).toContain('saveRDS(stan_data, "~/.dataforge/job-inputs/a.rds")');
    expect(saveDataCode('x; system("rm")', '/a')).toBeNull();
  });
});
