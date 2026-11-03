import { describe, expect, it, vi } from 'vitest';

vi.mock('../../kernels/kernels', () => ({ callHelper: vi.fn(), execute: vi.fn(), isRunning: () => true, useKernels: { getState: () => ({ kernels: {} }) } }));

import { actionCode } from './packagesStore';

describe('package action code', () => {
  it('builds R code, using renv in renv projects', () => {
    expect(actionCode('r', 'install', ['dplyr'])).toBe('install.packages("dplyr")');
    expect(actionCode('r', 'install', ['dplyr', 'tidyr'])).toBe('install.packages(c("dplyr", "tidyr"))');
    expect(actionCode('r', 'install', ['dplyr'], { renv: true })).toBe('renv::install("dplyr")');
    expect(actionCode('r', 'load', ['ggplot2'])).toBe('library(ggplot2)');
    expect(actionCode('r', 'unload', ['ggplot2'])).toBe('detach("package:ggplot2", unload = TRUE)');
  });

  it('builds Python code with %pip so packages land in the kernel environment', () => {
    expect(actionCode('python', 'install', ['polars'])).toBe('%pip install polars');
    expect(actionCode('python', 'install', ['pandas>=2.2'])).toBe('%pip install "pandas>=2.2"');
    expect(actionCode('python', 'update', ['numpy'])).toBe('%pip install --upgrade numpy');
    expect(actionCode('python', 'remove', ['numpy'])).toBe('%pip uninstall -y numpy');
    expect(actionCode('python', 'load', ['scikit-learn'], { module: 'sklearn' })).toBe('import sklearn');
    expect(actionCode('python', 'unload', ['x'])).toBeNull();
  });

  it('uses uv pip when the environment has no pip', () => {
    const uv = { program: '/bin/uv', python: '/p/.venv/bin/python' };
    expect(actionCode('python', 'install', ['tabulate'], { uv })).toBe('!"/bin/uv" pip install --python "/p/.venv/bin/python" tabulate');
    expect(actionCode('python', 'update', ['numpy'], { uv })).toBe('!"/bin/uv" pip install --python "/p/.venv/bin/python" --upgrade numpy');
    expect(actionCode('python', 'remove', ['numpy'], { uv })).toBe('!"/bin/uv" pip uninstall --python "/p/.venv/bin/python" numpy');
    expect(actionCode('python', 'load', ['numpy'], { uv })).toBe('import numpy');
  });

  it('rejects names that could inject code', () => {
    expect(actionCode('r', 'install', ['x"); system("rm -rf /'])).toBeNull();
    expect(actionCode('python', 'install', ['x; import os'])).toBeNull();
    expect(actionCode('r', 'install', ['  '])).toBeNull();
  });
});
