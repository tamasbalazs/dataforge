/**
 * Stan language catalog for completion and hover: blocks, keywords, types,
 * distributions (with their _lpdf/_lpmf/_lcdf/_lccdf/_rng forms) and the most
 * used functions. Signatures follow the Stan Functions Reference (2.36).
 */

export const BLOCKS = ['functions', 'data', 'transformed data', 'parameters', 'transformed parameters', 'model', 'generated quantities'];

export const KEYWORDS = ['for', 'in', 'while', 'repeat', 'until', 'if', 'else', 'true', 'false', 'target', 'return', 'break', 'continue', 'print', 'reject', 'fatal_error', 'profile', 'lower', 'upper', 'offset', 'multiplier', 'void', 'data', 'tuple', 'array'];

export const TYPES = [
  'int', 'real', 'complex', 'vector', 'row_vector', 'matrix', 'complex_vector', 'complex_row_vector', 'complex_matrix',
  'simplex', 'unit_vector', 'sum_to_zero_vector', 'ordered', 'positive_ordered', 'cholesky_factor_corr', 'cholesky_factor_cov',
  'corr_matrix', 'cov_matrix', 'column_stochastic_matrix', 'row_stochastic_matrix', 'array', 'tuple',
];

export interface Distribution {
  name: string;
  /** Parameters after the variate, as written in `y ~ name(...)`. */
  params: string[];
  /** Variate kind: continuous (lpdf) or discrete (lpmf). */
  discrete?: boolean;
  doc: string;
  /** No closed-form CDF in Stan. */
  noCdf?: boolean;
  /** No _rng in Stan. */
  noRng?: boolean;
}

