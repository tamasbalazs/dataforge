// Real stanc v2.36.0 (stanc.js) output, captured in Chromium.
export const SAMPLES = {
 "semantic": {
  "errors": [
   0,
   "Semantic error in 'string', line 3, column 8 to column 31:\n   -------------------------------------------------\n     1:  data { int N; vector[N] y; }\n     2:  parameters { real mu; real<lower=0> sigma; }\n     3:  model { y ~ normall(mu, sigma); }\n                 ^\n   -------------------------------------------------\n\nIll-typed arguments to '~' statement. No function 'normall_lpdf' was found when looking for distribution 'normall'.\n"
  ],
  "warnings": []
 },
 "syntax": {
  "errors": [
   0,
   "Syntax error in 'string', line 3, column 30 to column 31, parsing error:\n   -------------------------------------------------\n     1:  data { int N; vector[N] y; }\n     2:  parameters { real mu; real<lower=0> sigma; }\n     3:  model { y ~ normal(mu, sigma) }\n                                       ^\n   -------------------------------------------------\n\nIll-formed \"~\"-statement. Expect either \";\" or a truncation with the format \"T[\" optional expression \",\" optional expression \"];\".\n"
  ],
  "warnings": []
 },
 "undeclared": {
  "errors": [
   0,
   "Semantic error in 'string', line 3, column 23 to column 26:\n   -------------------------------------------------\n     1:  data { int N; vector[N] y; }\n     2:  parameters { real mu; real<lower=0> sigma; }\n     3:  model { y ~ normal(mu, tau); }\n                                ^\n   -------------------------------------------------\n\nIdentifier 'tau' not in scope. Did you mean 'tan'?\n"
  ],
  "warnings": []
 },
 "deprecated": {
  "errors": [
   0,
   "Syntax error in 'string', line 1, column 20 to column 21, parsing error:\n   -------------------------------------------------\n     1:  parameters { real x[2]; } model { x ~ normal(0, 1); }\n                             ^\n   -------------------------------------------------\n\n\";\" expected after variable declaration.\nIt looks like you are trying to use the old array syntax.\nPlease use the new syntax:\narray[2] real x;\n"
  ],
  "warnings": []
 },
 "include": {
  "errors": [
   0,
   "Syntax error in 'string', line 1, column 0, include error:\n   -------------------------------------------------\n     1:  #include foo.stan\n         ^\n     2:  parameters { real x; } model { x ~ normal(0,1); }\n   -------------------------------------------------\n\nCould not find include file 'foo.stan'.\nstanc was given information about the following files:\nNone\n"
  ],
  "warnings": []
 },
 "pedantic": {
  "warnings": [
   "Warning: The parameter sigma has no priors. This means either no prior is\n    provided, or the prior(s) depend on data variables. In the later case,\n    this may be a false positive.",
   "Warning: The parameter mu has no priors. This means either no prior is\n    provided, or the prior(s) depend on data variables. In the later case,\n    this may be a false positive."
  ]
 },
 "info": {
  "inputs": {
   "N": {
    "type": "int",
    "dimensions": 0
   },
   "y": {
    "type": "real",
    "dimensions": 1
   }
  },
  "parameters": {
   "mu": {
    "type": "real",
    "dimensions": 0
   },
   "sigma": {
    "type": "real",
    "dimensions": 0
   }
  },
  "transformed parameters": {},
  "generated quantities": {},
  "functions": [],
  "distributions": [
   "normal_lupdf"
  ],
  "included_files": []
 }
} as const;
