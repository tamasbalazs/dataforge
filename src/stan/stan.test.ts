import { describe, expect, it } from 'vitest';
import { DISTRIBUTIONS, distributionFunctions, lookup } from './catalog';
import { includeAware } from './language';
import { declaredTypes, parseMessages, placeUnlocated, rDataTemplate, type StanInfo } from './stanc';
import { SAMPLES } from './stancSamples.test-data';
import { findChunks, stanChunkR } from '../panels/editor/chunks';

const MODEL = 'data { int N; vector[N] y; }\nparameters { real mu; real<lower=0> sigma; }\nmodel { y ~ normal(mu, sigma); }\n';

describe('stanc messages', () => {
  it('semantic and syntax errors: position, span and the explanation', () => {
    const [sem] = parseMessages([...SAMPLES.semantic.errors], 'error');
    expect(sem).toMatchObject({ severity: 'error', line: 3, column: 9, endColumn: 32 });
    expect(sem.message).toBe("Ill-typed arguments to '~' statement. No function 'normall_lpdf' was found when looking for distribution 'normall'.");
    const [syn] = parseMessages([...SAMPLES.syntax.errors], 'error');
    expect(syn).toMatchObject({ severity: 'error', line: 3, column: 31, endColumn: 32 });
    expect(syn.message).toMatch(/^Ill-formed "~"-statement/);
    const [und] = parseMessages([...SAMPLES.undeclared.errors], 'error');
    expect(und.message).toBe("Identifier 'tau' not in scope. Did you mean 'tan'?");
    expect(und).toMatchObject({ line: 3, column: 24, endColumn: 27 });
  });

  it('keeps multi-line hints (old array syntax)', () => {
    const [d] = parseMessages([...SAMPLES.deprecated.errors], 'error');
    expect(d.message).toContain('old array syntax');
    expect(d.message).toContain('array[2] real x;');
  });

  it('includes become one info marker', () => {
    const code = '#include foo.stan\nparameters { real x; } model { x ~ normal(0,1); }\n';
    const diags = includeAware(code, parseMessages([...SAMPLES.include.errors], 'error'));
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: 'info', line: 1 });
  });

  it('pedantic warnings without a position go to the declaration', () => {
    const diags = placeUnlocated(MODEL, parseMessages([...SAMPLES.pedantic.warnings], 'warning'));
    expect(diags.map((d) => [d.severity, d.line, d.column])).toEqual([
      ['warning', 2, 37],
      ['warning', 2, 19],
    ]);
    expect(diags[0].message).toMatch(/^The parameter sigma has no priors/);
  });

  it('newer codespan-style reports', () => {
    const report = 'error: Ill-typed "~"-statement.\n    ┌─ string:3:37\n  3 │  model { mu ~ normall(0, 1); }\n    │              ^^^^^^^ No function "normall_lpdf" was found\n    │                      when looking for distribution "normall".\n';
    const [d] = parseMessages(['0', report], 'error');
    expect(d).toMatchObject({ line: 3, column: 37, endColumn: 44 });
    expect(d.message).toBe('Ill-typed "~"-statement. – No function "normall_lpdf" was found when looking for distribution "normall".');
  });
});

describe('data template', () => {
  it('uses declared types and dimensions from stanc --info', () => {
    expect(declaredTypes('data {\n  int<lower=0> N; // count\n  vector[N] y;\n  array[N, 2] int<lower=0, upper=1> z;\n}\nparameters { real a; }')).toEqual({ N: 'int<lower=0>', y: 'vector[N]', z: 'array[N, 2] int<lower=0, upper=1>' });
    const t = rDataTemplate(SAMPLES.info as unknown as StanInfo, MODEL);
    expect(t).toBe('stan_data <- list(\n  N = NA_integer_,  # int\n  y = numeric(0)  # vector[N]\n)');
    const info = { inputs: { X: { type: 'real', dimensions: 2 }, k: { type: 'int', dimensions: 3 } } } as unknown as StanInfo;
    expect(rDataTemplate(info)).toContain('X = matrix(numeric(0), 0, 0),');
    expect(rDataTemplate(info)).toContain('k = array(integer(0), dim = rep(0, 3))');
  });
});

describe('catalog', () => {
  it('derives lpdf/lpmf/rng names and finds them', () => {
    const normal = DISTRIBUTIONS.find((d) => d.name === 'normal')!;
    expect(distributionFunctions(normal).map((f) => f.name)).toEqual(['normal_lpdf', 'normal_lupdf', 'normal_lcdf', 'normal_lccdf', 'normal_rng']);
    const pois = DISTRIBUTIONS.find((d) => d.name === 'poisson_log')!;
    expect(distributionFunctions(pois).map((f) => f.name)).toEqual(['poisson_log_lpmf', 'poisson_log_lupmf', 'poisson_log_rng']);
    expect(lookup('neg_binomial_2_lpmf')?.sig).toBe('(n | mu, phi)');
    expect(lookup('cholesky_decompose')?.doc).toMatch(/Cholesky/);
  });
});

describe('{stan} chunks', () => {
  it('finds stan chunks with output.var and compiles them like knitr would', () => {
    const doc = ['```{r}', 'cmdstanr::register_knitr_engine()', '```', '', '```{stan output.var = "m1"}', 'parameters { real x; }', 'model { x ~ normal(0, 1); }', '```', '```{stan}', '#| output.var: m2', 'parameters { real y; }', '```'];
    const chunks = findChunks(doc);
    expect(chunks.map((c) => [c.lang, c.stan?.outputVar ?? null])).toEqual([['r', null], ['r', 'm1'], ['r', 'm2']]);
    const code = 'parameters { real x; }\nmodel { x ~ normal(0, 1); }';
    expect(stanChunkR(code, 'm1', doc)).toBe(`m1 <- cmdstanr::cmdstan_model(cmdstanr::write_stan_file("${code}"))`);
    expect(stanChunkR(code, 'm1', ['no engine registered'])).toBe(`m1 <- rstan::stan_model(model_code = "${code}")`);
    expect(stanChunkR(code, null, doc)).toMatch(/^stop\("Stan chunks need output.var/);
    expect(stanChunkR(code, 'bad name', doc)).toMatch(/^stop\(/);
  });
});