export const DISTRIBUTIONS: Distribution[] = [
  // Continuous, unbounded
  { name: 'normal', params: ['mu', 'sigma'], doc: 'Normal with location mu and scale sigma > 0.' },
  { name: 'std_normal', params: [], doc: 'Standard normal (mu = 0, sigma = 1); faster than normal(0, 1).' },
  { name: 'normal_id_glm', params: ['x', 'alpha', 'beta', 'sigma'], doc: 'Normal linear regression y ~ normal(alpha + x * beta, sigma), fused.', noCdf: true, noRng: true },
  { name: 'student_t', params: ['nu', 'mu', 'sigma'], doc: "Student's t with nu > 0 degrees of freedom." },
  { name: 'cauchy', params: ['mu', 'sigma'], doc: 'Cauchy with location mu and scale sigma > 0.' },
  { name: 'double_exponential', params: ['mu', 'sigma'], doc: 'Laplace (double exponential).' },
  { name: 'logistic', params: ['mu', 'sigma'], doc: 'Logistic.' },
  { name: 'gumbel', params: ['mu', 'beta'], doc: 'Gumbel (type I extreme value).' },
  { name: 'skew_normal', params: ['xi', 'omega', 'alpha'], doc: 'Skew normal with location xi, scale omega, shape alpha.' },
  { name: 'skew_double_exponential', params: ['mu', 'sigma', 'tau'], doc: 'Skewed Laplace; tau in (0, 1) is the skewness.' },
  { name: 'exp_mod_normal', params: ['mu', 'sigma', 'lambda'], doc: 'Exponentially modified normal.' },
  // Positive
  { name: 'lognormal', params: ['mu', 'sigma'], doc: 'Lognormal: log(y) ~ normal(mu, sigma).' },
  { name: 'chi_square', params: ['nu'], doc: 'Chi-square with nu > 0 degrees of freedom.' },
  { name: 'inv_chi_square', params: ['nu'], doc: 'Inverse chi-square.' },
  { name: 'scaled_inv_chi_square', params: ['nu', 's'], doc: 'Scaled inverse chi-square.' },
  { name: 'exponential', params: ['beta'], doc: 'Exponential with rate beta > 0.' },
  { name: 'gamma', params: ['alpha', 'beta'], doc: 'Gamma with shape alpha > 0 and rate beta > 0.' },
  { name: 'inv_gamma', params: ['alpha', 'beta'], doc: 'Inverse gamma with shape alpha and scale beta.' },
  { name: 'weibull', params: ['alpha', 'sigma'], doc: 'Weibull with shape alpha and scale sigma.' },
  { name: 'frechet', params: ['alpha', 'sigma'], doc: 'Fréchet with shape alpha and scale sigma.' },
  { name: 'rayleigh', params: ['sigma'], doc: 'Rayleigh with scale sigma.' },
  { name: 'loglogistic', params: ['alpha', 'beta'], doc: 'Log-logistic with scale alpha and shape beta.' },
  { name: 'pareto', params: ['y_min', 'alpha'], doc: 'Pareto with minimum y_min and shape alpha.' },
  { name: 'pareto_type_2', params: ['mu', 'lambda', 'alpha'], doc: 'Pareto type II (Lomax when mu = 0).' },
  { name: 'wiener', params: ['alpha', 'tau', 'beta', 'delta'], doc: 'Wiener first passage time (drift diffusion).', noCdf: true, noRng: true },
  // Bounded
  { name: 'beta', params: ['alpha', 'beta'], doc: 'Beta with shapes alpha, beta > 0.' },
  { name: 'beta_proportion', params: ['mu', 'kappa'], doc: 'Beta parameterized by mean mu in (0,1) and precision kappa.' },
  { name: 'von_mises', params: ['mu', 'kappa'], doc: 'Von Mises (circular) with location mu and concentration kappa.' },
  { name: 'uniform', params: ['alpha', 'beta'], doc: 'Uniform on (alpha, beta). Prefer declaring bounds instead.' },
  // Discrete
  { name: 'bernoulli', params: ['theta'], discrete: true, doc: 'Bernoulli with success probability theta.' },
  { name: 'bernoulli_logit', params: ['alpha'], discrete: true, doc: 'Bernoulli with logit-scale probability alpha.', noCdf: true },
  { name: 'bernoulli_logit_glm', params: ['x', 'alpha', 'beta'], discrete: true, doc: 'Logistic regression, fused and fast.', noCdf: true },
  { name: 'binomial', params: ['N', 'theta'], discrete: true, doc: 'Binomial with N trials and success probability theta.' },
  { name: 'binomial_logit', params: ['N', 'alpha'], discrete: true, doc: 'Binomial with logit-scale probability alpha.', noCdf: true },
  { name: 'beta_binomial', params: ['N', 'alpha', 'beta'], discrete: true, doc: 'Beta-binomial.' },
  { name: 'hypergeometric', params: ['N', 'a', 'b'], discrete: true, doc: 'Hypergeometric.', noCdf: true },
  { name: 'categorical', params: ['theta'], discrete: true, doc: 'Categorical with simplex theta.', noCdf: true },
  { name: 'categorical_logit', params: ['beta'], discrete: true, doc: 'Categorical with unnormalized log-probabilities beta.', noCdf: true },
  { name: 'categorical_logit_glm', params: ['x', 'alpha', 'beta'], discrete: true, doc: 'Multinomial logistic regression, fused.', noCdf: true, noRng: true },
  { name: 'discrete_range', params: ['lower', 'upper'], discrete: true, doc: 'Uniform over the integers lower..upper.' },
  { name: 'ordered_logistic', params: ['eta', 'c'], discrete: true, doc: 'Ordinal logistic with linear predictor eta and ordered cutpoints c.', noCdf: true },
  { name: 'ordered_logistic_glm', params: ['x', 'beta', 'c'], discrete: true, doc: 'Ordinal logistic regression, fused.', noCdf: true, noRng: true },
  { name: 'ordered_probit', params: ['eta', 'c'], discrete: true, doc: 'Ordinal probit.', noCdf: true },
  { name: 'poisson', params: ['lambda'], discrete: true, doc: 'Poisson with rate lambda.' },
  { name: 'poisson_log', params: ['alpha'], discrete: true, doc: 'Poisson with log rate alpha.', noCdf: true },
  { name: 'poisson_log_glm', params: ['x', 'alpha', 'beta'], discrete: true, doc: 'Poisson regression, fused.', noCdf: true, noRng: true },
  { name: 'neg_binomial', params: ['alpha', 'beta'], discrete: true, doc: 'Negative binomial with shape alpha and inverse scale beta.' },
  { name: 'neg_binomial_2', params: ['mu', 'phi'], discrete: true, doc: 'Negative binomial with mean mu and overdispersion phi.' },
  { name: 'neg_binomial_2_log', params: ['eta', 'phi'], discrete: true, doc: 'Negative binomial with log mean eta.', noCdf: true },
  { name: 'neg_binomial_2_log_glm', params: ['x', 'alpha', 'beta', 'phi'], discrete: true, doc: 'Negative binomial regression, fused.', noCdf: true, noRng: true },
  { name: 'beta_neg_binomial', params: ['r', 'alpha', 'beta'], discrete: true, doc: 'Beta negative binomial.' },
  { name: 'multinomial', params: ['theta'], discrete: true, doc: 'Multinomial with simplex theta.', noCdf: true },
  { name: 'multinomial_logit', params: ['gamma'], discrete: true, doc: 'Multinomial with log-probabilities gamma.', noCdf: true },
  // Multivariate
  { name: 'multi_normal', params: ['mu', 'Sigma'], doc: 'Multivariate normal with covariance Sigma.', noCdf: true },
  { name: 'multi_normal_cholesky', params: ['mu', 'L'], doc: 'Multivariate normal with Cholesky factor L of the covariance (faster).', noCdf: true },
  { name: 'multi_normal_prec', params: ['mu', 'Omega'], doc: 'Multivariate normal with precision Omega.', noCdf: true, noRng: true },
  { name: 'multi_gp', params: ['Sigma', 'w'], doc: 'Multiple Gaussian processes.', noCdf: true, noRng: true },
  { name: 'multi_gp_cholesky', params: ['L', 'w'], doc: 'Multiple Gaussian processes (Cholesky).', noCdf: true, noRng: true },
  { name: 'multi_student_t', params: ['nu', 'mu', 'Sigma'], doc: "Multivariate Student's t.", noCdf: true },
  { name: 'multi_student_t_cholesky', params: ['nu', 'mu', 'L'], doc: "Multivariate Student's t (Cholesky).", noCdf: true },
  { name: 'gaussian_dlm_obs', params: ['F', 'G', 'V', 'W', 'm0', 'C0'], doc: 'Gaussian dynamic linear model observations.', noCdf: true, noRng: true },
  { name: 'dirichlet', params: ['alpha'], doc: 'Dirichlet over simplexes.', noCdf: true },
  { name: 'dirichlet_multinomial', params: ['alpha'], discrete: true, doc: 'Dirichlet-multinomial.', noCdf: true },
  { name: 'lkj_corr', params: ['eta'], doc: 'LKJ prior on correlation matrices.', noCdf: true },
  { name: 'lkj_corr_cholesky', params: ['eta'], doc: 'LKJ prior on Cholesky factors of correlation matrices (preferred).', noCdf: true },
  { name: 'wishart', params: ['nu', 'Sigma'], doc: 'Wishart.', noCdf: true },
  { name: 'wishart_cholesky', params: ['nu', 'L_S'], doc: 'Wishart on Cholesky factors.', noCdf: true },
  { name: 'inv_wishart', params: ['nu', 'Sigma'], doc: 'Inverse Wishart.', noCdf: true },
  { name: 'inv_wishart_cholesky', params: ['nu', 'L_S'], doc: 'Inverse Wishart on Cholesky factors.', noCdf: true },
];

export interface StanFunction {
  name: string;
  sig: string;
  doc: string;
}

const f = (name: string, sig: string, doc: string): StanFunction => ({ name, sig, doc });

export const FUNCTIONS: StanFunction[] = [
  // Log-probability helpers
  f('log_sum_exp', '(x) or (x, y)', 'log(sum(exp(x))), computed stably.'),
  f('log_mix', '(theta, lp1, lp2)', 'Log of a two-component mixture: log(theta*exp(lp1) + (1-theta)*exp(lp2)).'),
  f('log_diff_exp', '(x, y)', 'log(exp(x) - exp(y)), stably.'),
  f('log1p_exp', '(x)', 'log(1 + exp(x)), stably.'),
  f('log1m_exp', '(x)', 'log(1 - exp(x)), stably.'),
  f('log_inv_logit', '(x)', 'log(inv_logit(x)).'),
  f('log1m_inv_logit', '(x)', 'log(1 - inv_logit(x)).'),
  f('log_softmax', '(x)', 'Log of the softmax of vector x.'),
  f('softmax', '(x)', 'Softmax of vector x (a simplex).'),
  // Link functions
  f('inv_logit', '(x)', 'Logistic sigmoid 1 / (1 + exp(-x)).'),
  f('logit', '(p)', 'log(p / (1 - p)).'),
  f('Phi', '(x)', 'Standard normal CDF.'),
  f('Phi_approx', '(x)', 'Fast logistic approximation of the standard normal CDF.'),
  f('inv_Phi', '(p)', 'Standard normal quantile function.'),
  f('inv_cloglog', '(x)', '1 - exp(-exp(x)).'),
  // Elementary
  f('exp', '(x)', 'Exponential.'),
  f('log', '(x)', 'Natural logarithm.'),
  f('log1p', '(x)', 'log(1 + x), accurate for small x.'),
  f('log1m', '(x)', 'log(1 - x), accurate for small x.'),
  f('expm1', '(x)', 'exp(x) - 1, accurate for small x.'),
  f('sqrt', '(x)', 'Square root.'),
  f('square', '(x)', 'x^2.'),
  f('inv', '(x)', '1 / x.'),
  f('inv_sqrt', '(x)', '1 / sqrt(x).'),
  f('inv_square', '(x)', '1 / x^2.'),
  f('pow', '(x, y)', 'x raised to y (also written x ^ y).'),
  f('abs', '(x)', 'Absolute value.'),
  f('fmin', '(x, y)', 'Minimum of two reals.'),
  f('fmax', '(x, y)', 'Maximum of two reals.'),
  f('fma', '(x, y, z)', 'x * y + z, fused.'),
  f('hypot', '(x, y)', 'sqrt(x^2 + y^2).'),
  f('lgamma', '(x)', 'Log of the gamma function.'),
  f('tgamma', '(x)', 'Gamma function.'),
  f('digamma', '(x)', 'Digamma function.'),
  f('lbeta', '(a, b)', 'Log of the beta function.'),
  f('lchoose', '(n, k)', 'Log binomial coefficient.'),
  f('choose', '(n, k)', 'Binomial coefficient (integers).'),
  f('erf', '(x)', 'Error function.'),
  f('erfc', '(x)', 'Complementary error function.'),
  f('floor', '(x)', 'Round down.'),
  f('ceil', '(x)', 'Round up.'),
  f('round', '(x)', 'Round to nearest.'),
  f('trunc', '(x)', 'Round toward zero.'),
  f('to_int', '(x)', 'Real to integer (truncating).'),
  f('step', '(x)', '1 if x > 0 else 0 (careful: not differentiable).'),
  f('int_step', '(x)', '1 if x > 0 else 0, integer.'),
  f('is_inf', '(x)', 'True for infinity.'),
  f('is_nan', '(x)', 'True for NaN.'),
  f('sin', '(x)', 'Sine.'),
  f('cos', '(x)', 'Cosine.'),
  f('tan', '(x)', 'Tangent.'),
  f('atan2', '(y, x)', 'Angle of (x, y).'),
  f('tanh', '(x)', 'Hyperbolic tangent.'),
  f('pi', '()', 'π.'),
  f('e', '()', "Euler's number."),
  f('positive_infinity', '()', '+∞.'),
  f('negative_infinity', '()', '−∞.'),
  f('not_a_number', '()', 'NaN.'),
  f('machine_precision', '()', 'Machine epsilon.'),
  // Reductions
  f('sum', '(x)', 'Sum of elements.'),
  f('prod', '(x)', 'Product of elements.'),
  f('mean', '(x)', 'Mean of elements.'),
  f('variance', '(x)', 'Sample variance.'),
  f('sd', '(x)', 'Sample standard deviation.'),
  f('min', '(x) or (x, y)', 'Minimum.'),
  f('max', '(x) or (x, y)', 'Maximum.'),
  f('quantile', '(x, p)', 'Sample quantile(s) of x.'),
  f('cumulative_sum', '(x)', 'Running sum.'),
  f('dot_product', '(x, y)', 'Dot product.'),
  f('dot_self', '(x)', 'x · x.'),
  f('columns_dot_product', '(x, y)', 'Dot product of corresponding columns.'),
  f('rows_dot_product', '(x, y)', 'Dot product of corresponding rows.'),
  f('squared_distance', '(x, y)', 'Squared Euclidean distance.'),
  f('distance', '(x, y)', 'Euclidean distance.'),
  f('norm2', '(x)', 'Euclidean norm.'),
  // Sizes, construction, slicing
  f('size', '(x)', 'Number of elements (top-level size for arrays).'),
  f('num_elements', '(x)', 'Total number of elements.'),
  f('rows', '(x)', 'Number of rows.'),
  f('cols', '(x)', 'Number of columns.'),
  f('dims', '(x)', 'Dimensions as an integer array.'),
  f('rep_vector', '(x, n)', 'Vector of n copies of x.'),
  f('rep_row_vector', '(x, n)', 'Row vector of n copies of x.'),
  f('rep_matrix', '(x, m, n)', 'm × n matrix filled with x.'),
  f('rep_array', '(x, n)', 'Array of n copies of x.'),
  f('zeros_vector', '(n)', 'Vector of n zeros.'),
  f('ones_vector', '(n)', 'Vector of n ones.'),
  f('linspaced_vector', '(n, lo, hi)', 'n evenly spaced values from lo to hi.'),
  f('one_hot_vector', '(n, k)', 'Vector of length n with a 1 at position k.'),
  f('uniform_simplex', '(n)', 'Simplex with all entries 1/n.'),
  f('to_vector', '(x)', 'Convert to a column vector.'),
  f('to_row_vector', '(x)', 'Convert to a row vector.'),
  f('to_matrix', '(x, m, n)', 'Convert/reshape to a matrix.'),
  f('to_array_1d', '(x)', 'Flatten to a 1-D array.'),
  f('to_complex', '(re, im)', 'Complex number.'),
  f('append_row', '(x, y)', 'Stack vertically.'),
  f('append_col', '(x, y)', 'Stack horizontally.'),
  f('append_array', '(x, y)', 'Concatenate arrays.'),
  f('head', '(x, n)', 'First n elements.'),
  f('tail', '(x, n)', 'Last n elements.'),
  f('segment', '(x, i, n)', 'n elements starting at i.'),
  f('block', '(x, i, j, n_rows, n_cols)', 'Sub-matrix.'),
  f('col', '(x, n)', 'Column n.'),
  f('row', '(x, m)', 'Row m.'),
  f('diagonal', '(x)', 'Diagonal of a matrix.'),
  f('diag_matrix', '(x)', 'Diagonal matrix from a vector.'),
  f('identity_matrix', '(n)', 'n × n identity.'),
  f('add_diag', '(m, d)', 'Add d to the diagonal of m.'),
  f('reverse', '(x)', 'Reverse order.'),
  f('sort_asc', '(x)', 'Sort ascending.'),
  f('sort_desc', '(x)', 'Sort descending.'),
  f('sort_indices_asc', '(x)', 'Indices that sort ascending.'),
  f('rank', '(x, s)', 'Number of elements less than x[s].'),
  // Linear algebra
  f('cholesky_decompose', '(A)', 'Lower Cholesky factor of a symmetric positive-definite matrix.'),
  f('multiply_lower_tri_self_transpose', '(L)', 'L * L′ for lower-triangular L.'),
  f('diag_pre_multiply', '(v, m)', 'diag_matrix(v) * m (e.g. scales from a Cholesky correlation factor).'),
  f('diag_post_multiply', '(m, v)', 'm * diag_matrix(v).'),
  f('quad_form', '(A, B)', "B' * A * B."),
  f('quad_form_diag', '(m, v)', 'diag_matrix(v) * m * diag_matrix(v).'),
  f('crossprod', '(x)', "x' * x."),
  f('tcrossprod', '(x)', "x * x'."),
  f('inverse', '(A)', 'Matrix inverse (prefer solves).'),
  f('inverse_spd', '(A)', 'Inverse of a symmetric positive-definite matrix.'),
  f('determinant', '(A)', 'Determinant.'),
  f('log_determinant', '(A)', 'Log absolute determinant.'),
  f('mdivide_left_tri_low', '(L, b)', 'Solve L x = b for lower-triangular L.'),
  f('mdivide_right_tri_low', '(b, L)', 'Solve x L = b for lower-triangular L.'),
  f('mdivide_left_spd', '(A, b)', 'Solve A x = b for symmetric positive-definite A.'),
  f('eigenvalues_sym', '(A)', 'Eigenvalues of a symmetric matrix.'),
  f('eigenvectors_sym', '(A)', 'Eigenvectors of a symmetric matrix.'),
  f('singular_values', '(A)', 'Singular values.'),
  f('matrix_exp', '(A)', 'Matrix exponential.'),
  f('trace', '(A)', 'Trace.'),
  f('csr_matrix_times_vector', '(m, n, w, v, u, b)', 'Sparse (CSR) matrix times vector.'),
  // Covariance functions
  f('gp_exp_quad_cov', '(x, sigma, length_scale)', 'Exponentiated quadratic (squared exponential) GP covariance.'),
  f('gp_matern32_cov', '(x, sigma, length_scale)', 'Matérn 3/2 GP covariance.'),
  f('gp_matern52_cov', '(x, sigma, length_scale)', 'Matérn 5/2 GP covariance.'),
  f('gp_exponential_cov', '(x, sigma, length_scale)', 'Exponential GP covariance.'),
  f('gp_periodic_cov', '(x, sigma, length_scale, period)', 'Periodic GP covariance.'),
  // Higher-order
  f('reduce_sum', '(partial_sum, x, grainsize, ...)', 'Parallel sum of partial log-likelihoods (within-chain threading).'),
  f('map_rect', '(f, phi, theta, x_r, x_i)', 'Parallel map over shards (MPI/threads).'),
  f('ode_rk45', '(f, y0, t0, ts, ...)', 'Non-stiff ODE solver (Runge–Kutta 4/5).'),
  f('ode_bdf', '(f, y0, t0, ts, ...)', 'Stiff ODE solver (BDF).'),
  f('ode_adams', '(f, y0, t0, ts, ...)', 'Non-stiff ODE solver (Adams–Moulton).'),
  f('ode_ckrk', '(f, y0, t0, ts, ...)', 'Non-stiff ODE solver (Cash–Karp).'),
  f('integrate_1d', '(f, a, b, theta, x_r, x_i)', '1-D numerical integration.'),
  f('solve_newton', '(f, guess, ...)', 'Algebraic system solver (Newton).'),
  f('solve_powell', '(f, guess, ...)', 'Algebraic system solver (Powell dogleg).'),
  f('hmm_marginal', '(log_omega, Gamma, rho)', 'Marginal log-density of a hidden Markov model.'),
  f('hmm_latent_rng', '(log_omega, Gamma, rho)', 'Draw latent HMM states.'),
];

export type Suffix = '_lpdf' | '_lpmf' | '_lupdf' | '_lupmf' | '_lcdf' | '_lccdf' | '_cdf' | '_rng';

/** Every callable name a distribution provides, with its signature. */
export function distributionFunctions(d: Distribution): StanFunction[] {
  const args = d.params.join(', ');
  const y = d.discrete ? 'n' : 'y';
  const lp = d.discrete ? '_lpmf' : '_lpdf';
  const lup = d.discrete ? '_lupmf' : '_lupdf';
  const out = [
    f(`${d.name}${lp}`, `(${y} | ${args})`, `Log ${d.discrete ? 'mass' : 'density'}. ${d.doc}`),
    f(`${d.name}${lup}`, `(${y} | ${args})`, `Log ${d.discrete ? 'mass' : 'density'} without constants (only in the model block). ${d.doc}`),
  ];
  if (!d.noCdf) {
    out.push(f(`${d.name}_lcdf`, `(${y} | ${args})`, `Log CDF. ${d.doc}`), f(`${d.name}_lccdf`, `(${y} | ${args})`, `Log complementary CDF. ${d.doc}`));
  }
  if (!d.noRng) out.push(f(`${d.name}_rng`, `(${args})`, `Random draw (generated quantities / transformed data). ${d.doc}`));
  return out;
}

let all: Map<string, StanFunction> | null = null;
/** Lookup by name for hover/signature help. */
export function lookup(name: string): StanFunction | undefined {
  if (!all) {
    all = new Map();
    for (const fn of FUNCTIONS) all.set(fn.name, fn);
    for (const d of DISTRIBUTIONS) {
      all.set(d.name, f(d.name, `(${d.params.join(', ')})`, `${d.doc}  Use as \`y ~ ${d.name}(${d.params.join(', ')})\`.`));
      for (const fn of distributionFunctions(d)) all.set(fn.name, fn);
    }
  }
  return all.get(name);
}

export const allFunctionNames = () => {
  lookup('');
  return [...all!.keys()];
};
